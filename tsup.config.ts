import { defineConfig } from "tsup";

export default defineConfig({
  // Named entries, so `ui/embed.tsx` lands next to the others as `dist/embed.js`.
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
    mcp: "src/mcp.ts",
    "mcp-bin": "src/mcp-bin.ts",
    worker: "src/worker.ts",
    "live-worker": "src/live-worker.ts",
    live: "src/live.ts",
    client: "src/client.ts",
    formats: "src/formats.ts",
    embed: "ui/embed.tsx",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  // The font files are bundled, so a Worker needs no file system.
  loader: { ".ttf": "binary", ".woff2": "file" },
});
