/** Finding the clinic's server and checking it is the one this desk paired with. */
import { createHash } from "node:crypto";
import { createSocket } from "node:dgram";
import { request } from "node:https";
import { networkInterfaces } from "node:os";
import type { TLSSocket } from "node:tls";
import { DISCOVERY_PORT, DISCOVERY_PROBE, normalizeFingerprint, serverCode, type DiscoveryReply } from "@ojas/shared";

/** SHA-256 of a PEM certificate's DER bytes, the same value the server reports. */
export function fingerprintOfPem(pem: string): string {
  const b64 = pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, "");
  return normalizeFingerprint(createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex"));
}

export interface Probe {
  ok: boolean;
  url: string;
  fingerprint?: string;
  serverCode?: string;
  name?: string;
  error?: string;
}

/**
 * GET over HTTPS accepting the server's self-signed certificate, reporting its fingerprint. Used for
 * pairing (to show the server code) and, with `expect`, to refuse any other server.
 */
export function getJson<T>(url: string, opts: { expect?: string; timeoutMs?: number } = {}): Promise<{ data: T; fingerprint: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { rejectUnauthorized: false, timeout: opts.timeoutMs ?? 4000 }, (res) => {
      const fingerprint = normalizeFingerprint((res.socket as TLSSocket).getPeerCertificate()?.fingerprint256 ?? "");
      if (opts.expect && fingerprint !== opts.expect) {
        res.destroy();
        return reject(new Error("This isn't the server this desk was paired with (its security code changed)."));
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          if ((res.statusCode ?? 500) >= 400) throw new Error(`HTTP ${res.statusCode}`);
          resolve({ data: JSON.parse(body) as T, fingerprint });
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("No answer (timed out)")));
    req.on("error", reject);
    req.end();
  });
}

/** "192.168.1.10" or "https://pc-name:4870" → "https://192.168.1.10:4870" */
export function normalizeServerUrl(input: string, port = 4870): string {
  let s = input.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  const u = new URL(s);
  u.protocol = "https:";
  if (!u.port) u.port = String(port);
  return u.origin;
}

export async function probe(input: string): Promise<Probe> {
  let url: string;
  try {
    url = normalizeServerUrl(input);
  } catch {
    return { ok: false, url: input, error: "That doesn't look like a PC name or address" };
  }
  try {
    const { fingerprint } = await getJson<{ ok: boolean }>(`${url}/api/health`);
    const { data } = await getJson<{ name: string }>(`${url}/api/facility`);
    return { ok: true, url, fingerprint, serverCode: serverCode(fingerprint), name: data.name };
  } catch (e) {
    return { ok: false, url, error: (e as Error).message };
  }
}

/** IPv4 broadcast addresses of this PC's network adapters (plus the global one). */
function broadcastAddresses(): string[] {
  const out = new Set(["255.255.255.255"]);
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family !== "IPv4" || i.internal) continue;
      const ip = i.address.split(".").map(Number);
      const mask = i.netmask.split(".").map(Number);
      out.add(ip.map((b, k) => (b & mask[k]!) | (~mask[k]! & 255)).join("."));
    }
  }
  return [...out];
}

export interface FoundServer extends DiscoveryReply {
  address: string;
  url: string;
}

/** Broadcasts a probe and collects replies for `ms`. Firewalls may block this; typing the address always works. */
export function discover(ms = 2500): Promise<FoundServer[]> {
  return new Promise((resolve) => {
    const found = new Map<string, FoundServer>();
    const socket = createSocket({ type: "udp4", reuseAddr: true });
    socket.on("message", (msg, rinfo) => {
      try {
        const r = JSON.parse(msg.toString("utf8")) as DiscoveryReply;
        if (r.app !== "ojas" || r.v !== 1) return;
        found.set(r.fingerprint, { ...r, address: rinfo.address, url: `https://${rinfo.address}:${r.port}` });
      } catch { /* not ours */ }
    });
    socket.on("error", () => { /* e.g. no network: nothing found */ });
    socket.bind(0, () => {
      socket.setBroadcast(true);
      for (const addr of broadcastAddresses()) socket.send(DISCOVERY_PROBE, DISCOVERY_PORT, addr, () => {});
      // Also ask this PC itself (the server PC pairing its own desktop app, or loopback-only setups).
      socket.send(DISCOVERY_PROBE, DISCOVERY_PORT, "127.0.0.1", () => {});
    });
    setTimeout(() => {
      try { socket.close(); } catch { /* already closed */ }
      resolve([...found.values()]);
    }, ms);
  });
}
