import type { DeckOutline, ElementPatch } from "./core/deck.js";
import type { Principal, PrincipalKind, SlidesErrorCode } from "./core/principal.js";

/** The remote client for the Worker HTTP API. It uses only `fetch`, so it runs in browsers, Workers, and Node. */

/** A code from the deck engine, or a code that only the HTTP layer sets. */
export type ApiErrorCode = SlidesErrorCode | "UNAUTHORIZED" | "BAD_REQUEST" | "NOT_FOUND" | "UPGRADE_REQUIRED" | "MISCONFIGURED" | "INTERNAL";

export interface ApiIssue {
  code?: SlidesErrorCode;
  slide?: number;
  message: string;
  path?: string;
}

/** The API refused a call. `status` is the HTTP status. `code` is the API error code. */
export class SlidesApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode | "UNKNOWN",
    message: string,
    readonly issues: ApiIssue[] = [],
  ) {
    super(message);
    this.name = "SlidesApiError";
  }
}

export interface ClientOptions {
  /** The origin of the Worker, for example `https://slides.example.com`. */
  baseUrl: string;
  /** The bearer token. It names the author of each edit. */
  token: string;
  /** A replacement for the global `fetch`. */
  fetch?: typeof fetch;
}

/** Options for each call. */
export interface CallOptions {
  signal?: AbortSignal;
}

/** An image file for an outline: base64 text, or the bytes of a PNG or JPEG file. */
export type ImageData = string | Uint8Array;

export interface AddSlidesInput {
  outline?: string;
  layout?: string;
  /** The 1-based position for the new slides. */
  at?: number;
  images?: Record<string, ImageData>;
}

export interface PdfExport {
  bytes: Uint8Array;
  warnings: string[];
}

export interface Me extends Principal {
  role: "editor" | "viewer";
}

export interface Health {
  ok: true;
  pack: string;
  version: string;
}

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};
const fromBase64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

const encodeImages = (images?: Record<string, ImageData>) =>
  images && Object.fromEntries(Object.entries(images).map(([path, data]) => [path, typeof data === "string" ? data : toBase64(data)]));

/** Make a client. A call that fails with an API error throws `SlidesApiError`. The client never retries a call. */
export function createClient({ baseUrl, token, fetch: send = (...args) => globalThis.fetch(...args) }: ClientOptions) {
  if (!token) throw new TypeError("createClient needs a token.");
  const root = `${baseUrl.replace(/\/+$/, "")}/api/v1/slides`;
  const seg = encodeURIComponent;

  async function call(method: string, path: string, options: CallOptions & { body?: unknown; raw?: Uint8Array; root?: string } = {}): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    let body: BodyInit | undefined;
    if (options.raw) {
      headers["content-type"] = "application/octet-stream";
      body = options.raw as Uint8Array<ArrayBuffer>;
    } else if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.body);
    }
    const response = await send(`${options.root ?? root}${path}`, { method, headers, body, signal: options.signal });
    if (response.ok) return response;
    const sent = (await response.json().catch(() => undefined)) as { error?: { code?: string; message?: string; issues?: ApiIssue[] } } | undefined;
    const error = sent?.error;
    throw new SlidesApiError(
      response.status,
      (error?.code as ApiErrorCode | undefined) ?? "UNKNOWN",
      error?.message ?? `The server answered ${response.status}.`,
      Array.isArray(error?.issues) ? error.issues : [],
    );
  }
  const json = async <T>(response: Promise<Response>) => (await response).json() as Promise<T>;
  const done = async (response: Promise<Response>): Promise<void> => void (await response);
  const slidePath = (deck: string, slide: string | number) => `/decks/${seg(deck)}/slides/${seg(String(slide))}`;

  return {
    /** The Worker health. It needs no token. */
    health: (options: CallOptions = {}) => json<Health>(call("GET", "", { ...options, root: `${baseUrl.replace(/\/+$/, "")}/health` })),
    /** Who the token stands for. */
    me: (options: CallOptions = {}) => json<Me>(call("GET", "/me", options)),
    createDeck: (input: { title: string; id?: string }, options: CallOptions = {}) => json<{ id: string }>(call("POST", "/decks", { ...options, body: input })),
    outline: (deck: string, options: CallOptions = {}) => json<DeckOutline>(call("GET", `/decks/${seg(deck)}`, options)),
    addSlides: (deck: string, input: AddSlidesInput, options: CallOptions = {}) =>
      json<{ slideIds: string[] }>(call("POST", `/decks/${seg(deck)}/slides`, { ...options, body: { ...input, images: encodeImages(input.images) } })),
    /** Replace one slide from an outline. `slide` is an id, or a 1-based position. */
    setSlide: (deck: string, slide: string | number, input: { outline: string; images?: Record<string, ImageData> }, options: CallOptions = {}) =>
      done(call("PUT", slidePath(deck, slide), { ...options, body: { ...input, images: encodeImages(input.images) } })),
    editElement: (deck: string, slide: string | number, element: string, patch: ElementPatch, options: CallOptions = {}) =>
      done(call("PATCH", `${slidePath(deck, slide)}/elements/${seg(element)}`, { ...options, body: patch })),
    /** Move a slide to a 1-based position. */
    moveSlide: (deck: string, slide: string | number, to: number, options: CallOptions = {}) => done(call("POST", `${slidePath(deck, slide)}/move`, { ...options, body: { to } })),
    deleteSlide: (deck: string, slide: string | number, options: CallOptions = {}) => done(call("DELETE", slidePath(deck, slide), options)),
    /** The HTML page of the deck, or the present page. */
    render: async (deck: string, options: CallOptions & { present?: boolean } = {}) =>
      (await call("GET", `/decks/${seg(deck)}/render${options.present ? "?present=1" : ""}`, options)).text(),
    exportPdf: async (deck: string, options: CallOptions = {}): Promise<PdfExport> => {
      const sent = await json<{ pdfBase64: string; warnings: string[] }>(call("GET", `/decks/${seg(deck)}/export?envelope=json`, options));
      return { bytes: fromBase64(sent.pdfBase64), warnings: sent.warnings };
    },
    /** The Yjs state of the deck. A live room reads it. */
    state: async (deck: string, options: CallOptions = {}) => new Uint8Array(await (await call("GET", `/decks/${seg(deck)}/state`, options)).arrayBuffer()),
    /** Save a Yjs update. The server checks it, and it can refuse it. */
    checkpoint: (deck: string, update: Uint8Array, options: CallOptions = {}) => done(call("POST", `/decks/${seg(deck)}/checkpoint`, { ...options, raw: update })),
  };
}

export type SlidesClient = ReturnType<typeof createClient>;
export type { DeckOutline, ElementPatch, Principal, PrincipalKind, SlidesErrorCode };
