import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/cli.ts",
    "src/mcp.ts",
    "src/mcp-bin.ts",
    "src/worker.ts",
    "src/live-worker.ts",
  ],
  format: ["esm"],
  dts: true,
  clean: true,
  // The font files are bundled, so a Worker needs no file system.
  loader: { ".ttf": "binary" },
});
