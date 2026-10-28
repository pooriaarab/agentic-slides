import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { fromBase64, toBase64 } from "lib0/buffer";
import { Deck, type DeckOutline, type ElementPatch } from "./core/deck.js";
import { isLayout, LAYOUT_NAMES, type LayoutName } from "./core/layouts.js";
import { fail, type Principal } from "./core/principal.js";
import { renderPdf } from "./export/pdf.js";
import type { Blobs, Store } from "./ports.js";
import { renderDeck } from "./render/html.js";
import { renderPresent } from "./render/present.js";

const COLLECTION = "decks";
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

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
export function createService({ store, blobs }: Ports) {
  async function load(id: string): Promise<Deck> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) fail("INVALID_ID", `"${id}" is not a valid deck id`);
    const saved = await store.get<{ update: string }>(COLLECTION, id);
    return saved ? Deck.fromUpdate(fromBase64(saved.update)) : fail("NO_DECK", `no deck "${id}"`);
  }

  async function save(id: string, deck: Deck): Promise<void> {
    await store.put(COLLECTION, id, { update: toBase64(deck.encode()), title: deck.outline().title });
  }

  async function mutate<R>(id: string, fn: (deck: Deck) => R): Promise<R> {
    const deck = await load(id);
    const result = fn(deck);
    await save(id, deck);
    return result;
  }

  /** Store each image once under its content hash. Returns the outline path -> blob key map. */
  async function storeImages(outline: string, files: Record<string, Uint8Array> = {}): Promise<Record<string, string>> {
    const map: Record<string, string> = {};
    for (const [path, data] of Object.entries(files)) {
      if (data.length > MAX_IMAGE_BYTES) fail("UNSUPPORTED_IMAGE", `image "${path}" is over ${MAX_IMAGE_BYTES} bytes`);
      const contentType = sniff(data);
      const key = `sha256-${bytesToHex(sha256(data))}`;
      await blobs.put(key, data, { contentType });
      map[path] = `blob:${key}`;
    }
    for (const match of outline.matchAll(/\]\((blob:[^)\s]+)\)/g)) {
      if (await blobs.get(match[1]!.slice(5))) map[match[1]!] = match[1]!;
    }
    return map;
  }

  async function imageBytes(outline: DeckOutline): Promise<Map<string, { data: Uint8Array; contentType?: string }>> {
    const found = new Map<string, { data: Uint8Array; contentType?: string }>();
    for (const slide of outline.slides) {
      for (const e of slide.elements) {
        if (e.kind !== "image" || found.has(e.src)) continue;
        found.set(e.src, (await blobs.get(e.src.slice(5))) ?? fail("IMAGE_MISSING", `image "${e.src}" is not in the blob store`, slide.index));
      }
    }
    return found;
  }

  return {
    async create(input: { title: string; author: Principal; id?: string }): Promise<{ id: string }> {
      const id = input.id ?? `d${bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(5)))}`;
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) fail("INVALID_ID", `"${id}" is not a valid deck id`);
      if (await store.get(COLLECTION, id)) fail("DECK_EXISTS", `deck "${id}" exists`);
      await save(id, Deck.create({ title: input.title, author: input.author }));
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
      const images = await storeImages(input.outline, input.images);
      return { slideIds: await mutate(id, (d) => d.addSlidesFromOutline(input.outline!, { author: input.author, images, at })) };
    },

    async setSlide(id: string, slide: SlideSel, input: { outline: string; images?: Record<string, Uint8Array>; author: Principal }): Promise<void> {
      const images = await storeImages(input.outline, input.images);
      await mutate(id, (d) => d.setSlideFromOutline(slideRef(slide), input.outline, { author: input.author, images }));
    },

    async editElement(id: string, slide: SlideSel, elementId: string, patch: ElementPatch, author: Principal): Promise<void> {
      await mutate(id, (d) => d.editElement(slideRef(slide), elementId, patch, author));
    },

    async moveSlide(id: string, slide: SlideSel, to: number, author: Principal): Promise<void> {
      await mutate(id, (d) => d.moveSlide(slideRef(slide), to - 1, author));
    },

    async deleteSlide(id: string, slide: SlideSel, author: Principal): Promise<void> {
      await mutate(id, (d) => d.deleteSlide(slideRef(slide), author));
    },

    /** One self-contained HTML page: images are inlined, so the file opens anywhere. */
    async render(id: string, options: { present?: boolean } = {}): Promise<string> {
      const outline = (await load(id)).outline();
      const images = await imageBytes(outline);
      const imageUrl = (key: string) => {
        const image = images.get(key)!;
        return `data:${image.contentType ?? sniff(image.data)};base64,${toBase64(image.data)}`;
      };
      return (options.present ? renderPresent : renderDeck)(outline, { imageUrl });
    },

    async exportPdf(id: string): Promise<{ bytes: Uint8Array; warnings: string[] }> {
      const outline = (await load(id)).outline();
      const images = await imageBytes(outline);
      return renderPdf(outline, new Map([...images].map(([key, image]) => [key, image.data])));
    },
  };
}

export type Service = ReturnType<typeof createService>;
