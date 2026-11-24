import { dirname, join, resolve } from "node:path";
import { DEFAULT_PORT } from "@ojas/shared";

/**
 * Configuration comes from environment variables. The Windows Service installer writes these;
 * in standalone mode the Electron shell sets them when it starts the server.
 */
export interface Config {
  port: number;
  /** 127.0.0.1 = standalone (this PC only); 0.0.0.0 = LAN server. */
  host: string;
  /** postgres://... for LAN deployments. When empty, the embedded PGlite database is used. */
  dbUrl?: string;
  /** Folder for the embedded database. */
  dataDir: string;
  /** Default backup folder (the administrator can choose another, plus a second copy). */
  backupDir: string;
  /** standalone = this PC only (127.0.0.1, http); server = the clinic's server (Windows Service, https). */
  mode: "standalone" | "server";
  /** Serve HTTPS with the server's own certificate (server mode). */
  tls: boolean;
  tlsDir: string;
  /** Answer desks looking for the server on the network (UDP broadcast). */
  discovery: boolean;
  /** The Windows Service host sends "shutdown" on stdin to stop the server cleanly. */
  stdinControl: boolean;
  /** Built web UI to serve, so LAN browsers and token display screens need no install. */
  webDir?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = resolve(env.OJAS_DATA_DIR ?? join(process.cwd(), ".data", "db"));
  return {
    port: Number(env.OJAS_PORT ?? DEFAULT_PORT),
    host: env.OJAS_HOST ?? "127.0.0.1",
    dbUrl: env.OJAS_DB_URL || undefined,
    // Paths may be relative in a hand-written service config; resolve them against the working folder.
    dataDir,
    backupDir: resolve(env.OJAS_BACKUP_DIR ?? join(dirname(dataDir), "backups")),
    mode: env.OJAS_MODE === "server" ? "server" : "standalone",
    tls: env.OJAS_TLS === "1",
    tlsDir: resolve(env.OJAS_TLS_DIR ?? join(dirname(dataDir), "tls")),
    discovery: env.OJAS_DISCOVERY === "1",
    stdinControl: env.OJAS_STDIN_CONTROL === "1",
    webDir: env.OJAS_WEB_DIR ? resolve(env.OJAS_WEB_DIR) : undefined,
  };
}
