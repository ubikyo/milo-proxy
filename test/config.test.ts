import assert from "node:assert/strict";
import { test } from "node:test";
import { configPath, parseConfig, socketUrl } from "../src/config.js";

test("the lines Milo shows are a configuration", () => {
  const config = parseConfig("server=milo.example.fr\ntoken=mpx_abc\n");
  assert.deepEqual(config, { url: "wss://milo.example.fr/api/proxy/socket", token: "mpx_abc" });
});

test("comments, blanks and CRLF are ignored", () => {
  const config = parseConfig("# Milo\r\n\r\n  server = milo.example.fr  \r\ntoken=mpx_abc\r\n");
  assert.equal(config.url, "wss://milo.example.fr/api/proxy/socket");
});

test("a full address chooses its scheme", () => {
  assert.equal(socketUrl("http://localhost:3001"), "ws://localhost:3001/api/proxy/socket");
  assert.equal(socketUrl("https://milo.example.fr/"), "wss://milo.example.fr/api/proxy/socket");
  assert.equal(socketUrl("milo.example.fr:8443"), "wss://milo.example.fr:8443/api/proxy/socket");
  assert.throws(() => socketUrl("milo.example.fr/api"));
});

test("a missing or foreign token is refused", () => {
  assert.throws(() => parseConfig("server=milo.example.fr"), /token/);
  assert.throws(() => parseConfig("server=milo.example.fr\ntoken=abc"), /mpx_/);
  assert.throws(() => parseConfig("token=mpx_abc"), /server/);
});

test("systemd's credentials come first", () => {
  assert.equal(configPath({ CREDENTIALS_DIRECTORY: "/run/credentials/milo-proxy.service" }), "/run/credentials/milo-proxy.service/config");
  assert.equal(configPath({ MILO_PROXY_CONFIG: "./local.conf" }), "./local.conf");
  assert.equal(configPath({}), "/etc/milo.proxy.conf");
});
