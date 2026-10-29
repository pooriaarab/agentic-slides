import { parseRegion } from "agentic-identity";
import { createR2Blobs, createD1Store, D1_SCHEMA, type D1Like, type R2Like } from "agentic-identity/cloudflare";
import { bytesToHex } from "@noble/hashes/utils.js";
import { createApp } from "./api.js";
import { ConfigError, parseTokens, tokenAuth, type Authenticator } from "./auth.js";
import { createService } from "./service.js";

export interface WorkerEnv {
  /** The D1 database. Create it in the EU: `wrangler d1 create agentic-slides --location weur`. */
  DB?: D1Like;
  /** The R2 bucket for images. Create it in the EU: `wrangler r2 bucket create agentic-slides-images --jurisdiction eu`. */
  IMAGES?: R2Like;
  /** Secret. `token=kind:name,token=kind:name`. With none set, every API call is refused. */
  SLIDES_TOKENS?: string;
  /** The region both adapters declare. It is "eu" unless this says otherwise. "unknown" is for local runs, where D1 does not report a region. */
  SLIDES_REGION?: string;
}

// Both resources are declared in wrangler.jsonc as EU resources, so the adapters claim "eu" by default.
// With "eu" the D1 adapter refuses any query that D1 did not report as served in the EU.

function authenticator(config: string | undefined): Authenticator {
  try {
    return tokenAuth(parseTokens(config));
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return async () => {
      throw error;
    };
  }
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

let cached: { db: D1Like; images: R2Like; config: string | undefined; region: string | undefined; app: ReturnType<typeof createApp> } | undefined;

function appFor(db: D1Like, images: R2Like, config: string | undefined, region: string | undefined) {
  if (cached?.db !== db || cached.images !== images || cached.config !== config || cached.region !== region) {
    const declared = parseRegion(region ?? "eu");
    const service = createService({
      store: createD1Store(db, { region: declared }),
      blobs: createR2Blobs(images, { region: declared, urlBase: "https://slides.invalid/blob", urlSecret: (urlSecret ??= bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(32)))) }),
    });
    cached = { db, images, config, region, app: createApp({ service, auth: authenticator(config) }) };
  }
  return cached.app;
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
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
    return appFor(env.DB, env.IMAGES, env.SLIDES_TOKENS, env.SLIDES_REGION).fetch(request);
  },
};
