import { readOdp, readPptx, sniffImage, writeOdp, writePptx, type Deck as FormatsDeck, type Slide, type SlideShape, type TextBox, type TextRun } from "agentic-formats";
import type { DeckOutline } from "./core/deck.js";
import { SLIDE_HEIGHT, SLIDE_WIDTH } from "./core/layouts.js";
import { isBlobRef, type Element } from "./core/model.js";

/**
 * Map a deck to and from ODP and PPTX. The file code is in `agentic-formats`, so this file holds only the mapping.
 * `agentic-formats` throws a `FormatError` for a file that is not safe or not valid. Each result lists in `warnings` what the other side could not hold.
 */

/** The bytes of each image that a deck uses, by blob ref (`blob:sha256-...`). The service reads them from the blob store. */
export type ImageBytes = ReadonlyMap<string, { data: Uint8Array; contentType?: string }>;

export interface ExportedFile {
  bytes: Uint8Array;
  warnings: string[];
}

/** What an imported file gives. `outline` is outline text. Add it with `Deck.addSlidesFromOutline` and map each key of `images` to a blob ref. */
export interface ImportedDeck {
  outline: string;
  /** Image files by the path that the outline names. */
  images: Record<string, Uint8Array>;
  warnings: string[];
}

const BULLET = "• ";

/** The neutral deck for a deck outline. A table becomes text and a missing image is left out: each one adds a warning. */
export function toFormatsDeck(outline: DeckOutline, images: ImageBytes = new Map()): { deck: FormatsDeck; warnings: string[] } {
  const warnings: string[] = [];
  const slides = outline.slides.map((slide): Slide => {
    const shapes: SlideShape[] = [];
    for (const el of slide.elements) {
      const shape = shapeOf(el, outline, images, (message) => warnings.push(`slide ${slide.index}: ${message}`));
      if (shape) shapes.push(shape);
    }
    return { shapes, ...(slide.notes ? { notes: slide.notes } : {}) };
  });
  return { deck: { width: SLIDE_WIDTH, height: SLIDE_HEIGHT, slides }, warnings };
}

function shapeOf(el: Element, outline: DeckOutline, images: ImageBytes, warn: (message: string) => void): SlideShape | undefined {
  const frame = { x: el.x, y: el.y, width: el.w, height: el.h };
  if (el.kind === "shape") return { type: "shape", kind: el.shape === "rect" ? "rectangle" : "ellipse", frame, fill: outline.theme.colors[el.fill] };
  if (el.kind === "image") {
    const image = isBlobRef(el.src) ? images.get(el.src) : undefined;
    const sniffed = image && sniffImage(image.data);
    if (!image || !sniffed) return void warn(`image "${el.alt}" is ${image ? "not a PNG, JPEG, or GIF file" : "not in the image store"}, so the file leaves it out`);
    return { type: "picture", frame, data: image.data, mime: sniffed.mime, alt: el.alt };
  }
  if (el.kind === "table") {
    warn("a table is written as text, one line for each row");
    return { type: "textbox", frame, paragraphs: el.rows.map((row) => [{ type: "text", text: row.join("  |  ") }]) };
  }
  if (el.runs.every((run) => run.text.trim() === "")) return;
  const runs: TextRun[][] = [[]];
  for (const run of el.runs) {
    run.text.split("\n").forEach((part, i) => {
      if (i > 0) runs.push([]);
      if (part !== "") runs[runs.length - 1]!.push({ type: "text", text: part, ...(run.bold || run.italic ? { marks: [...(run.bold ? ["bold" as const] : []), ...(run.italic ? ["italic" as const] : [])] } : {}) });
    });
  }
  const paragraphs = el.list ? runs.map((p) => [{ type: "text" as const, text: BULLET }, ...p]) : runs;
  return { type: "textbox", frame, paragraphs };
}

/** The deck as an OpenDocument presentation. */
export function deckToOdp(outline: DeckOutline, images?: ImageBytes): ExportedFile {
  const { deck, warnings } = toFormatsDeck(outline, images);
  const written = writeOdp(deck);
  return { bytes: written.bytes, warnings: [...warnings, ...written.warnings] };
}

/** The deck as a PowerPoint file. */
export function deckToPptx(outline: DeckOutline, images?: ImageBytes): ExportedFile {
  const { deck, warnings } = toFormatsDeck(outline, images);
  const written = writePptx(deck);
  return { bytes: written.bytes, warnings: [...warnings, ...written.warnings] };
}

/** The text of one paragraph, with `**` and `*` marks. An outline has no escape, so a literal star becomes the asterisk operator (U+2217). A run that is bold and italic keeps only bold: an outline has no mark for both. */
function paragraphText(paragraph: TextRun[], warn: (message: string) => void): string {
  const text = paragraph
    .map((run) => {
      const piece = run.text.replace(/\s+/g, " ").replaceAll("*", "∗");
      const [, lead = "", core = "", trail = ""] = /^(\s*)(.*?)(\s*)$/.exec(piece)!;
      if (core === "") return piece;
      const bold = run.marks?.includes("bold");
      const italic = run.marks?.includes("italic");
      if (bold && italic) warn("bold italic text keeps only bold");
      return `${lead}${bold ? `**${core}**` : italic ? `*${core}*` : core}${trail}`;
    })
    .join("")
    .trim();
  return text.startsWith(BULLET) ? text.slice(BULLET.length).trim() : text;
}

/** The text of a paragraph with no marks. A title holds no marks. */
const plainText = (paragraph: TextRun[]) => paragraph.map((run) => run.text).join("").replace(/\s+/g, " ").trim().replaceAll("*", "∗").replace(/^•\s*/, "");

const textOf = (box: TextBox, warn: (message: string) => void) => ({
  lines: box.paragraphs.map((p) => paragraphText(p, warn)).filter((line) => line !== ""),
  plain: box.paragraphs.map(plainText).filter((line) => line !== ""),
});

const EXTENSIONS = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif" } as const;

/**
 * Outline text for a neutral deck. The layout of the file is not kept: the title is the top text box, the other text
 * boxes are bullet lists, the first picture is the image, and each position comes from the layout. Shapes are dropped.
 * Every body line is a list item, so no text in a file can act as a title, a note, or a slide break.
 */
export function outlineFromFormatsDeck(deck: FormatsDeck, fileWarnings: string[] = []): ImportedDeck {
  const warnings = [...fileWarnings];
  const images: Record<string, Uint8Array> = {};
  const scale = deck.height > 0 ? SLIDE_HEIGHT / deck.height : 1;
  const chunks = deck.slides.map((slide, i) => {
    const warn = (message: string) => warnings.push(`slide ${i + 1}: ${message}`);
    const boxes = slide.shapes
      .filter((s): s is TextBox => s.type === "textbox")
      .map((box) => ({ box, ...textOf(box, warn) }))
      .filter((b) => b.lines.length > 0)
      .sort((a, b) => a.box.frame.y - b.box.frame.y || a.box.frame.x - b.box.frame.x);
    const pictures = slide.shapes.filter((s) => s.type === "picture");
    const dropped = slide.shapes.filter((s) => s.type === "shape").length;
    if (dropped > 0) warn(`${dropped} shape(s) are not kept`);
    if (pictures.length > 1) warn(`${pictures.length - 1} extra picture(s) are not kept`);

    const lines: string[] = [];
    const first = boxes[0];
    const isTitle = first !== undefined && (boxes.length > 1 || first.box.frame.y * scale < SLIDE_HEIGHT / 4);
    const body = isTitle ? boxes.slice(1) : boxes;
    if (isTitle) lines.push(`# ${first.plain.join(" ")}`);
    const picture = pictures[0];
    if (picture?.type === "picture") {
      const path = `image-${i + 1}.${EXTENSIONS[picture.mime]}`;
      images[path] = picture.data;
      lines.push(`![${(picture.alt ?? "Image").replace(/[[\]()\n]/g, " ").trim() || "Image"}](${path})`);
    }
    // The two-column layout holds two text boxes. A layout with a picture holds one. More text joins the last box.
    const columns = picture ? 1 : 2;
    const groups: string[][] = [[]];
    body.forEach((b, n) => {
      if (n > 0 && groups.length < columns) groups.push([]);
      groups[groups.length - 1]!.push(...b.lines);
    });
    groups.forEach((group, n) => {
      if (n > 0) lines.push("+++");
      lines.push(...group.map((line) => `- ${line.replaceAll("\n", " ")}`));
    });
    const notes = (slide.notes ?? "").split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
    lines.push(...notes.map((line) => `> ${line}`));
    return lines.length > 0 ? lines.join("\n") : "layout: blank";
  });
  return { outline: chunks.join("\n---\n"), images, warnings };
}

/** Read an OpenDocument presentation into outline text and image files. Throws `FormatError` for a file that is not safe or not valid. */
export function outlineFromOdp(bytes: Uint8Array): ImportedDeck {
  const { model, warnings } = readOdp(bytes);
  return outlineFromFormatsDeck(model, warnings);
}

/** Read a PowerPoint file into outline text and image files. Throws `FormatError` for a file that is not safe or not valid. */
export function outlineFromPptx(bytes: Uint8Array): ImportedDeck {
  const { model, warnings } = readPptx(bytes);
  return outlineFromFormatsDeck(model, warnings);
}

