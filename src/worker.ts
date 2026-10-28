import { createApp } from "./api.js";
import { ConfigError, parseTokens, tokenAuth, type Authenticator } from "./auth.js";
import { createService } from "./service.js";
import { MemoryBlobs, MemoryStore } from "./store/memory.js";

export interface WorkerEnv {
  /** Secret. `token=kind:name,token=kind:name`. With none set, every API call is refused. */
  SLIDES_TOKENS?: string;
}

// Decks live in memory, per isolate. They are lost when the isolate restarts.
// Swap in durable adapters behind the same Store and Blobs ports for real use.
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
    if (cached?.config !== env.SLIDES_TOKENS || cached === undefined) {
      cached = { config: env.SLIDES_TOKENS, app: createApp({ service, auth: authenticator(env.SLIDES_TOKENS) }) };
    }
    return cached.app.fetch(request);
  },
};
