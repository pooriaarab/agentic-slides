import type { DeckOutline, SlideOutline } from "./deck.js";
import { COLOR_TOKENS, SLIDE_HEIGHT, SLIDE_WIDTH, checkTheme, isLayout, tableFits, textFit } from "./layouts.js";
import { checkImageSrc, runsText, type Run } from "./model.js";
import { fail, type Principal } from "./principal.js";

// A live room holds a deck that clients wrote with no check. These functions judge a deck state before the server saves it.

const SLOTS = ["title", "subtitle", "body", "left", "right", "image"];
const COMMON = ["id", "kind", "x", "y", "w", "h", "createdBy", "editedBy", "machineMade"];
const KEYS: Record<string, string[]> = {
  text: [...COMMON, "slot", "runs", "fontSize", "color", "list"],
  shape: [...COMMON, "shape", "fill"],
  image: [...COMMON, "slot", "src", "alt"],
  table: [...COMMON, "slot", "rows"],
};

const num = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Check the theme, each layout, and each element, by the rules that an edit through the Deck class keeps. */
export function checkDeckState(outline: DeckOutline): void {
  checkTheme(outline.theme);
  const ids = new Set<string>();
  for (const slide of outline.slides) {
    const at = slide.index;
    if (typeof slide.layout !== "string" || !isLayout(slide.layout)) fail("UNKNOWN_LAYOUT", `unknown layout "${String(slide.layout).slice(0, 40)}"`, at);
    for (const e of slide.elements as unknown as Record<string, unknown>[]) {
      const kind = String(e.kind);
      const allowed = KEYS[kind];
      if (!allowed) fail("BAD_PATCH", `unknown element kind "${kind.slice(0, 40)}"`, at);
      for (const key of Object.keys(e)) if (!allowed!.includes(key)) fail("BAD_PATCH", `a ${kind} element has no "${key.slice(0, 40)}" field`, at);
      if (typeof e.id !== "string" || e.id === "" || ids.has(e.id)) fail("BAD_PATCH", "each element needs its own id, as text", at);
      ids.add(e.id as string);
      const box = [e.x, e.y, e.w, e.h];
      if (!box.every(num)) fail("OUT_OF_BOUNDS", "x, y, w, and h must be numbers", at);
      const [x, y, w, h] = box as number[];
      if (x! < 0 || y! < 0 || w! <= 0 || h! <= 0 || x! + w! > SLIDE_WIDTH || y! + h! > SLIDE_HEIGHT) {
        fail("OUT_OF_BOUNDS", `the box must stay inside ${SLIDE_WIDTH}x${SLIDE_HEIGHT} with a positive size`, at);
      }
      if (e.slot !== undefined && !SLOTS.includes(e.slot as string)) fail("BAD_PATCH", "the slot name is not known", at);
      const token = (value: unknown) => typeof value === "string" && (COLOR_TOKENS as readonly string[]).includes(value);
      if (kind === "text") {
        const runs = e.runs;
        if (!Array.isArray(runs) || !runs.every((r) => typeof r?.text === "string")) fail("BAD_PATCH", "the text of an element is missing", at);
        if (!num(e.fontSize) || e.fontSize <= 0 || !token(e.color) || typeof e.list !== "boolean") fail("BAD_PATCH", "a text element needs fontSize, color, and list", at);
        // The fit rule that an edit runs. A checkpoint must not save text that overflows its box.
        const plain = runsText(runs as Run[]);
        const fit = textFit(plain.split("\n"), { x: x!, y: y!, w: w!, h: h! }, e.fontSize as number);
        if (plain !== "" && fit.needed > fit.available) fail("TEXT_OVERFLOW", `the text needs ${fit.needed} line(s), the box holds ${fit.available}`, at);
      } else if (kind === "shape") {
        if ((e.shape !== "rect" && e.shape !== "ellipse") || !token(e.fill)) fail("BAD_PATCH", "a shape needs a known shape and a fill token", at);
      } else if (kind === "image") {
        if (typeof e.alt !== "string") fail("BAD_PATCH", "alt must be a string", at);
        checkImageSrc(e.src as string);
      } else {
        if (!Array.isArray(e.rows) || !e.rows.every((r) => Array.isArray(r) && r.every((c) => typeof c === "string"))) fail("BAD_PATCH", "rows must be an array of string arrays", at);
        // The table fit rule that an edit runs.
        if (!tableFits(e.rows as string[][], { x: x!, y: y!, w: w!, h: h! })) fail("TEXT_OVERFLOW", "the table does not fit the box", at);
      }
    }
  }
}

const same = (a: Principal, b: Principal) => a.kind === b.kind && a.name === b.name;

const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v));

const without = (value: object, drop: string[]) => Object.fromEntries(Object.entries(value).filter(([key]) => !drop.includes(key)));

/**
 * Check who the update says made each change. A new item, a changed item, and a changed deck must carry a
 * label from `allowed`: the caller, or someone the room saw send an update. A label that is missing counts as
 * an agent named "unknown", so it fails too. A creator never changes.
 */
export function checkAuthors(before: DeckOutline, after: DeckOutline, allowed: Principal[]): void {
  const ok = (who: Principal) => allowed.some((a) => same(a, who));
  const forged = (what: string): never => fail("FORBIDDEN", `the update labels ${what} with an author that has not edited in this room`);
  const labeled = (what: string, now: { editedBy: Principal }) => ok(now.editedBy) || forged(what);

  const shape = (o: DeckOutline) => stable([o.title, o.theme, o.slides.map((s) => s.id)]);
  if (!same(before.editedBy, after.editedBy) || shape(before) !== shape(after)) labeled("the deck", after);

  const oldSlides = new Map(before.slides.map((s) => [s.id, s]));
  for (const slide of after.slides) {
    const was = oldSlides.get(slide.id);
    const name = `slide ${slide.index}`;
    if (!was) {
      if (!ok(slide.createdBy)) forged(name);
    } else if (!same(was.createdBy, slide.createdBy)) forged(name);
    const slideShape = (s: SlideOutline) => stable([s.layout, s.notes, s.elements.map((e) => e.id)]);
    if (!was || !same(was.editedBy, slide.editedBy) || slideShape(was) !== slideShape(slide)) labeled(name, slide);
    const oldElements = new Map((was?.elements ?? []).map((e) => [e.id, e]));
    for (const element of slide.elements) {
      const prior = oldElements.get(element.id);
      const what = `an element of slide ${slide.index}`;
      if (!prior) {
        if (!ok(element.createdBy)) forged(what);
      } else if (!same(prior.createdBy, element.createdBy)) forged(what);
      const content = (e: object) => stable(without(e, ["createdBy", "editedBy", "machineMade"]));
      if (!prior || !same(prior.editedBy, element.editedBy) || content(prior) !== content(element)) labeled(what, element);
    }
  }
}
