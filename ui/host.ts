import { bytesToHex } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { useEffect, useState } from "react";
import * as Y from "yjs";
import type { PresenceEntry } from "agentic-design/react";
import { Deck, type DeckOutline, type ElementPatch, type SlideRef } from "../src/core/deck.js";
import { LAYOUT_NAMES, isLayout, type LayoutName } from "../src/core/layouts.js";
import { checkImageSrc } from "../src/core/model.js";
import { DEFAULT_LIMITS, sniff, tooManyPixels } from "../src/export/limits.js";
import { checkDeckState } from "../src/core/verify.js";
import { fail, type Principal } from "../src/core/principal.js";

/** The part of a Yjs awareness that the editor uses. `Awareness` from `y-protocols` fits. */
export interface AwarenessLike {
  clientID: number;
  getStates(): Map<number, Record<string, unknown>>;
  setLocalStateField(field: string, value: unknown): void;
  on(event: "change", listener: () => void): void;
  off(event: "change", listener: () => void): void;
}

/** The document and the optional room of a host app. */
export interface DeckHost {
  /** The Yjs document that holds the deck. The editor reads and writes it. It never closes it. */
  doc: Y.Doc;
  /** Presence for the room of the document. Each peer sets the field `user` to `{ name, kind? }`. */
  awareness?: AwarenessLike;
  /** Stores the bytes of a picture and gives back its `blob:sha256-<64 hex digits>` reference. Without it, the editor adds no image slide. */
  putImage?: (bytes: Uint8Array) => Promise<string>;
}

/** The calls that the editor makes. `SlidesClient` has them too, so the editor has one code path. */
export interface DeckApi {
  outline(id: string): Promise<DeckOutline>;
  addSlides(id: string, input: { outline?: string; layout?: string; at?: number; images?: Record<string, Uint8Array> }): Promise<{ slideIds: string[] }>;
  editElement(id: string, slide: SlideRef, element: string, patch: ElementPatch): Promise<unknown>;
  moveSlide(id: string, slide: SlideRef, to: number): Promise<unknown>;
  deleteSlide(id: string, slide: SlideRef): Promise<unknown>;
}

/** A host must give a document from the same copy of Yjs. A document from another copy would break on a type check. */
export function checkHost(host: DeckHost): void {
  if (!host || !(host.doc instanceof Y.Doc)) throw new TypeError("host.doc must be a Y.Doc from the same copy of yjs as agentic-slides");
  const a = host.awareness;
  if (a !== undefined && (typeof a?.clientID !== "number" || typeof a.getStates !== "function" || typeof a.setLocalStateField !== "function" || typeof a.on !== "function" || typeof a.off !== "function")) {
    throw new TypeError("host.awareness must have clientID, getStates, setLocalStateField, on, and off");
  }
  if (host.putImage !== undefined && typeof host.putImage !== "function") throw new TypeError("host.putImage must be a function");
}

/** The calls of the editor, answered from the host document. No call leaves the page. Positions are 1-based, as in the client. */
export function hostApi(host: DeckHost, author: Principal): DeckApi & { stop(): void; start(): void } {
  const deck = new Deck(host.doc);
  // A stopped api writes nothing. A slow `putImage` can end after the editor left, or after the person lost the right to write.
  let stopped = false;
  /**
   * The host room may hold anything a peer wrote. The editor reads and writes only a deck that the service would save:
   * a bad theme or element could load a remote address or break the page, and an edit on a deck that the person cannot
   * see would change a state that they never saw. A document with no deck is refused too, so a wrong room is not
   * filled with deck data. Make a deck with `Deck.create`.
   */
  const current = (): DeckOutline => {
    if (!host.doc.getMap("deck").has("title")) fail("NO_DECK", "this document holds no deck");
    deck.checkShape();
    const outline = deck.outline();
    checkDeckState(outline);
    return outline;
  };
  const guard = () => void (stopped ? fail("INVALID_AUTHOR", "the editor was closed or changed before the edit ended") : current());
  return {
    stop: () => void (stopped = true),
    start: () => void (stopped = false),
    // A refused state keeps the last good deck on screen, with a banner.
    outline: async () => current(),
    async addSlides(_id, input) {
      guard();
      const at = input.at === undefined ? undefined : input.at - 1;
      if (input.outline === undefined) {
        const layout = input.layout ?? "title-body";
        if (!isLayout(layout)) fail("UNKNOWN_LAYOUT", `unknown layout "${layout}". Use one of: ${LAYOUT_NAMES.join(", ")}`);
        return { slideIds: [deck.addSlide({ layout: layout as LayoutName, at }, author)] };
      }
      const images: Record<string, string> = {};
      for (const [path, bytes] of Object.entries(input.images ?? {})) {
        const put = host.putImage ?? fail("UNSUPPORTED_IMAGE", "this editor has no place to keep pictures");
        // The same checks as the service, before the host stores anything.
        if (bytes.length > DEFAULT_LIMITS.maxImageBytes) fail("UNSUPPORTED_IMAGE", `image "${path}" is over ${DEFAULT_LIMITS.maxImageBytes} bytes`);
        sniff(bytes);
        if (tooManyPixels(bytes, DEFAULT_LIMITS)) fail("UNSUPPORTED_IMAGE", `image "${path}" is over ${DEFAULT_LIMITS.maxImagePixels} pixels`);
        const ref = checkImageSrc(await put(bytes));
        if (ref !== `blob:sha256-${bytesToHex(sha256(bytes))}`) fail("REMOTE_ASSET", "putImage must give the blob reference of the bytes it got: blob:sha256-<hash of the bytes>");
        images[path] = ref;
      }
      // A peer can change the document while the host stores a picture, so check once more before the write.
      guard();
      return { slideIds: deck.addSlidesFromOutline(input.outline, { author, images, at }) };
    },
    // A `src` patch is checked for its form only. Your store holds the bytes, so it can check that the picture exists.
    editElement: async (_id, slide, element, patch) => (guard(), deck.editElement(slide, element, patch, author)),
    moveSlide: async (_id, slide, to) => (guard(), deck.moveSlide(slide, to - 1, author)),
    deleteSlide: async (_id, slide) => (guard(), deck.deleteSlide(slide, author)),
  };
}

/** Calls `listener` after the changes of the document, from any writer. Changes in one tick make one call. Returns the call that stops it. */
export function watchDoc(doc: Y.Doc, listener: () => void): () => void {
  let live = true;
  let queued = false;
  const onUpdate = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (live) listener();
    });
  };
  doc.on("update", onUpdate);
  return () => {
    live = false;
    doc.off("update", onUpdate);
  };
}

/** A peer is an agent unless its kind is `human` or missing. */
const MAX_NAME = 80;
const entryOfState = (id: number, state: Record<string, unknown>): PresenceEntry[] => {
  const user = state.user as { name?: unknown; kind?: unknown } | null | undefined;
  if (!user || typeof user.name !== "string" || user.name === "") return [];
  return [{ id: `peer-${id}`, name: user.name.slice(0, MAX_NAME), kind: user.kind === undefined || user.kind === "human" ? "person" : "agent" }];
};

/** The other peers in the host's room. This tab announces its own name and kind, and takes both back on unmount. */
export function useAwareness(awareness: AwarenessLike | undefined, user: { name: string; kind: string }): PresenceEntry[] {
  const [peers, setPeers] = useState<PresenceEntry[]>([]);
  useEffect(() => {
    if (!awareness) return setPeers([]);
    const read = () => setPeers([...awareness.getStates()].flatMap(([id, state]) => (id === awareness.clientID ? [] : entryOfState(id, state))));
    // The field `user` may hold more, such as a color for a cursor binding. Keep it, and give it back on unmount.
    const before = awareness.getStates().get(awareness.clientID)?.user as Record<string, unknown> | null | undefined;
    awareness.setLocalStateField("user", { ...before, ...user });
    awareness.on("change", read);
    read();
    return () => {
      awareness.off("change", read);
      // Take back only what this editor wrote, and only while it is still there. The host may have changed it since mount.
      const now = { ...((awareness.getStates().get(awareness.clientID)?.user ?? {}) as Record<string, unknown>) };
      for (const key of ["name", "kind"] as const) {
        if (now[key] !== user[key]) continue;
        if (before?.[key] === undefined) delete now[key];
        else now[key] = before[key];
      }
      awareness.setLocalStateField("user", Object.keys(now).length ? now : null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awareness, user.name, user.kind]);
  return peers;
}
