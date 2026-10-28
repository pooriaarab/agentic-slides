import { PDFDocument } from "@cantoo/pdf-lib";
import { describe, expect, test } from "vitest";
import { Deck, type DeckOutline } from "../core/deck.js";
import { SlidesError } from "../core/principal.js";
import { renderPdf } from "./pdf.js";

// Ways an export can hurt the host, written before the limits: too many slides or
// elements, one huge image, many big images, a slow export, and an image that is
// missing or broken. Each must refuse with a code or draw a placeholder and warn.
const author = { kind: "human" as const, name: "ada" };
const key = (n: number) => `blob:sha256-${n.toString(16).padStart(64, "0")}`;
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));

function pngHeader(width: number, height: number): Uint8Array {
  const data = new Uint8Array(33);
  data.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(data.buffer).setUint32(16, width);
  new DataView(data.buffer).setUint32(20, height);
  return data;
}
function jpegHeader(width: number, height: number): Uint8Array {
  const data = new Uint8Array(24);
  data.set([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8]);
  new DataView(data.buffer).setUint16(13, height);
  new DataView(data.buffer).setUint16(15, width);
  return data;
}

function deckOf(slides: number, ...keys: string[]): DeckOutline {
  const deck = Deck.create({ title: "Export", author });
  const images = Object.fromEntries(keys.map((k, i) => [`i${i}.png`, k]));
  const outline = Array.from({ length: slides }, (_, i) => `layout: image-right\n# S${i + 1}\n${keys.length ? `![pic](i${i % keys.length}.png)` : ""}`).join("\n---\n");
  deck.addSlidesFromOutline(outline, { author, images });
  return deck.outline();
}

const refused = async (promise: Promise<unknown>) => {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(SlidesError);
  return (error as SlidesError).code;
};

describe("resource limits", () => {
  test("one image used on many slides is embedded once", async () => {
    const images = (n: number) => renderPdf(deckOf(n, key(1)), new Map([[key(1), PNG]])).then((r) => Buffer.from(r.bytes).toString("latin1").match(/\/Subtype\s*\/Image/g)?.length);
    // The PNG has an alpha channel, so one embed is two image objects: the picture and its mask.
    expect(await images(1)).toBe(2);
    expect(await images(12)).toBe(2);
  });

  test("too many slides or elements are refused", async () => {
    expect(await refused(renderPdf(deckOf(4), new Map(), { limits: { maxSlides: 3 } }))).toBe("EXPORT_LIMIT");
    expect(await refused(renderPdf(deckOf(4), new Map(), { limits: { maxElements: 5 } }))).toBe("EXPORT_LIMIT");
  });

  test("an image with too many pixels is refused before it is decoded", async () => {
    for (const data of [pngHeader(20_000, 20_000), jpegHeader(30_000, 30_000)]) {
      expect(await refused(renderPdf(deckOf(1, key(2)), new Map([[key(2), data]])))).toBe("EXPORT_LIMIT");
    }
  });

  test("many images that add up to too many bytes are refused", async () => {
    const images = new Map([key(3), key(4)].map((k) => [k, pngHeader(1, 1)] as const));
    expect(await refused(renderPdf(deckOf(2, key(3), key(4)), images, { limits: { maxTotalImageBytes: 50 } }))).toBe("EXPORT_LIMIT");
  });

  test("a slow export stops with a code", async () => {
    let t = 0;
    expect(await refused(renderPdf(deckOf(5), new Map(), { limits: { maxMillis: 500 }, now: () => (t += 400) }))).toBe("EXPORT_LIMIT");
  });
});

describe("images that cannot be drawn", () => {
  test("a missing, remote, or broken image is a placeholder with a warning, and the other pages still draw", async () => {
    const outline = deckOf(3, key(5), key(6), key(7));
    const [, second] = outline.slides;
    const remote = second!.elements.find((e) => e.kind === "image")!;
    if (remote.kind === "image") remote.src = "https://cdn.example.com/x.png";
    const broken = pngHeader(10, 10);
    const { bytes, warnings } = await renderPdf(outline, new Map([[key(5), PNG], [key(7), broken]]));
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(3);
    expect(warnings).toEqual(["slide 2: image unavailable, drew a placeholder", "slide 3: image unavailable, drew a placeholder"]);
  });

  test("text that does not fit its box is reported", async () => {
    const deck = Deck.create({ title: "Wide", author });
    deck.addSlidesFromOutline(`# ${Array(4).fill("W".repeat(10)).join(" ")}`, { author });
    const { warnings } = await renderPdf(deck.outline(), new Map());
    expect(warnings.join(" ")).toMatch(/slide 1.*cut/);
  });
});
