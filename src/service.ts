import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { fromBase64, toBase64 } from "lib0/buffer";
import { Deck, type DeckOutline, type ElementPatch } from "./core/deck.js";
import { isLayout, LAYOUT_NAMES, type LayoutName } from "./core/layouts.js";
import { checkImageSrc, isBlobRef } from "./core/model.js";
import { fail, type Principal } from "./core/principal.js";
import { DEFAULT_LIMITS, checkDeckSize, tooManyPixels, type Limits } from "./export/limits.js";
import { renderPdf } from "./export/pdf.js";
import type { Blobs, Store } from "./ports.js";
import { renderDeck } from "./render/html.js";
import { renderPresent } from "./render/present.js";

const COLLECTION = "decks";

/** A slide by id, or by 1-based position when the text is all digits. Slide ids start with a letter. */
export type SlideSel = string | number;

const slideRef = (sel: SlideSel) => (typeof sel === "number" || /^\d+$/.test(sel) ? Number(sel) - 1 : sel);

function sniff(data: Uint8Array): string {
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return "image/png";
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  return fail("UNSUPPORTED_IMAGE", "images must be PNG or JPEG files");
}

export interface Ports {
  store: Store;
  blobs: Blobs;
}

/** The operations behind the CLI, the MCP server, and the HTTP API. Slide positions are 1-based here. */
export function createService({ store, blobs }: Ports, overrides: Partial<Limits> = {}) {
  const limits: Limits = { ...DEFAULT_LIMITS, ...overrides };
  async function load(id: string): Promise<Deck> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) fail("INVALID_ID", `"${id}" is not a valid deck id`);
    const saved = await store.get<{ update: string }>(COLLECTION, id);
    return saved ? Deck.fromUpdate(fromBase64(saved.update)) : fail("NO_DECK", `no deck "${id}"`);
  }

  async function save(id: string, deck: Deck): Promise<void> {
    await store.put(COLLECTION, id, { update: toBase64(deck.encode()), title: deck.outline().title });
  }

  /**
   * Load the deck under the doc's lock, so the load sees every earlier save, run `fn`,
   * then `after` (blob writes: only once the edit has passed), then save.
   */
  async function mutate<R>(id: string, fn: (deck: Deck) => R, after?: () => Promise<void>): Promise<R> {
    return store.exclusive(COLLECTION, id, async () => {
      const deck = await load(id);
      const result = fn(deck);
      await after?.();
      await save(id, deck);
      return result;
    });
  }

  /**
   * Work out the blob key of each image file and the outline path -> blob ref map, without
   * writing. `write` stores the new blobs, so the caller can do it after the edit passes.
   */
  async function prepareImages(outline: string, files: Record<string, Uint8Array> = {}) {
    const map: Record<string, string> = {};
    const pending: { key: string; data: Uint8Array; contentType: string }[] = [];
    for (const [path, data] of Object.entries(files)) {
      if (data.length > limits.maxImageBytes) fail("UNSUPPORTED_IMAGE", `image "${path}" is over ${limits.maxImageBytes} bytes`);
      const contentType = sniff(data);
      if (tooManyPixels(data, limits)) fail("UNSUPPORTED_IMAGE", `image "${path}" is over ${limits.maxImagePixels} pixels`);
      const key = `sha256-${bytesToHex(sha256(data))}`;
      pending.push({ key, data, contentType });
      map[path] = `blob:${key}`;
    }
    for (const match of outline.matchAll(/\]\((blob:[^)\s]+)\)/g)) {
      if (isBlobRef(match[1]) && (await blobs.get(match[1].slice(5)))) map[match[1]] = match[1];
    }
    const write = async () => {
      for (const { key, data, contentType } of pending) await blobs.put(key, data, { contentType });
    };
    return { map, write };
  }

  /** The bytes of each image the deck uses. An image missing from the store is left out, so it renders as a placeholder. */
  async function imageBytes(outline: DeckOutline): Promise<Map<string, { data: Uint8Array; contentType?: string }>> {
    const found = new Map<string, { data: Uint8Array; contentType?: string }>();
    let total = 0;
    for (const slide of outline.slides) {
      for (const e of slide.elements) {
        if (e.kind !== "image" || found.has(e.src) || !isBlobRef(e.src)) continue;
        const image = await blobs.get(e.src.slice(5));
        if (!image) continue;
        total += image.data.length;
        if (total > limits.maxTotalImageBytes) fail("EXPORT_LIMIT", `the deck images are over ${limits.maxTotalImageBytes} bytes`);
        found.set(e.src, image);
      }
    }
    return found;
  }

  return {
    async create(input: { title: string; author: Principal; id?: string }): Promise<{ id: string }> {
      const id = input.id ?? `d${bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(5)))}`;
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) fail("INVALID_ID", `"${id}" is not a valid deck id`);
      await store.exclusive(COLLECTION, id, async () => {
        if (await store.get(COLLECTION, id)) fail("DECK_EXISTS", `deck "${id}" exists`);
        await save(id, Deck.create({ title: input.title, author: input.author }));
      });
      return { id };
    },

    async outline(id: string): Promise<DeckOutline> {
      return (await load(id)).outline();
    },

    /** Add slides from an outline, or one empty slide of a layout. */
    async addSlides(
      id: string,
      input: { outline?: string; layout?: string; at?: number; images?: Record<string, Uint8Array>; author: Principal },
    ): Promise<{ slideIds: string[] }> {
      const at = input.at === undefined ? undefined : input.at - 1;
      if (input.outline === undefined) {
        const layout = input.layout ?? "title-body";
        if (!isLayout(layout)) fail("UNKNOWN_LAYOUT", `unknown layout "${layout}". Use one of: ${LAYOUT_NAMES.join(", ")}`);
        return { slideIds: [await mutate(id, (d) => d.addSlide({ layout: layout as LayoutName, at }, input.author))] };
      }
      const { map: images, write } = await prepareImages(input.outline, input.images);
      return { slideIds: await mutate(id, (d) => d.addSlidesFromOutline(input.outline!, { author: input.author, images, at }), write) };
    },

    async setSlide(id: string, slide: SlideSel, input: { outline: string; images?: Record<string, Uint8Array>; author: Principal }): Promise<void> {
      const { map: images, write } = await prepareImages(input.outline, input.images);
      await mutate(id, (d) => d.setSlideFromOutline(slideRef(slide), input.outline, { author: input.author, images }), write);
    },

    async editElement(id: string, slide: SlideSel, elementId: string, patch: ElementPatch, author: Principal): Promise<void> {
      if (typeof patch?.src === "string" && !(await blobs.get(checkImageSrc(patch.src).slice(5)))) {
        fail("IMAGE_MISSING", `image "${patch.src}" is not in the blob store`);
      }
      await mutate(id, (d) => d.editElement(slideRef(slide), elementId, patch, author));
    },

    async moveSlide(id: string, slide: SlideSel, to: number, author: Principal): Promise<void> {
      await mutate(id, (d) => d.moveSlide(slideRef(slide), to - 1, author));
    },

    async deleteSlide(id: string, slide: SlideSel, author: Principal): Promise<void> {
      await mutate(id, (d) => d.deleteSlide(slideRef(slide), author));
    },

    /** One self-contained HTML page: images are inlined, so the file opens anywhere. A missing image is a placeholder. */
    async render(id: string, options: { present?: boolean } = {}): Promise<string> {
      const outline = (await load(id)).outline();
      checkDeckSize(outline, limits);
      const images = await imageBytes(outline);
      const uses = outline.slides.flatMap((s) => s.elements).filter((e) => e.kind === "image");
      const inlined = uses.reduce((sum, e) => sum + (images.get(e.src)?.data.length ?? 0), 0);
      if (inlined > limits.maxRenderBytes) fail("EXPORT_LIMIT", `the page would inline ${inlined} bytes of images, the limit is ${limits.maxRenderBytes}`);
      const urls = new Map<string, string>();
      const imageUrl = (key: string) => {
        const image = images.get(key);
        if (!image) return undefined;
        if (!urls.has(key)) urls.set(key, `data:${image.contentType ?? sniff(image.data)};base64,${toBase64(image.data)}`);
        return urls.get(key);
      };
      return (options.present ? renderPresent : renderDeck)(outline, { imageUrl });
    },

    async exportPdf(id: string): Promise<{ bytes: Uint8Array; warnings: string[] }> {
      const outline = (await load(id)).outline();
      checkDeckSize(outline, limits);
      const images = await imageBytes(outline);
      return renderPdf(outline, new Map([...images].map(([key, image]) => [key, image.data])), { limits });
    },
  };
}

export type Service = ReturnType<typeof createService>;
