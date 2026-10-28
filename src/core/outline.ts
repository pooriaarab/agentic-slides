import { LAYOUTS, LAYOUT_NAMES, isLayout, tableFits, textFit, type LayoutName, type Slot } from "./layouts.js";
import { checkImageSrc, parseInline, type NewElement, type SlideContent } from "./model.js";
import { SlidesError, type Issue } from "./principal.js";

// Outline format. Slides are split by a line of `---`.
//   layout: <name>      first line only. Without it the layout follows the content.
//   # Title             one per slide.
//   text, - item        body lines. A first line of "- " makes the body a list.
//   +++                 starts the next column (two-column layout).
//   |a|b|               table rows. A table fills the first body box.
//   ![alt](path)        one image. `path` is looked up in the `images` map.
//   > note              speaker notes.
// Inline marks: **bold** and *italic*.

const REMOTE = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i;

function splitSlides(text: string): string[][] {
  const chunks: string[][] = [[]];
  for (const line of text.split(/\r?\n/)) {
    if (/^---\s*$/.test(line)) chunks.push([]);
    else chunks[chunks.length - 1]!.push(line);
  }
  const blank = (c: string[]) => c.every((l) => l.trim() === "");
  if (chunks.every(blank)) return [];
  while (blank(chunks[0]!)) chunks.shift();
  while (blank(chunks[chunks.length - 1]!)) chunks.pop();
  return chunks;
}

function compileSlide(lines: string[], number: number, images: Record<string, string>, issues: Issue[]): SlideContent | undefined {
  const problem = (code: Issue["code"], message: string) => void issues.push({ code, slide: number, message });
  let layoutName: string | undefined;
  let title: string | undefined;
  let image: { alt: string; path: string } | undefined;
  const groups: string[][] = [[]];
  const notes: string[] = [];
  const table: string[][] = [];
  let seenContent = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") continue;
    const declared = !seenContent && /^layout:\s*(\S+)$/.exec(line);
    if (declared) {
      layoutName = declared[1];
      continue;
    }
    seenContent = true;
    const picture = /^!\[(.*?)\]\((.+?)\)$/.exec(line);
    if (line.startsWith("# ")) {
      if (title !== undefined) problem("OUTLINE_INVALID", "a slide holds one title");
      else title = line.slice(2).trim();
    } else if (line.startsWith(">")) notes.push(line.replace(/^>\s?/, ""));
    else if (picture) {
      if (image) problem("OUTLINE_INVALID", "a slide holds one image");
      else image = { alt: picture[1]!, path: picture[2]! };
    } else if (line.startsWith("|")) table.push(line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
    else if (line === "+++") groups.push([]);
    else groups[groups.length - 1]!.push(line);
  }
  while (groups.length > 1 && groups[groups.length - 1]!.length === 0) groups.pop();
  const hasBody = groups.some((g) => g.length > 0) || table.length > 0;

  let layout: LayoutName;
  if (layoutName !== undefined) {
    if (!isLayout(layoutName)) return void problem("UNKNOWN_LAYOUT", `unknown layout "${layoutName}". Use one of: ${LAYOUT_NAMES.join(", ")}`);
    layout = layoutName;
  } else if (title === undefined && !hasBody && !image && notes.length === 0) {
    return void problem("EMPTY_SLIDE", "the slide has no content");
  } else if (image) layout = "image-right";
  else if (groups.length > 1) layout = "two-column";
  else if (hasBody) layout = "title-body";
  else layout = title === undefined ? "blank" : "section";

  const def = LAYOUTS[layout];
  const textSlots = def.slots.filter((s: Slot) => s.name !== "title" && s.name !== "image");
  const imageSlot = def.slots.find((s: Slot) => s.name === "image");
  const titleSlot = def.slots.find((s: Slot) => s.name === "title");
  const before = issues.length;
  if (title !== undefined && !titleSlot) problem("NO_SLOT", `layout "${layout}" has no title`);
  if (groups.length > textSlots.length && groups.slice(textSlots.length).some((g) => g.length)) {
    problem("NO_SLOT", `layout "${layout}" holds ${textSlots.length} text box(es), the outline has ${groups.length}`);
  }
  if (table.length > 0 && (!textSlots[0] || groups[0]!.length > 0)) {
    problem("NO_SLOT", "a table needs the body box of the layout, with no other text in it");
  }
  let src: string | undefined;
  if (image) {
    if (!imageSlot) problem("NO_SLOT", `layout "${layout}" has no image box`);
    else if (REMOTE.test(image.path)) problem("REMOTE_ASSET", `image "${image.path}" is a network address. Add the file to the asset store instead`);
    else if (!Object.hasOwn(images, image.path) || typeof images[image.path] !== "string") problem("IMAGE_MISSING", `image "${image.path}" was not found`);
    else src = checkImageSrc(images[image.path]!);
  }
  if (issues.length > before) return undefined;

  const elements: NewElement[] = def.decor.map((d) => ({ kind: "shape", shape: "rect", ...d }));
  const overflow = (name: string, needed: number, available: number) =>
    problem("TEXT_OVERFLOW", `${name} needs ${needed} line(s), the box holds ${available}`);
  for (const slot of def.slots) {
    const { name, x, y, w, h, fontSize } = slot;
    if (name === "image") {
      if (src) elements.push({ kind: "image", slot: name, x, y, w, h, src, alt: image!.alt });
      continue;
    }
    if (table.length > 0 && slot === textSlots[0]) {
      const cols = Math.max(...table.map((r) => r.length));
      const rows = table.map((r) => Array.from({ length: cols }, (_, i) => r[i] ?? ""));
      if (!tableFits(rows, slot)) problem("TEXT_OVERFLOW", "the table does not fit the body box");
      elements.push({ kind: "table", slot: name, x, y, w, h, rows });
      continue;
    }
    const paragraphs = name === "title" ? (title ? [title] : []) : (groups[textSlots.indexOf(slot)] ?? []);
    const list = name !== "title" && (paragraphs[0]?.startsWith("- ") ?? false);
    const shown = list ? paragraphs.map((p) => p.replace(/^-\s+/, "")) : paragraphs;
    const fit = textFit(shown, slot, fontSize);
    if (shown.length > 0 && fit.needed > fit.available) overflow(name, fit.needed, fit.available);
    const color = name === "subtitle" ? "muted" : "text";
    elements.push({ kind: "text", slot: name, x, y, w, h, fontSize, color, list, runs: parseInline(shown.join("\n")) });
  }
  return issues.length > before ? undefined : { layout, notes: notes.join("\n"), elements };
}

/**
 * Turn outline text into slide content. Throws one SlidesError that lists every
 * problem of every slide, so an agent can fix them in one pass.
 */
export function compileOutline(text: string, images: Record<string, string> = {}): SlideContent[] {
  const chunks = splitSlides(text);
  if (chunks.length === 0) throw new SlidesError([{ code: "EMPTY_OUTLINE", message: "the outline has no slides" }]);
  const issues: Issue[] = [];
  const slides = chunks.map((lines, i) => compileSlide(lines, i + 1, images, issues));
  if (issues.length > 0) throw new SlidesError(issues);
  return slides as SlideContent[];
}

/** The local image paths an outline mentions. Callers read these files and pass them as images. */
export const imagePaths = (text: string): string[] =>
  [...text.matchAll(/^\s*!\[.*?\]\((.+?)\)\s*$/gm)].map((m) => m[1]!).filter((p) => !REMOTE.test(p) && !p.startsWith("blob:"));
