import { mkdirSync } from "node:fs";
import { loadConfig } from "./config.js";
import { openDb } from "./db/index.js";
import { ensureFacility, seedDemo } from "./db/seed.js";
import { buildApp } from "./app.js";
import { ensureCertificate } from "./net/tls.js";
import { startDiscovery } from "./net/discovery.js";
import { APP_VERSION, DISCOVERY_PORT } from "@ojas/shared";

const config = loadConfig();
if (!config.dbUrl) mkdirSync(config.dataDir, { recursive: true });

const db = await openDb({ url: config.dbUrl, dataDir: config.dbUrl ? undefined : config.dataDir });
await ensureFacility(db);
// OJAS_DEMO=1 (npm run dev:demo) fills an empty database with a demo clinic and doctors.
if (process.env.OJAS_DEMO === "1") await seedDemo(db);
const tls = config.tls ? ensureCertificate(config.tlsDir, {
  // The service runs as SYSTEM; "OjasService.exe run" (testing, as a normal user) sets OJAS_RESTRICT_KEY=0.
  restrictKey: config.mode === "server" && process.env.OJAS_RESTRICT_KEY !== "0",
}) : undefined;
const app = await buildApp({
  db, webDir: config.webDir, logger: true, backupDir: config.backupDir,
  https: tls && { key: tls.key, cert: tls.cert },
  system: { mode: config.mode, port: config.port, serverCode: tls?.serverCode ?? null },
});
app.backups.start(); // scheduled backups, once the administrator has set them up

await app.listen({ port: config.port, host: config.host });
app.log.info(`Ojas server ready (${db.engine}, ${config.mode}) on ${tls ? "https" : "http"}://${config.host}:${config.port}`);
if (tls) app.log.info(`Server code: ${tls.serverCode}`);

const discovery = config.discovery && tls
  ? await startDiscovery({
      port: DISCOVERY_PORT,
      info: async () => ({
        app: "ojas", v: 1, name: (await db.query<{ name: string }>("select name from core.facility where id = 1")).rows[0]?.name ?? "",
        port: config.port, tls: true, fingerprint: tls.fingerprint, serverCode: tls.serverCode, version: APP_VERSION,
      }),
      onError: (e) => app.log.warn({ err: e }, "discovery"),
    }).catch((e: Error) => {
      app.log.warn({ err: e }, `Discovery is off (UDP ${DISCOVERY_PORT} unavailable); desks can still type this server's address`);
      return undefined;
    })
  : undefined;

// Graceful shutdown: PGlite must flush to disk, or the last writes could be lost on exit.
let closing = false;
const shutdown = async (signal: string) => {
  if (closing) return;
  closing = true;
  app.log.info(`${signal} received, shutting down`);
  app.backups.stop();
  discovery?.close();
  await app.close();
  await db.close();
  process.exit(0);
};
for (const s of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) process.on(s, () => void shutdown(s));
// The Electron shell asks the server to stop through IPC, because signals are unreliable on Windows.
// Electron utility process → process.parentPort; child_process.fork → process.on("message").
const parentPort = (process as unknown as { parentPort?: { on(ev: "message", fn: (e: { data: unknown }) => void): void } }).parentPort;
parentPort?.on("message", (e) => e.data === "shutdown" && void shutdown("ipc"));
process.on("message", (m) => m === "shutdown" && void shutdown("ipc"));
// Windows Service host: it can't send signals or IPC to a child, so it writes "shutdown" on stdin.
if (config.stdinControl) {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => String(d).includes("shutdown") && void shutdown("service"));
  process.stdin.on("end", () => void shutdown("service host gone"));
}
