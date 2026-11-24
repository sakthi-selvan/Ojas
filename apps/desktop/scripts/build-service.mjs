// Compiles the Windows Service host with the C# compiler included in Windows (.NET Framework 4),
// so building needs no extra SDK and the installer ships no third-party service wrapper.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

if (process.platform !== "win32") {
  console.log("build-service: skipped (Windows only)");
  process.exit(0);
}
const csc = join(process.env.WINDIR ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
if (!existsSync(csc)) throw new Error(`C# compiler not found at ${csc} (.NET Framework 4 is part of Windows 10/11)`);
mkdirSync("dist/service", { recursive: true });
execFileSync(csc, [
  "/nologo", "/optimize+", "/target:exe", "/platform:anycpu",
  "/r:System.ServiceProcess.dll",
  // Absolute Windows paths: csc reads anything starting with "/" as an option.
  `/out:${resolve("dist/service/OjasService.exe")}`,
  resolve("service/OjasService.cs"),
], { stdio: "inherit" });
console.log("build-service: dist/service/OjasService.exe");
