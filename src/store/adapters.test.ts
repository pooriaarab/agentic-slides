// The adapters this package uses run the shared contract suites. Ways the deck layer can fail on them:
//  1. Two services on one store load the same deck, and one edit is lost.
//  2. A failed edit leaves a blob that no deck uses.
//  3. A transaction that runs again writes a blob twice, or fails on the second run.
//  4. A restart loses a committed edit, or brings back one that rolled back.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryBlobs, createMemoryStore } from "agentic-identity";
import { runBlobsContract, runStoreContract } from "agentic-identity/testing";
import { describe, expect, test } from "vitest";
import { createService } from "../service.js";
import { createFileBlobs, createFileStore } from "./file.js";

const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
const author = { kind: "agent" as const, name: "bot" };
const fresh = () => mkdtempSync(join(tmpdir(), "slides-store-"));

const shared = new Map<string, string>();
const dirFor = (name?: string) => (name === undefined ? fresh() : (shared.get(name) ?? shared.set(name, fresh()).get(name)!));

describe("memory adapters", () => {
  runStoreContract((options) => createMemoryStore(options));
  runBlobsContract((options) => createMemoryBlobs(options));
});
describe("file adapters", () => {
  runStoreContract((options) => createFileStore(dirFor(options.shared), options));
  runBlobsContract((options) => createFileBlobs(dirFor(options.shared), options));
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
