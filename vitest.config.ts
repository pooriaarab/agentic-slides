import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    {
      // Load a .ttf import as base64, as the bundler and the Worker do.
      name: "ttf-bytes",
      enforce: "pre",
      load(id) {
        if (!id.endsWith(".ttf")) return null;
        return `export default "${readFileSync(id).toString("base64")}";`;
      },
    },
  ],
  test: {
    include: ["src/**/*.test.ts", "ui/**/*.test.tsx"],
    environment: "node",
    // The E2E tests start the built CLI and MCP server as real processes.
    testTimeout: 60_000,
  },
});
