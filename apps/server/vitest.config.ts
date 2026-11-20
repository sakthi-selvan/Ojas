import { defineConfig } from "vitest/config";
// PGlite boots a WASM Postgres per test file; give it time on slower PCs.
export default defineConfig({ test: { hookTimeout: 60_000, testTimeout: 30_000 } });
