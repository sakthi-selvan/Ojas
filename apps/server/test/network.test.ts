import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSocket } from "node:dgram";
import { request } from "node:https";
import type { AddressInfo } from "node:net";
import { DISCOVERY_PROBE, normalizeFingerprint, serverCode, type DiscoveryReply } from "@ojas/shared";
import { openDb } from "../src/db/index.js";
import { ensureFacility } from "../src/db/seed.js";
import { buildApp } from "../src/app.js";
import { ensureCertificate } from "../src/net/tls.js";
import { startDiscovery } from "../src/net/discovery.js";
import { ADMIN } from "./helpers.js";

const dir = mkdtempSync(join(tmpdir(), "ojas-net-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** An HTTPS request that accepts the self-signed certificate and reports its fingerprint, as a desk does. */
function get(url: string, opts: { method?: string; body?: object } = {}): Promise<{ status: number; fingerprint: string; setCookie: string[]; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = opts.body ? JSON.stringify(opts.body) : undefined;
    const req = request(url, {
      method: opts.method ?? "GET",
      rejectUnauthorized: false,
      headers: payload ? { "content-type": "application/json", "x-ojas-terminal": "T-test" } : {},
    }, (res) => {
      const fp = (res.socket as import("node:tls").TLSSocket).getPeerCertificate().fingerprint256;
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode!, fingerprint: normalizeFingerprint(fp), setCookie: [res.headers["set-cookie"] ?? []].flat(), body }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

describe("server certificate", () => {
  it("is made once and then reused (desks pin it)", () => {
    const a = ensureCertificate(join(dir, "tls"));
    const b = ensureCertificate(join(dir, "tls"));
    expect(a.fingerprint).toMatch(/^[0-9A-F]{64}$/);
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(a.serverCode).toBe(serverCode(a.fingerprint));
    expect(a.serverCode).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);
  });
});

describe("server mode over HTTPS", () => {
  it("serves the API with its certificate and marks the session cookie Secure", async () => {
    const tls = ensureCertificate(join(dir, "tls"));
    const db = await openDb({});
    await ensureFacility(db);
    const app = await buildApp({ db, https: { key: tls.key, cert: tls.cert }, system: { mode: "server", port: 0, serverCode: tls.serverCode } });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const base = `https://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    try {
      const health = await get(`${base}/api/health`);
      expect(health.status).toBe(200);
      expect(health.fingerprint).toBe(tls.fingerprint); // what a desk compares with its pinned value
      const setup = await get(`${base}/api/auth/setup`, { method: "POST", body: ADMIN });
      expect(setup.status).toBe(201);
      expect(setup.setCookie.join(";")).toMatch(/ojas_session=.*Secure/i);
    } finally {
      await app.close();
      await db.close();
    }
  });
});

describe("discovery", () => {
  it("answers a desk's probe with the clinic name and certificate fingerprint, and ignores anything else", async () => {
    const reply: DiscoveryReply = { app: "ojas", v: 1, name: "Sunrise Clinic", port: 4870, tls: true, fingerprint: "AB".repeat(32), serverCode: serverCode("AB".repeat(32)), version: "0.1.0" };
    const server = await startDiscovery({ port: 0, info: async () => reply });
    const port = server.address().port;
    const desk = createSocket("udp4");
    try {
      const got = await new Promise<DiscoveryReply>((resolve, reject) => {
        desk.on("message", (m) => resolve(JSON.parse(m.toString())));
        desk.send("hello", port, "127.0.0.1"); // ignored
        desk.send(DISCOVERY_PROBE, port, "127.0.0.1");
        setTimeout(() => reject(new Error("no reply")), 3000);
      });
      expect(got).toEqual(reply);
    } finally {
      desk.close();
      server.close();
    }
  });
});

describe("system info", () => {
  it("tells administrators the mode, addresses and server code", async () => {
    const db = await openDb({});
    await ensureFacility(db);
    const app = await buildApp({ db, system: { mode: "server", port: 4870, serverCode: "AAAA-BBBB-CCCC-DDDD" } });
    try {
      const { Client } = await import("./helpers.js");
      const admin = new Client(app);
      await admin.post("/api/auth/setup", ADMIN);
      const info = (await admin.get("/api/system/info")).json();
      expect(info).toMatchObject({ mode: "server", port: 4870, serverCode: "AAAA-BBBB-CCCC-DDDD", tls: false });
      expect(Array.isArray(info.addresses)).toBe(true);
      expect((await new Client(app).get("/api/system/info")).statusCode).toBe(401);
    } finally {
      await app.close();
      await db.close();
    }
  });
});
