// The adapters this package uses run the shared contract suites. Ways the deck layer can fail on them:
//  1. Two services on one store load the same deck, and one edit is lost.
//  2. A failed edit leaves a blob that no deck uses.
//  3. A transaction that runs again writes a blob twice, or fails on the second run.
//  4. A restart loses a committed edit, or brings back one that rolled back.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryBlobs, createMemoryStore } from "agentic-identity";
import { runBlobsContract, runStoreContract } from "agentic-identity/testing";
import { describe, expect, test } from "vitest";
import { SlidesError } from "../core/principal.js";
import { createService } from "../service.js";
import { createFileBlobs, createFileStore } from "./file.js";

const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
const author = { kind: "agent" as const, name: "bot" };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const fresh = () => mkdtempSync(join(tmpdir(), "slides-store-"));

const shared = new Map<string, string>();
const dirFor = (name?: string) => (name === undefined ? fresh() : (shared.get(name) ?? shared.set(name, fresh()).get(name)!));

describe("memory adapters", () => {
  runStoreContract((options) => createMemoryStore(options));
  runBlobsContract((options) => createMemoryBlobs(options));
});
describe("file adapters", () => {
  runStoreContract((options) => createFileStore(dirFor(options.shared), options));
  runBlobsContract((options) => createFileBlobs(dirFor(options.shared), { urlBase: "https://files.test/blobs", urlSecret: "s".repeat(32), ...options }));
});

describe("the service on shared ports", () => {
  test("concurrent edits through two services on one store lose nothing", async () => {
    const store = createMemoryStore();
    const blobs = createMemoryBlobs();
    const [one, two] = [createService({ store, blobs }), createService({ store, blobs })];
    await one.create({ title: "Race", author, id: "race" });
    await Promise.all(Array.from({ length: 24 }, (_, i) => (i % 2 ? one : two).addSlides("race", { outline: `# S${i}`, author })));
    const titles = (await one.outline("race")).slides.map((s) => s.title).sort();
    expect(titles).toEqual(Array.from({ length: 24 }, (_, i) => `S${i}`).sort());
  });

  test("a failed edit stores no image and does not stop the next edit", async () => {
    const blobs = createMemoryBlobs();
    const service = createService({ store: createMemoryStore(), blobs });
    await service.create({ title: "T", author, id: "t" });
    const bad = await service.addSlides("t", { outline: "layout: zigzag\n# a\n![x](p.png)", images: { "p.png": PNG }, author }).catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(Error);
    await service.addSlides("t", { outline: "# ok", author });
    expect((await service.outline("t")).slides).toHaveLength(1);
    const stored = await service.addSlides("t", { outline: "# pic\n![x](p.png)", images: { "p.png": PNG }, author });
    expect(stored.slideIds).toHaveLength(1);
    // The same image twice is one blob, and the second write is a no-op.
    await service.addSlides("t", { outline: "# pic2\n![x](p.png)", images: { "p.png": PNG }, author });
    expect((await service.outline("t")).slides).toHaveLength(3);
  });

  test("edits and blobs survive a restart of the file adapters", async () => {
    const dir = fresh();
    const open = () => createService({ store: createFileStore(dir), blobs: createFileBlobs(dir) });
    const first = open();
    await first.create({ title: "Kept", author, id: "kept" });
    await first.addSlides("kept", { outline: "# One\n![x](p.png)", images: { "p.png": PNG }, author });
    const second = open();
    const outline = await second.outline("kept");
    expect(outline.slides).toHaveLength(1);
    expect(outline.slides[0]!.elements.some((e) => e.editedBy.kind === "agent" && e.machineMade)).toBe(true);
    expect((await second.exportPdf("kept")).warnings).toEqual([]);
  });
});

describe("the file store", () => {
  test("two stores on one folder make no stray temp file", async () => {
    const dir = fresh();
    const stores = [createFileStore(dir), createFileStore(dir)];
    await Promise.all(Array.from({ length: 40 }, (_, i) => stores[i % 2]!.put("decks", "same", { n: i })));
    expect(await stores[0]!.get("decks", "same")).toMatchObject({ n: expect.any(Number) });
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("the file adapters on a folder of version 0.8.0", () => {
  test("a store file in the old shape opens and keeps its docs", async () => {
    const dir = fresh();
    writeFileSync(join(dir, "store.json"), JSON.stringify({ clock: 2, tables: { decks: { a: { v: 1, doc: { n: 1 } }, b: { v: 2, doc: { n: 2 } } } } }));
    const store = createFileStore(dir);
    expect(await store.get("decks", "a")).toEqual({ n: 1 });
    await store.put("decks", "c", { n: 3 });
    const again = createFileStore(dir);
    expect(await again.get("decks", "b")).toEqual({ n: 2 });
    expect(await again.get("decks", "c")).toEqual({ n: 3 });
    expect(JSON.parse(readFileSync(join(dir, "store.json"), "utf8")).format).toBe(1);
  });

  test("a blob in the old layout is found under its key, with its type", async () => {
    const dir = fresh();
    const key = `sha256-${createHash("sha256").update(PNG).digest("hex")}`;
    const old = join(dir, "blobs", createHash("sha256").update(key).digest("hex"));
    mkdirSync(join(dir, "blobs"));
    writeFileSync(old, PNG);
    writeFileSync(`${old}.type`, "image/png");
    const blobs = createFileBlobs(dir);
    expect((await blobs.head(key))?.contentType).toBe("image/png");
    expect(Array.from((await blobs.get(key))!.data)).toEqual(Array.from(PNG));
    expect(readdirSync(join(dir, "blobs")).filter((name) => !name.endsWith(".blob"))).toEqual([]);
  });
});

describe("the old blob files", () => {
  test("a file whose name does not match its bytes stays in place and the other blobs still work", async () => {
    const dir = fresh();
    mkdirSync(join(dir, "blobs"));
    const odd = join(dir, "blobs", createHash("sha256").update("sha256-aaaa").digest("hex"));
    writeFileSync(odd, "truncated");
    const blobs = createFileBlobs(dir);
    expect(await blobs.head("sha256-aaaa")).toBeNull();
    expect(readFileSync(odd, "utf8")).toBe("truncated");
    await blobs.put("k", PNG, { contentType: "image/png" });
    expect((await blobs.head("k"))?.contentType).toBe("image/png");
  });
});

describe("the file store lock", () => {
  async function withLock(age: number, waitMs?: number) {
    const dir = fresh();
    const service = createService({ store: createFileStore(dir, { waitMs }), blobs: createFileBlobs(dir) });
    await service.create({ title: "Locked", author, id: "locked" });
    const lock = join(dir, "store.json.lock");
    writeFileSync(lock, "someone else");
    const when = new Date(Date.now() - age);
    utimesSync(lock, when, when);
    return { service, dir };
  }

  test("a lock that a dead process left behind is taken over", async () => {
    const { service } = await withLock(10 * 60_000);
    await service.addSlides("locked", { outline: "# Ok", author });
    expect((await service.outline("locked")).slides).toHaveLength(1);
  });

  test("a lock that its owner keeps alive makes the edit fail with STORE_BUSY and change nothing", async () => {
    const { service, dir } = await withLock(10 * 60_000, 300);
    const lock = join(dir, "store.json.lock");
    // A second process renews the lock, as a live writer does, for longer than the adapter waits.
    const holder = spawn(process.execPath, ["-e", `const fs=require("fs");const end=Date.now()+9000;const t=setInterval(()=>{const n=new Date();fs.writeFileSync(process.argv[1],"live");fs.utimesSync(process.argv[1],n,n);if(Date.now()>end){clearInterval(t);fs.unlinkSync(process.argv[1])}},200)`, lock], { stdio: "ignore" });
    try {
      for (let i = 0; i < 100 && !(existsSync(lock) && readFileSync(lock, "utf8") === "live"); i++) await sleep(50);
      const error = await service.addSlides("locked", { outline: "# No", author }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SlidesError);
      expect((error as SlidesError).code).toBe("STORE_BUSY");
    } finally {
      holder.kill();
      rmSync(lock, { force: true });
    }
    expect((await service.outline("locked")).slides).toHaveLength(0);
  }, 30_000);
});
