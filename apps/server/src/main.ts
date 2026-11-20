import { mkdirSync } from "node:fs";
import { loadConfig } from "./config.js";
import { openDb } from "./db/index.js";
import { ensureFacility, seedDemo } from "./db/seed.js";
import { buildApp } from "./app.js";

const config = loadConfig();
if (!config.dbUrl) mkdirSync(config.dataDir, { recursive: true });

const db = await openDb({ url: config.dbUrl, dataDir: config.dbUrl ? undefined : config.dataDir });
await ensureFacility(db);
// OJAS_DEMO=1 (npm run dev:demo) fills an empty database with a demo clinic and doctors.
if (process.env.OJAS_DEMO === "1") await seedDemo(db);
const app = await buildApp({ db, webDir: config.webDir, logger: true });

await app.listen({ port: config.port, host: config.host });
app.log.info(`Ojas server ready (${db.engine}) on http://${config.host}:${config.port}`);

// Graceful shutdown: PGlite must flush to disk, or the last writes could be lost on exit.
let closing = false;
const shutdown = async (signal: string) => {
  if (closing) return;
  closing = true;
  app.log.info(`${signal} received, shutting down`);
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
