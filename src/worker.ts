import { createApp } from "./api.js";
import { ConfigError, parseTokens, tokenAuth, type Authenticator } from "./auth.js";
import { createService } from "./service.js";
import { MemoryBlobs, MemoryStore } from "./store/memory.js";

export interface WorkerEnv {
  /** Secret. `token=kind:name,token=kind:name`. With none set, every API call is refused. */
  SLIDES_TOKENS?: string;
  /** Set to "1" to accept that decks live in memory, per isolate, and can vanish between two requests. */
  SLIDES_UNSAFE_MEMORY_STORE?: string;
}

// A stopgap: decks live in memory, per isolate. Another isolate does not see them, and a restart loses
// them. The Worker refuses every request until SLIDES_UNSAFE_MEMORY_STORE=1. Swap in durable adapters
// behind the same Store and Blobs ports for real use.
const service = createService({ store: new MemoryStore(), blobs: new MemoryBlobs() });

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

let cached: { config: string | undefined; app: ReturnType<typeof createApp> } | undefined;

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    if (env.SLIDES_UNSAFE_MEMORY_STORE !== "1") {
      const message = "This Worker keeps decks in memory and is a demo. Set SLIDES_UNSAFE_MEMORY_STORE=1 to run it anyway.";
      return Response.json({ error: { code: "MISCONFIGURED", message } }, { status: 500 });
    }
    if (cached?.config !== env.SLIDES_TOKENS || cached === undefined) {
      cached = { config: env.SLIDES_TOKENS, app: createApp({ service, auth: authenticator(env.SLIDES_TOKENS) }) };
    }
    return cached.app.fetch(request);
  },
};
