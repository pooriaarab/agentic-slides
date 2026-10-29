import type { DeckOutline, ElementPatch, SlideOutline } from "./core/deck.js";
import type { DeckSummary } from "./service.js";
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

/** The role that a person or an agent holds on a deck. */
export type Role = "owner" | "editor" | "commenter" | "viewer";

/** Who holds a role. A person (`human`) and an agent (`agent`) with one id are two subjects. */
export interface Subject {
  kind: "human" | "agent";
  id: string;
}

export interface Me extends Principal {
  role: "editor" | "viewer";
  /** What this token holds roles as. Give it to an owner who shares a deck with you. */
  subject: Subject | null;
}

export interface Grant {
  resourceId: string;
  subjectKind: Subject["kind"];
  subjectId: string;
  role: Role;
}

export interface InviteSummary {
  id: string;
  resourceId: string;
  role: Role;
  for: "email" | "handle";
  handle?: string;
  expiresAt?: number;
  acceptedAt?: number;
}

export interface LinkSummary {
  id: string;
  role: Role;
  signedInOnly: boolean;
  expiresAt: number | null;
  revoked: boolean;
}

/** Who can reach a deck. A link token and an invite email are never in it. */
export interface Access {
  grants: Grant[];
  invites: InviteSummary[];
  links: LinkSummary[];
  /** Pass it as `cursor` for the next page of grants. */
  nextCursor?: string;
  /** More invites exist than this page holds. Pass it as `inviteCursor`. */
  nextInviteCursor?: string;
  /** More links exist than this page holds. Pass it as `linkCursor`. */
  nextLinkCursor?: string;
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

  async function call(method: string, path: string, options: CallOptions & { body?: unknown; raw?: Uint8Array; root?: string; headers?: Record<string, string> } = {}): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, ...options.headers };
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
    /** One page of decks, newest edit first, with the last editor of each. Pass `nextCursor` of the last page as `cursor` for the next. */
    listDecks: (input: { limit?: number; cursor?: string } = {}, options: CallOptions = {}) => {
      const query = new URLSearchParams(Object.entries(input).flatMap(([key, value]) => (value === undefined ? [] : [[key, String(value)]])));
      return json<{ decks: DeckSummary[]; nextCursor?: string }>(call("GET", `/decks${query.size ? `?${query}` : ""}`, options));
    },
    createDeck: (input: { title: string; id?: string }, options: CallOptions = {}) => json<{ id: string }>(call("POST", "/decks", { ...options, body: input })),
    /** Delete the deck and its list entry. */
    deleteDeck: (deck: string, options: CallOptions = {}) => done(call("DELETE", `/decks/${seg(deck)}`, options)),
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
    /** Who can reach the deck. Only an owner may ask. */
    access: (deck: string, input: { limit?: number; cursor?: string; inviteCursor?: string; linkCursor?: string } = {}, options: CallOptions = {}) => {
      const query = new URLSearchParams(Object.entries(input).flatMap(([key, value]) => (value === undefined ? [] : [[key, String(value)]])));
      return json<Access>(call("GET", `/decks/${seg(deck)}/access${query.size ? `?${query}` : ""}`, options));
    },
    /** Give a person or an agent a role on the deck. Only an owner may. */
    grant: (deck: string, input: { subject: Subject; role: Role }, options: CallOptions = {}) =>
      done(call("POST", `/decks/${seg(deck)}/grants`, { ...options, body: { subjectKind: input.subject.kind, subjectId: input.subject.id, role: input.role } })),
    /** Take a role away. The last owner cannot be removed. */
    revoke: (deck: string, subject: Subject, options: CallOptions = {}) =>
      done(call("DELETE", `/decks/${seg(deck)}/grants?${new URLSearchParams({ subjectKind: subject.kind, subjectId: subject.id })}`, options)),
    /** Invite a person by `email` or an agent by `handle`. It sends no message: give the id to the invitee. */
    invite: (deck: string, input: { role: Role; email?: string; handle?: string; expiresInMs?: number }, options: CallOptions = {}) =>
      json<{ id: string }>(call("POST", `/decks/${seg(deck)}/invites`, { ...options, body: input })),
    /** Accept an invite by handle. The handle is the name of the token. */
    acceptInvite: (id: string, options: CallOptions = {}) => done(call("POST", "/invites/accept", { ...options, body: { id } })),
    /** Make a share link. The token comes back once: keep it. */
    createShareLink: (deck: string, input: { role: Role; expiresInMs?: number; signedInOnly?: boolean }, options: CallOptions = {}) =>
      json<{ id: string; token: string }>(call("POST", `/decks/${seg(deck)}/links`, { ...options, body: input })),
    revokeShareLink: (deck: string, link: string, options: CallOptions = {}) => done(call("DELETE", `/decks/${seg(deck)}/links/${seg(link)}`, options)),
    /** Read the outline of a deck with a share link token. This client's own token is sent too, and must be valid. */
    readShared: (deck: string, linkToken: string, options: CallOptions = {}) => json<DeckOutline>(call("GET", `/shared/${seg(deck)}`, { ...options, headers: { "x-link-token": linkToken } })),
    /** The Yjs state of the deck. A live room reads it. */
    state: async (deck: string, options: CallOptions = {}) => new Uint8Array(await (await call("GET", `/decks/${seg(deck)}/state`, options)).arrayBuffer()),
    /** Save a Yjs update. The server checks it, and it can refuse it. */
    checkpoint: (deck: string, update: Uint8Array, options: CallOptions = {}) => done(call("POST", `/decks/${seg(deck)}/checkpoint`, { ...options, raw: update })),
  };
}

export type SlidesClient = ReturnType<typeof createClient>;
export type { DeckSummary, DeckOutline, SlideOutline, ElementPatch, Principal, PrincipalKind, SlidesErrorCode };
