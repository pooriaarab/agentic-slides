import { PDFDocument, StandardFonts, rgb, type PDFFont } from "@cantoo/pdf-lib";
import type { DeckOutline } from "../core/deck.js";
import { SLIDE_HEIGHT, SLIDE_WIDTH, TABLE_FONT_SIZE, checkTheme, type ColorToken } from "../core/layouts.js";
import type { Element, Run } from "../core/model.js";
import { fail } from "../core/principal.js";

type Fonts = Record<"regular" | "bold" | "italic" | "boldItalic", PDFFont>;
interface Word {
  text: string;
  font: PDFFont;
}

const LINE_HEIGHT = 1.3;
const ROW_HEIGHT = TABLE_FONT_SIZE * 2;

function hex(value: string) {
  const n = Number.parseInt(value.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/**
 * Draw the deck as a PDF, one 1280x720 page per slide, with no browser. Text uses the
 * standard Helvetica faces, so characters outside Latin-1 become "?" and come back as warnings.
 * `images` holds the bytes of each `blob:` key.
 */
export async function renderPdf(
  outline: DeckOutline,
  images: Map<string, Uint8Array>,
): Promise<{ bytes: Uint8Array; warnings: string[] }> {
  const theme = checkTheme(outline.theme);
  const color = (token: ColorToken) => hex(theme.colors[token]);
  const doc = await PDFDocument.create();
  doc.setTitle(outline.title);
  doc.setCreator("agentic-slides");
  doc.setProducer("agentic-slides");
  doc.setCreationDate(new Date(0));
  doc.setModificationDate(new Date(0));
  if (outline.slides.some((s) => s.machineMade)) doc.setSubject("Includes machine-made content");
  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
  };
  const warnings: string[] = [];

  for (const slide of outline.slides) {
    const page = doc.addPage([SLIDE_WIDTH, SLIDE_HEIGHT]);
    const lost = new Set<string>();
    const safe = (text: string): string =>
      [...text].map((ch) => {
        // The font encodes a character it cannot draw as "?" (0x3F) and does not throw.
        if (ch === "?" || String(fonts.regular.encodeText(ch)) !== "<3F>") return ch;
        lost.add(ch);
        return "?";
      }).join("");
    const top = (y: number, h: number) => SLIDE_HEIGHT - y - h;
    page.drawRectangle({ x: 0, y: 0, width: SLIDE_WIDTH, height: SLIDE_HEIGHT, color: color("background") });

    const wrap = (runs: Run[], width: number, size: number, forceBold: boolean): Word[][] => {
      const lines: Word[][] = [];
      for (const paragraph of runs.map((r) => ({ ...r, text: safe(r.text) })).flatMap((r) => r.text.split("\n").map((part, i) => ({ r, part, fresh: i > 0 })))) {
        if (paragraph.fresh || lines.length === 0) lines.push([]);
        const bold = paragraph.r.bold || forceBold;
        const font = bold ? (paragraph.r.italic ? fonts.boldItalic : fonts.bold) : paragraph.r.italic ? fonts.italic : fonts.regular;
        for (const text of paragraph.part.split(/(?<=\s)/).filter(Boolean)) {
          const line = lines[lines.length - 1]!;
          const used = line.reduce((sum, w) => sum + w.font.widthOfTextAtSize(w.text, size), 0);
          if (line.length > 0 && used + font.widthOfTextAtSize(text.trimEnd(), size) > width) lines.push([{ text, font }]);
          else line.push({ text, font });
        }
      }
      return lines;
    };

    const drawText = (e: Extract<Element, { kind: "text" }>) => {
      const lines = wrap(e.runs, e.w - (e.list ? e.fontSize : 0), e.fontSize, e.slot === "title");
      const step = e.fontSize * LINE_HEIGHT;
      lines.slice(0, Math.floor(e.h / step)).forEach((words, i) => {
        const baseline = top(e.y + i * step, 0) - e.fontSize;
        let x = e.x + (e.list ? e.fontSize : 0);
        if (e.list) page.drawText("•", { x: e.x, y: baseline, size: e.fontSize, font: fonts.regular, color: color(e.color) });
        for (const word of words) {
          page.drawText(word.text, { x, y: baseline, size: e.fontSize, font: word.font, color: color(e.color) });
          x += word.font.widthOfTextAtSize(word.text, e.fontSize);
        }
      });
    };

    const drawTable = (e: Extract<Element, { kind: "table" }>) => {
      const columns = Math.max(1, ...e.rows.map((r) => r.length));
      const cell = e.w / columns;
      e.rows.slice(0, Math.floor(e.h / ROW_HEIGHT)).forEach((row, r) => {
        row.forEach((text, c) => {
          const x = e.x + c * cell;
          const y = top(e.y + r * ROW_HEIGHT, ROW_HEIGHT);
          page.drawRectangle({ x, y, width: cell, height: ROW_HEIGHT, borderColor: color("muted"), borderWidth: 1, ...(r === 0 ? { color: color("accent") } : {}) });
          page.drawText(safe(text), { x: x + 10, y: y + 15, size: TABLE_FONT_SIZE, font: r === 0 ? fonts.bold : fonts.regular, color: color(r === 0 ? "accentText" : "text") });
        });
      });
    };

    const drawImage = async (e: Extract<Element, { kind: "image" }>) => {
      const bytes = images.get(e.src) ?? fail("IMAGE_MISSING", `image "${e.src}" is not in the blob store`, slide.index);
      const png = bytes[0] === 0x89;
      const image = png ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
      const scale = Math.min(e.w / image.width, e.h / image.height);
      const [w, h] = [image.width * scale, image.height * scale];
      page.drawImage(image, { x: e.x + (e.w - w) / 2, y: top(e.y + (e.h - h) / 2, h), width: w, height: h });
    };

    for (const e of slide.elements) {
      if (e.kind === "shape") {
        const box = { color: color(e.fill) };
        if (e.shape === "ellipse") page.drawEllipse({ x: e.x + e.w / 2, y: top(e.y, e.h) + e.h / 2, xScale: e.w / 2, yScale: e.h / 2, ...box });
        else page.drawRectangle({ x: e.x, y: top(e.y, e.h), width: e.w, height: e.h, ...box });
      } else if (e.kind === "text") drawText(e);
      else if (e.kind === "table") drawTable(e);
      else await drawImage(e);
    }
    if (lost.size > 0) warnings.push(`slide ${slide.index}: replaced unsupported characters ${[...lost].map((c) => JSON.stringify(c)).join(" ")} with "?"`);
  }
  return { bytes: await doc.save({ useObjectStreams: false }), warnings };
}


