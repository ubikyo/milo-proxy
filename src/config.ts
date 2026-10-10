// The proxy's configuration: the lines Milo shows once, in "Paramétrage" >
// "Proxy", when the proxy is created or its token regenerated.
//
//   server=milo.example.fr
//   token=mpx_…
//
// Read from systemd's credentials when there are (deploy/milo-proxy.service:
// the file stays readable by root alone), otherwise from MILO_PROXY_CONFIG, or
// /etc/milo.proxy.conf.

import fs from "node:fs";
import path from "node:path";

/** What every proxy token starts with (Milo's shared/src/proxies.ts). */
export const TOKEN_PREFIX = "mpx_";

/** Where Milo listens for the proxies. */
export const SOCKET_PATH = "/api/proxy/socket";

export const DEFAULT_CONFIG_PATH = "/etc/milo.proxy.conf";

export interface Config {
  /** wss://milo.example.fr/api/proxy/socket */
  url: string;
  token: string;
}

/** Where the configuration is read from. */
export const configPath = (env: NodeJS.ProcessEnv = process.env): string => {
  if (env.CREDENTIALS_DIRECTORY) return path.join(env.CREDENTIALS_DIRECTORY, "config");
  return env.MILO_PROXY_CONFIG || DEFAULT_CONFIG_PATH;
};

/**
 * The socket's address. "milo.example.fr" — what Milo gives — is reached over
 * HTTPS; a full address may say otherwise: "http://localhost:3001" while
 * developing.
 */
export const socketUrl = (server: string): string => {
  const match = /^(https?|wss?):\/\/(.+)$/i.exec(server);
  const scheme = match ? match[1]!.toLowerCase() : "https";
  const host = (match ? match[2]! : server).replace(/\/+$/, "");
  if (!host || host.includes("/")) throw new Error(`adresse de serveur invalide : ${server}`);
  const secure = scheme === "https" || scheme === "wss";
  return `${secure ? "wss" : "ws"}://${host}${SOCKET_PATH}`;
};

/** "key=value" lines; blank lines and "#" comments ignored. */
export const parseConfig = (text: string): Config => {
  const values = new Map<string, string>();
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const equal = line.indexOf("=");
    if (equal < 1) throw new Error(`ligne ${index + 1} illisible : ${line}`);
    values.set(line.slice(0, equal).trim().toLowerCase(), line.slice(equal + 1).trim());
  }
  const server = values.get("server");
  const token = values.get("token");
  if (!server) throw new Error("« server » manquant");
  if (!token) throw new Error("« token » manquant");
  if (!token.startsWith(TOKEN_PREFIX)) throw new Error(`le token doit commencer par « ${TOKEN_PREFIX} »`);
  return { url: socketUrl(server), token };
};

export const readConfig = (file: string): Config => {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    throw new Error(`configuration illisible (${file}) : ${(e as Error).message}`);
  }
  try {
    return parseConfig(text);
  } catch (e) {
    throw new Error(`configuration invalide (${file}) : ${(e as Error).message}`);
  }
};
