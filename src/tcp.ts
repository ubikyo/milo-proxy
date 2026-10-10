// A device's raw TCP port, reached on the site's network: what Milo does
// itself for the devices it can reach (Milo's server/src/lib/raw-link.ts),
// done here for those it cannot.
// - "send": the bytes written, the connection closed — a print job;
// - "exchange": the bytes written, then the device's answer read — until a
//   given end, a silence, the time up or the size reached.

import net from "node:net";

export interface ExchangeOptions {
  /** How long the connection has to open. */
  connectTimeout: number;
  /** How long the whole exchange may last: what was read by then is the answer. */
  timeout: number;
  /** Once the device has started answering, this much silence ends its answer. */
  idle: number;
  /** The bytes that end the answer, as soon as they arrive. */
  until?: Buffer;
  /** The answer's largest size: reached, it is the answer. */
  maxBytes: number;
}

/**
 * The bytes written on the port, the connection closed; resolves once the
 * device has them all. Destroyed right after writing, the connection could be
 * reset before the device had read the job.
 */
export const tcpSend = (host: string, port: number, data: Buffer, timeout: number, connectTimeout: number) =>
  new Promise<void>((resolve, reject) => {
    const socket = net.connect({ host, port });
    let sent = false;
    const connecting = setTimeout(() => {
      socket.destroy();
      reject(new Error("délai de connexion dépassé"));
    }, connectTimeout);
    socket.setTimeout(timeout, () => {
      socket.destroy();
      // Written, the job is the device's: one that keeps the connection open
      // has it all the same.
      if (sent) resolve();
      else reject(new Error("délai dépassé"));
    });
    socket.once("error", (e) => {
      clearTimeout(connecting);
      reject(e);
    });
    socket.once("connect", () => {
      clearTimeout(connecting);
      socket.end(data, () => (sent = true));
    });
    // Whatever the device answers is read, so the connection closes cleanly.
    socket.on("data", () => undefined);
    socket.once("close", (failed) => {
      if (!failed) resolve();
    });
  });

export const tcpExchange = (host: string, port: number, data: Buffer, options: ExchangeOptions) =>
  new Promise<Buffer>((resolve, reject) => {
    const socket = net.connect({ host, port });
    const chunks: Buffer[] = [];
    let size = 0;
    let idle: NodeJS.Timeout | undefined;
    let settled = false;
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(idle);
      clearTimeout(connecting);
      clearTimeout(overall);
      socket.destroy();
      if (error) reject(error);
      else resolve(Buffer.concat(chunks).subarray(0, options.maxBytes));
    };
    const connecting = setTimeout(() => finish(new Error("délai de connexion dépassé")), options.connectTimeout);
    const overall = setTimeout(() => finish(null), options.timeout);
    socket.once("error", (e) => finish(chunks.length ? null : e));
    socket.once("connect", () => {
      clearTimeout(connecting);
      socket.write(data);
    });
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      clearTimeout(idle);
      idle = setTimeout(() => finish(null), options.idle);
      if (size >= options.maxBytes) finish(null);
      else if (options.until && Buffer.concat(chunks).includes(options.until)) finish(null);
    });
    socket.once("end", () => finish(null));
  });
