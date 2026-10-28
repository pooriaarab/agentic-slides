import { mkdtempSync, mkdirSync, utimesSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { SlidesError } from "../core/principal.js";
import { createService } from "../service.js";
import { FileBlobs, FileStore } from "./file.js";

// Ways the file store can lose data, written before the guard: two writers that
// load the same deck, two writes that share a temp name, a lock that never
// frees, and a lock that is held for real.
const author = { kind: "agent" as const, name: "bot" };
const root = () => mkdtempSync(join(tmpdir(), "slides-file-"));
const open = (dir: string, options?: { lockTimeoutMs?: number }) => createService({ store: new FileStore(dir, options), blobs: new FileBlobs(dir) });

describe("two instances on one directory", () => {
  test("concurrent edits through both lose nothing", async () => {
    const dir = root();
    const [one, two] = [open(dir), open(dir)];
    await one.create({ title: "Race", author, id: "race" });
    await Promise.all(Array.from({ length: 24 }, (_, i) => (i % 2 ? one : two).addSlides("race", { outline: `# S${i}`, author })));
    const titles = (await one.outline("race")).slides.map((s) => s.title).sort();
    expect(titles).toEqual(Array.from({ length: 24 }, (_, i) => `S${i}`).sort());
  });

  test("concurrent puts of one key do not fail on a shared temp file", async () => {
    const dir = root();
    const stores = [new FileStore(dir), new FileStore(dir)];
    await Promise.all(Array.from({ length: 40 }, (_, i) => stores[i % 2]!.put("decks", "same", { n: i })));
    expect(await stores[0]!.get("decks", "same")).toMatchObject({ n: expect.any(Number) });
    expect(readdirSync(join(dir, "store", "decks")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("the lock", () => {
  async function withLock(age: number, options?: { lockTimeoutMs?: number }) {
    const dir = root();
    const service = open(dir, options);
    await service.create({ title: "Locked", author, id: "locked" });
    const lock = join(dir, "store", "decks", "locked.json.lock");
    writeFileSync(lock, "someone else");
    const when = new Date(Date.now() - age);
    utimesSync(lock, when, when);
    return { service };
  }

  test("a lock that a dead process left behind is taken over", async () => {
    const { service } = await withLock(10 * 60_000);
    await service.addSlides("locked", { outline: "# Ok", author });
    expect((await service.outline("locked")).slides).toHaveLength(1);
  });

  test("a live lock is waited for, then the edit fails with a code and changes nothing", async () => {
    const { service } = await withLock(0, { lockTimeoutMs: 300 });
    const error = await service.addSlides("locked", { outline: "# No", author }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SlidesError);
    expect((error as SlidesError).code).toBe("STORE_BUSY");
    expect((await service.outline("locked").catch(() => ({ slides: [] }))).slides).toHaveLength(0);
  });
});

mkdirSync(tmpdir(), { recursive: true });
