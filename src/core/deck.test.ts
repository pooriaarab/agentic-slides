import { describe, expect, test } from "vitest";
import { Deck } from "./deck.js";
import { SlidesError, type Principal, type SlidesErrorCode } from "./principal.js";
import { compileOutline } from "./outline.js";

// Ways the ops can fail, written before the code. Each must throw a coded
// SlidesError and leave the deck as it was.
const human: Principal = { kind: "human", name: "ada" };
const agent: Principal = { kind: "agent", name: "bot" };

function codeOf(fn: () => unknown): SlidesErrorCode {
  try {
    fn();
  } catch (error) {
    if (error instanceof SlidesError) return error.code;
    throw error;
  }
  throw new Error("expected a SlidesError");
}

function sample(): { deck: Deck; ids: string[] } {
  const deck = Deck.create({ title: "Talk", author: human });
  const ids = deck.addSlidesFromOutline("# One\nbody\n---\n# Two\nbody\n---\n# Three\nbody", { author: human });
  return { deck, ids };
}

describe("author", () => {
  test.each([
    ["no author", undefined],
    ["unknown kind", { kind: "robot", name: "x" }],
    ["empty name", { kind: "human", name: " " }],
  ])("%s is refused by every op", (_label, bad) => {
    const { deck, ids } = sample();
    const before = deck.outline();
    const author = bad as unknown as Principal;
    const element = before.slides[0]!.elements[0]!.id;
    expect(codeOf(() => deck.addSlide({}, author))).toBe("INVALID_AUTHOR");
    expect(codeOf(() => deck.moveSlide(ids[0]!, 1, author))).toBe("INVALID_AUTHOR");
    expect(codeOf(() => deck.deleteSlide(ids[0]!, author))).toBe("INVALID_AUTHOR");
    expect(codeOf(() => deck.addSlidesFromOutline("# x", { author }))).toBe("INVALID_AUTHOR");
    expect(codeOf(() => deck.editElement(ids[0]!, element, { x: 5 }, author))).toBe("INVALID_AUTHOR");
    expect(deck.outline()).toEqual(before);
  });

  test("the author kind is kept on every edit and marks machine-made work", () => {
    const { deck, ids } = sample();
    expect(deck.outline().slides[0]).toMatchObject({ createdBy: human, editedBy: human, machineMade: false });
    const title = deck.outline().slides[0]!.elements.find((e) => e.kind === "text")!;
    deck.editElement(ids[0]!, title.id, { text: "Changed" }, agent);
    const slide = deck.outline().slides[0]!;
    expect(slide).toMatchObject({ editedBy: agent, machineMade: true });
    expect(slide.elements.find((e) => e.id === title.id)).toMatchObject({ createdBy: human, editedBy: agent, machineMade: true });
    expect(deck.outline().editedBy).toEqual(agent);
    deck.moveSlide(ids[2]!, 0, { kind: "user_token", name: "ada-via-tool" });
    expect(deck.outline().slides[0]).toMatchObject({ editedBy: { kind: "user_token" }, machineMade: true });
  });
});

describe("slide ops", () => {
  test("unknown slide id and out-of-range index", () => {
    const { deck } = sample();
    expect(codeOf(() => deck.deleteSlide("nope", human))).toBe("NO_SLIDE");
    expect(codeOf(() => deck.deleteSlide(9, human))).toBe("NO_SLIDE");
    expect(codeOf(() => deck.moveSlide(0, 3, human))).toBe("OUT_OF_RANGE");
    expect(codeOf(() => deck.moveSlide(0, -1, human))).toBe("OUT_OF_RANGE");
    expect(codeOf(() => deck.addSlide({ at: 4 }, human))).toBe("OUT_OF_RANGE");
    expect(codeOf(() => deck.addSlide({ layout: "zigzag" as never }, human))).toBe("UNKNOWN_LAYOUT");
    expect(deck.outline().slides).toHaveLength(3);
  });

  test("add, move, and delete keep order", () => {
    const { deck, ids } = sample();
    const added = deck.addSlide({ layout: "section", at: 1 }, agent);
    expect(deck.outline().slides.map((s) => s.id)).toEqual([ids[0], added, ids[1], ids[2]]);
    deck.moveSlide(added, 3, human);
    expect(deck.outline().slides.map((s) => s.id)).toEqual([ids[0], ids[1], ids[2], added]);
    deck.deleteSlide(ids[1]!, human);
    expect(deck.outline().slides.map((s) => s.index)).toEqual([1, 2, 3]);
    expect(deck.outline().slides.map((s) => s.title)).toEqual(["One", "Three", ""]);
  });

  test("setSlideFromOutline replaces content and refuses several slides", () => {
    const { deck, ids } = sample();
    deck.setSlideFromOutline(ids[1]!, "# Replaced\n- a\n> note", { author: agent });
    expect(deck.outline().slides[1]).toMatchObject({ id: ids[1], title: "Replaced", notes: "note", editedBy: agent });
    expect(codeOf(() => deck.setSlideFromOutline(ids[1]!, "# a\n---\n# b", { author: agent }))).toBe("OUTLINE_INVALID");
  });
});

describe("editElement", () => {
  function target() {
    const { deck, ids } = sample();
    const slide = deck.outline().slides[0]!;
    return { deck, slideId: ids[0]!, slide, text: slide.elements.find((e) => e.kind === "text")! };
  }

  test("unknown element, bounds, and wrong-kind fields", () => {
    const { deck, slideId, text } = target();
    expect(codeOf(() => deck.editElement(slideId, "nope", { x: 1 }, human))).toBe("NO_ELEMENT");
    for (const bad of [{ x: -1 }, { w: 0 }, { x: 1200, w: 100 }, { h: Number.NaN }, { y: 700, h: 40 }]) {
      expect(codeOf(() => deck.editElement(slideId, text.id, bad, human))).toBe("OUT_OF_BOUNDS");
    }
    expect(codeOf(() => deck.editElement(slideId, text.id, { alt: "x" }, human))).toBe("BAD_PATCH");
    expect(codeOf(() => deck.editElement(slideId, text.id, { fill: "accent" }, human))).toBe("BAD_PATCH");
    expect(codeOf(() => deck.editElement(slideId, text.id, { color: "pink" } as never, human))).toBe("BAD_PATCH");
    expect(codeOf(() => deck.editElement(slideId, text.id, { bogus: 1 } as never, human))).toBe("BAD_PATCH");
  });

  test("text that no longer fits is refused", () => {
    const { deck, slideId, text } = target();
    expect(codeOf(() => deck.editElement(slideId, text.id, { text: "word ".repeat(300) }, agent))).toBe("TEXT_OVERFLOW");
    expect(codeOf(() => deck.editElement(slideId, text.id, { fontSize: 200 }, agent))).toBe("TEXT_OVERFLOW");
  });

  test("a valid patch moves, resizes, and rewrites rich text", () => {
    const { deck, slideId, text } = target();
    deck.editElement(slideId, text.id, { x: 100, y: 120, text: "A **bold** claim" }, agent);
    const edited = deck.outline().slides[0]!.elements.find((e) => e.id === text.id);
    expect(edited).toMatchObject({ x: 100, y: 120, runs: [{ text: "A " }, { text: "bold", bold: true }, { text: " claim" }] });
  });
});

describe("theme", () => {
  test("a bad color or a remote font is refused", () => {
    const { deck } = sample();
    const theme = deck.outline().theme;
    expect(codeOf(() => deck.setTheme({ ...theme, colors: { ...theme.colors, accent: "red; x:url(//e.com)" } }, human))).toBe("BAD_THEME");
    expect(codeOf(() => deck.setTheme({ ...theme, fonts: { heading: "x}</style><script>", body: "Inter" } }, human))).toBe("BAD_THEME");
    const face = { family: "Inter", weight: 400, style: "normal" as const };
    for (const src of ["https://fonts.example.com/inter.woff2", "//cdn.example.com/a.woff2", "../x.woff2", "data:font/woff2;base64,AA"]) {
      expect(codeOf(() => deck.setTheme({ ...theme, fontFaces: [{ ...face, src }] }, human))).toBe("REMOTE_ASSET");
    }
    deck.setTheme({ ...theme, fontFaces: [{ ...face, src: "fonts/inter-400.woff2" }] }, human);
    expect(deck.outline().theme.fontFaces).toHaveLength(1);
  });
});

describe("sync", () => {
  test("concurrent edits converge and keep author kinds", () => {
    const { deck } = sample();
    const copy = Deck.fromUpdate(deck.encode());
    const [one, two] = deck.outline().slides;
    const text = (s: typeof one) => s!.elements.find((e) => e.kind === "text")!.id;
    deck.editElement(one!.id, text(one), { text: "from human" }, human);
    copy.editElement(two!.id, text(two), { text: "from agent" }, agent);
    deck.applyUpdate(copy.encode());
    copy.applyUpdate(deck.encode());
    expect(copy.outline()).toEqual(deck.outline());
    expect(deck.outline().slides.map((s) => s.editedBy.kind)).toEqual(["human", "agent", "human"]);
  });
});

// Two Y.Docs that start equal, edit apart, then exchange updates.
function pair() {
  const { deck, ids } = sample();
  const copy = Deck.fromUpdate(deck.encode());
  const sync = () => {
    deck.applyUpdate(copy.encode());
    copy.applyUpdate(deck.encode());
    expect(copy.outline()).toEqual(deck.outline());
    return deck.outline();
  };
  return { deck, copy, ids, sync };
}
const titleOf = (d: Deck, id: string) => d.outline().slides.find((s) => s.id === id)!.elements.find((e) => e.kind === "text")!;
const textOf = (d: Deck, id: string) => {
  const el = titleOf(d, id);
  return el.kind === "text" ? el.runs.map((r) => r.text).join("") : "";
};

describe("concurrent edits to one slide", () => {
  test("a rewrite of the same text by two writers keeps one of them, never both", () => {
    const { deck, copy, ids, sync } = pair();
    const el = titleOf(deck, ids[0]!);
    deck.editElement(ids[0]!, el.id, { text: "from human" }, human);
    copy.editElement(ids[0]!, el.id, { text: "from agent" }, agent);
    sync();
    expect(["from human", "from agent"]).toContain(textOf(deck, ids[0]!));
  });

  test("edits to different words of one text both survive", () => {
    const { deck, copy, ids, sync } = pair();
    const el = titleOf(deck, ids[0]!);
    deck.editElement(ids[0]!, el.id, { text: "Quarterly plan for launch" }, human);
    copy.applyUpdate(deck.encode());
    deck.editElement(ids[0]!, el.id, { text: "Annual plan for launch" }, human);
    copy.editElement(ids[0]!, el.id, { text: "Quarterly plan for release" }, agent);
    sync();
    expect(textOf(deck, ids[0]!)).toBe("Annual plan for release");
  });

  test("bold marks follow a text edit", () => {
    const { deck, ids } = pair();
    const el = titleOf(deck, ids[0]!);
    deck.editElement(ids[0]!, el.id, { text: "A **bold** claim" }, human);
    deck.editElement(ids[0]!, el.id, { text: "A claim, **bold**" }, human);
    expect(titleOf(deck, ids[0]!)).toMatchObject({ runs: [{ text: "A claim, " }, { text: "bold", bold: true }] });
  });

  test("two writers moving one slide leave one copy of it", () => {
    const { deck, copy, ids, sync } = pair();
    deck.moveSlide(ids[0]!, 2, human);
    copy.moveSlide(ids[0]!, 1, agent);
    const merged = sync();
    expect([...merged.slides.map((s) => s.id)].sort()).toEqual([...ids].sort());
    expect(merged.slides.map((s) => s.index)).toEqual([1, 2, 3]);
  });

  test("an edit made while another writer moves the slide is kept", () => {
    const { deck, copy, ids, sync } = pair();
    const el = titleOf(deck, ids[0]!);
    deck.moveSlide(ids[0]!, 2, human);
    copy.editElement(ids[0]!, el.id, { text: "kept" }, agent);
    const merged = sync();
    expect(merged.slides.map((s) => s.id)).toEqual([ids[1], ids[2], ids[0]]);
    expect(textOf(deck, ids[0]!)).toBe("kept");
  });

  test("a slide deleted by one writer and moved by another stays deleted", () => {
    const { deck, copy, ids, sync } = pair();
    deck.deleteSlide(ids[1]!, human);
    copy.moveSlide(ids[1]!, 0, agent);
    const merged = sync();
    expect(merged.slides.map((s) => s.id)).toEqual([ids[0], ids[2]]);
    expect(deck.addSlide({ at: 1 }, human)).toBeTruthy();
    expect(deck.outline().slides).toHaveLength(3);
  });

  test("speaker notes written by two writers keep one of them", () => {
    const { deck, copy, ids, sync } = pair();
    deck.setSlideFromOutline(ids[0]!, "# One\n> note by human", { author: human });
    copy.setSlideFromOutline(ids[0]!, "# One\n> note by agent", { author: agent });
    const merged = sync();
    expect(["note by human", "note by agent"]).toContain(merged.slides[0]!.notes);
  });
});

describe("bad data", () => {
  test("patch values of the wrong type are coded errors", () => {
    const { deck, ids } = sample();
    const el = titleOf(deck, ids[0]!);
    for (const bad of [{ text: 5 }, { alt: 5 }, { src: 5 }, { x: null }, { x: "5" }, null, [], "x"]) {
      expect(codeOf(() => deck.editElement(ids[0]!, el.id, bad as never, human))).toMatch(/BAD_PATCH|OUT_OF_BOUNDS/);
    }
  });

  test("an outline image named like an inherited property is missing, not a crash", () => {
    for (const path of ["constructor", "__proto__", "toString"]) {
      expect(() => compileOutline(`layout: image-right\n# a\n![x](${path})`, {})).toThrow(/was not found/);
    }
  });

  test("a doc from a peer with no author data reads as machine-made", () => {
    const { deck, ids } = sample();
    deck.doc.getMap("deck").delete("editedBy");
    const slide = (deck.doc.getMap("slides") as import("yjs").Map<import("yjs").Map<unknown>>).get(ids[0]!)!;
    slide.delete("createdBy");
    slide.delete("editedBy");
    const outline = deck.outline();
    expect(outline.machineMade).toBe(true);
    expect(outline.slides[0]).toMatchObject({ machineMade: true });
    expect(outline.slides[1]).toMatchObject({ machineMade: false });
  });
});
