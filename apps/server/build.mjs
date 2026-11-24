// Bundles the server into one file for the installer. Only PGlite stays external: it loads its
// WebAssembly and data files from its own package folder, which the installer ships beside main.js.
import { writeFile } from "node:fs/promises";
import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "dist/main.js",
  external: ["@electric-sql/pglite", "pg-native"],
  // Some bundled CommonJS packages call require(); give the ES module one.
  banner: { js: 'import { createRequire as __ojasRequire } from "node:module"; const require = __ojasRequire(import.meta.url);' },
  legalComments: "linked",
  logLevel: "warning",
});

// Marks main.js as an ES module for Node, so it loads without the reparse warning and slowdown.
await writeFile("dist/package.json", JSON.stringify({ type: "module" }) + "\n");
