// The proxy's socket to Milo: opened by the proxy — Milo never connects to
// it —, its token in the "Authorization" header, kept open, reopened when
// lost. Over it, Milo gives the devices the proxy may reach and sends its
// requests; the proxy answers them (ressources/proxy/PROTOCOL.md, in Milo).
//
//   proxy → Milo  hello     { protocol, version, hostname, capabilities }
//   Milo → proxy  welcome   { proxy: { id, name }, devices }
//   Milo → proxy  devices   { devices }                — whenever they change
//   Milo → proxy  request   { id, device, service, op, data, … }
//   proxy → Milo  response  { id, ok, data | error }
//   Milo → proxy  error     { message }                — before closing

import os from "node:os";
import { WebSocket } from "ws";
import type { RawData } from "ws";
import type { Config } from "./config.js";
import { handleRequest, parseDevices, SERVICES } from "./requests.js";
import type { Device } from "./requests.js";
import { VERSION } from "./version.js";

/** The protocol spoken: Milo refuses a proxy announcing another. */
export const PROTOCOL = 1;

/** A frame's largest size, both ways (Milo's MAX_PAYLOAD). */
const MAX_PAYLOAD = 8 * 1024 * 1024;

/** How often Milo is pinged; without its pong before the next, the socket is closed. */
const PING_INTERVAL = 15_000;

/** How long the socket has to open. */
const HANDSHAKE_TIMEOUT = 15_000;

/** Requests run at once: beyond, they are refused. */
const MAX_PENDING = 32;

/** Milo's close codes (its proxy-hub.ts). */
const CLOSE = {
  shutdown: 1001,
  protocolError: 4000,
  replaced: 4001,
  unsupportedProtocol: 4002,
  revoked: 4003,
  helloTimeout: 4004,
} as const;

/** The waits before reconnecting, in milliseconds. */
export interface Delays {
  /** After a loss: doubled each failure, from first to max. */
  first: number;
  max: number;
  /** Replaced by another connection: another proxy may use the same token. */
  replaced: number;
  /** The token refused, too many failures, or the protocol: no quick retries. */
  refused: number;
}

export const DELAYS: Delays = {
  first: 1_000,
  max: 60_000,
  replaced: 60_000,
  refused: 10 * 60_000,
};

export interface ProxyOptions {
  config: Config;
  log?: (message: string) => void;
  delays?: Delays;
  /** The port of each service: for the tests alone, SERVICES otherwise. */
  ports?: Readonly<Record<string, number>>;
}

export interface Proxy {
  /** The socket closed for good: the proxy stops. */
  stop(): Promise<void>;
}

/** What a closing, or a refused upgrade, means for the next attempt. */
const delayAfter = (delays: Delays, backoff: number, code: number, status: number): number => {
  if (status === 401 || status === 403 || status === 429) return delays.refused;
  if (code === CLOSE.revoked || code === CLOSE.unsupportedProtocol) return delays.refused;
  if (code === CLOSE.replaced) return delays.replaced;
  return backoff;
};

const reasonOf = (code: number, status: number): string => {
  if (status === 401) return "token refusé : vérifier la configuration, ou régénérer le token dans Milo";
  if (status === 403) return "accès refusé (403) : nginx protège-t-il /api/proxy/socket ?";
  if (status === 429) return "trop d'échecs depuis cette adresse (429)";
  if (status === 404) return "adresse introuvable (404) : vérifier « server » et le bloc nginx du socket";
  if (status) return `réponse HTTP ${status}`;
  switch (code) {
    case CLOSE.shutdown:
      return "arrêt de Milo";
    case CLOSE.protocolError:
      return "message refusé par Milo";
    case CLOSE.replaced:
      return "remplacée par une nouvelle connexion — un autre proxy utilise-t-il le même token ?";
    case CLOSE.unsupportedProtocol:
      return `protocole ${PROTOCOL} non pris en charge par Milo : mettre à jour le proxy`;
    case CLOSE.revoked:
      return "token régénéré ou proxy supprimé dans Milo";
    case CLOSE.helloTimeout:
      return "présentation trop tardive";
    default:
      return `code ${code}`;
  }
};

const seconds = (ms: number): string =>
  ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`;

export const startProxy = ({ config, log = console.log, delays = DELAYS, ports = SERVICES }: ProxyOptions): Proxy => {
  let socket: WebSocket | null = null;
  let retry: NodeJS.Timeout | undefined;
  let stopped = false;
  let backoff = delays.first;
  let stoppedResolve: (() => void) | undefined;

  const connect = (): void => {
    let devices = new Map<string, Device>();
    let welcomed = false;
    let alive = true;
    let status = 0;
    let pending = 0;

    const ws = new WebSocket(config.url, {
      headers: { Authorization: `Bearer ${config.token}` },
      maxPayload: MAX_PAYLOAD,
      handshakeTimeout: HANDSHAKE_TIMEOUT,
    });
    socket = ws;

    const send = (message: object): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    };

    const heartbeat = setInterval(() => {
      if (!alive) {
        log("Milo ne répond plus aux pings : connexion coupée");
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, PING_INTERVAL);

    const setDevices = (value: unknown): boolean => {
      const list = parseDevices(value);
      if (!list) {
        log("liste de périphériques illisible : ignorée");
        return false;
      }
      devices = new Map(list.map((d) => [d.id, d]));
      return true;
    };

    const onRequest = async (message: Record<string, unknown>): Promise<void> => {
      const id = typeof message.id === "string" ? message.id : "";
      if (!id) return log("requête sans identifiant : ignorée");
      if (pending >= MAX_PENDING) return send({ type: "response", id, ok: false, error: "proxy saturé" });
      pending += 1;
      const device = typeof message.device === "string" ? devices.get(message.device) : undefined;
      const answer = await handleRequest(message, devices, ports);
      pending -= 1;
      if (!answer.ok) {
        log(`${String(message.op)} ${device ? `« ${device.name} » (${device.host})` : String(message.device)} : ${answer.error}`);
      }
      send({ type: "response", id, ...answer });
    };

    const onMessage = (raw: RawData, binary: boolean): void => {
      alive = true;
      let message: Record<string, unknown>;
      try {
        if (binary) throw new Error();
        message = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (!message || typeof message !== "object") throw new Error();
      } catch {
        log("message illisible de Milo : ignoré");
        return;
      }
      switch (message.type) {
        case "welcome": {
          welcomed = true;
          const proxy = (message.proxy ?? {}) as Record<string, unknown>;
          setDevices(message.devices);
          log(`connecté en tant que « ${String(proxy.name ?? "?")} » : ${devices.size} périphérique(s)`);
          break;
        }
        case "devices":
          if (setDevices(message.devices)) log(`liste de périphériques reçue : ${devices.size}`);
          break;
        case "request":
          void onRequest(message);
          break;
        case "error":
          log(`Milo : ${String(message.message ?? "")}`);
          break;
        default:
          log(`message ignoré : ${String(message.type)}`);
      }
    };

    ws.on("open", () => {
      send({
        type: "hello",
        protocol: PROTOCOL,
        version: VERSION,
        hostname: os.hostname(),
        capabilities: Object.keys(ports),
      });
    });
    ws.on("message", onMessage);
    ws.on("pong", () => (alive = true));
    // A refused upgrade: its status tells what to do next.
    ws.on("unexpected-response", (_req, res) => {
      status = res.statusCode ?? 0;
      res.resume();
      ws.terminate();
    });
    ws.on("error", (e) => {
      if (!status) log(`connexion à ${config.url} impossible : ${e.message}`);
    });
    ws.once("close", (code) => {
      clearInterval(heartbeat);
      if (socket === ws) socket = null;
      if (stopped) {
        stoppedResolve?.();
        return;
      }
      // Lost after it was welcomed: the next attempt starts quick again.
      const base = welcomed ? delays.first : backoff;
      const wait = delayAfter(delays, base, code, status);
      backoff = Math.min(base * 2, delays.max);
      // A connection that failed to open has already said why.
      if (welcomed || status || code !== 1006) log(`déconnecté : ${reasonOf(code, status)}`);
      log(`nouvelle tentative dans ${seconds(wait)}`);
      retry = setTimeout(connect, wait);
    });
  };

  log(`Milo Proxy ${VERSION} : connexion à ${config.url}`);
  connect();

  return {
    stop: () =>
      new Promise<void>((resolve) => {
        stopped = true;
        clearTimeout(retry);
        if (!socket || socket.readyState === WebSocket.CLOSED) return resolve();
        stoppedResolve = resolve;
        if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
        else socket.close(1001, "Arrêt du proxy");
        // A Milo that does not answer the closing does not hold the stop.
        setTimeout(() => socket?.terminate(), 2_000).unref();
      }),
  };
};
