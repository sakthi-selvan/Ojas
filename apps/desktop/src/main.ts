/**
 * HealthSuite desktop shell.
 *
 * Modes (from %ProgramData%\HealthSuite\desktop.json, written by the installer / first-run wizard):
 *   standalone: this PC is both server and client. The shell starts the bundled server and opens it.
 *   client:     this PC is a LAN terminal. The shell opens the hospital server's URL.
 * Dev:  HS_DEV_URL=http://127.0.0.1:5173 loads the Vite dev server (the server runs via `npm run dev`).
 *
 * The UI is the same web app in every mode, served by the HealthSuite server, so LAN terminals
 * always run the server's UI version and never fall out of step with it.
 */
import { app, BrowserWindow, ipcMain, shell, utilityProcess, dialog, type UtilityProcess } from "electron";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface DesktopConfig {
  mode: "standalone" | "client";
  /** Client mode: e.g. http://192.168.1.10:4870 */
  serverUrl?: string;
  port?: number;
}

const PROGRAM_DATA = join(process.env.PROGRAMDATA ?? app.getPath("userData"), "HealthSuite");

function loadConfig(): DesktopConfig {
  const file = join(PROGRAM_DATA, "desktop.json");
  try {
    if (existsSync(file)) return { mode: "standalone", ...JSON.parse(readFileSync(file, "utf8")) } as DesktopConfig;
  } catch (e) {
    dialog.showErrorBox("HealthSuite", `Settings file is damaged: ${file}\n\n${String(e)}\n\nStarting as a standalone system.`);
  }
  return { mode: "standalone" };
}

let server: UtilityProcess | undefined;
let win: BrowserWindow | undefined;

async function waitForHealth(base: string, timeoutMs = 60_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`HealthSuite server did not start within ${timeoutMs / 1000}s`);
}

/** Standalone: run the bundled server in an Electron utility process (no separate Node install needed). */
function startEmbeddedServer(port: number): void {
  const resources = app.isPackaged ? process.resourcesPath : join(__dirname, "..", "..");
  const entry = app.isPackaged ? join(resources, "server", "main.js") : join(resources, "server", "dist", "main.js");
  const webDir = app.isPackaged ? join(resources, "web") : join(resources, "web", "dist");
  const dataDir = process.env.HS_DATA_DIR ?? join(PROGRAM_DATA, "data", "db");
  mkdirSync(dataDir, { recursive: true });
  server = utilityProcess.fork(entry, [], {
    serviceName: "HealthSuite Server",
    stdio: "inherit",
    env: { ...process.env, HS_PORT: String(port), HS_HOST: "127.0.0.1", HS_DATA_DIR: dataDir, HS_WEB_DIR: webDir },
  });
  server.on("exit", (code) => {
    if (!quitting) dialog.showErrorBox("HealthSuite", `The local server stopped unexpectedly (code ${code}). Your saved data is safe. Please restart HealthSuite.`);
  });
}

async function resolveUrl(): Promise<string> {
  if (process.env.HS_DEV_URL) return process.env.HS_DEV_URL;
  const cfg = loadConfig();
  if (cfg.mode === "client") {
    if (!cfg.serverUrl) throw new Error("Client mode needs serverUrl in desktop.json");
    return cfg.serverUrl.replace(/\/$/, "");
  }
  const port = Number(process.env.HS_PORT ?? cfg.port ?? 4870);
  const base = `http://127.0.0.1:${port}`;
  startEmbeddedServer(port);
  await waitForHealth(base);
  return base;
}

function createWindow(url: string): void {
  const origin = new URL(url).origin;
  win = new BrowserWindow({
    width: 1366,
    height: 860,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    title: "HealthSuite",
    autoHideMenuBar: true,
    backgroundColor: "#0f1214",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.once("ready-to-show", () => {
    win?.maximize();
    win?.show();
  });

  // Security: the window may only show the HealthSuite server. Anything else opens in the normal browser.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/.test(target)) void shell.openExternal(target);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, target) => {
    if (new URL(target).origin !== origin) e.preventDefault();
  });

  // Reconnect screen if the LAN server is unreachable at launch.
  win.webContents.on("did-fail-load", (_e, _code, desc, failedUrl) => {
    if (new URL(failedUrl).origin !== origin) return;
    void win?.loadURL(
      "data:text/html;charset=utf-8," +
        encodeURIComponent(`<body style="font:16px Segoe UI;background:#0f1214;color:#eef1f4;display:grid;place-items:center;height:100vh;margin:0">
          <div style="max-width:480px;text-align:center"><h2>Can't reach the HealthSuite server</h2>
          <p style="color:#b8c0c8">${origin} (${desc}). Check that the server PC is switched on and this PC is on the same network.</p>
          <p style="color:#8f99a3">Retrying automatically…</p></div></body>`),
    );
    setTimeout(() => void win?.loadURL(url), 5_000);
  });

  void win.loadURL(url);
}

// Silent printing straight to the default printer: receipts and token slips need no dialog at the desk.
ipcMain.handle("hs:print", async (e, opts?: { silent?: boolean; deviceName?: string }) => {
  const wc = e.sender;
  return new Promise<{ ok: boolean; error?: string }>((resolve) =>
    wc.print({ silent: opts?.silent ?? true, printBackground: false, deviceName: opts?.deviceName }, (ok, error) => resolve({ ok, error })),
  );
});
ipcMain.handle("hs:printers", (e) => e.sender.getPrintersAsync());

let quitting = false;
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win?.isMinimized()) win.restore();
    win?.focus();
  });
  app.whenReady().then(async () => {
    try {
      createWindow(await resolveUrl());
    } catch (e) {
      dialog.showErrorBox("HealthSuite could not start", String(e instanceof Error ? e.message : e));
      app.quit();
    }
  });
  app.on("before-quit", () => {
    quitting = true;
    // Ask the server to flush and close the database cleanly; force-kill if it hangs.
    if (server) {
      server.postMessage("shutdown");
      setTimeout(() => server?.kill(), 5_000).unref();
    }
  });
  app.on("window-all-closed", () => app.quit());
}
