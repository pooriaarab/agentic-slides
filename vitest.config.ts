import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // The E2E tests start the built CLI and MCP server as real processes.
    testTimeout: 60_000,
  },
});
