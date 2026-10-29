import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

// The tests run against the real Worker under `wrangler dev`. Run `npm run build` first: the Worker serves dist/ui.
// The flows and the views each get their own Worker and their own state, so the empty deck list is really empty.
const PORT = Number(process.env.E2E_PORT ?? 18911);
// The runner makes the state folder once. Its workers read the same name from the environment. The teardown removes it.
process.env.E2E_STATE ??= mkdtempSync(join(tmpdir(), "slides-ui-"));
const state = process.env.E2E_STATE;
export const HUMAN = "human-token-0123456789-abcdefghij";
export const AGENT = "agent-token-0123456789-abcdefghij";
export const VIEWER = "viewer-token-0123456789-abcdefghij";
const tokens = `${HUMAN}=human:ada,${AGENT}=agent_of_human:bot,${VIEWER}=human:eve;viewer`;

const worker = (port: number) => ({
  command: `npx wrangler dev --port ${port} --ip 127.0.0.1 --inspector-port ${port + 1} --persist-to ${join(state, String(port))} --var SLIDES_REGION:unknown --var '${`SLIDES_TOKENS:${tokens}`}'`,
  url: `http://127.0.0.1:${port}/health`,
  reuseExistingServer: false,
  timeout: 120_000,
  env: { WRANGLER_SEND_METRICS: "false", CI: "1" },
});

export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  workers: 1,
  globalTeardown: "./e2e/teardown.ts",
  reporter: [["list"]],
  use: { viewport: { width: 1280, height: 800 }, screenshot: "off", trace: "off" },
  projects: [
    { name: "flows", testMatch: "flows.spec.ts", use: { baseURL: `http://127.0.0.1:${PORT}` } },
    { name: "views", testMatch: "views.spec.ts", use: { baseURL: `http://127.0.0.1:${PORT + 2}` } },
  ],
  webServer: [worker(PORT), worker(PORT + 2)],
});
