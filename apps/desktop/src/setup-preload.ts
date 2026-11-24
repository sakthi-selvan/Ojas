import { contextBridge, ipcRenderer } from "electron";
import type { SetupApi } from "./setup-api";

/** Only for the local chooser page (setup.html); the main window never gets these. */
const api: SetupApi = {
  context: () => ipcRenderer.invoke("setup:context"),
  discover: () => ipcRenderer.invoke("setup:discover"),
  probe: (address) => ipcRenderer.invoke("setup:probe", address),
  useStandalone: () => ipcRenderer.invoke("setup:standalone"),
  useClient: (s) => ipcRenderer.invoke("setup:client", s),
  installServer: () => ipcRenderer.invoke("setup:install-server"),
  removeServer: () => ipcRenderer.invoke("setup:remove-server"),
  relaunch: () => ipcRenderer.invoke("setup:relaunch"),
};
contextBridge.exposeInMainWorld("ojasSetup", api);
