import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, expect, test } from "vitest";

// The packed package, installed in a fresh project, must expose `agentic-slides/worker`.
const root = mkdtempSync(join(tmpdir(), "slides-pack-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("agentic-slides/worker loads from a packed install and refuses a call with no database", () => {
  const packs = join(root, "pack");
  const project = join(root, "project");
  execFileSync("mkdir", ["-p", packs, project]);
  const out = execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", packs, "--json"], { cwd: resolve("."), encoding: "utf8" });
  const file = join(packs, (JSON.parse(out) as { filename: string }[])[0]!.filename);
  writeFileSync(join(project, "package.json"), '{"name":"probe","private":true,"type":"module"}');
  execFileSync("npm", ["install", file, "--no-audit", "--no-fund", "--prefer-offline"], { cwd: project, stdio: "pipe" });
  writeFileSync(
    join(project, "probe.mjs"),
    `import worker, { createWorker } from "agentic-slides/worker";
const res = await worker.fetch(new Request("http://x/api/v1/slides/decks"), {});
console.log(JSON.stringify({ factory: typeof createWorker, status: res.status, body: await res.json() }));`,
  );
  const result = JSON.parse(execFileSync("node", ["probe.mjs"], { cwd: project, encoding: "utf8" })) as { factory: string; status: number; body: { error: { code: string } } };
  expect(result.factory).toBe("function");
  expect(result.status).toBe(500);
  expect(result.body.error.code).toBe("MISCONFIGURED");
}, 180_000);
