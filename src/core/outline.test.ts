import { describe, expect, test } from "vitest";
import { Deck } from "./deck.js";
import { LAYOUT_NAMES } from "./layouts.js";
import { compileOutline } from "./outline.js";
import { SlidesError, type Principal } from "./principal.js";

// Failure modes of outline -> deck, written before the code. Each one must
// fail loudly with a code and the slide number, and must leave the deck as it was.
const agent: Principal = { kind: "agent_of_human", name: "writer-bot" };

function issues(text: string, images: Record<string, string> = {}) {
  try {
    compileOutline(text, images);
  } catch (error) {
    if (error instanceof SlidesError) return error.issues;
    throw error;
  }
  throw new Error("expected compileOutline to throw");
}

describe("outline failure modes", () => {
  test.each(["", "   \n\n", "---", "---\n---\n"])("empty outline %j is refused", (text) => {
    expect(issues(text).map((i) => i.code)).toEqual(["EMPTY_OUTLINE"]);
  });

  test("a blank slide between two others is refused with its number", () => {
    expect(issues("# One\n---\n\n---\n# Three")).toMatchObject([{ code: "EMPTY_SLIDE", slide: 2 }]);
  });

  test("an unknown layout names the valid layouts", () => {
    const found = issues("layout: zigzag\n# One\n---\nlayout: nope\n# Two");
    expect(found.map((i) => [i.code, i.slide])).toEqual([
      ["UNKNOWN_LAYOUT", 1],
      ["UNKNOWN_LAYOUT", 2],
    ]);
    for (const name of LAYOUT_NAMES) expect(found[0]!.message).toContain(name);
  });

  test("a title at the limit fits, one character more overflows", () => {
    expect(() => compileOutline(`layout: title-body\n# ${"x".repeat(46)}`)).not.toThrow();
    expect(issues(`layout: title-body\n# ${"x".repeat(47)}`)).toMatchObject([{ code: "TEXT_OVERFLOW", slide: 1 }]);
  });

  test("too many body lines overflow the box", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `- point ${i}`).join("\n");
    expect(issues(`# Long\n${lines}`)).toMatchObject([{ code: "TEXT_OVERFLOW", slide: 1 }]);
  });

  test("one long paragraph overflows by wrapped lines, not by line count", () => {
    expect(issues(`# Long\n${"word ".repeat(400)}`)).toMatchObject([{ code: "TEXT_OVERFLOW" }]);
  });

  test("a missing image is refused", () => {
    expect(issues("# Pic\n![A cat](cat.png)")).toMatchObject([{ code: "IMAGE_MISSING", slide: 1 }]);
  });

  test("a remote image is refused, never fetched", () => {
    expect(issues("# Pic\n![A cat](https://cdn.example.com/cat.png)")).toMatchObject([
      { code: "REMOTE_ASSET", slide: 1 },
    ]);
  });

  test("an image on a layout with no image slot is refused", () => {
    expect(issues("layout: title-body\n# Pic\n![A cat](cat.png)", { "cat.png": "blob:k" })).toMatchObject([
      { code: "NO_SLOT", slide: 1 },
    ]);
  });

  test("more columns than the layout holds is refused", () => {
    expect(issues("layout: title-body\n# Cols\none\n+++\ntwo")).toMatchObject([{ code: "NO_SLOT" }]);
  });

  test("a table that shares the body with text is refused", () => {
    expect(issues("# T\nsome text\n|a|b|\n|1|2|")).toMatchObject([{ code: "NO_SLOT" }]);
  });

  test("two titles on one slide are refused", () => {
    expect(issues("# One\n# Two")).toMatchObject([{ code: "OUTLINE_INVALID" }]);
  });

  test("every bad slide is reported, not only the first", () => {
    const found = issues("layout: zigzag\n# A\n---\n# B\n![x](nope.png)\n---\n# " + "y".repeat(80));
    expect(found.map((i) => i.slide)).toEqual([1, 2, 3]);
  });

  test("a failed outline leaves the deck unchanged", () => {
    const deck = Deck.create({ title: "Talk", author: agent });
    deck.addSlidesFromOutline("# Good", { author: agent });
    const before = deck.outline();
    expect(() => deck.addSlidesFromOutline("# Fine\n---\nlayout: zigzag\n# Bad", { author: agent })).toThrow(SlidesError);
    expect(deck.outline()).toEqual(before);
  });
});

describe("outline success", () => {
  test("builds title, bullets, notes, and rich text", () => {
    const [slide] = compileOutline("# Plan\n- **ship** it\n- *then* rest\n> say hello");
    expect(slide!.layout).toBe("title-body");
    expect(slide!.notes).toBe("say hello");
    const body = slide!.elements.find((e) => e.kind === "text" && e.slot === "body");
    expect(body).toMatchObject({ list: true, runs: [{ text: "ship", bold: true }, { text: " it\n" }, { text: "then", italic: true }, { text: " rest" }] });
  });

  test("builds a table and an image", () => {
    const [table, image] = compileOutline("# T\n|a|b|\n|1|2|\n---\n# I\n![A cat](cat.png)", { "cat.png": `blob:sha256-${"1".repeat(64)}` });
    expect(table!.elements.find((e) => e.kind === "table")).toMatchObject({ rows: [["a", "b"], ["1", "2"]] });
    expect(image!.layout).toBe("image-right");
    expect(image!.elements.find((e) => e.kind === "image")).toMatchObject({ src: `blob:sha256-${"1".repeat(64)}`, alt: "A cat" });
  });
});
