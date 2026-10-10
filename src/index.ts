// Milo Proxy: run by systemd (deploy/milo-proxy.service), logs in its journal
// — "journalctl -u milo-proxy".

import { configPath, readConfig } from "./config.js";
import { startProxy } from "./proxy.js";

const file = configPath();
let config;
try {
  config = readConfig(file);
} catch (e) {
  console.error((e as Error).message);
  // A configuration to fix: systemd should not restart it in a loop.
  process.exit(78);
}

const proxy = startProxy({ config });

const stop = (signal: string) => {
  console.log(`arrêt (${signal})`);
  void proxy.stop().then(() => process.exit(0));
};
process.once("SIGTERM", () => stop("SIGTERM"));
process.once("SIGINT", () => stop("SIGINT"));
