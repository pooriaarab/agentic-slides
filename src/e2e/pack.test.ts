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
  writeFileSync(join(project, "account.ts"), `import { slidesAccount, type SlidesAccountDeps } from "agentic-slides/account";
import { createAccountRegistry, type AccountPackage } from "agentic-identity/account";
const contributor: AccountPackage<SlidesAccountDeps> = slidesAccount;
export const compose = (deps: SlidesAccountDeps) => createAccountRegistry().register(contributor, deps);
`);
  execFileSync(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck", "--module", "NodeNext", "--target", "ES2022", "account.ts"], { cwd: project, stdio: "pipe" });
  writeFileSync(join(project, "account.mjs"), `import assert from "node:assert/strict";
import { slidesAccount } from "agentic-slides/account";
import { createMemoryStore, createSharing } from "agentic-identity";
import { createAccountRegistry } from "agentic-identity/account";
const store = createMemoryStore();
const owner = { id: "ana", kind: "human" };
const ctx = { principalId: owner.id, kind: owner.kind, chain: [owner], scopes: ["deck:admin"] };
const sharing = createSharing(store);
await sharing.createResource(ctx, { id: "mine", type: "deck" });
await sharing.createResource(ctx, { id: "shared", type: "deck" });
await sharing.grant(ctx, "shared", { id: "bo", kind: "human" }, "owner");
const deleted = [], rooms = [];
let fail = true;
const registry = createAccountRegistry().register(slidesAccount, { store,
  contentSource: { exportContent: async id => ({ id }), eraseContent: async id => {
    if (fail) { fail = false; throw new Error("retry"); }
    deleted.push(id);
  } }, live: { erase: async id => { rooms.push(id); } }
});
const out = await registry.export(owner);
assert.deepEqual(out.manifest.apps.map(app => app.id), ["slides"]);
assert.equal((await registry.erase(owner, store, { actor: null })).ok, false);
assert.equal((await registry.erase(owner, store, { actor: null })).ok, true);
assert.deepEqual(deleted, ["mine"]);
assert.deepEqual(rooms, ["mine"]);
assert.ok(await store.get("resources", "shared"));
assert.deepEqual((await registry.erase(owner, store, { actor: null })).counts.slides, { decks: 0, grants: 0, authored: 0 });
console.log("account registry passed");`);
  expect(execFileSync("node", ["account.mjs"], { cwd: project, encoding: "utf8" })).toContain("account registry passed");
  const result = JSON.parse(execFileSync("node", ["probe.mjs"], { cwd: project, encoding: "utf8" })) as { factory: string; status: number; body: { error: { code: string } } };
  expect(result.factory).toBe("function");
  expect(result.status).toBe(500);
  expect(result.body.error.code).toBe("MISCONFIGURED");
}, 180_000);
