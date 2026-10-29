import { sha256 } from "@noble/hashes/sha2.js";
import type { DeckOutline, SlideOutline } from "../core/deck.js";
import { COLOR_TOKENS, SLIDE_HEIGHT, SLIDE_WIDTH, checkTheme, type ColorToken, type Theme } from "../core/layouts.js";
import { tokenCss } from "./tokens.js";
import { isBlobRef, type Element, type Run } from "../core/model.js";

export interface RenderOptions {
  /** Page language. Defaults to "en". */
  lang?: string;
  /** Where an image blob is served from. Defaults to a relative `blobs/<key>` path. Return undefined for a missing image. */
  imageUrl?: (key: string) => string | undefined;
}

// A page loads nothing from the network: no connections, no frames, only its own files.
// It runs no script, or one fixed script that the policy names by hash.
const CSP_BASE =
  "default-src 'none'; img-src 'self' data:; font-src 'self'; style-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'";

/** The policy for a page whose only script is `script`, or for a page with none. */
export function cspFor(script?: string): string {
  if (script === undefined) return `${CSP_BASE}; script-src 'none'`;
  const hash = btoa(String.fromCharCode(...sha256(new TextEncoder().encode(script))));
  return `${CSP_BASE}; script-src 'sha256-${hash}'`;
}

export const CSP = cspFor();

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (value: string): string => value.replace(/[&<>"']/g, (c) => ESCAPES[c]!);

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const token = (value: unknown): ColorToken => (COLOR_TOKENS.includes(value as ColorToken) ? (value as ColorToken) : "text");
const color = (value: unknown): string => `var(--c-${token(value)})`;
const FORMATS: Record<string, string> = { woff2: "woff2", woff: "woff", ttf: "truetype", otf: "opentype" };

export function themeCss(input: Theme): string {
  const theme = checkTheme(input);
  const faces = theme.fontFaces.map((f) => {
    const format = FORMATS[f.src.split(".").pop()!.toLowerCase()];
    return `@font-face{font-family:"${f.family.replace(/["']/g, "")}";src:url("${f.src}")${format ? ` format("${format}")` : ""};font-weight:${num(f.weight) || 400};font-style:${f.style === "italic" ? "italic" : "normal"};font-display:swap}`;
  });
  const vars = COLOR_TOKENS.map((t) => `--c-${t}:${theme.colors[t]}`).join(";");
  return [
    ...faces,
    `:root{${vars};--font-heading:${theme.fonts.heading};--font-body:${theme.fonts.body}}`,
    `.slide{position:relative;width:${SLIDE_WIDTH}px;height:${SLIDE_HEIGHT}px;overflow:hidden;background:var(--c-background);color:var(--c-text);font-family:var(--font-body);line-height:1.3}`,
    `.slide .el{position:absolute;box-sizing:border-box;margin:0;overflow:hidden}`,
    `.slide h2{font-family:var(--font-heading);font-weight:700;line-height:1.3}`,
    `.slide p,.slide ul{margin:0;padding:0}.slide ul{padding-left:1.2em}`,
    `.slide img{width:100%;height:100%;object-fit:contain}`,
    `.slide .placeholder{background:var(--c-surface);border:2px dashed var(--c-muted)}`,
    `.slide table{border-collapse:collapse;width:100%;font-size:24px}`,
    `.slide th{background:var(--c-accent);color:var(--c-accentText);text-align:left}`,
    `.slide th,.slide td{padding:6px 10px;border:1px solid var(--c-muted)}`,
    `.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}`,
  ].join("\n");
}

function paragraphs(runs: Run[]): string[] {
  const out = [""];
  for (const run of runs) {
    run.text.split("\n").forEach((part, i) => {
      if (i > 0) out.push("");
      if (part === "") return;
      let html = esc(part);
      if (run.bold) html = `<strong>${html}</strong>`;
      if (run.italic) html = `<em>${html}</em>`;
      out[out.length - 1] += html;
    });
  }
  return out.filter((p) => p !== "");
}

function renderElement(element: Element, options: RenderOptions): string {
  const box = `left:${num(element.x)}px;top:${num(element.y)}px;width:${num(element.w)}px;height:${num(element.h)}px`;
  const attrs = `class="el" data-machine-made="${element.machineMade}"`;
  switch (element.kind) {
    case "shape":
      return `<div ${attrs} aria-hidden="true" style="${box};background:${color(element.fill)};${element.shape === "ellipse" ? "border-radius:50%" : ""}"></div>`;
    case "image": {
      // A src that is not a blob ref, or a blob that is gone, costs one placeholder, not the deck.
      const key = isBlobRef(element.src) ? element.src : undefined;
      const url = key && (options.imageUrl ? options.imageUrl(key) : `blobs/${encodeURIComponent(key.slice(5))}`);
      const alt = esc(String(element.alt));
      if (!url) return `<div ${attrs.replace('class="el"', 'class="el placeholder"')} role="img" aria-label="${alt} (image unavailable)" style="${box}"></div>`;
      return `<div ${attrs} style="${box}"><img src="${esc(url)}" alt="${alt}"></div>`;
    }
    case "table": {
      const [head = [], ...body] = element.rows;
      const row = (cells: string[], tag: "th" | "td") => `<tr>${cells.map((c) => (tag === "th" ? `<th scope="col">${esc(c)}</th>` : `<td>${esc(c)}</td>`)).join("")}</tr>`;
      return `<div ${attrs} style="${box}"><table><thead>${row(head, "th")}</thead><tbody>${body.map((r) => row(r, "td")).join("")}</tbody></table></div>`;
    }
    case "text": {
      const lines = paragraphs(element.runs);
      if (lines.length === 0) return "";
      const style = `${box};font-size:${num(element.fontSize)}px;color:${color(element.color)}`;
      if (element.slot === "title") return `<h2 ${attrs} style="${style}">${lines.join("<br>")}</h2>`;
      const inner = element.list ? `<ul>${lines.map((l) => `<li>${l}</li>`).join("")}</ul>` : lines.map((l) => `<p>${l}</p>`).join("");
      return `<div ${attrs} style="${style}">${inner}</div>`;
    }
  }
}

/** One slide as an HTML fragment. Pair it with `themeCss`. */
export function renderSlide(slide: SlideOutline, theme: Theme, options: RenderOptions = {}, total = slide.index, hidden = false): string {
  checkTheme(theme);
  const label = `Slide ${slide.index} of ${total}`;
  const head = `<div class="slide" role="group" aria-roledescription="slide" aria-label="${label}" data-machine-made="${slide.machineMade}"${hidden ? " hidden" : ""}>`;
  return `${head}${slide.elements.map((e) => renderElement(e, options)).join("")}</div>`;
}

export function renderPage(outline: DeckOutline, css: string, body: string, options: RenderOptions, csp: string = CSP): string {
  return [
    `<!doctype html>`,
    `<html lang="${esc(options.lang ?? "en")}">`,
    `<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`,
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    `<title>${esc(outline.title)}</title><style>${css}</style></head>`,
    body,
    `</html>`,
  ].join("\n");
}

/** The whole deck as one page, slides stacked. A browser prints it one slide per page. */
export function renderDeck(outline: DeckOutline, options: RenderOptions = {}): string {
  const total = outline.slides.length;
  const css = `${tokenCss()}
${themeCss(outline.theme)}
body{margin:0;background:var(--agd-color-surface-sunken)}main{display:flex;flex-direction:column;align-items:center;gap:var(--agd-space-6);padding:var(--agd-space-6)}.slide{border-radius:var(--agd-radius-md);box-shadow:0 0 0 1px var(--agd-color-border)}
@media print{@page{size:${SLIDE_WIDTH}px ${SLIDE_HEIGHT}px;margin:0}body{background:none}main{display:block;padding:0}.slide{break-after:page;border-radius:0;box-shadow:none}}`;
  const slides = outline.slides.map((s) => renderSlide(s, outline.theme, options, total)).join("\n");
  const body = `<body><h1 class="sr-only">${esc(outline.title)}</h1><main aria-label="Slides">${slides}</main></body>`;
  return renderPage(outline, css, body, options);
}
