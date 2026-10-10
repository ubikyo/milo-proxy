// The proxy against a fake Milo — a WebSocket server — and a fake printer — a
// TCP server —, both on this machine.

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import net from "node:net";
import { after, before, test } from "node:test";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { startProxy } from "../src/proxy.js";
import type { Proxy } from "../src/proxy.js";

const TOKEN = "mpx_test";
const DELAYS = { first: 50, max: 200, replaced: 300, refused: 600 };

/** What the printer received, connection by connection; what it answers. */
const received: Buffer[] = [];
let answer = (_data: Buffer, _socket: net.Socket): void => undefined;

const printer = net.createServer((socket) => {
  const chunks: Buffer[] = [];
  socket.on("data", (chunk) => {
    chunks.push(chunk);
    answer(Buffer.concat(chunks), socket);
  });
  socket.on("end", () => {
    received.push(Buffer.concat(chunks));
    socket.end();
  });
  socket.on("error", () => undefined);
});

let printerPort = 0;
let wss: WebSocketServer;
let url = "";
/** Each upgrade's answer: a status refuses it. */
let refuseWith = 0;
const connections: { socket: WebSocket; hello: Record<string, unknown>; at: number }[] = [];
let onConnection: (() => void) | undefined;

const nextMessage = (socket: WebSocket) =>
  new Promise<Record<string, unknown>>((resolve) =>
    socket.once("message", (raw) => resolve(JSON.parse(raw.toString()) as Record<string, unknown>)),
  );

const nextConnection = () =>
  new Promise<(typeof connections)[number]>((resolve) => {
    const count = connections.length;
    onConnection = () => {
      if (connections.length > count) resolve(connections[connections.length - 1]!);
    };
  });

before(async () => {
  await new Promise<void>((resolve) => printer.listen(0, "127.0.0.1", resolve));
  printerPort = (printer.address() as AddressInfo).port;
  wss = new WebSocketServer({
    port: 0,
    host: "127.0.0.1",
    verifyClient: (info, done) => {
      if (refuseWith) return done(false, refuseWith);
      done(info.req.headers.authorization === `Bearer ${TOKEN}`, 401);
    },
  });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/api/proxy/socket`;
  wss.on("connection", (socket) => {
    void nextMessage(socket).then((hello) => {
      connections.push({ socket, hello, at: Date.now() });
      socket.send(
        JSON.stringify({
          type: "welcome",
          proxy: { id: 1, name: "Test" },
          devices: [{ id: "printer:1", name: "zebra", host: "127.0.0.1", services: ["raw-print"] }],
        }),
      );
      onConnection?.();
    });
  });
});

after(() => {
  printer.close();
  wss.close();
});

const logs: string[] = [];
let proxy: Proxy;

const start = () =>
  startProxy({
    config: { url, token: TOKEN },
    delays: DELAYS,
    ports: { "raw-print": printerPort },
    log: (message) => logs.push(message),
  });

/** A request sent, its response. */
const ask = async (socket: WebSocket, request: Record<string, unknown>) => {
  const response = nextMessage(socket);
  socket.send(JSON.stringify({ type: "request", ...request }));
  return response;
};

test("the proxy says who it is", async () => {
  const connected = nextConnection();
  proxy = start();
  const { hello } = await connected;
  assert.equal(hello.type, "hello");
  assert.equal(hello.protocol, 1);
  assert.deepEqual(hello.capabilities, ["raw-print"]);
  assert.equal(typeof hello.hostname, "string");
});

test("send: the bytes reach the printer", async () => {
  const { socket } = connections.at(-1)!;
  const response = await ask(socket, {
    id: "1",
    device: "printer:1",
    service: "raw-print",
    op: "send",
    data: Buffer.from("^XA^XZ").toString("base64"),
    timeout_ms: 2000,
    connect_timeout_ms: 1000,
  });
  assert.deepEqual(response, { type: "response", id: "1", ok: true, data: "" });
  assert.equal(received.at(-1)?.toString(), "^XA^XZ");
});

test("exchange: the printer's answer, up to its end", async () => {
  answer = (data, socket) => {
    if (data.toString() === "~HS") socket.write("\x02status\x03\r\n");
  };
  const { socket } = connections.at(-1)!;
  const response = await ask(socket, {
    id: "2",
    device: "printer:1",
    service: "raw-print",
    op: "exchange",
    data: Buffer.from("~HS").toString("base64"),
    timeout_ms: 2000,
    connect_timeout_ms: 1000,
    idle_ms: 1500,
    until: Buffer.from("\r\n").toString("base64"),
    max_bytes: 1024,
  });
  assert.equal(response.ok, true);
  assert.equal(Buffer.from(response.data as string, "base64").toString(), "\x02status\x03\r\n");
});

test("only the devices and services Milo gave", async () => {
  const { socket } = connections.at(-1)!;
  const data = Buffer.from("x").toString("base64");
  const unknown = await ask(socket, { id: "3", device: "printer:2", service: "raw-print", op: "send", data });
  assert.deepEqual(unknown, { type: "response", id: "3", ok: false, error: "périphérique inconnu" });
  const service = await ask(socket, { id: "4", device: "printer:1", service: "ssh", op: "send", data });
  assert.deepEqual(service, { type: "response", id: "4", ok: false, error: "service non disponible" });
  const op = await ask(socket, { id: "5", device: "printer:1", service: "raw-print", op: "connect", data });
  assert.deepEqual(op, { type: "response", id: "5", ok: false, error: "opération non prise en charge" });
});

test("a new device list replaces the last", async () => {
  const { socket } = connections.at(-1)!;
  socket.send(JSON.stringify({ type: "devices", devices: [] }));
  const data = Buffer.from("x").toString("base64");
  const response = await ask(socket, { id: "6", device: "printer:1", service: "raw-print", op: "send", data });
  assert.equal(response.error, "périphérique inconnu");
});

test("an unreachable device is a short French error", async () => {
  const closed = net.createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const port = (closed.address() as AddressInfo).port;
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  const other = startProxy({
    config: { url, token: TOKEN },
    delays: DELAYS,
    ports: { "raw-print": port },
    log: () => undefined,
  });
  const { socket } = await nextConnection();
  const response = await ask(socket, {
    id: "7",
    device: "printer:1",
    service: "raw-print",
    op: "send",
    data: Buffer.from("x").toString("base64"),
    connect_timeout_ms: 1000,
  });
  assert.deepEqual(response, { type: "response", id: "7", ok: false, error: "connexion refusée" });
  await other.stop();
});

test("lost, the connection is reopened", async () => {
  const { socket } = connections.at(-2)!;
  const reconnected = nextConnection();
  const closedAt = Date.now();
  socket.close(1001, "Arrêt de Milo");
  const next = await reconnected;
  assert.ok(next.at - closedAt < DELAYS.replaced);
});

test("replaced, it waits longer before reconnecting", async () => {
  const { socket } = connections.at(-1)!;
  const reconnected = nextConnection();
  const closedAt = Date.now();
  socket.close(4001, "Remplacée par une nouvelle connexion");
  const next = await reconnected;
  assert.ok(next.at - closedAt >= DELAYS.replaced);
});

test("a refused token stops the quick retries", async () => {
  const { socket } = connections.at(-1)!;
  refuseWith = 401;
  const closedAt = Date.now();
  const reconnected = nextConnection();
  socket.close(4003, "Token régénéré");
  // The first attempt is refused (401): the next one waits "refused".
  await new Promise((resolve) => setTimeout(resolve, DELAYS.refused / 2));
  refuseWith = 0;
  const next = await reconnected;
  assert.ok(next.at - closedAt >= DELAYS.refused);
  assert.ok(logs.some((l) => l.includes("token régénéré")));
  await proxy.stop();
});
