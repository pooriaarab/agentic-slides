import { PDFDocument, rgb, type PDFFont, type PDFImage } from "@cantoo/pdf-lib";
import * as fontkit from "@cantoo/fontkit";
import type { DeckOutline } from "../core/deck.js";
import { SLIDE_HEIGHT, SLIDE_WIDTH, TABLE_FONT_SIZE, checkTheme, type ColorToken } from "../core/layouts.js";
import { isBlobRef, type Element, type Run } from "../core/model.js";
import { fail } from "../core/principal.js";
import { NOTO_SANS } from "./fonts.js";
import { DEFAULT_LIMITS, checkDeckSize, tooManyPixels, type Limits } from "./limits.js";

type Face = "regular" | "bold" | "italic" | "boldItalic";
type Fonts = Record<Face, PDFFont>;
const faceOf = (bold: boolean | undefined, italic: boolean | undefined): Face => (bold ? (italic ? "boldItalic" : "bold") : italic ? "italic" : "regular");

interface Word {
  text: string;
  face: Face;
}

const FACES = ["regular", "bold", "italic", "boldItalic"] as const;
const metrics = new Map<Face, fontkit.Font>();
/** Width of text in a face, measured without embedding it. */
function widthOf(face: Face, text: string, size: number): number {
  let font = metrics.get(face);
  if (!font) metrics.set(face, (font = fontkit.create(NOTO_SANS[face]) as fontkit.Font));
  return (font.layout(text).glyphs.reduce((sum, g) => sum + g.advanceWidth, 0) * size) / font.unitsPerEm;
}

const LINE_HEIGHT = 1.3;
const ROW_HEIGHT = TABLE_FONT_SIZE * 2;

function hex(value: string) {
  const n = Number.parseInt(value.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/**
 * Draw the deck as a PDF, one 1280x720 page per slide, with no browser. Text uses the
 * Noto Sans, so Latin, Greek, and Cyrillic text draws. A character the font lacks becomes "?"
 * and comes back as a warning.
 * `images` holds the bytes of each `blob:` key. An image that is missing or cannot be decoded
 * becomes a placeholder and a warning. A deck over a limit is refused with EXPORT_LIMIT.
 */
export async function renderPdf(
  outline: DeckOutline,
  images: Map<string, Uint8Array>,
  options: { limits?: Partial<Limits>; now?: () => number } = {},
): Promise<{ bytes: Uint8Array; warnings: string[] }> {
  const limits: Limits = { ...DEFAULT_LIMITS, ...options.limits };
  const now = options.now ?? Date.now;
  const started = now();
  const tick = () => {
    if (now() - started > limits.maxMillis) fail("EXPORT_LIMIT", `the export took longer than ${limits.maxMillis} ms`);
  };
  checkDeckSize(outline, limits);
  const theme = checkTheme(outline.theme);
  const color = (token: ColorToken) => hex(theme.colors[token]);
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle(outline.title);
  doc.setCreator("agentic-slides");
  doc.setProducer("agentic-slides");
  doc.setCreationDate(new Date(0));
  doc.setModificationDate(new Date(0));
  if (outline.slides.some((s) => s.machineMade)) doc.setSubject("Includes machine-made content");
  // A fixed name keeps the bytes the same on every run. The default adds a random suffix.
  const embedFace = (bytes: Uint8Array, customName: string) => doc.embedFont(bytes, { subset: true, customName });
  const fonts: Partial<Fonts> = {};
  const covered = fontkit.create(NOTO_SANS.regular) as fontkit.Font;
  const warnings: string[] = [];
  const embedded = new Map<string, PDFImage | undefined>();
  let imageBytes = 0;

  /** Each image is embedded once, however many elements use it. */
  async function embed(src: string, slideNumber: number): Promise<PDFImage | undefined> {
    if (embedded.has(src)) return embedded.get(src);
    const bytes = isBlobRef(src) ? images.get(src) : undefined;
    let image: PDFImage | undefined;
    if (bytes) {
      imageBytes += bytes.length;
      if (imageBytes > limits.maxTotalImageBytes) fail("EXPORT_LIMIT", `the deck images are over ${limits.maxTotalImageBytes} bytes`, slideNumber);
      if (bytes.length > limits.maxImageBytes) fail("EXPORT_LIMIT", `an image is over ${limits.maxImageBytes} bytes`, slideNumber);
      if (tooManyPixels(bytes, limits)) fail("EXPORT_LIMIT", `an image is over ${limits.maxImagePixels} pixels`, slideNumber);
      image = await (bytes[0] === 0x89 ? doc.embedPng(bytes) : doc.embedJpg(bytes)).catch(() => undefined);
    }
    embedded.set(src, image);
    return image;
  }

  for (const slide of outline.slides) {
    tick();
    const page = doc.addPage([SLIDE_WIDTH, SLIDE_HEIGHT]);
    const lost = new Set<string>();
    // Drawing waits until the slide is laid out, so a face is embedded only when a glyph is drawn in it.
    const ops: Array<() => void> = [];
    const faces = new Set<Face>();
    const drawWord = (text: string, face: Face, options: { x: number; y: number; size: number; color: ReturnType<typeof hex> }) => {
      if (text === "") return;
      faces.add(face);
      ops.push(() => page.drawText(text, { ...options, font: fonts[face]! }));
    };
    let cut = 0;
    let missingImages = 0;
    const safe = (text: string): string =>
      [...text].map((ch) => {
        if (ch === " " || ch === "\n" || covered.hasGlyphForCodePoint(ch.codePointAt(0)!)) return ch;
        lost.add(ch);
        return "?";
      }).join("");
    const top = (y: number, h: number) => SLIDE_HEIGHT - y - h;
    page.drawRectangle({ x: 0, y: 0, width: SLIDE_WIDTH, height: SLIDE_HEIGHT, color: color("background") });

    const wrap = (runs: Run[], width: number, size: number, forceBold: boolean): Word[][] => {
      const lines: Word[][] = [];
      for (const paragraph of runs.map((r) => ({ ...r, text: safe(r.text) })).flatMap((r) => r.text.split("\n").map((part, i) => ({ r, part, fresh: i > 0 })))) {
        if (paragraph.fresh || lines.length === 0) lines.push([]);
        const face = faceOf(paragraph.r.bold || forceBold, paragraph.r.italic);
        for (const text of paragraph.part.split(/(?<=\s)/).filter(Boolean)) {
          const line = lines[lines.length - 1]!;
          const used = line.reduce((sum, w) => sum + widthOf(w.face, w.text, size), 0);
          if (line.length > 0 && used + widthOf(face, text.trimEnd(), size) > width) lines.push([{ text, face }]);
          else line.push({ text, face });
        }
      }
      return lines;
    };

    const drawText = (e: Extract<Element, { kind: "text" }>) => {
      const lines = wrap(e.runs, e.w - (e.list ? e.fontSize : 0), e.fontSize, e.slot === "title");
      const step = e.fontSize * LINE_HEIGHT;
      const allowed = Math.floor(e.h / step);
      cut += Math.max(0, lines.length - allowed);
      lines.slice(0, allowed).forEach((words, i) => {
        const baseline = top(e.y + i * step, 0) - e.fontSize;
        let x = e.x + (e.list ? e.fontSize : 0);
        if (e.list) drawWord("•", "regular", { x: e.x, y: baseline, size: e.fontSize, color: color(e.color) });
        for (const word of words) {
          drawWord(word.text, word.face, { x, y: baseline, size: e.fontSize, color: color(e.color) });
          x += widthOf(word.face, word.text, e.fontSize);
        }
      });
    };

    const drawTable = (e: Extract<Element, { kind: "table" }>) => {
      const columns = Math.max(1, ...e.rows.map((r) => r.length));
      const cell = e.w / columns;
      const allowed = Math.floor(e.h / ROW_HEIGHT);
      cut += Math.max(0, e.rows.length - allowed);
      e.rows.slice(0, allowed).forEach((row, r) => {
        row.forEach((text, c) => {
          const x = e.x + c * cell;
          const y = top(e.y + r * ROW_HEIGHT, ROW_HEIGHT);
          ops.push(() => page.drawRectangle({ x, y, width: cell, height: ROW_HEIGHT, borderColor: color("muted"), borderWidth: 1, ...(r === 0 ? { color: color("accent") } : {}) }));
          drawWord(safe(text), r === 0 ? "bold" : "regular", { x: x + 10, y: y + 15, size: TABLE_FONT_SIZE, color: color(r === 0 ? "accentText" : "text") });
        });
      });
    };

    const drawImage = async (e: Extract<Element, { kind: "image" }>) => {
      const image = await embed(e.src, slide.index);
      if (!image) {
        missingImages++;
        ops.push(() => page.drawRectangle({ x: e.x, y: top(e.y, e.h), width: e.w, height: e.h, color: color("surface"), borderColor: color("muted"), borderWidth: 2 }));
        return;
      }
      const scale = Math.min(e.w / image.width, e.h / image.height);
      const [w, h] = [image.width * scale, image.height * scale];
      ops.push(() => page.drawImage(image, { x: e.x + (e.w - w) / 2, y: top(e.y + (e.h - h) / 2, h), width: w, height: h }));
    };

    for (const e of slide.elements) {
      tick();
      if (e.kind === "shape") {
        const box = { color: color(e.fill) };
        if (e.shape === "ellipse") ops.push(() => page.drawEllipse({ x: e.x + e.w / 2, y: top(e.y, e.h) + e.h / 2, xScale: e.w / 2, yScale: e.h / 2, ...box }));
        else ops.push(() => page.drawRectangle({ x: e.x, y: top(e.y, e.h), width: e.w, height: e.h, ...box }));
      } else if (e.kind === "text") drawText(e);
      else if (e.kind === "table") drawTable(e);
      else await drawImage(e);
    }
    for (const face of FACES) if (faces.has(face) && !fonts[face]) fonts[face] = await embedFace(NOTO_SANS[face], `NotoSans-${face}`);
    for (const op of ops) op();
    if (cut > 0) warnings.push(`slide ${slide.index}: text cut to fit the box, ${cut} line(s) not drawn`);
    if (missingImages > 0) warnings.push(`slide ${slide.index}: image unavailable, drew a placeholder`);
    if (lost.size > 0) warnings.push(`slide ${slide.index}: replaced unsupported characters ${[...lost].map((c) => JSON.stringify(c)).join(" ")} with "?"`);
  }
  return { bytes: await doc.save({ useObjectStreams: false }), warnings };
}


