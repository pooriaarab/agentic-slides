import { uuidv4 } from "lib0/random";
import * as Y from "yjs";
import {
  COLOR_TOKENS,
  DEFAULT_THEME,
  LAYOUT_NAMES,
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  checkTheme,
  isLayout,
  tableFits,
  textFit,
  type ColorToken,
  type LayoutName,
  type Theme,
} from "./layouts.js";
import { checkImageSrc, parseInline, runsText, type Element, type NewElement, type Run, type SlideContent } from "./model.js";
import { compileOutline } from "./outline.js";
import { checkAuthor, fail, isMachineMade, readPrincipal, type Principal } from "./principal.js";

/** A slide id, or its 0-based position. */
export type SlideRef = string | number;

export interface ElementPatch {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  /** Text with `**bold**` and `*italic*` marks. Replaces the whole text. */
  text?: string;
  fontSize?: number;
  color?: ColorToken;
  fill?: ColorToken;
  alt?: string;
  src?: string;
  rows?: string[][];
}

export interface OutlineOptions {
  author: Principal;
  /** Maps an outline image path to a `blob:<key>` reference. */
  images?: Record<string, string>;
  /** 0-based position for new slides. Defaults to the end. */
  at?: number;
}

export interface SlideOutline {
  /** 1-based position. */
  index: number;
  id: string;
  layout: LayoutName;
  title: string;
  notes: string;
  createdBy: Principal;
  editedBy: Principal;
  machineMade: boolean;
  elements: Element[];
}

export interface DeckOutline {
  title: string;
  theme: Theme;
  editedBy: Principal;
  machineMade: boolean;
  slides: SlideOutline[];
}

const PATCH_KEYS = {
  text: ["text", "fontSize", "color"],
  shape: ["fill"],
  image: ["alt", "src"],
  table: ["rows"],
} as const;
const BOX_KEYS = ["x", "y", "w", "h"] as const;
const MAX_TITLE_CHARS = 1000;

type YMap = Y.Map<unknown>;

/** Length of the shared start and end of two strings, never splitting a surrogate pair. */
function sharedEdges(a: string, b: string): [number, number] {
  const max = Math.min(a.length, b.length);
  let head = 0;
  while (head < max && a[head] === b[head]) head++;
  if (head > 0 && /[\ud800-\udbff]/.test(a[head - 1]!)) head--;
  let tail = 0;
  while (tail < max - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  if (tail > 0 && /[\udc00-\udfff]/.test(a[a.length - tail]!)) tail--;
  return [head, tail];
}

const marks = (r: Run) => ({ bold: r.bold ? true : null, italic: r.italic ? true : null });

/**
 * Write `runs` into the Y.Text at `key`. Only the changed middle is deleted and
 * inserted, so edits that other writers make to the rest of the text survive. A
 * rewrite that shares nothing with the old text swaps the Y.Text, so two such
 * rewrites keep one of them instead of both.
 */
function writeText(owner: YMap, key: string, runs: Run[]): void {
  const next = runsText(runs);
  const existing = owner.get(key);
  let text = existing instanceof Y.Text ? existing : undefined;
  const current = text?.toString() ?? "";
  let [head, tail] = sharedEdges(current, next);
  if (!text || (head + tail === 0 && current !== "" && next !== "")) {
    text = new Y.Text();
    owner.set(key, text);
    head = tail = 0;
  } else text.delete(head, current.length - head - tail);
  let at = 0;
  for (const run of runs) {
    const start = Math.max(at, head);
    const end = Math.min(at + run.text.length, next.length - tail);
    if (end > start) text.insert(start, next.slice(start, end), marks(run));
    at += run.text.length;
  }
  at = 0;
  for (const run of runs) {
    if (run.text.length > 0) text.format(at, run.text.length, marks(run));
    at += run.text.length;
  }
}

function readRuns(text: Y.Text): Run[] {
  return (text.toDelta() as { insert: string; attributes?: { bold?: boolean; italic?: boolean } }[]).map((op) => ({
    text: op.insert,
    ...(op.attributes?.bold ? { bold: true } : {}),
    ...(op.attributes?.italic ? { italic: true } : {}),
  }));
}

/** A deck on a Yjs document. Every edit takes an author and keeps its kind. */
export class Deck {
  private readonly newId: () => string;

  constructor(
    readonly doc: Y.Doc = new Y.Doc(),
    options: { newId?: () => string } = {},
  ) {
    this.newId = options.newId ?? (() => `s${uuidv4().replaceAll("-", "").slice(0, 11)}`);
  }

  static create(
    init: { title: string; author: Principal; theme?: Theme },
    options?: { newId?: () => string },
  ): Deck {
    const deck = new Deck(new Y.Doc(), options);
    const theme = checkTheme(init.theme ?? DEFAULT_THEME);
    deck.change(init.author, () => {
      deck.meta.set("title", init.title);
      deck.meta.set("theme", theme);
    });
    return deck;
  }

  static fromUpdate(update: Uint8Array, options?: { newId?: () => string }): Deck {
    const deck = new Deck(new Y.Doc(), options);
    deck.applyUpdate(update);
    return deck;
  }

  encode(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc);
  }

  applyUpdate(update: Uint8Array): void {
    Y.applyUpdate(this.doc, update);
  }

  private get meta(): YMap {
    return this.doc.getMap("deck");
  }

  /** Slide content by slide id. A move never touches it. */
  private get slides(): Y.Map<YMap> {
    return this.doc.getMap("slides");
  }

  /** Slide ids in show order. Two writers can both move one slide, so read it through `liveIds`. */
  private get order(): Y.Array<string> {
    return this.doc.getArray("order");
  }

  /** The ids of slides that exist, in order, each once. */
  private liveIds(): string[] {
    const seen = new Set<string>();
    return this.order.toArray().filter((id) => this.slides.has(id) && !seen.has(id) && seen.add(id));
  }

  /** Drop deleted and repeated ids from `order`, so an index into it is an index into the deck. */
  private tidyOrder(): void {
    const seen = new Set<string>();
    const stale = this.order.toArray().flatMap((id, i) => (this.slides.has(id) && !seen.has(id) && seen.add(id) ? [] : [i]));
    for (const i of stale.reverse()) this.order.delete(i, 1);
  }

  /** Check the author, run `fn` as one transaction, and stamp the deck. Validate before you write. */
  private change<R>(author: Principal, fn: (who: Principal) => R): R {
    const who = checkAuthor(author);
    return this.doc.transact(() => {
      this.tidyOrder();
      const result = fn(who);
      this.meta.set("editedBy", who);
      return result;
    }, who) as R;
  }

  private find(ref: SlideRef): { index: number; id: string; slide: YMap } {
    const ids = this.liveIds();
    const index = typeof ref === "number" ? ref : ids.indexOf(ref);
    const id = Number.isInteger(index) && index >= 0 ? ids[index] : undefined;
    const slide = id === undefined ? undefined : this.slides.get(id);
    return slide ? { index, id: id!, slide } : fail("NO_SLIDE", `no slide "${ref}"`);
  }

  private position(at: number | undefined, max: number): number {
    const position = at ?? max;
    return Number.isInteger(position) && position >= 0 && position <= max ? position : fail("OUT_OF_RANGE", `position ${at} is outside 0..${max}`);
  }

  private fillElement(map: YMap, element: NewElement, who: Principal): void {
    map.set("id", this.newId());
    map.set("createdBy", who);
    map.set("editedBy", who);
    for (const [key, value] of Object.entries(element)) {
      if (value === undefined) continue;
      if (key === "runs") writeText(map, "text", value as Run[]);
      else map.set(key, value);
    }
  }

  private fillSlide(slide: YMap, content: SlideContent, who: Principal): void {
    slide.set("layout", content.layout);
    slide.set("notes", new Y.Text(content.notes));
    const elements = new Y.Array<YMap>();
    slide.set("elements", elements);
    for (const element of content.elements) {
      const map = new Y.Map<unknown>();
      elements.push([map]);
      this.fillElement(map, element, who);
    }
    slide.set("editedBy", who);
  }

  private insertSlides(contents: SlideContent[], at: number, who: Principal): string[] {
    const ids = contents.map(() => this.newId());
    this.order.insert(at, ids);
    ids.forEach((id, i) => {
      const map = new Y.Map<unknown>();
      this.slides.set(id, map);
      map.set("id", id);
      map.set("createdBy", who);
      this.fillSlide(map, contents[i]!, who);
    });
    return ids;
  }

  addSlide(options: { layout?: LayoutName; at?: number }, author: Principal): string {
    return this.change(author, (who) => {
      const layout = options.layout ?? "title-body";
      if (!isLayout(layout)) fail("UNKNOWN_LAYOUT", `unknown layout "${layout}". Use one of: ${LAYOUT_NAMES.join(", ")}`);
      const at = this.position(options.at, this.order.length);
      return this.insertSlides(compileOutline(`layout: ${layout}`), at, who)[0]!;
    });
  }

  addSlidesFromOutline(text: string, options: OutlineOptions): string[] {
    return this.change(options.author, (who) => {
      const contents = compileOutline(text, options.images);
      return this.insertSlides(contents, this.position(options.at, this.order.length), who);
    });
  }

  setSlideFromOutline(ref: SlideRef, text: string, options: OutlineOptions): void {
    this.change(options.author, (who) => {
      const { slide } = this.find(ref);
      const contents = compileOutline(text, options.images);
      if (contents.length !== 1) fail("OUTLINE_INVALID", `setSlideFromOutline takes one slide, the outline has ${contents.length}`);
      this.fillSlide(slide, contents[0]!, who);
    });
  }

  /** Moving changes the order list only. The slide keeps its content and any edit made to it at the same moment. */
  moveSlide(ref: SlideRef, to: number, author: Principal): void {
    this.change(author, (who) => {
      const { index, id, slide } = this.find(ref);
      const target = this.position(to, this.order.length - 1);
      this.order.delete(index, 1);
      this.order.insert(target, [id]);
      slide.set("editedBy", who);
    });
  }

  deleteSlide(ref: SlideRef, author: Principal): void {
    this.change(author, () => {
      const { index, id } = this.find(ref);
      this.order.delete(index, 1);
      this.slides.delete(id);
    });
  }

  setTheme(theme: Theme, author: Principal): void {
    this.change(author, () => {
      this.meta.set("theme", checkTheme(theme));
    });
  }

  editElement(ref: SlideRef, elementId: string, patch: ElementPatch, author: Principal): void {
    this.change(author, (who) => {
      const { slide } = this.find(ref);
      const element = (slide.get("elements") as Y.Array<YMap>).toArray().find((e) => e.get("id") === elementId);
      if (!element) return fail("NO_ELEMENT", `no element "${elementId}" on the slide`);
      if (typeof patch !== "object" || patch === null || Array.isArray(patch)) fail("BAD_PATCH", "the patch must be an object");
      const kind = element.get("kind") as keyof typeof PATCH_KEYS;
      const allowed: readonly string[] = [...BOX_KEYS, ...PATCH_KEYS[kind]];
      for (const key of Object.keys(patch)) {
        if (!allowed.includes(key)) fail("BAD_PATCH", `a ${kind} element has no "${key}" field. Allowed: ${allowed.join(", ")}`);
      }
      for (const key of ["text", "alt", "src"] as const) {
        if (patch[key] !== undefined && typeof patch[key] !== "string") fail("BAD_PATCH", `${key} must be a string`);
      }
      for (const key of BOX_KEYS) {
        if (patch[key] !== undefined && typeof patch[key] !== "number") fail("OUT_OF_BOUNDS", `${key} must be a number`);
      }
      const box = Object.fromEntries(BOX_KEYS.map((k) => [k, patch[k] ?? (element.get(k) as number)])) as Record<(typeof BOX_KEYS)[number], number>;
      const inside = box.x >= 0 && box.y >= 0 && box.w > 0 && box.h > 0 && box.x + box.w <= SLIDE_WIDTH && box.y + box.h <= SLIDE_HEIGHT;
      if (!BOX_KEYS.every((k) => Number.isFinite(box[k])) || !inside) {
        fail("OUT_OF_BOUNDS", `the box must stay inside ${SLIDE_WIDTH}x${SLIDE_HEIGHT} with a positive size`);
      }
      for (const token of [patch.color, patch.fill]) {
        if (token !== undefined && !COLOR_TOKENS.includes(token)) fail("BAD_PATCH", `color must be one of ${COLOR_TOKENS.join(", ")}`);
      }
      const fontSize = patch.fontSize ?? (element.get("fontSize") as number | undefined);
      if (patch.fontSize !== undefined && !(Number.isFinite(patch.fontSize) && patch.fontSize > 0)) fail("BAD_PATCH", "fontSize must be a positive number");
      if (kind === "text") {
        const current = readRuns(element.get("text") as Y.Text);
        const runs = patch.text === undefined ? current : parseInline(patch.text);
        const plain = runsText(runs);
        const fit = textFit(plain.split("\n"), box, fontSize!);
        if (plain !== "" && fit.needed > fit.available) fail("TEXT_OVERFLOW", `the text needs ${fit.needed} line(s), the box holds ${fit.available}`);
        if (patch.text !== undefined) writeText(element, "text", runs);
      }
      if (patch.rows !== undefined) {
        const valid = Array.isArray(patch.rows) && patch.rows.every((r) => Array.isArray(r) && r.every((c) => typeof c === "string"));
        if (!valid) fail("BAD_PATCH", "rows must be an array of string arrays");
      }
      // The fit of a table holds for its rows and its box, so a box-only patch is checked too.
      if (kind === "table" && !tableFits((patch.rows ?? element.get("rows")) as string[][], box)) fail("TEXT_OVERFLOW", "the table does not fit the box");
      if (patch.src !== undefined) checkImageSrc(patch.src);
      for (const [key, value] of Object.entries(patch)) if (key !== "text" && value !== undefined) element.set(key, value);
      element.set("editedBy", who);
      slide.set("editedBy", who);
    });
  }

  /** Delete the slides that `order` does not hold. No reader sees them, and no operation can remove them. */
  pruneOrphans(): void {
    const held = new Set(this.order.toArray());
    this.doc.transact(() => {
      for (const id of [...this.slides.keys()]) if (!held.has(id)) this.slides.delete(id);
    });
  }

  /**
   * Check the raw Yjs types, which `outline` reads with no check. A client can write any Yjs value, and the
   * Deck class never writes these: so a deck that fails here came from outside, and no reader can use it.
   */
  checkShape(): void {
    const bad = (what: string): never => fail("INVALID_UPDATE", `the deck state is not valid: ${what}`);
    const title = this.meta.get("title");
    if (title !== undefined && (typeof title !== "string" || title.length > MAX_TITLE_CHARS)) bad("the title must be text of up to 1000 characters");
    if (!this.order.toArray().every((id) => typeof id === "string")) bad("the order holds an id that is not text");
    for (const [id, slide] of this.slides) {
      if (!(slide instanceof Y.Map) || !(slide.get("notes") instanceof Y.Text) || !(slide.get("elements") instanceof Y.Array)) bad(`slide "${id}" is not made as the Deck class makes one`);
      for (const element of (slide.get("elements") as Y.Array<unknown>).toArray()) {
        if (!(element instanceof Y.Map)) bad(`slide "${id}" holds an element that is not a map`);
        const text = (element as YMap).get("text");
        if ((element as YMap).get("kind") === "text" ? !(text instanceof Y.Text) : text !== undefined) bad(`slide "${id}" holds an element with a text field of the wrong type`);
        if (typeof (element as YMap).get("id") !== "string") bad(`slide "${id}" holds an element with an id that is not text`);
        if ((element as YMap).has("runs")) bad(`slide "${id}" holds an element with a stored "runs" field`);
      }
    }
  }

  /** Every record that holds an author: the deck, each slide, each element. */
  private *authored(): Generator<{ map: YMap; slideId?: string; elementId?: string }> {
    yield { map: this.meta };
    for (const [slideId, slide] of this.slides.entries()) {
      yield { map: slide, slideId };
      for (const element of (slide.get("elements") as Y.Array<unknown> | undefined)?.toArray() ?? []) {
        if (element instanceof Y.Map) yield { map: element as YMap, slideId, elementId: element.get("id") as string };
      }
    }
  }

  /** The records where one of `who` made or last changed the content. Slide ids are in no order. */
  authorship(who: Principal[]): { slideId?: string; elementId?: string; createdBy?: Principal; editedBy?: Principal }[] {
    const is = (value: unknown) => who.some((p) => (value as Principal | undefined)?.kind === p.kind && (value as Principal | undefined)?.name === p.name);
    const out = [];
    for (const { map, slideId, elementId } of this.authored()) {
      const createdBy = is(map.get("createdBy")) ? readPrincipal(map.get("createdBy")) : undefined;
      const editedBy = is(map.get("editedBy")) ? readPrincipal(map.get("editedBy")) : undefined;
      if (createdBy || editedBy) out.push({ ...(slideId === undefined ? {} : { slideId }), ...(elementId === undefined ? {} : { elementId }), ...(createdBy ? { createdBy } : {}), ...(editedBy ? { editedBy } : {}) });
    }
    return out;
  }

  /**
   * Replace each author in `who` with the same kind and the name `name`, so the machine-made label stays. It does not stamp
   * the deck as edited. It returns how many records changed.
   */
  anonymise(who: Principal[], name: string): number {
    let changed = 0;
    this.doc.transact(() => {
      for (const { map } of this.authored()) {
        let hit = false;
        for (const key of ["createdBy", "editedBy"]) {
          const value = map.get(key) as Principal | undefined;
          if (value && who.some((p) => p.kind === value.kind && p.name === value.name)) {
            map.set(key, { kind: value.kind, name });
            hit = true;
          }
        }
        if (hit) changed++;
      }
    });
    return changed;
  }

  outline(): DeckOutline {
    const editedBy = readPrincipal(this.meta.get("editedBy"));
    return {
      title: (this.meta.get("title") as string | undefined) ?? "",
      theme: structuredClone((this.meta.get("theme") as Theme | undefined) ?? DEFAULT_THEME),
      editedBy,
      machineMade: isMachineMade(editedBy.kind),
      slides: this.liveIds().map((id, i): SlideOutline => {
        const slide = this.slides.get(id)!;
        const elements = (slide.get("elements") as Y.Array<YMap>).toArray().map((map): Element => {
          const { text, ...fields } = map.toJSON() as Record<string, unknown>;
          const createdBy = readPrincipal(fields.createdBy);
          const editedBy = readPrincipal(fields.editedBy);
          const machineMade = isMachineMade(createdBy.kind) || isMachineMade(editedBy.kind);
          const runs = map.get("text") instanceof Y.Text ? { runs: readRuns(map.get("text") as Y.Text) } : {};
          return structuredClone({ ...fields, createdBy, editedBy, ...runs, machineMade }) as unknown as Element;
        });
        const createdBy = readPrincipal(slide.get("createdBy"));
        const last = readPrincipal(slide.get("editedBy"));
        const title = elements.find((e) => e.kind === "text" && e.slot === "title");
        return {
          index: i + 1,
          id,
          layout: slide.get("layout") as LayoutName,
          title: title?.kind === "text" ? runsText(title.runs) : "",
          notes: (slide.get("notes") as Y.Text).toString(),
          createdBy,
          editedBy: last,
          machineMade: isMachineMade(createdBy.kind) || isMachineMade(last.kind),
          elements,
        };
      }),
    };
  }
}
