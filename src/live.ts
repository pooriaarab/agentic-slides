import * as Y from "yjs";
import { SyncClient, type ConnectOptions, type Peer } from "agentic-realtime/client";
import { Deck, type DeckOutline, type ElementPatch } from "./core/deck.js";
import { PRINCIPAL_KINDS, SlidesError, fail, type Principal, type SlidesErrorCode } from "./core/principal.js";
import { fromBase64 } from "./bytes.js";
import { MAX_LIVE_BYTES, slideRef, type Operations } from "./service.js";

export interface LiveOptions {
  /** The Worker address, such as `https://slides.example.com`. */
  server: string;
  /** A bearer token. The server maps it to the author kind and the role. */
  token: string;
  /** The name other people see in presence. Defaults to the author name. */
  name?: string;
  /** Reconnect after a drop. Edits made offline merge when the socket returns. */
  reconnect?: { initialMs?: number; maxMs?: number };
  /** Opens the room connection. A test passes its own. */
  connect?: (options: ConnectOptions) => Promise<Pick<SyncClient, "doc" | "denied" | "peers" | "flush" | "disconnect">>;
}

/** True for an `https:` address, or an `http:` address on this machine. A token never goes over plain http to another host. */
export function isLiveServer(server: string): boolean {
  try {
    const url = new URL(server);
    return url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  } catch {
    return false;
  }
}

/** Who the server says the token is. */
export interface Me {
  author: Principal;
  role: "editor" | "viewer";
}

const CODES: Record<SlidesErrorCode, true> = {
  INVALID_AUTHOR: true, EMPTY_OUTLINE: true, EMPTY_SLIDE: true, UNKNOWN_LAYOUT: true, TEXT_OVERFLOW: true, IMAGE_MISSING: true, REMOTE_ASSET: true,
  NO_SLOT: true, OUTLINE_INVALID: true, NO_SLIDE: true, NO_ELEMENT: true, OUT_OF_RANGE: true, OUT_OF_BOUNDS: true, BAD_PATCH: true, BAD_THEME: true,
  NO_DECK: true, DECK_EXISTS: true, INVALID_ID: true, UNSUPPORTED_IMAGE: true, EXPORT_LIMIT: true, TOO_LARGE: true, STORE_BUSY: true,
  FORBIDDEN: true, INVALID_UPDATE: true, LIVE_UNAVAILABLE: true,
};

/**
 * The server's error as a SlidesError. A refused token is FORBIDDEN, as `whoAmI` maps it, even on a later call.
 * A code that this package does not know becomes LIVE_UNAVAILABLE.
 */
async function refusal(response: Response, fallback: string): Promise<SlidesError> {
  const { error } = (await response.json().catch(() => ({}))) as { error?: { code?: unknown; message?: unknown } };
  const known = typeof error?.code === "string" && Object.hasOwn(CODES, error.code) ? (error.code as SlidesErrorCode) : "LIVE_UNAVAILABLE";
  const code = response.status === 401 || response.status === 403 ? "FORBIDDEN" : known;
  const message = typeof error?.message === "string" ? error.message : `${fallback} (${response.status})`;
  return new SlidesError([{ code, message }]);
}

const base = (server: string) => `${server.replace(/\/$/, "")}/api/v1/slides`;

/** Why a request failed. Node's `fetch failed` hides the reason in `cause`. */
const reason = (error: unknown): string => {
  const cause = error instanceof Error ? (error.cause as { code?: unknown; message?: unknown } | undefined) : undefined;
  const detail = typeof cause?.code === "string" ? cause.code : typeof cause?.message === "string" ? cause.message : undefined;
  return `${error instanceof Error ? error.message : String(error)}${detail ? ` (${detail})` : ""}`;
};

const unreachable = (error: unknown): SlidesError =>
  error instanceof SlidesError ? error : new SlidesError([{ code: "LIVE_UNAVAILABLE", message: `could not reach the live server: ${reason(error)}` }]);

const checkId = (id: string) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) fail("INVALID_ID", `"${id}" is not a valid deck id`);
};

async function ask(server: string, token: string, path: string, init: RequestInit = {}): Promise<Response> {
  if (!isLiveServer(server)) fail("LIVE_UNAVAILABLE", "the server address must be https://, or http:// on this machine: a token must not cross the network in the clear");
  // Creating a deck is the one request that must not run twice: the first try may have made it.
  const attempts = init.method === "POST" && path === "/decks" ? 1 : 2;
  for (let attempt = 1; ; attempt++) {
    try {
      // A redirect is an error. Following it would send the token on, and read a reply from an address that was never checked.
      return await fetch(`${base(server)}${path}`, { ...init, redirect: "error", headers: { ...init.headers, authorization: `Bearer ${token}` } });
    } catch (error) {
      // A server may close a connection that sat idle, and Node reuses it. One more try opens a new connection.
      const closed = (error as { cause?: { code?: unknown } }).cause?.code === "UND_ERR_SOCKET";
      if (!closed || attempt >= attempts) throw unreachable(error);
    }
  }
}

export async function whoAmI(server: string, token: string): Promise<Me> {
  const response = await ask(server, token, "/me");
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) fail("FORBIDDEN", `the server refused the token (${response.status})`);
    throw await refusal(response, "the server could not say who the token is");
  }
  const { kind, name, role } = (await response.json().catch(() => ({}))) as { kind?: unknown; name?: unknown; role?: unknown };
  if (!PRINCIPAL_KINDS.includes(kind as never) || typeof name !== "string" || name.trim() === "" || (role !== "editor" && role !== "viewer")) {
    fail("LIVE_UNAVAILABLE", "the server sent an identity this client does not know");
  }
  return { author: { kind: kind as Principal["kind"], name: name as string }, role: role as Me["role"] };
}

/**
 * One deck, open in a live room. The author of every edit is the one the server reads from the token, so an
 * agent token always writes agent edits. The room keeps the edits. `save` writes the state to the stored deck.
 */
export class LiveDeck {
  private constructor(
    readonly deck: Deck,
    readonly me: Me,
    private readonly id: string,
    private readonly options: LiveOptions,
    private readonly client: Pick<SyncClient, "doc" | "denied" | "peers" | "flush" | "disconnect">,
    private readonly refusedAtStart: number,
  ) {}

  /** `write` says the caller means to change the deck: a viewer is refused before any room is opened. */
  static async join(id: string, options: LiveOptions, { write = false }: { write?: boolean } = {}): Promise<LiveDeck> {
    checkId(id);
    const me = await whoAmI(options.server, options.token);
    if (write && me.role === "viewer") fail("FORBIDDEN", "this token is a viewer. It cannot change a deck");
    const stored = await ask(options.server, options.token, `/decks/${id}/state`);
    if (!stored.ok) throw await refusal(stored, "could not read the stored deck");
    const state = new Uint8Array(await stored.arrayBuffer());
    if (state.length > MAX_LIVE_BYTES) fail("TOO_LARGE", `the stored deck is over ${MAX_LIVE_BYTES} bytes, the most a live room takes`);
    const url = new URL(`${base(options.server)}/decks/${id}/ws`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    let client: Awaited<ReturnType<NonNullable<LiveOptions["connect"]>>>;
    try {
      client = await (options.connect ?? SyncClient.connect)({
        url: url.toString(),
        headers: { authorization: `Bearer ${options.token}` },
        presence: { name: options.name ?? me.author.name },
        reconnect: options.reconnect,
      });
    } catch (error) {
      throw unreachable(error);
    }
    try {
      // A room that nobody opened is empty. The stored deck and the room come from one Yjs document, so the merge adds nothing twice.
      Y.applyUpdate(client.doc, state);
      await client.flush();
      // A room drops a viewer's seed, and that is no refusal of an edit. An editor's refused seed is an error.
      if (me.role === "editor" && client.denied.length > 0) fail("FORBIDDEN", `the room refused the stored deck: ${client.denied[0]}`);
    } catch (error) {
      // Never leave the client open: with reconnect it would retry for ever.
      await client.disconnect();
      throw unreachable(error);
    }
    return new LiveDeck(new Deck(client.doc), me, id, options, client, client.denied.length);
  }

  /** The other people and agents in the room. `machine` is true for an agent. */
  get peers(): Peer[] {
    return this.client.peers;
  }

  /** Why the room dropped an update, in order. */
  get denied(): string[] {
    return this.client.denied.slice(this.refusedAtStart);
  }

  /**
   * Runs one change as the token's author and waits until the room has it. A viewer fails before the change.
   * After a refusal from the room the local copy still holds the change. Leave and join again.
   */
  async edit<T>(run: (deck: Deck, author: Principal) => T): Promise<T> {
    if (this.me.role === "viewer") fail("FORBIDDEN", "this token is a viewer. It cannot change a deck");
    const seen = this.denied.length;
    const result = run(this.deck, this.me.author);
    try {
      await this.client.flush();
    } catch (error) {
      // The room can hold the change even when the answer never came. A caller that repeats it would add it twice.
      throw new SlidesError([{ code: "LIVE_UNAVAILABLE", message: `the connection failed after the change: ${reason(error)}. The room may have the change. Do not repeat the change without a read first` }]);
    }
    if (this.denied.length > seen) fail("FORBIDDEN", `the room refused the edit: ${this.denied[seen]}`);
    return result;
  }

  /** Waits until the room has every change made so far. */
  flush(): Promise<void> {
    return this.client.flush();
  }

  /** Saves the room state to the stored deck. The server checks it first. A viewer cannot save. */
  async save(): Promise<void> {
    if (this.me.role === "viewer") fail("FORBIDDEN", "this token is a viewer. It cannot change a deck");
    await this.client.flush();
    const saved = await ask(this.options.server, this.options.token, `/decks/${this.id}/checkpoint`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array(this.deck.encode()),
    });
    if (!saved.ok) throw await refusal(saved, "the server did not save the deck");
  }

  async leave(): Promise<void> {
    await this.client.disconnect();
  }
}

const NO_IMAGES = "images are not available in a live room yet. Use the HTTP API to add them";

/**
 * The operations of the CLI and the MCP server, run in a live room. Each call joins the room, runs one change as
 * the token's author, saves to the stored deck, and leaves. The `author` argument is ignored: the token decides.
 */
export function createLiveService(options: LiveOptions): Operations {
  const open = async (id: string, write = false) => {
    try {
      return await LiveDeck.join(id, options, { write });
    } catch (error) {
      throw unreachable(error);
    }
  };

  async function read<T>(id: string, run: (deck: Deck) => T): Promise<T> {
    const live = await open(id);
    try {
      return run(live.deck);
    } finally {
      await live.leave();
    }
  }

  async function write<T>(id: string, run: (deck: Deck, author: Principal) => T): Promise<T> {
    const live = await open(id, true);
    try {
      const result = await live.edit(run);
      try {
        await live.save();
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        throw new SlidesError([{ code: error instanceof SlidesError ? error.code : "LIVE_UNAVAILABLE", message: `the room has the change, but it is not saved: ${why}. Do not repeat the change` }]);
      }
      return result;
    } finally {
      await live.leave();
    }
  }

  const page = async (id: string, path: string): Promise<Response> => {
    checkId(id);
    const response = await ask(options.server, options.token, `/decks/${id}${path}`);
    if (!response.ok) throw await refusal(response, "the server refused the request");
    return response;
  };

  return {
    async create({ title, id }) {
      const response = await ask(options.server, options.token, "/decks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, id }) });
      if (!response.ok) throw await refusal(response, "the server refused the request");
      const made = (await response.json().catch(() => undefined)) as { id?: unknown } | undefined;
      return typeof made?.id === "string" ? { id: made.id } : fail("LIVE_UNAVAILABLE", "the server did not say the id of the new deck");
    },
    outline: (id): Promise<DeckOutline> => read(id, (deck) => deck.outline()),
    async addSlides(id, input) {
      if (Object.keys(input.images ?? {}).length > 0) fail("UNSUPPORTED_IMAGE", NO_IMAGES);
      const at = input.at === undefined ? undefined : input.at - 1;
      if (input.outline === undefined) {
        const layout = input.layout ?? "title-body";
        return { slideIds: [await write(id, (d, author) => d.addSlide({ layout: layout as never, at }, author))] };
      }
      return { slideIds: await write(id, (d, author) => d.addSlidesFromOutline(input.outline!, { author, images: {}, at })) };
    },
    async setSlide(id, slide, input) {
      if (Object.keys(input.images ?? {}).length > 0) fail("UNSUPPORTED_IMAGE", NO_IMAGES);
      await write(id, (d, author) => d.setSlideFromOutline(slideRef(slide), input.outline, { author, images: {} }));
    },
    async editElement(id, slide, elementId, patch: ElementPatch) {
      if (typeof patch?.src === "string") fail("UNSUPPORTED_IMAGE", NO_IMAGES);
      await write(id, (d, author) => d.editElement(slideRef(slide), elementId, patch, author));
    },
    async moveSlide(id, slide, to) {
      await write(id, (d, author) => d.moveSlide(slideRef(slide), to - 1, author));
    },
    async deleteSlide(id, slide) {
      await write(id, (d, author) => d.deleteSlide(slideRef(slide), author));
    },
    async render(id, { present } = {}) {
      return (await page(id, `/render${present ? "?present=1" : ""}`)).text();
    },
    async exportPdf(id) {
      const sent = (await (await page(id, "/export?envelope=json")).json().catch(() => undefined)) as { pdfBase64?: unknown; warnings?: unknown } | undefined;
      if (typeof sent?.pdfBase64 !== "string" || !Array.isArray(sent.warnings)) return fail("LIVE_UNAVAILABLE", "the server sent an export that this client does not know");
      return { bytes: fromBase64(sent.pdfBase64), warnings: sent.warnings.map(String) };
    },
  };
}
