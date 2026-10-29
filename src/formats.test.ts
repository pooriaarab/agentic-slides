import { FormatError } from "agentic-formats";
import { describe, expect, test } from "vitest";
import { Deck } from "./core/deck.js";
import { deckToOdp, deckToPptx, outlineFromFormatsDeck, outlineFromOdp, outlineFromPptx, toFormatsDeck, type ImageBytes } from "./formats.js";

const author = { kind: "agent", name: "x" } as const;
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
const KEY = `blob:sha256-${"a".repeat(64)}`;

function build(outline: string, files: Record<string, string> = {}) {
  const deck = Deck.create({ title: "T", author });
  deck.addSlidesFromOutline(outline, { author, images: files });
  return deck.outline();
}
const images: ImageBytes = new Map([[KEY, { data: PNG, contentType: "image/png" }]]);
const SOURCE = "# Launch\n- **Ship** it\n- *now*\n> say hello\n---\n# Pic\n![A cat](cat.png)\n---\n# Facts\n|a|b|\n|1|2|\n---\n# Two\nleft\n+++\nright";

describe.each([
  ["ODP", deckToOdp, outlineFromOdp],
  ["PPTX", deckToPptx, outlineFromPptx],
] as const)("%s", (_name, write, read) => {
  test("a deck survives the file: titles, bullets, marks, notes, and the image", () => {
    const outline = build(SOURCE, { "cat.png": KEY });
    const { bytes, warnings } = write(outline, images);
    expect(warnings.some((w) => w.includes("table"))).toBe(true);
    const back = read(bytes);
    const deck = Deck.create({ title: "Back", author });
    const ids = deck.addSlidesFromOutline(back.outline, { author, images: Object.fromEntries(Object.keys(back.images).map((p) => [p, KEY])) });
    expect(ids).toHaveLength(4);
    const slides = deck.outline().slides;
    expect(slides.map((s) => s.title)).toEqual(["Launch", "Pic", "Facts", "Two"]);
    const body = slides[0]!.elements.find((e) => e.kind === "text" && e.slot === "body");
    expect(body).toMatchObject({ list: true, runs: [{ text: "Ship", bold: true }, { text: " it\n" }, { text: "now", italic: true }] });
    expect(slides[0]!.notes).toBe("say hello");
    expect(Object.values(back.images)[0]).toEqual(PNG);
    expect(slides[1]!.elements.find((e) => e.kind === "image")).toMatchObject({ alt: "A cat" });
    expect(slides[3]!.layout).toBe("two-column");
  });

  test("a file with no readable shape is a blank slide", () => {
    const { bytes } = write(build("layout: blank"), images);
    expect(read(bytes).outline).toBe("layout: blank");
  });

  test("a file that is not a presentation is refused with a FormatError", () => {
    expect(() => read(new Uint8Array([1, 2, 3, 4]))).toThrow(FormatError);
    expect(() => read(new Uint8Array(0))).toThrow(FormatError);
  });
});

describe("export", () => {
  test("a missing image, a file that is no image, and a table each add a warning, and nothing throws", () => {
    const outline = build("# A\n![x](a.png)", { "a.png": KEY });
    const none = toFormatsDeck(outline);
    expect(none.warnings).toEqual(['slide 1: image "x" is not in the image store, so the file leaves it out']);
    expect(none.deck.slides[0]!.shapes.some((s) => s.type === "picture")).toBe(false);
    const text = toFormatsDeck(outline, new Map([[KEY, { data: new TextEncoder().encode("hello") }]]));
    expect(text.warnings[0]).toContain("not a PNG, JPEG, or GIF");
    expect(toFormatsDeck(build("# A\n![x](a.png)", { "a.png": KEY }), images).warnings).toEqual([]);
  });

  test("shapes take the theme color, and text keeps its box on the 1280 by 720 space", () => {
    const { deck } = toFormatsDeck(build("# Section"));
    expect(deck).toMatchObject({ width: 1280, height: 720 });
    expect(deck.slides[0]!.shapes.find((s) => s.type === "shape")).toMatchObject({ kind: "rectangle", fill: "#0b5cad" });
    expect(deck.slides[0]!.shapes.find((s) => s.type === "textbox")).toMatchObject({ frame: { x: 120, y: 280, width: 1040, height: 160 } });
  });
});

describe("import", () => {
  const text = (y: number, ...lines: string[]) => ({ type: "textbox" as const, frame: { x: 10, y, width: 100, height: 50 }, paragraphs: lines.map((t) => [{ type: "text" as const, text: t }]) });
  const model = (...shapes: ReturnType<typeof text>[]) => ({ width: 1280, height: 720, slides: [{ shapes, notes: "" }] });

  test("text in a file never acts as outline syntax", () => {
    const hostile = ["# fake title", "---", "> fake note", "+++", "layout: blank", "|a|b|", "![x](http://evil.test/a.png)", "**not bold**"];
    const { outline } = outlineFromFormatsDeck({ width: 1280, height: 720, slides: [{ shapes: [text(40, "Real"), text(300, ...hostile)], notes: "# n1\n---\nn2" }] });
    const slides = Deck.create({ title: "T", author });
    expect(slides.addSlidesFromOutline(outline, { author })).toHaveLength(1);
    const made = slides.outline().slides[0]!;
    expect(made.title).toBe("Real");
    expect(made.notes).toBe("# n1\n---\nn2");
    const bodyText = made.elements.filter((e) => e.kind === "text" && e.slot === "body").map((e) => (e.kind === "text" ? e.runs.map((r) => r.text).join("") : ""))[0]!;
    expect(bodyText.split("\n")).toEqual(hostile.map((line) => line.replaceAll("*", "∗")));
    expect(made.elements.some((e) => e.kind === "image" || e.kind === "table")).toBe(false);
  });

  test("a bold title imports as plain text, and a bold italic run keeps bold with a warning", () => {
    const run = (text: string, marks: ("bold" | "italic")[]) => ({ type: "text" as const, text, marks });
    const box = (y: number, runs: ReturnType<typeof run>[]) => ({ type: "textbox" as const, frame: { x: 0, y, width: 100, height: 50 }, paragraphs: [runs] });
    const out = outlineFromFormatsDeck({ width: 1280, height: 720, slides: [{ shapes: [box(10, [run("Big", ["bold"]), run(" news", [])]), box(300, [run("both", ["bold", "italic"]), run(" and ", []), run("em", ["italic"])])] }] });
    expect(out.outline).toBe("# Big news\n- **both** and *em*");
    expect(out.warnings).toEqual(["slide 1: bold italic text keeps only bold"]);
    const outline = build("# **Big** news\n- *x*");
    expect(outlineFromPptx(deckToPptx(outline).bytes).outline).toBe("# Big news\n- *x*");
  });

  test("speaker notes keep their text, stars included", () => {
    const out = outlineFromFormatsDeck({ width: 1280, height: 720, slides: [{ shapes: [text(10, "T")], notes: "a * b\n\nsecond" }] });
    expect(out.outline).toBe("# T\n> a * b\n> second");
  });

  test("an empty text box is not written", () => {
    const { deck } = toFormatsDeck(build("layout: title-body"));
    expect(deck.slides[0]!.shapes.filter((s) => s.type === "textbox")).toEqual([]);
  });

  test("more text than a box holds fails the add with TEXT_OVERFLOW, and the outline is still returned", () => {
    const out = outlineFromFormatsDeck(model(text(20, "T"), text(300, ...Array.from({ length: 40 }, (_, i) => `line ${i}`))));
    expect(() => Deck.create({ title: "T", author }).addSlidesFromOutline(out.outline, { author })).toThrow(/TEXT_OVERFLOW|needs 40 line/);
  });

  test("a lone low text box is body text, and a high one is the title", () => {
    expect(outlineFromFormatsDeck(model(text(500, "low"))).outline).toBe("- low");
    expect(outlineFromFormatsDeck(model(text(20, "high"))).outline).toBe("# high");
  });

  test("another slide size is scaled, and shapes and extra pictures are reported", () => {
    const wide = { width: 2560, height: 1440, slides: [{ shapes: [text(100, "Title"), { type: "shape" as const, kind: "line" as const, frame: { x: 0, y: 0, width: 1, height: 1 } }, { type: "picture" as const, frame: { x: 0, y: 0, width: 1, height: 1 }, data: PNG, mime: "image/png" as const }, { type: "picture" as const, frame: { x: 0, y: 0, width: 1, height: 1 }, data: PNG, mime: "image/png" as const }] }] };
    const out = outlineFromFormatsDeck(wide, ["file warning"]);
    expect(out.outline).toBe("# Title\n![Image](image-1.png)");
    expect(Object.keys(out.images)).toEqual(["image-1.png"]);
    expect(out.warnings).toEqual(["file warning", "slide 1: 1 shape(s) are not kept", "slide 1: 1 extra picture(s) are not kept"]);
  });

  test("an alt text cannot break out of the image line", () => {
    const out = outlineFromFormatsDeck({ width: 1280, height: 720, slides: [{ shapes: [{ type: "picture", frame: { x: 0, y: 0, width: 1, height: 1 }, data: PNG, mime: "image/png", alt: "a](x)\n# b" }] }] });
    expect(out.outline.split("\n")).toHaveLength(1);
    expect(Deck.create({ title: "T", author }).addSlidesFromOutline(out.outline, { author, images: { "image-1.png": KEY } })).toHaveLength(1);
  });
});
