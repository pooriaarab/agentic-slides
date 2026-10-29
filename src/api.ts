import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { COMMAND } from "./brand.js";
import type { Realtime } from "agentic-realtime";
import { acceptWebSocketProtocol, principalFromWebSocketRequest } from "agentic-identity/http";
import { EraseRefusedError, ROLES, StoreConflictError, createSharing, type Auth, type Json, type PrincipalContext, type Store } from "agentic-identity";
import { DECK, DECK_ID, contextOf, roomPrincipals, subjectOf } from "./access.js";
import { ConfigError, type Authenticator, type Caller, type SlidesRole } from "./auth.js";
import { SlidesError, fail, parsePrincipal, type Principal, type SlidesErrorCode } from "./core/principal.js";
import { toBase64 } from "./bytes.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { CSP } from "./render/html.js";
import { PRESENT_CSP } from "./render/present.js";
import { decodeImages, images, patch } from "./schemas.js";
import { MAX_LIVE_BYTES, type Service } from "./service.js";
import { VERSION } from "./version.js";

export interface AppDeps {
  service: Service;
  auth: Authenticator;
  /** Makes the live room server from the Worker bindings. Without it, the room route answers 404. */
  live?: (env: unknown) => Realtime;
  /** The people and agents that the editor tokens name now. A checkpoint trusts a label only from these. Without it, none is trusted. */
  principals?: Principal[];
  /**
   * The store that holds the roles. With it, each deck made through the API has an owner, and the routes check the role of the caller.
   * Without it, the token role is the only check. A deck with no owner (made before sharing) keeps that check.
   */
  store?: Store;
}

const MAX_BODY_BYTES = 32 * 1024 * 1024;
const NOT_FOUND = new Set<SlidesErrorCode>(["NO_DECK", "NO_SLIDE", "NO_ELEMENT"]);
const BAD_REQUEST = new Set<SlidesErrorCode>(["INVALID_SHARE", "INVALID_ID", "BAD_PATCH", "BAD_THEME", "INVALID_AUTHOR", "INVALID_UPDATE"]);

const statusOf = (code: SlidesErrorCode): 403 | 404 | 409 | 400 | 413 | 422 | 503 =>
  code === "FORBIDDEN" ? 403 : NOT_FOUND.has(code) ? 404 : code === "DECK_EXISTS" ? 409 : code === "TOO_LARGE" ? 413 : code === "STORE_BUSY" ? 503 : BAD_REQUEST.has(code) ? 400 : 422;

// The header is a summary. Full warnings come back from `?envelope=json`.
const WARNINGS_HEADER_CHARS = 1024;
const WARNING_CHARS = 100;
function warningsSummary(warnings: string[]): string {
  const shown: string[] = [];
  for (const warning of warnings) {
    const next = [...shown, [...warning].slice(0, WARNING_CHARS).join("")];
    if (encodeURIComponent(JSON.stringify(next)).length > WARNINGS_HEADER_CHARS) break;
    shown.push(next[next.length - 1]!);
  }
  return encodeURIComponent(JSON.stringify(shown));
}

const body = {
  create: z.object({ title: z.string().min(1).max(200), id: z.string().optional() }),
  add: z.object({ outline: z.string().optional(), layout: z.string().optional(), at: z.number().int().optional(), images }),
  set: z.object({ outline: z.string(), images }),
  page: z.object({ limit: z.coerce.number().int().min(1).max(200).optional(), cursor: z.string().min(1).max(2000).optional() }),
  move: z.object({ to: z.number().int() }),
  grant: z.object({ subjectKind: z.enum(["human", "agent"]), subjectId: z.string().min(1).max(128), role: z.enum(ROLES) }),
  invite: z.object({ role: z.enum(ROLES), email: z.string().max(320).optional(), handle: z.string().max(128).optional(), expiresInMs: z.number().int().positive().optional() }),
  link: z.object({ role: z.enum(ROLES), expiresInMs: z.number().int().positive().optional(), signedInOnly: z.boolean().optional() }),
  access: z.object({ limit: z.coerce.number().int().min(1).max(200).optional(), cursor: z.string().min(1).max(2000).optional(), inviteCursor: z.string().min(1).max(2000).optional(), linkCursor: z.string().min(1).max(2000).optional() }),
  accept: z.object({ id: z.string().min(1).max(128) }),
};

const SHARE_ERROR = /^(invalid|give an|expiresAt|expiresInMs|the last owner|limit must)/;
/** Runs sharing code. Its plain errors become slides errors. Any other failure passes on as it is. */
async function viaSharing<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof Error) || error instanceof SlidesError) throw error;
    if (error.message === "forbidden") return fail("FORBIDDEN", "This caller may not do this.");
    if (error.message === "resource exists") return fail("DECK_EXISTS", "This deck id has an owner already.");
    if (error.message === "resource id has old audit entries") return fail("DECK_EXISTS", "An old record blocks this deck id. Use another id, or ask the operator to clear it.");
    if (error instanceof EraseRefusedError) return fail("INVALID_SHARE", error.message);
    if (error instanceof StoreConflictError) return fail("STORE_BUSY", "another writer changed the deck. Try again");
    if (error instanceof RangeError || SHARE_ERROR.test(error.message)) return fail("INVALID_SHARE", error.message);
    throw error;
  }
}

/** The most decks that one list call reads while it looks for decks that the caller may see. A call that stops there returns what it found, with a cursor to go on. */
const MAX_SCANNED = 200;
/** The most pages of 200 roles that a list reads for one caller. A caller with more roles sees the decks of the first ones: the list fails closed. */
const MAX_HELD_PAGES = 5;
const DEFAULT_LISTED = 50;
const SHARE_ROUTE = /\/decks\/[^/]+\/(access|grants|invites|links)(\/|$)/;
const ROOM_ROUTE = /\/decks\/[^/]+\/ws$/;
/** The WebSocket subprotocol of this app. A browser also offers `agentic-slides.bearer.<token>`, which holds the token. */
export const ROOM_PROTOCOL = "agentic-slides";

/** The room token helper needs an `Auth` port. This one wraps the app authenticator, and keeps the role for the request. */
function roomAuth(auth: AppDeps["auth"]): { port: Auth; callers: WeakMap<PrincipalContext, Caller>; fault?: unknown } {
  const callers = new WeakMap<PrincipalContext, Caller>();
  const port: Auth = {
    async authenticate(request) {
      let caller: Caller | null;
      try {
        caller = await auth(request);
      } catch (error) {
        result.fault = error ?? new Error("auth failed");
        throw error;
      }
      if (!caller) return null;
      const context: PrincipalContext = { principalId: `${caller.author.kind}:${caller.author.name}`, kind: caller.author.kind, chain: [], scopes: [] };
      callers.set(context, caller);
      return context;
    },
  };
  const result: { port: Auth; callers: WeakMap<PrincipalContext, Caller>; fault?: unknown } = { port, callers };
  return result;
}

const failure = (code: string, message: string, extra: object = {}) => ({ error: { code, message, ...extra } });

/** The HTTP API under /api/v1/slides. It mirrors the CLI. The caller's token names the author of each edit. */
export function createApp({ service, auth, live, principals = [], store }: AppDeps) {
  const sharing = store && createSharing(store);
  const configured = new Set(principals.map((who) => `${who.kind}:${who.name}`));
  const app = new Hono<{ Variables: { author: Principal; role: SlidesRole } }>();
  app.use("*", async (c, next) => {
    await next();
    c.header("x-content-type-options", "nosniff");
    c.header("cache-control", "no-store");
  });
  app.get("/health", (c) => c.json({ ok: true, pack: COMMAND, version: VERSION }));

  const api = new Hono<{ Variables: { author: Principal; role: SlidesRole } }>();
  const general = bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json(failure("TOO_LARGE", "The request body is too large."), 413) });
  // A checkpoint has its own, lower cap.
  api.use("*", (c, next) => (c.req.method === "POST" && /\/decks\/[^/]+\/checkpoint$/.test(c.req.path) ? next() : general(c, next)));
  api.use("*", async (c, next) => {
    let caller: Caller | null;
    if (ROOM_ROUTE.test(c.req.path)) {
      // Only the room route reads the token from the subprotocol, and only when there is no Authorization header.
      const room = roomAuth(auth);
      const found = await principalFromWebSocketRequest(c.req.raw, room.port, { protocol: ROOM_PROTOCOL });
      if (room.fault !== undefined) throw room.fault; // the error handler answers it, as on every other route
      if (found instanceof Response && found.status === 403) return c.json(failure("FORBIDDEN", "This request is not allowed."), 403);
      caller = found instanceof Response ? null : (room.callers.get(found) ?? null);
    } else caller = await auth(c.req.raw);
    if (!caller) return c.json(failure("UNAUTHORIZED", "Send a valid bearer token."), 401, { "www-authenticate": "Bearer" });
    c.set("author", caller.author);
    c.set("role", caller.role);
    // Only a read is safe for a viewer. This holds for every route added later, too.
    if (caller.role === "viewer" && c.req.method !== "GET" && c.req.method !== "HEAD") {
      return c.json(failure("FORBIDDEN", "This token is a viewer. It cannot change a deck."), 403);
    }
    await next();
  });

  const callerOf = (c: Context): Caller => ({ author: c.get("author"), role: c.get("role") });
  const contextFor = (c: Context): PrincipalContext => contextOf(callerOf(c)) ?? fail("FORBIDDEN", "The name of this token cannot hold a role.");
  /** Who may do what on a deck: a delete and the share routes need an owner, a read needs a viewer, any other change needs an editor. */
  const actionOf = (method: string, rest: string): "read" | "write" | "admin" => {
    if (/^\/(access|grants|invites|links)(\/|$)/.test(rest) || (method === "DELETE" && rest === "")) return "admin";
    return method === "GET" || method === "HEAD" ? "read" : "write";
  };
  // A deck with an owner is open to the people and agents that hold a role on it. A caller with no role learns nothing: the answer is the one for a missing deck.
  api.use("/decks/:deck/*", async (c, next) => {
    const id = c.req.param("deck");
    if (!sharing || !store || !DECK_ID.test(id)) return next();
    const owned = await store.get<{ type?: string }>("resources", id);
    if (!owned) {
      // Made before sharing, or no deck at all. The deck routes answer as before. The share routes have no owner to ask.
      if (!SHARE_ROUTE.test(c.req.path)) return next();
      await service.exists(id);
      return c.json(failure("FORBIDDEN", "This deck has no owner, so it cannot be shared."), 403);
    }
    const ctx = contextOf(callerOf(c));
    const decision = owned.type === DECK && ctx ? await sharing.can(ctx, actionOf(c.req.method, c.req.path.replace(/^.*?\/decks\/[^/]+/, "")), id) : { allowed: false };
    if (!decision.allowed && !("role" in decision && decision.role) && ctx && owned.type === DECK) {
      // The scope of the token can stop an action before the role is read. A caller with a role gets 403, not the answer for a missing deck.
      // A plain read of the grant, so no audit row says that the caller did something that its token cannot do.
      const subject = subjectOf(callerOf(c));
      const grant = subject && (await store.query<{ role?: string }>("grants", { where: { resourceId: id, subjectKind: subject.kind, subjectId: subject.id }, limit: 1 })).items[0];
      if (grant && (ROLES as readonly unknown[]).includes(grant.data.role)) return c.json(failure("FORBIDDEN", "This token cannot do this. It may only read."), 403);
    }
    if (!decision.allowed) {
      return "role" in decision && decision.role
        ? c.json(failure("FORBIDDEN", `This caller is ${decision.role === "owner" ? "an owner" : `a ${decision.role}`} of the deck. It cannot do this.`), 403)
        : c.json(failure("NO_DECK", `no deck "${id}"`), 404);
    }
    // The room gets the role to match: only an editor or an owner may write there.
    const role = (decision as { role?: string }).role;
    c.set("role", role === "owner" || role === "editor" ? c.get("role") : "viewer");
    await next();
  });

  // Who the token stands for. A live client reads its author kind here, so it never claims one.
  api.get("/me", (c) => c.json({ ...c.get("author"), role: c.get("role"), subject: subjectOf(callerOf(c)) }));

  // The live room of a deck. The token sets the author kind and the role. A viewer joins and reads, and the room drops its writes.
  api.get("/decks/:deck/ws", async (c) => {
    if (!live) return c.json(failure("NOT_FOUND", "This server hosts no live rooms."), 404);
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") return c.json(failure("UPGRADE_REQUIRED", "Open this route as a WebSocket."), 426);
    const id = c.req.param("deck");
    await service.exists(id); // a deck that does not exist has no room
    const { kind, name } = c.get("author");
    const room = await live(c.env).connect(id, c.req.raw, { principal: { id: `${kind}:${name}`, kind }, role: c.get("role"), name });
    // The browser closes the socket unless the answer names the subprotocol that it offered. The answer never names the entry with the token.
    return acceptWebSocketProtocol(c.req.raw, room, ROOM_PROTOCOL);
  });
  // A live room reads its start state here and saves its state back.
  api.get("/decks/:deck/state", async (c) => c.body((await service.state(c.req.param("deck"))) as Uint8Array<ArrayBuffer>, 200, { "content-type": "application/octet-stream" }));
  api.post(
    "/decks/:deck/checkpoint",
    bodyLimit({ maxSize: MAX_LIVE_BYTES, onError: (c) => c.json(failure("TOO_LARGE", "The update is too large."), 413) }),
    async (c) => {
      const id = c.req.param("deck");
      const update = new Uint8Array(await c.req.arrayBuffer());
      await service.exists(id);
      // The room knows who sent updates. Those people and agents may label a change, with the caller, while a configured token still names them.
      // A token that was removed keeps its record in the room, but its label is no longer trusted.
      const seen = live ? (await live(c.env).meta(id)).contributors : [];
      const allowed = [c.get("author"), ...seen.filter((who) => configured.has(who.id)).map((who) => parsePrincipal(who.id))];
      await service.checkpoint(id, update, allowed);
      return c.json({ ok: true });
    },
  );

  api.post("/decks", async (c) => {
    const input = body.create.parse(await c.req.json());
    const author = c.get("author");
    if (!sharing) return c.json(await service.create({ ...input, author }), 201);
    // The owner record comes first, so the deck is never open to every editor, not even for a moment. One caller wins a race for an id.
    const ctx = contextFor(c);
    const id = input.id ?? `d${bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(5)))}`;
    if (!DECK_ID.test(id)) return fail("INVALID_ID", `"${id}" is not a valid deck id`);
    // A deck that exists already is not claimed here: a deck made before sharing keeps no owner.
    if (await service.exists(id).then(() => true, (error: unknown) => (error instanceof SlidesError && error.code === "NO_DECK" ? false : Promise.reject(error)))) {
      return fail("DECK_EXISTS", `deck "${id}" exists`);
    }
    await viaSharing(() => sharing.createResource(ctx, { id, type: DECK }));
    try {
      await service.create({ ...input, id, author });
    } catch (error) {
      await sharing.deleteResource(ctx, id).catch(() => undefined);
      throw error;
    }
    return c.json({ id }, 201);
  });
  api.get("/decks", async (c) => {
    const { limit = DEFAULT_LISTED, cursor } = body.page.parse({ limit: c.req.query("limit"), cursor: c.req.query("cursor") });
    if (!sharing || !store) return c.json(await service.list({ limit, cursor }));
    // A deck with an owner shows only to a caller with a role. A page is filled from later pages, and the cursor stands after the last deck that it returns.
    // A caller then gets no cursor of a deck that it cannot see, unless the scan stops at `MAX_SCANNED` decks.
    // The check is a plain read of the roles of the caller: a list writes no audit row, and a call reads a bounded number of records.
    const subject = subjectOf(callerOf(c));
    const held = new Set<string>();
    if (subject) {
      for (let at: string | undefined, n = 0; n < MAX_HELD_PAGES; n++) {
        const roles = await store.query<{ resourceId?: string; role?: string }>("grants", { where: { subjectKind: subject.kind, subjectId: subject.id }, limit: 200, ...(at === undefined ? {} : { cursor: at }) });
        // Only a role that identity honors counts. A record with another role holds nothing.
        for (const { data } of roles.items) if (typeof data.resourceId === "string" && (ROLES as readonly unknown[]).includes(data.role)) held.add(data.resourceId);
        if ((at = roles.nextCursor) === undefined) break;
      }
    }
    const decks: Awaited<ReturnType<Service["list"]>>["decks"] = [];
    let scanned = 0;
    let next: string | undefined = cursor;
    for (;;) {
      const page = await service.list({ limit: limit - decks.length, cursor: next });
      scanned += page.decks.length;
      for (const deck of page.decks) {
        const owned = await store.get<{ type?: string }>("resources", deck.id);
        if (!owned || (owned.type === DECK && held.has(deck.id))) decks.push(deck);
      }
      next = page.nextCursor;
      if (decks.length >= limit || next === undefined || scanned >= MAX_SCANNED) break;
    }
    return c.json({ decks, ...(next === undefined ? {} : { nextCursor: next }) });
  });
  api.delete("/decks/:deck", async (c) => {
    const id = c.req.param("deck");
    const ctx = sharing && contextOf(callerOf(c));
    // A deck can be gone while its owner record stays, after a failed delete. The owner can finish the erase.
    const gone = await service.exists(id).then(() => false, (error: unknown) => (error instanceof SlidesError && error.code === "NO_DECK" ? true : Promise.reject(error)));
    const owned = Boolean(sharing && ctx && store && DECK_ID.test(id) && (await store.get("resources", id)));
    if (gone && !owned) await service.exists(id);
    if (!gone) {
      // Clear the live room first: it keeps the deck state, and a new deck with the same id must not read it.
      if (live) await live(c.env).erase(id);
      await service.deleteDeck(id, c.get("author"));
    }
    // The deck is gone. Erase its roles, links, and invites, so a new deck with the same id starts clean.
    if (sharing && ctx && owned) await viaSharing(() => sharing.deleteResource(ctx, id));
    return c.json({ ok: true });
  });
  api.get("/decks/:deck", async (c) => c.json(await service.outline(c.req.param("deck"))));
  api.post("/decks/:deck/slides", async (c) => {
    const input = body.add.parse(await c.req.json());
    return c.json(await service.addSlides(c.req.param("deck"), { ...input, images: decodeImages(input.images), author: c.get("author") }), 201);
  });
  api.put("/decks/:deck/slides/:slide", async (c) => {
    const input = body.set.parse(await c.req.json());
    await service.setSlide(c.req.param("deck"), c.req.param("slide"), { outline: input.outline, images: decodeImages(input.images), author: c.get("author") });
    return c.json({ ok: true });
  });
  api.patch("/decks/:deck/slides/:slide/elements/:element", async (c) => {
    const input = patch.parse(await c.req.json());
    await service.editElement(c.req.param("deck"), c.req.param("slide"), c.req.param("element"), input, c.get("author"));
    return c.json({ ok: true });
  });
  api.post("/decks/:deck/slides/:slide/move", async (c) => {
    const { to } = body.move.parse(await c.req.json());
    await service.moveSlide(c.req.param("deck"), c.req.param("slide"), to, c.get("author"));
    return c.json({ ok: true });
  });
  api.delete("/decks/:deck/slides/:slide", async (c) => {
    await service.deleteSlide(c.req.param("deck"), c.req.param("slide"), c.get("author"));
    return c.json({ ok: true });
  });
  api.get("/decks/:deck/render", async (c) => {
    const present = c.req.query("present") === "1";
    const html = await service.render(c.req.param("deck"), { present });
    return c.html(html, 200, { "content-security-policy": present ? PRESENT_CSP : CSP });
  });
  api.get("/decks/:deck/export", async (c) => {
    if ((c.req.query("format") ?? "pdf") !== "pdf") return c.json(failure("BAD_REQUEST", "format must be pdf."), 400);
    const { bytes, warnings } = await service.exportPdf(c.req.param("deck"));
    if (c.req.query("envelope") === "json") return c.json({ pdfBase64: toBase64(bytes), bytes: bytes.length, warnings });
    return c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
      "content-type": "application/pdf",
      "content-disposition": 'attachment; filename="deck.pdf"',
      "x-slides-warnings-count": String(warnings.length),
      "x-slides-warnings": warningsSummary(warnings),
    });
  });

  // Sharing. Identity decides who may share: the guard above has checked for an owner already, and identity checks again.
  const needSharing = () => sharing ?? fail("INVALID_SHARE", "This server keeps no roles. Sharing is off.");
  const lifetime = (ms: number | undefined) => (ms === undefined ? {} : { expiresAt: Date.now() + ms });
  api.get("/decks/:deck/access", async (c) => {
    const id = c.req.param("deck");
    const { limit, cursor, inviteCursor, linkCursor } = body.access.parse({ limit: c.req.query("limit"), cursor: c.req.query("cursor"), inviteCursor: c.req.query("inviteCursor"), linkCursor: c.req.query("linkCursor") });
    const share = needSharing();
    const ctx = contextFor(c);
    const grants = await viaSharing(() => share.listGrants(ctx, id, { limit, cursor }));
    const invites = await viaSharing(() => share.listInvites(ctx, id, { limit, cursor: inviteCursor }));
    // A link token is never shown: the store keeps only its hash.
    const links = await viaSharing(() => store!.query<Record<string, Json>>("links", { where: { resourceId: id }, limit: limit ?? 50, ...(linkCursor === undefined ? {} : { cursor: linkCursor }) }));
    return c.json({
      grants: grants.grants,
      invites: invites.invites,
      links: links.items.map(({ data: l }) => ({ id: l.id, role: l.role, signedInOnly: l.signedInOnly === true, expiresAt: l.expiresAt ?? null, revoked: l.revokedAt != null })),
      ...(grants.nextCursor === undefined ? {} : { nextCursor: grants.nextCursor }),
      ...(invites.nextCursor === undefined ? {} : { nextInviteCursor: invites.nextCursor }),
      ...(links.nextCursor === undefined ? {} : { nextLinkCursor: links.nextCursor }),
    });
  });
  api.post("/decks/:deck/grants", async (c) => {
    const input = body.grant.parse(await c.req.json());
    const share = needSharing();
    const id = c.req.param("deck");
    const subject = { kind: input.subjectKind, id: input.subjectId };
    await viaSharing(() => share.grant(contextFor(c), id, subject, input.role));
    // An open room keeps the role from connect time. The new role reaches it now. A lower role caps the sockets, and the room drops their writes.
    // A role that can write lifts the cap or the ban that an earlier change left.
    if (live) for (const who of roomPrincipals(subject)) await live(c.env).updateRole(id, who, input.role === "owner" || input.role === "editor" ? null : "viewer");
    return c.json({ ok: true });
  });
  api.delete("/decks/:deck/grants", async (c) => {
    const input = body.grant.omit({ role: true }).parse({ subjectKind: c.req.query("subjectKind"), subjectId: c.req.query("subjectId") });
    const share = needSharing();
    const id = c.req.param("deck");
    const subject = { kind: input.subjectKind, id: input.subjectId };
    await viaSharing(() => share.revokeGrant(contextFor(c), id, subject));
    // The revoked caller leaves an open room at once, and the room refuses it until a grant lifts the ban.
    if (live) for (const who of roomPrincipals(subject)) await live(c.env).revoke(id, who);
    return c.json({ ok: true });
  });
  // An invite sends no message. The owner gives the id to the person or the agent.
  api.post("/decks/:deck/invites", async (c) => {
    const input = body.invite.parse(await c.req.json());
    const share = needSharing();
    return c.json(await viaSharing(() => share.createInvite(contextFor(c), c.req.param("deck"), input)), 201);
  });
  api.post("/decks/:deck/links", async (c) => {
    const input = body.link.parse(await c.req.json());
    const share = needSharing();
    const made = await viaSharing(() => share.createLink(contextFor(c), c.req.param("deck"), { role: input.role, signedInOnly: input.signedInOnly === true, ...lifetime(input.expiresInMs) }));
    return c.json(made, 201);
  });
  api.delete("/decks/:deck/links/:link", async (c) => {
    const share = needSharing();
    await viaSharing(() => share.revokeLink(contextFor(c), c.req.param("link")));
    return c.json({ ok: true });
  });
  // A token has no verified email, so only an invite by handle can be accepted here. The handle is the name of the token.
  api.post("/invites/accept", async (c) => {
    const { id } = body.accept.parse(await c.req.json());
    const share = needSharing();
    // Only an agent with its own identity holds a handle. A delegated token has the name of its agent, but not its identity.
    if (c.get("author").kind !== "agent") return fail("FORBIDDEN", "Only an agent token can accept an invite by handle.");
    const invite = await store!.get<{ resourceId?: string; role?: string }>("invites", id);
    await viaSharing(() => share.acceptInvite(contextFor(c), id, { handle: c.get("author").name }));
    // A ban from an earlier revoke ends. An accept never lowers a role, so the room needs no cap: a socket that is open keeps the role that it has.
    const subject = subjectOf(callerOf(c));
    if (live && subject && typeof invite?.resourceId === "string") for (const who of roomPrincipals(subject)) await live(c.env).updateRole(invite.resourceId, who, null);
    return c.json({ ok: true });
  });

  // A visitor reads a deck with a link token in `x-link-token`. A bearer token, if sent, must be valid. A role from a link is for reading only.
  const shared = new Hono<{ Variables: { author: Principal; role: SlidesRole } }>();
  const visit = async (c: Context): Promise<{ id: string } | Response> => {
    const id = c.req.param("deck") ?? "";
    const token = c.req.header("x-link-token");
    let ctx: PrincipalContext | null = null;
    if (c.req.header("authorization") !== undefined) {
      const caller = await auth(c.req.raw);
      if (!caller) return c.json(failure("UNAUTHORIZED", "Send a valid bearer token."), 401, { "www-authenticate": "Bearer" });
      ctx = contextOf(caller);
    }
    const gone = c.json(failure("NO_DECK", `no deck "${id}"`), 404);
    if (!sharing || !store || !token || !DECK_ID.test(id)) return gone;
    // An id with no deck record gets no check, so a caller with no token cannot make audit rows for ids that never existed.
    if ((await store.get<{ type?: string }>("resources", id))?.type !== DECK) return gone;
    // A deck with no link has nothing to check a link token against, and a check would only write an audit row.
    if (ctx === null && (await store.query("links", { where: { resourceId: id }, limit: 1 })).items.length === 0) return gone;
    return (await sharing.can(ctx, "read", id, { linkToken: token })).allowed ? { id } : gone;
  };
  shared.get("/:deck", async (c) => {
    const seen = await visit(c);
    return seen instanceof Response ? seen : c.json(await service.outline(seen.id));
  });
  shared.get("/:deck/render", async (c) => {
    const seen = await visit(c);
    if (seen instanceof Response) return seen;
    const present = c.req.query("present") === "1";
    return c.html(await service.render(seen.id, { present }), 200, { "content-security-policy": present ? PRESENT_CSP : CSP });
  });

  // The visitor routes come first, so the bearer check of `api` does not run for them.
  app.route("/api/v1/slides/shared", shared);
  app.route("/api/v1/slides", api);
  app.notFound((c) => c.json(failure("NOT_FOUND", "No such route."), 404));
  app.onError((error, c) => {
    if (error instanceof SlidesError) {
      return c.json(failure(error.code, error.message, { issues: error.issues }), statusOf(error.code));
    }
    if (error instanceof ConfigError) return c.json(failure("MISCONFIGURED", "The server token setting is invalid."), 500);
    if (error instanceof z.ZodError) {
      return c.json(failure("BAD_REQUEST", "The request body is not valid.", { issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }), 400);
    }
    if (error instanceof SyntaxError) return c.json(failure("BAD_REQUEST", "The request body must be JSON."), 400);
    // Log the name. Log the message only for a D1 error: it holds a reference, not slide text.
    console.error(`unhandled ${error.name}`, error.message.startsWith("D1_ERROR") ? error.message : "");
    return c.json(failure("INTERNAL", "The server could not finish the request."), 500);
  });
  return app;
}
