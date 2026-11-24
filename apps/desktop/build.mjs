// Builds the desktop shell: main process, the two preloads, and the first-launch chooser page.
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

const common = { bundle: true, platform: "node", target: "node22", external: ["electron"], logLevel: "warning" };
mkdirSync("dist", { recursive: true });
await Promise.all([
  build({ ...common, entryPoints: ["src/main.ts"], format: "cjs", outfile: "dist/main.cjs" }),
  build({ ...common, entryPoints: ["src/preload.ts"], format: "cjs", outfile: "dist/preload.cjs" }),
  build({ ...common, entryPoints: ["src/setup-preload.ts"], format: "cjs", outfile: "dist/setup-preload.cjs" }),
  build({ entryPoints: ["src/setup-page.ts"], bundle: true, platform: "browser", target: "chrome130", format: "iife", outfile: "dist/setup.js", logLevel: "warning" }),
]);
copyFileSync("src/setup.html", "dist/setup.html");
