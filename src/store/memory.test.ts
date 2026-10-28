import { describe, expect, test } from "vitest";
import { createService } from "../service.js";
import { MemoryBlobs, MemoryStore } from "./memory.js";

// Two requests in one isolate interleave at every await. Two services share one store.
describe("the memory store", () => {
  test("concurrent edits through two services lose nothing", async () => {
    const store = new MemoryStore();
    const blobs = new MemoryBlobs();
    const [one, two] = [createService({ store, blobs }), createService({ store, blobs })];
    const author = { kind: "agent" as const, name: "bot" };
    await one.create({ title: "Race", author, id: "race" });
    await Promise.all(Array.from({ length: 24 }, (_, i) => (i % 2 ? one : two).addSlides("race", { outline: `# S${i}`, author })));
    const titles = (await one.outline("race")).slides.map((s) => s.title).sort();
    expect(titles).toEqual(Array.from({ length: 24 }, (_, i) => `S${i}`).sort());
  });

  test("a failed edit does not stop the next one", async () => {
    const store = new MemoryStore();
    const service = createService({ store, blobs: new MemoryBlobs() });
    const author = { kind: "agent" as const, name: "bot" };
    await service.create({ title: "T", author, id: "t" });
    await service.addSlides("t", { outline: "layout: zigzag\n# a", author }).catch(() => undefined);
    await service.addSlides("t", { outline: "# ok", author });
    expect((await service.outline("t")).slides).toHaveLength(1);
  });
});
