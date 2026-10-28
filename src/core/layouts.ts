import { fail } from "./principal.js";

/** Every slide lives in one fixed 16:9 space. Renderers scale it to the screen. */
export const SLIDE_WIDTH = 1280;
export const SLIDE_HEIGHT = 720;

export const COLOR_TOKENS = ["background", "surface", "text", "muted", "accent", "accentText"] as const;
export type ColorToken = (typeof COLOR_TOKENS)[number];

export interface FontFace {
  family: string;
  /** A path relative to the deck's asset root. Remote URLs are refused. */
  src: string;
  weight: number;
  style: "normal" | "italic";
}

export interface Theme {
  fonts: { heading: string; body: string };
  fontFaces: FontFace[];
  colors: Record<ColorToken, string>;
}

export const DEFAULT_THEME: Theme = {
  fonts: { heading: "system-ui, sans-serif", body: "system-ui, sans-serif" },
  fontFaces: [],
  colors: {
    background: "#ffffff",
    surface: "#f2f4f7",
    text: "#1a1a1a",
    muted: "#4a4a4a",
    accent: "#0b5cad",
    accentText: "#ffffff",
  },
};

const FONT_STACK = /^[A-Za-z0-9 ,'"_-]{1,200}$/;
const LOCAL_PATH = /^(?!.*\.\.)[A-Za-z0-9_][A-Za-z0-9_./-]*$/;
const HEX = /^#[0-9a-fA-F]{6}$/;

/** Throws unless the theme is safe to put into CSS and keeps every asset local. */
export function checkTheme(input: Theme): Theme {
  const theme = { ...input, fontFaces: input.fontFaces ?? [] };
  if (!Array.isArray(theme.fontFaces)) fail("BAD_THEME", "fontFaces must be a list");
  for (const token of COLOR_TOKENS) {
    if (!HEX.test(theme.colors?.[token])) fail("BAD_THEME", `color "${token}" must be a #rrggbb value`);
  }
  for (const value of [theme.fonts?.heading, theme.fonts?.body]) {
    if (!FONT_STACK.test(value)) fail("BAD_THEME", "font stacks hold only letters, digits, spaces, commas, quotes, _ and -");
  }
  for (const face of theme.fontFaces) {
    if (!FONT_STACK.test(face.family)) fail("BAD_THEME", "a font face needs a plain family name");
    if (!LOCAL_PATH.test(face.src)) fail("REMOTE_ASSET", `font src "${face.src}" must be a relative path in the asset root`);
  }
  return theme;
}

export type SlotName = "title" | "subtitle" | "body" | "left" | "right" | "image";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Slot extends Box {
  name: SlotName;
  fontSize: number;
}

export interface LayoutDef {
  slots: Slot[];
  /** Decor shapes that every slide of the layout carries. */
  decor: (Box & { fill: ColorToken })[];
}

const slot = (name: SlotName, x: number, y: number, w: number, h: number, fontSize = 0): Slot => ({ name, x, y, w, h, fontSize });
const header = slot("title", 80, 60, 1120, 100, 44);
const bar = { x: 120, y: 210, w: 160, h: 8, fill: "accent" } as const;

export const LAYOUTS = {
  title: { slots: [slot("title", 120, 240, 1040, 140, 64), slot("subtitle", 120, 400, 1040, 80, 32)], decor: [bar] },
  "title-body": { slots: [header, slot("body", 80, 190, 1120, 460, 30)], decor: [] },
  section: { slots: [slot("title", 120, 280, 1040, 160, 56)], decor: [bar] },
  "two-column": { slots: [header, slot("left", 80, 190, 540, 460, 28), slot("right", 660, 190, 540, 460, 28)], decor: [] },
  "image-right": { slots: [header, slot("body", 80, 190, 600, 460, 28), slot("image", 720, 190, 480, 460)], decor: [] },
  blank: { slots: [], decor: [] },
} satisfies Record<string, LayoutDef>;

export type LayoutName = keyof typeof LAYOUTS;
export const LAYOUT_NAMES = Object.keys(LAYOUTS) as LayoutName[];
export const isLayout = (name: string): name is LayoutName => Object.hasOwn(LAYOUTS, name);

export const TABLE_FONT_SIZE = 24;
const GLYPH_WIDTH = 0.55;
const LINE_HEIGHT = 1.3;

/** Lines the text needs against lines the box holds. An estimate, the same on every run. */
export function textFit(paragraphs: string[], box: Box, fontSize: number): { needed: number; available: number } {
  const columns = Math.max(1, Math.floor(box.w / (fontSize * GLYPH_WIDTH)));
  const needed = paragraphs.reduce((sum, p) => sum + Math.max(1, Math.ceil(p.length / columns)), 0);
  return { needed, available: Math.floor(box.h / (fontSize * LINE_HEIGHT)) };
}

export function tableFits(rows: string[][], box: Box): boolean {
  const columns = Math.max(1, ...rows.map((r) => r.length));
  const perCell = Math.floor(box.w / columns / (TABLE_FONT_SIZE * GLYPH_WIDTH));
  return rows.length <= Math.floor(box.h / (TABLE_FONT_SIZE * 2)) && rows.every((r) => r.every((c) => c.length <= perCell));
}
