import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { COMMAND } from "./brand.js";
import { ConfigError, type Authenticator } from "./auth.js";
import { SlidesError, type Principal, type SlidesErrorCode } from "./core/principal.js";
import { CSP } from "./render/html.js";
import { decodeImages, images, patch } from "./schemas.js";
import type { Service } from "./service.js";
import { VERSION } from "./version.js";

export interface AppDeps {
  service: Service;
  auth: Authenticator;
}

const MAX_BODY_BYTES = 32 * 1024 * 1024;
const NOT_FOUND = new Set<SlidesErrorCode>(["NO_DECK", "NO_SLIDE", "NO_ELEMENT"]);
const BAD_REQUEST = new Set<SlidesErrorCode>(["INVALID_ID", "BAD_PATCH", "BAD_THEME", "INVALID_AUTHOR"]);

const statusOf = (code: SlidesErrorCode): 404 | 409 | 400 | 422 =>
  NOT_FOUND.has(code) ? 404 : code === "DECK_EXISTS" ? 409 : BAD_REQUEST.has(code) ? 400 : 422;

const body = {
  create: z.object({ title: z.string().min(1).max(200), id: z.string().optional() }),
  add: z.object({ outline: z.string().optional(), layout: z.string().optional(), at: z.number().int().optional(), images }),
  set: z.object({ outline: z.string(), images }),
  move: z.object({ to: z.number().int() }),
};

const failure = (code: string, message: string, extra: object = {}) => ({ error: { code, message, ...extra } });

/** The HTTP API under /api/v1/slides. It mirrors the CLI. The caller's token names the author of each edit. */
export function createApp({ service, auth }: AppDeps) {
  const app = new Hono<{ Variables: { author: Principal } }>();
  app.use("*", async (c, next) => {
    await next();
    c.header("x-content-type-options", "nosniff");
    c.header("cache-control", "no-store");
  });
  app.get("/health", (c) => c.json({ ok: true, pack: COMMAND, version: VERSION }));

  const api = new Hono<{ Variables: { author: Principal } }>();
  api.use("*", bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json(failure("TOO_LARGE", "The request body is too large."), 413) }));
  api.use("*", async (c, next) => {
    const author = await auth(c.req.raw);
    if (!author) return c.json(failure("UNAUTHORIZED", "Send a valid bearer token."), 401, { "www-authenticate": "Bearer" });
    c.set("author", author);
    await next();
  });

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
    const html = await service.render(c.req.param("deck"), { present: c.req.query("present") === "1" });
    return c.html(html, 200, { "content-security-policy": CSP });
  });
  api.get("/decks/:deck/export", async (c) => {
    if ((c.req.query("format") ?? "pdf") !== "pdf") return c.json(failure("BAD_REQUEST", "format must be pdf."), 400);
    const { bytes, warnings } = await service.exportPdf(c.req.param("deck"));
    return c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
      "content-type": "application/pdf",
      "content-disposition": 'attachment; filename="deck.pdf"',
      "x-slides-warnings": encodeURIComponent(JSON.stringify(warnings)),
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
