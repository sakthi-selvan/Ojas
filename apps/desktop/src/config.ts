/**
 * How this PC uses Ojas. Read from %ProgramData%\Ojas\desktop.json (written by IT for every user
 * of the PC) or, failing that, from this Windows user's settings (written by the first-launch chooser).
 * A PC with the Ojas Server service installed is always in server mode.
 */
import { app } from "electron";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type DesktopConfig =
  | { mode: "standalone"; port?: number }
  /** This PC runs the Ojas Server service; the window connects to it locally. */
  | { mode: "server" }
  /** A desk on the clinic network, pinned to one server's certificate. */
  | { mode: "client"; serverUrl: string; fingerprint: string; serverName?: string };

export const PROGRAM_DATA = join(process.env.PROGRAMDATA ?? app.getPath("userData"), "Ojas");
const machineFile = join(PROGRAM_DATA, "desktop.json");
const userFile = () => join(app.getPath("userData"), "desktop.json");

export function loadConfig(): DesktopConfig | undefined {
  for (const file of [machineFile, userFile()]) {
    if (!existsSync(file)) continue;
    const cfg = JSON.parse(readFileSync(file, "utf8")) as DesktopConfig;
    if (cfg.mode === "client" && (!cfg.serverUrl || !cfg.fingerprint)) throw new Error(`${file}: client mode needs serverUrl and fingerprint`);
    return cfg;
  }
  return undefined;
}

export function saveConfig(cfg: DesktopConfig): void {
  const file = userFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(cfg, null, 2));
}

export const SERVICE_NAME = "OjasServer";

/** True when the Ojas Server Windows Service is installed on this PC. */
export function serviceInstalled(): Promise<boolean> {
  if (process.platform !== "win32") return Promise.resolve(false);
  return new Promise((resolve) => execFile("sc.exe", ["query", SERVICE_NAME], { windowsHide: true }, (err) => resolve(!err)));
}

/** Where the installed app keeps the service host (resources\service\OjasService.exe). */
export const serviceExe = () => join(process.resourcesPath, "service", "OjasService.exe");

/** The server certificate made by the service (readable by everyone; the private key is not). */
export const serverCertFile = join(PROGRAM_DATA, "tls", "cert.pem");
