/**
 * Ojas desktop shell.
 *
 * How this PC is used (see config.ts; chosen on first launch):
 *   standalone  this PC is both server and desk: the shell runs the bundled server on 127.0.0.1.
 *   server      the Ojas Server Windows Service runs the server (HTTPS) for the whole clinic; this
 *               window connects to it locally.
 *   client      a desk on the clinic network, pinned to the server's certificate fingerprint.
 * Dev: OJAS_DEV_URL=http://127.0.0.1:5173 loads the Vite dev server (`npm run dev` runs the server).
 *
 * The UI is the web app served by the Ojas server, so desks always run the server's UI version.
 */
import { app, BrowserWindow, dialog, ipcMain, session, shell, utilityProcess, type IpcMainInvokeEvent, type UtilityProcess } from "electron";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { DEFAULT_PORT, serverCode } from "@ojas/shared";
import { PROGRAM_DATA, loadConfig, saveConfig, serverCertFile, serviceExe, serviceInstalled, type DesktopConfig } from "./config";
import { discover, fingerprintOfPem, getJson, probe } from "./net";
import type { SetupContext } from "./setup-api";

let server: UtilityProcess | undefined;
let win: BrowserWindow | undefined;
let setupWin: BrowserWindow | undefined;
let quitting = false;

/** The one server certificate this app accepts (client and server modes). */
let pinned: { host: string; fingerprint: string } | undefined;

function pin(url: string, fingerprint: string) {
  pinned = { host: new URL(url).hostname, fingerprint };
  // Chromium (window, WebSocket) accepts exactly this certificate for this host and nothing else self-signed.
  session.defaultSession.setCertificateVerifyProc((req, cb) => {
    if (pinned && req.hostname === pinned.host) return cb(fingerprintOfPem(req.certificate.data) === pinned.fingerprint ? 0 : -2);
    cb(-3); // everything else: normal verification
  });
}

const lanAddresses = () =>
  Object.values(networkInterfaces()).flat().filter((i) => i && i.family === "IPv4" && !i.internal).map((i) => i!.address);

// ───────────────────────── Standalone: embedded server ─────────────────────────

async function waitForHealth(check: () => Promise<unknown>, timeoutMs = 60_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < until) {
    try {
      await check();
      return;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`The Ojas server did not answer within ${timeoutMs / 1000} s (${(last as Error)?.message ?? "no answer"})`);
}

function startEmbeddedServer(port: number): void {
  const resources = app.isPackaged ? process.resourcesPath : join(__dirname, "..", "..");
  const entry = app.isPackaged ? join(resources, "server", "main.js") : join(resources, "server", "dist", "main.js");
  const webDir = app.isPackaged ? join(resources, "web") : join(resources, "web", "dist");
  const dataDir = process.env.OJAS_DATA_DIR ?? join(PROGRAM_DATA, "data", "db");
  mkdirSync(dataDir, { recursive: true });
  server = utilityProcess.fork(entry, [], {
    serviceName: "Ojas Server",
    stdio: "inherit",
    env: { ...process.env, OJAS_MODE: "standalone", OJAS_PORT: String(port), OJAS_HOST: "127.0.0.1", OJAS_DATA_DIR: dataDir, OJAS_WEB_DIR: webDir },
  });
  server.on("exit", (code) => {
    if (!quitting) dialog.showErrorBox("Ojas", `The local server stopped unexpectedly (code ${code}). Your saved data is safe. Please restart Ojas.`);
  });
}

// ───────────────────────── Which URL to open ─────────────────────────

type Start = { url: string } | { setup: SetupContext["reason"] };

async function resolveStart(): Promise<Start> {
  if (process.env.OJAS_DEV_URL) return { url: process.env.OJAS_DEV_URL };

  if (await serviceInstalled()) {
    // This PC is the clinic's server: connect to the local service, pinned to its certificate.
    const url = `https://127.0.0.1:${DEFAULT_PORT}`;
    await waitForHealth(async () => {
      if (!existsSync(serverCertFile)) throw new Error("the server is still creating its certificate");
      const fp = fingerprintOfPem(readFileSync(serverCertFile, "utf8"));
      await getJson(`${url}/api/health`, { expect: fp });
      pin(url, fp);
    }, 90_000);
    return { url };
  }

  let cfg: DesktopConfig | undefined;
  try {
    cfg = loadConfig();
  } catch (e) {
    dialog.showErrorBox("Ojas", `This PC's Ojas settings are damaged:\n\n${(e as Error).message}\n\nPlease choose again.`);
  }
  if (!cfg) return { setup: "first-run" };
  if (cfg.mode === "server") return { setup: "first-run" }; // service was removed

  if (cfg.mode === "client") {
    pin(cfg.serverUrl, cfg.fingerprint);
    try {
      await getJson(`${cfg.serverUrl}/api/health`, { expect: cfg.fingerprint, timeoutMs: 5000 });
      return { url: cfg.serverUrl };
    } catch {
      // The server PC may have a new address (DHCP): look for the same certificate on the network.
      const moved = (await discover()).find((s) => s.fingerprint === cfg.fingerprint);
      if (moved) {
        saveConfig({ ...cfg, serverUrl: moved.url });
        pin(moved.url, cfg.fingerprint);
        return { url: moved.url };
      }
      return { setup: "unreachable" };
    }
  }

  const port = Number(process.env.OJAS_PORT ?? cfg.port ?? DEFAULT_PORT);
  const base = `http://127.0.0.1:${port}`;
  startEmbeddedServer(port);
  await waitForHealth(async () => {
    const r = await fetch(`${base}/api/health`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  });
  return { url: base };
}

// ───────────────────────── Windows ─────────────────────────

function createWindow(url: string): void {
  const origin = new URL(url).origin;
  win = new BrowserWindow({
    width: 1366,
    height: 860,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    title: "Ojas",
    autoHideMenuBar: true,
    backgroundColor: "#0f1214",
    webPreferences: { preload: join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  win.once("ready-to-show", () => {
    win?.maximize();
    win?.show();
  });

  // Security: the window may only show the Ojas server. Anything else opens in the normal browser.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/.test(target)) void shell.openExternal(target);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, target) => {
    if (new URL(target).origin !== origin) e.preventDefault();
  });

  // Lost the server while running: retry, and offer to find it again.
  win.webContents.on("did-fail-load", (_e, _code, desc, failedUrl, isMainFrame) => {
    if (!isMainFrame || new URL(failedUrl).origin !== origin) return;
    void win?.loadURL(
      "data:text/html;charset=utf-8," +
        encodeURIComponent(`<body style="font:16px Segoe UI;background:#0f1214;color:#eef1f4;display:grid;place-items:center;height:100vh;margin:0">
          <div style="max-width:520px;text-align:center"><h2>Can't reach the Ojas server</h2>
          <p style="color:#b8c0c8">${origin} (${desc}). Check that the server PC is switched on and this PC is on the same network.</p>
          <p style="color:#8f99a3">Retrying automatically…</p>
          <button onclick="window.ojas && window.ojas.changeConnection()" style="font:inherit;padding:8px 16px;border-radius:8px;border:1px solid #2c3338;background:#171b1e;color:#eef1f4;cursor:pointer">Find the server again</button></div></body>`),
    );
    setTimeout(() => void win?.loadURL(url), 5_000);
  });

  void win.loadURL(url);
}

function openSetup(reason: SetupContext["reason"]): void {
  if (setupWin) return void setupWin.focus();
  setupWin = new BrowserWindow({
    width: 940,
    height: 720,
    minWidth: 640,
    minHeight: 560,
    title: "Set up Ojas on this PC",
    autoHideMenuBar: true,
    backgroundColor: "#0f1214",
    webPreferences: { preload: join(__dirname, "setup-preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  setupReason = reason;
  setupWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  setupWin.webContents.on("will-navigate", (e) => e.preventDefault());
  setupWin.on("closed", () => {
    setupWin = undefined;
    if (!win) app.quit();
  });
  void setupWin.loadFile(join(__dirname, "setup.html"));
}

let setupReason: SetupContext["reason"] = "first-run";

const relaunch = () => {
  quitting = true;
  app.relaunch();
  app.exit(0);
};

// ───────────────────────── Chooser handlers (setup window only) ─────────────────────────

function fromSetup(e: IpcMainInvokeEvent) {
  if (!setupWin || e.sender !== setupWin.webContents) throw new Error("Not allowed");
}
const handle = (channel: string, fn: (...args: never[]) => unknown) =>
  ipcMain.handle(channel, (e, ...args) => {
    fromSetup(e);
    return (fn as (...a: unknown[]) => unknown)(...args);
  });

async function localServerInfo(): Promise<{ serverCode: string; addresses: string[] }> {
  const fp = fingerprintOfPem(readFileSync(serverCertFile, "utf8"));
  return { serverCode: serverCode(fp), addresses: lanAddresses() };
}

/** Runs the service host elevated (Windows shows the UAC prompt). */
function runServiceHostElevated(verb: "install" | "uninstall"): Promise<void> {
  const exe = serviceExe();
  if (!existsSync(exe)) return Promise.reject(new Error("The server component is missing. Reinstall Ojas."));
  const ps = `$p = Start-Process -FilePath '${exe.replace(/'/g, "''")}' -ArgumentList '${verb}' -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode`;
  return new Promise((resolve, reject) =>
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true }, (err, _out, stderr) => {
      if (!err) return resolve();
      const cancelled = /canceled by the user|cancelled by the user/i.test(stderr);
      reject(new Error(cancelled ? "Windows permission was not given." : `Exit code ${err.code}. ${stderr.trim().split("\n")[0] ?? ""}`));
    }),
  );
}

handle("setup:context", async (): Promise<SetupContext> => ({
  packaged: app.isPackaged,
  reason: setupReason,
  server: (await serviceInstalled()) && existsSync(serverCertFile) ? await localServerInfo() : undefined,
}));
handle("setup:discover", () => discover());
handle("setup:probe", (address: string) => probe(String(address)));
handle("setup:standalone", () => {
  saveConfig({ mode: "standalone" });
  relaunch();
  return { ok: true };
});
handle("setup:client", async (s: { url: string; fingerprint: string; name: string }) => {
  // Check again here rather than trusting the page: the server must still present the confirmed certificate.
  const p = await probe(s.url);
  if (!p.ok || p.fingerprint !== s.fingerprint) return { ok: false, error: p.error ?? "The server's code changed. Search again." };
  saveConfig({ mode: "client", serverUrl: p.url, fingerprint: p.fingerprint, serverName: p.name });
  relaunch();
  return { ok: true };
});
handle("setup:install-server", async () => {
  try {
    await runServiceHostElevated("install");
    await waitForHealth(async () => {
      if (!existsSync(serverCertFile)) throw new Error("creating certificate");
      await getJson(`https://127.0.0.1:${DEFAULT_PORT}/api/health`, { expect: fingerprintOfPem(readFileSync(serverCertFile, "utf8")) });
    }, 120_000);
    saveConfig({ mode: "server" });
    return { ok: true, ...(await localServerInfo()) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
});
handle("setup:remove-server", async () => {
  try {
    await runServiceHostElevated("uninstall");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
});
handle("setup:relaunch", () => relaunch());

// ───────────────────────── Main window bridge ─────────────────────────

// Silent printing straight to the default printer: receipts and token slips need no dialog at the desk.
ipcMain.handle("ojas:print", async (e, opts?: { silent?: boolean; deviceName?: string }) => {
  const wc = e.sender;
  return new Promise<{ ok: boolean; error?: string }>((resolve) =>
    wc.print({ silent: opts?.silent ?? true, printBackground: false, deviceName: opts?.deviceName }, (ok, error) => resolve({ ok, error })),
  );
});
ipcMain.handle("ojas:printers", (e) => e.sender.getPrintersAsync());
ipcMain.handle("ojas:change-connection", (e) => {
  if (!win || e.sender !== win.webContents) return;
  openSetup("changed");
});

// ───────────────────────── Lifecycle ─────────────────────────

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const w = setupWin ?? win;
    if (w?.isMinimized()) w.restore();
    w?.focus();
  });
  app.whenReady().then(async () => {
    try {
      const start = await resolveStart();
      if ("url" in start) createWindow(start.url);
      else openSetup(start.setup);
    } catch (e) {
      dialog.showErrorBox("Ojas could not start", String(e instanceof Error ? e.message : e));
      app.quit();
    }
  });
  app.on("before-quit", () => {
    quitting = true;
    // Ask the embedded server to flush and close the database cleanly; force-kill if it hangs.
    if (server) {
      server.postMessage("shutdown");
      setTimeout(() => server?.kill(), 5_000).unref();
    }
  });
  app.on("window-all-closed", () => app.quit());
}
