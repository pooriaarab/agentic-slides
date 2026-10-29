import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { COMMAND } from "./brand.js";
import type { Realtime } from "agentic-realtime";
import { ConfigError, type Authenticator, type SlidesRole } from "./auth.js";
import { SlidesError, type Principal, type SlidesErrorCode } from "./core/principal.js";
import { toBase64 } from "./bytes.js";
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
}

const MAX_BODY_BYTES = 32 * 1024 * 1024;
const NOT_FOUND = new Set<SlidesErrorCode>(["NO_DECK", "NO_SLIDE", "NO_ELEMENT"]);
const BAD_REQUEST = new Set<SlidesErrorCode>(["INVALID_ID", "BAD_PATCH", "BAD_THEME", "INVALID_AUTHOR", "INVALID_UPDATE"]);

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
  move: z.object({ to: z.number().int() }),
};

const failure = (code: string, message: string, extra: object = {}) => ({ error: { code, message, ...extra } });

/** The HTTP API under /api/v1/slides. It mirrors the CLI. The caller's token names the author of each edit. */
export function createApp({ service, auth, live }: AppDeps) {
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
  api.use("*", (c, next) => (c.req.path.endsWith("/checkpoint") ? next() : general(c, next)));
  api.use("*", async (c, next) => {
    const caller = await auth(c.req.raw);
    if (!caller) return c.json(failure("UNAUTHORIZED", "Send a valid bearer token."), 401, { "www-authenticate": "Bearer" });
    c.set("author", caller.author);
    c.set("role", caller.role);
    // Only a read is safe for a viewer. This holds for every route added later, too.
    if (caller.role === "viewer" && c.req.method !== "GET" && c.req.method !== "HEAD") {
      return c.json(failure("FORBIDDEN", "This token is a viewer. It cannot change a deck."), 403);
    }
    await next();
  });

  // Who the token stands for. A live client reads its author kind here, so it never claims one.
  api.get("/me", (c) => c.json({ ...c.get("author"), role: c.get("role") }));

  // The live room of a deck. The token sets the author kind and the role. A viewer joins and reads, and the room drops its writes.
  api.get("/decks/:deck/ws", async (c) => {
    if (!live) return c.json(failure("NOT_FOUND", "This server hosts no live rooms."), 404);
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") return c.json(failure("UPGRADE_REQUIRED", "Open this route as a WebSocket."), 426);
    const id = c.req.param("deck");
    await service.state(id); // a deck that does not exist has no room
    const { kind, name } = c.get("author");
    return live(c.env).connect(id, c.req.raw, { principal: { id: name, kind }, role: c.get("role"), name });
  });
  // A live room reads its start state here and saves its state back.
  api.get("/decks/:deck/state", async (c) => c.body((await service.state(c.req.param("deck"))) as Uint8Array<ArrayBuffer>, 200, { "content-type": "application/octet-stream" }));
  api.post(
    "/decks/:deck/checkpoint",
    bodyLimit({ maxSize: MAX_LIVE_BYTES, onError: (c) => c.json(failure("TOO_LARGE", "The update is too large."), 413) }),
    async (c) => {
      await service.checkpoint(c.req.param("deck"), new Uint8Array(await c.req.arrayBuffer()));
      return c.json({ ok: true });
    },
  );

  api.post("/decks", async (c) => {
    const input = body.create.parse(await c.req.json());
    return c.json(await service.create({ ...input, author: c.get("author") }), 201);
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
    // Log the error name only: a message can hold slide text.
    console.error(`unhandled ${error.name}`);
    return c.json(failure("INTERNAL", "The server could not finish the request."), 500);
  });
  return app;
}
