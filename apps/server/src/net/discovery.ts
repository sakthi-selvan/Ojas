/**
 * Answers desks looking for the server: they broadcast DISCOVERY_PROBE on UDP DISCOVERY_PORT and the
 * server replies (unicast) with its name, port and certificate fingerprint. Nothing secret is sent;
 * the fingerprint is checked again on the HTTPS connection itself.
 */
import { createSocket, type Socket } from "node:dgram";
import { DISCOVERY_PROBE, type DiscoveryReply } from "@ojas/shared";

export function startDiscovery(opts: { port: number; info: () => Promise<DiscoveryReply>; onError?: (e: Error) => void }): Promise<Socket> {
  const socket = createSocket({ type: "udp4", reuseAddr: true });
  socket.on("message", (msg, rinfo) => {
    if (msg.length > 64 || msg.toString("utf8").trim() !== DISCOVERY_PROBE) return;
    void opts.info().then(
      (reply) => socket.send(Buffer.from(JSON.stringify(reply)), rinfo.port, rinfo.address),
      (e: Error) => opts.onError?.(e),
    );
  });
  socket.on("error", (e) => opts.onError?.(e));
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(opts.port, () => {
      socket.off("error", reject);
      resolve(socket);
    });
  });
}
