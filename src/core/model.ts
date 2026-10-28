import type { Box, ColorToken, LayoutName, SlotName } from "./layouts.js";
import { fail, type Principal } from "./principal.js";

/** A stretch of text with one style. Paragraphs are split by "\n" inside the text. */
export interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
}

export type NewElement =
  | (Box & { kind: "text"; slot?: SlotName; runs: Run[]; fontSize: number; color: ColorToken; list: boolean })
  | (Box & { kind: "shape"; shape: "rect" | "ellipse"; fill: ColorToken })
  | (Box & { kind: "image"; slot?: SlotName; src: string; alt: string })
  | (Box & { kind: "table"; slot?: SlotName; rows: string[][] });

export interface SlideContent {
  layout: LayoutName;
  notes: string;
  elements: NewElement[];
}

export interface Authorship {
  id: string;
  createdBy: Principal;
  editedBy: Principal;
  /** True when an agent or a user token made or last changed it. */
  machineMade: boolean;
}

export type Element = NewElement extends infer E ? (E extends unknown ? E & Authorship : never) : never;

/** Read `**bold**` and `*italic*` marks into runs. Marks do not nest. */
export function parseInline(text: string): Run[] {
  const runs: Run[] = [];
  const push = (run: Run) => {
    const last = runs[runs.length - 1];
    if (last && !last.bold === !run.bold && !last.italic === !run.italic) last.text += run.text;
    else runs.push(run);
  };
  let from = 0;
  for (const m of text.matchAll(/\*\*(.+?)\*\*|\*(.+?)\*/g)) {
    if (m.index > from) push({ text: text.slice(from, m.index) });
    push(m[1] !== undefined ? { text: m[1], bold: true } : { text: m[2]!, italic: true });
    from = m.index + m[0].length;
  }
  if (from < text.length) push({ text: text.slice(from) });
  return runs;
}

export const runsText = (runs: Run[]): string => runs.map((r) => r.text).join("");

/** Images are blob keys. A deck never points at a network address. */
export function checkImageSrc(src: string): string {
  if (!src.startsWith("blob:") || src.length < 6) fail("REMOTE_ASSET", `image src "${src}" must be a "blob:<key>" reference`);
  return src;
}
