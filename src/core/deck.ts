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
import { checkAuthor, fail, isMachineMade, type Principal } from "./principal.js";

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

type YMap = Y.Map<unknown>;

function writeRuns(text: Y.Text, runs: Run[]): void {
  text.delete(0, text.length);
  text.applyDelta(
    runs.map((r) => ({ insert: r.text, attributes: { bold: r.bold ? true : null, italic: r.italic ? true : null } })),
  );
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
    this.newId = options.newId ?? (() => uuidv4().replaceAll("-", "").slice(0, 12));
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

  private get slides(): Y.Array<YMap> {
    return this.doc.getArray("slides");
  }

  /** Check the author, run `fn` as one transaction, and stamp the deck. Validate before you write. */
  private change<R>(author: Principal, fn: (who: Principal) => R): R {
    const who = checkAuthor(author);
    return this.doc.transact(() => {
      const result = fn(who);
      this.meta.set("editedBy", who);
      return result;
    }, who) as R;
  }

  private find(ref: SlideRef): { index: number; slide: YMap } {
    const index = typeof ref === "number" ? ref : this.slides.toArray().findIndex((s) => s.get("id") === ref);
    const slide = Number.isInteger(index) && index >= 0 ? this.slides.get(index) : undefined;
    return slide ? { index, slide } : fail("NO_SLIDE", `no slide "${ref}"`);
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
      if (key === "runs") {
        const text = new Y.Text();
        map.set("text", text);
        writeRuns(text, value as Run[]);
      } else map.set(key, value);
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
    const maps = contents.map(() => new Y.Map<unknown>());
    this.slides.insert(at, maps);
    return maps.map((map, i) => {
      const id = this.newId();
      map.set("id", id);
      map.set("createdBy", who);
      this.fillSlide(map, contents[i]!, who);
      return id;
    });
  }

  addSlide(options: { layout?: LayoutName; at?: number }, author: Principal): string {
    return this.change(author, (who) => {
      const layout = options.layout ?? "title-body";
      if (!isLayout(layout)) fail("UNKNOWN_LAYOUT", `unknown layout "${layout}". Use one of: ${LAYOUT_NAMES.join(", ")}`);
      const at = this.position(options.at, this.slides.length);
      return this.insertSlides(compileOutline(`layout: ${layout}`), at, who)[0]!;
    });
  }

  addSlidesFromOutline(text: string, options: OutlineOptions): string[] {
    return this.change(options.author, (who) => {
      const contents = compileOutline(text, options.images);
      return this.insertSlides(contents, this.position(options.at, this.slides.length), who);
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

  /** Moving copies the slide, so edits that other clients make to it at the same moment are lost. */
  moveSlide(ref: SlideRef, to: number, author: Principal): void {
    this.change(author, (who) => {
      const { index, slide } = this.find(ref);
      const target = this.position(to, this.slides.length - 1);
      const copy = slide.clone();
      this.slides.delete(index, 1);
      this.slides.insert(target, [copy]);
      copy.set("editedBy", who);
    });
  }

  deleteSlide(ref: SlideRef, author: Principal): void {
    this.change(author, () => {
      this.slides.delete(this.find(ref).index, 1);
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
      const kind = element.get("kind") as keyof typeof PATCH_KEYS;
      const allowed: readonly string[] = [...BOX_KEYS, ...PATCH_KEYS[kind]];
      for (const key of Object.keys(patch)) {
        if (!allowed.includes(key)) fail("BAD_PATCH", `a ${kind} element has no "${key}" field. Allowed: ${allowed.join(", ")}`);
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
        if (patch.text !== undefined) writeRuns(element.get("text") as Y.Text, runs);
      }
      if (patch.rows !== undefined) {
        const valid = Array.isArray(patch.rows) && patch.rows.every((r) => Array.isArray(r) && r.every((c) => typeof c === "string"));
        if (!valid) fail("BAD_PATCH", "rows must be an array of string arrays");
        if (!tableFits(patch.rows, box)) fail("TEXT_OVERFLOW", "the table does not fit the box");
      }
      if (patch.src !== undefined) checkImageSrc(patch.src);
      for (const [key, value] of Object.entries(patch)) if (key !== "text" && value !== undefined) element.set(key, value);
      element.set("editedBy", who);
      slide.set("editedBy", who);
    });
  }

  outline(): DeckOutline {
    const editedBy = this.meta.get("editedBy") as Principal;
    return {
      title: (this.meta.get("title") as string | undefined) ?? "",
      theme: structuredClone((this.meta.get("theme") as Theme | undefined) ?? DEFAULT_THEME),
      editedBy,
      machineMade: editedBy !== undefined && isMachineMade(editedBy.kind),
      slides: this.slides.toArray().map((slide, i): SlideOutline => {
        const elements = (slide.get("elements") as Y.Array<YMap>).toArray().map((map): Element => {
          const { text, ...fields } = map.toJSON() as Record<string, unknown> & { createdBy: Principal; editedBy: Principal };
          const machineMade = isMachineMade(fields.createdBy.kind) || isMachineMade(fields.editedBy.kind);
          const runs = map.get("text") instanceof Y.Text ? { runs: readRuns(map.get("text") as Y.Text) } : {};
          return structuredClone({ ...fields, ...runs, machineMade }) as unknown as Element;
        });
        const createdBy = slide.get("createdBy") as Principal;
        const last = slide.get("editedBy") as Principal;
        const title = elements.find((e) => e.kind === "text" && e.slot === "title");
        return {
          index: i + 1,
          id: slide.get("id") as string,
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
