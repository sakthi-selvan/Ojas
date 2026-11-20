import { contextBridge, ipcRenderer } from "electron";

/**
 * The only bridge between the web UI and the PC. Deliberately tiny: the UI can print and list
 * printers, nothing else (no file system, no shell). Hardware access grows here one audited
 * capability at a time (cash drawer, label printer, serial analyzers).
 */
contextBridge.exposeInMainWorld("healthsuite", {
  desktop: true,
  print: (opts?: { silent?: boolean; deviceName?: string }) => ipcRenderer.invoke("hs:print", opts),
  printers: () => ipcRenderer.invoke("hs:printers"),
});
