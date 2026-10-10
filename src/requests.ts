// Milo's requests, answered: each names a device by its id — never by its
// address — and one of its services. The proxy reaches only the devices Milo
// last gave it, each on the port its service has here, in this code: no
// request chooses a port (ressources/proxy/PROTOCOL.md, in Milo).

import { tcpExchange, tcpSend } from "./tcp.js";

/** The services the proxy knows, and the port of each. */
export const SERVICES: Readonly<Record<string, number>> = {
  // Raw TCP printing: Zebra, and most network printers.
  "raw-print": 9100,
};

export interface Device {
  id: string;
  name: string;
  host: string;
  services: string[];
}

export type Answer = { ok: true; data: string } | { ok: false; error: string };

/** The bounds a request's times are held in, in milliseconds. */
const MAX_TIMEOUT = 120_000;
const MAX_CONNECT_TIMEOUT = 30_000;

/** The largest answer read from a device (Milo asks for 4 Mio). */
const MAX_ANSWER = 4 * 1024 * 1024;

const isString = (value: unknown): value is string => typeof value === "string";

/** Milo's device list, or null if it cannot be read. */
export const parseDevices = (value: unknown): Device[] | null => {
  if (!Array.isArray(value)) return null;
  const devices: Device[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const { id, name, host, services } = item as Record<string, unknown>;
    if (!isString(id) || !isString(host) || !Array.isArray(services) || !services.every(isString)) return null;
    devices.push({ id, name: isString(name) ? name : id, host: host.trim(), services });
  }
  return devices;
};

/** A time Milo gave, held within its bounds; the default if it gave none. */
const duration = (value: unknown, fallback: number, max: number): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(Math.max(Math.round(value), 1), max) : fallback;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const bytes = (value: unknown): Buffer | null =>
  isString(value) && value.length % 4 === 0 && BASE64.test(value) ? Buffer.from(value, "base64") : null;

/** A network error, as the user reads it in Milo: in French, short. */
export const describe = (error: unknown): string => {
  const code = (error as NodeJS.ErrnoException).code;
  switch (code) {
    case "ECONNREFUSED":
      return "connexion refusée";
    case "ECONNRESET":
      return "connexion interrompue par le périphérique";
    case "EHOSTUNREACH":
    case "EHOSTDOWN":
      return "périphérique injoignable";
    case "ENETUNREACH":
      return "réseau injoignable";
    case "ETIMEDOUT":
      return "délai de connexion dépassé";
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "nom d'hôte inconnu";
    default:
      return error instanceof Error ? error.message : String(error);
  }
};

/**
 * A request, done: its answer. Never rejects — whatever goes wrong is the
 * answer's error.
 */
export const handleRequest = async (
  message: Record<string, unknown>,
  devices: ReadonlyMap<string, Device>,
  ports: Readonly<Record<string, number>> = SERVICES,
): Promise<Answer> => {
  const device = isString(message.device) ? devices.get(message.device) : undefined;
  if (!device) return { ok: false, error: "périphérique inconnu" };
  const service = isString(message.service) ? message.service : "";
  const port = Object.hasOwn(ports, service) ? ports[service] : undefined;
  if (port === undefined || !device.services.includes(service)) return { ok: false, error: "service non disponible" };
  const data = bytes(message.data);
  if (!data) return { ok: false, error: "données illisibles" };
  const timeout = duration(message.timeout_ms, 10_000, MAX_TIMEOUT);
  const connectTimeout = duration(message.connect_timeout_ms, 2_000, MAX_CONNECT_TIMEOUT);
  try {
    if (message.op === "send") {
      await tcpSend(device.host, port, data, timeout, connectTimeout);
      return { ok: true, data: "" };
    }
    if (message.op === "exchange") {
      const until = message.until === undefined ? undefined : bytes(message.until);
      if (until === null || until?.length === 0) return { ok: false, error: "données illisibles" };
      const answer = await tcpExchange(device.host, port, data, {
        connectTimeout,
        timeout,
        idle: duration(message.idle_ms, 1_500, MAX_TIMEOUT),
        until,
        maxBytes: duration(message.max_bytes, MAX_ANSWER, MAX_ANSWER),
      });
      return { ok: true, data: answer.toString("base64") };
    }
    return { ok: false, error: "opération non prise en charge" };
  } catch (e) {
    return { ok: false, error: describe(e) };
  }
};
