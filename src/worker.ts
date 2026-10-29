import { createStoreAuth, hasScope, parseRegion, resolveChain, type Region, type Store } from "agentic-identity";
import type { Realtime } from "agentic-realtime";
import { createR2Blobs, createD1Store, D1_SCHEMA, type D1Like, type R2Like } from "agentic-identity/cloudflare";
import { bytesToHex } from "@noble/hashes/utils.js";
import { subjectOf } from "./access.js";
import { createApp } from "./api.js";
import { ConfigError, NotGrantedError, parseTokens, tokenAuth, type Authenticator } from "./auth.js";
import { checkAuthor, type Principal } from "./core/principal.js";
import { createService } from "./service.js";

export interface WorkerEnv {
  /** The D1 database. Create it in the EU: `wrangler d1 create agentic-slides --location weur`. */
  DB?: D1Like;
  /** The R2 bucket for images. Create it in the EU: `wrangler r2 bucket create agentic-slides-images --jurisdiction eu`. */
  IMAGES?: R2Like;
  /**
   * Dev fallback. Set it to "1" to let `SLIDES_TOKENS` sign requests in. Without it, `SLIDES_TOKENS` is not read,
   * and an API call that sets it gets 500, so a deploy never trusts a static list by accident. Never set it in production.
   */
  SLIDES_UNSAFE_STATIC_TOKENS?: string;
  /** Dev fallback, read only when `SLIDES_UNSAFE_STATIC_TOKENS` is "1". `token=kind:name,token=kind:name`. It is tried before the identity credentials. */
  SLIDES_TOKENS?: string;
  /** The region both adapters declare. It is "eu" unless this says otherwise. "unknown" is for local runs, where D1 does not report a region. */
  SLIDES_REGION?: string;
}

/** Makes the live room server for a Worker. The region is the claim that D1 and R2 already use. */
export type LiveFactory = (env: never, region: Region) => Realtime;

// Both resources are declared in wrangler.jsonc as EU resources, so the adapters claim "eu" by default.
// With "eu" the D1 adapter refuses any query that D1 did not report as served in the EU.

/** The static list as an authenticator, and the people and agents that it names. A bad setting names none. */
function tokensOf(config: string | undefined): { auth: Authenticator; principals: Principal[] } {
  try {
    const tokens = parseTokens(config);
    // Sharing keeps roles by a subject id of 1 to 128 of A-Z a-z 0-9 _ -. A name outside that could hold no role, so the setting is refused.
    if (tokens.some(([, caller]) => subjectOf(caller) === null)) throw new ConfigError("a token name needs 1 to 128 of A-Z a-z 0-9 _ -, and an agent name cannot start with a delegated kind and an underscore");
    // A viewer's token cannot write, so its name is no trusted label.
    return { auth: tokenAuth(tokens), principals: tokens.filter(([, caller]) => caller.role === "editor").map(([, caller]) => caller.author) };
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return { auth: refuse(error), principals: [] };
  }
}

const refuse = (error: Error): Authenticator => async () => {
  throw error;
};

/**
 * Credentials and principals in the Store (agentic-identity). The scopes of the principal set the role: `slides:write` is an editor,
 * `slides:read` a viewer, and none is a 403. A store that fails throws, so it is never a 401. The kind of the principal stays on the author.
 */
function identityAuth(store: Store): Authenticator {
  const port = createStoreAuth(store);
  return async (request) => {
    // Only a bearer token signs in. The store also reads a session cookie, and a cookie that a browser sends by itself must not write.
    const token = /^bearer (\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
    if (token === undefined) return null;
    const found = await port.authenticate(new Request(request.url, { headers: { authorization: `Bearer ${token}` } }));
    if (!found) return null;
    let author: Principal;
    try {
      author = checkAuthor({ kind: found.kind, name: found.principalId });
    } catch {
      throw new NotGrantedError("principal has no valid kind");
    }
    // A principal id that cannot be a sharing subject (for example one with a dot) could hold no role, so it is refused here.
    if (subjectOf({ author, role: "viewer" }) === null) throw new NotGrantedError("principal id cannot hold a role");
    const role = hasScope(found.scopes, "slides:write") ? "editor" : hasScope(found.scopes, "slides:read") ? "viewer" : null;
    if (!role) throw new NotGrantedError("no slides scope");
    return { author, role };
  };
}

/** True when the principal `<kind>:<name>` is in the Store with a valid chain and holds `slides:write` now. A failed read is not trust. */
function identityTrusted(store: Store): (id: string) => Promise<boolean> {
  return async (id) => {
    const cut = id.indexOf(":");
    const kind = id.slice(0, cut);
    const name = id.slice(cut + 1);
    if (cut < 0) return false;
    try {
      const found = await resolveChain(name, async (key) => (await store.get("principals", key)) as never, { now: Date.now() });
      return found.ok && found.kind === kind && hasScope(found.scopes, "slides:write");
    } catch {
      return false;
    }
  };
}

/**
 * The default is identity credentials. The static list is a dev fallback: with `SLIDES_UNSAFE_STATIC_TOKENS=1` it is tried first.
 * A list without the switch makes every API call fail with a config error, so a deploy never trusts it by accident.
 */
function workerAuth(config: string | undefined, unsafe: boolean, store: Store): { auth: Authenticator; principals: Principal[]; trusted: (id: string) => Promise<boolean> } {
  const trusted = identityTrusted(store);
  if (config?.trim() && !unsafe) return { auth: refuse(new ConfigError("SLIDES_TOKENS needs SLIDES_UNSAFE_STATIC_TOKENS=1")), principals: [], trusted };
  const identity = identityAuth(store);
  if (!unsafe) return { auth: identity, principals: [], trusted };
  const { auth: dev, principals } = tokensOf(config);
  return { auth: async (request) => (await dev(request)) ?? (await identity(request)), principals, trusted };
}

/** The schema is created once per database. A failed attempt is not kept, so the next request tries again. */
const schemas = new WeakMap<object, Promise<unknown>>();
async function ensureSchema(db: D1Like): Promise<void> {
  let ready = schemas.get(db);
  if (!ready) {
    ready = db.prepare(D1_SCHEMA).run().catch((error: unknown) => {
      schemas.delete(db);
      throw error;
    });
    schemas.set(db, ready);
  }
  await ready;
}

// `signedUrl` is the one Blobs call that needs a secret, and this package never calls it.
// A random secret per isolate (made on first use, as a Worker may not draw random bytes at load) satisfies the adapter and signs nothing that outlives the isolate.
let urlSecret: string | undefined;

export interface WorkerOptions {
  /** Hosts a live room for each deck. Without it, the room route answers 404. */
  live?: LiveFactory;
}

/** The Worker. `live-worker.ts` adds live rooms, because the Durable Object code cannot load outside a Worker. */
export function createWorker(options: WorkerOptions = {}) {
  let cached: { db: D1Like; images: R2Like; config: string | undefined; unsafe: boolean; region: string | undefined; app: ReturnType<typeof createApp> } | undefined;

  function appFor(db: D1Like, images: R2Like, config: string | undefined, unsafe: boolean, region: string | undefined) {
    if (cached?.db !== db || cached.images !== images || cached.config !== config || cached.unsafe !== unsafe || cached.region !== region) {
      const declared = parseRegion(region ?? "eu");
      const store = createD1Store(db, { region: declared });
      const service = createService({
        store,
        blobs: createR2Blobs(images, { region: declared, urlBase: "https://slides.invalid/blob", urlSecret: (urlSecret ??= bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(32)))) }),
      });
      const live = options.live;
      const { auth, principals, trusted } = workerAuth(config, unsafe, store);
      cached = { db, images, config, unsafe, region, app: createApp({ service, auth, principals, trusted, store, live: live && ((env) => live(env as never, declared)) }) };
    }
    return cached.app;
  }

  return {
    async fetch(request: Request, env: WorkerEnv, ctx?: unknown): Promise<Response> {
      const missing = env.DB ? (env.IMAGES ? undefined : "bind an R2 bucket as IMAGES") : "bind a D1 database as DB";
      if (missing || !env.DB || !env.IMAGES) {
        return Response.json({ error: { code: "MISCONFIGURED", message: missing } }, { status: 500 });
      }
      try {
        parseRegion(env.SLIDES_REGION ?? "eu");
      } catch {
        return Response.json({ error: { code: "MISCONFIGURED", message: 'SLIDES_REGION must be "eu", "us", or "unknown"' } }, { status: 500 });
      }
      try {
        await ensureSchema(env.DB);
      } catch {
        return Response.json({ error: { code: "UNAVAILABLE", message: "the database is not ready. Try again" } }, { status: 503 });
      }
      return appFor(env.DB, env.IMAGES, env.SLIDES_TOKENS, env.SLIDES_UNSAFE_STATIC_TOKENS === "1", env.SLIDES_REGION).fetch(request, env, ctx as never);
    },
  };
}

export default createWorker();
