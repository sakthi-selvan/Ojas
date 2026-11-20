import { join } from "node:path";

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
  /** Built web UI to serve, so LAN browsers and token display screens need no install. */
  webDir?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.HS_PORT ?? 4870),
    host: env.HS_HOST ?? "127.0.0.1",
    dbUrl: env.HS_DB_URL || undefined,
    dataDir: env.HS_DATA_DIR ?? join(process.cwd(), ".data", "db"),
    webDir: env.HS_WEB_DIR || undefined,
  };
}
