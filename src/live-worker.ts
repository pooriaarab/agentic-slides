import { createDurableObjectRealtime } from "agentic-realtime/worker";
import { createWorker, type WorkerEnv } from "./worker.js";

export { SyncRoom } from "agentic-realtime/worker";

type Namespace = Parameters<typeof createDurableObjectRealtime>[0];

export interface LiveEnv extends WorkerEnv {
  /** Durable Object namespace of the live rooms. Bind `SyncRoom` to it. */
  SYNC_ROOM?: Namespace;
}

/**
 * The Worker with live rooms. One Durable Object holds one deck. A room sits in the EU jurisdiction when the
 * region is "eu". Durable Objects have no US jurisdiction: with "us" a room sits near the first client that opens it.
 */
export default createWorker({
  live: (env: LiveEnv, region) => {
    if (!env.SYNC_ROOM) throw new Error("bind a Durable Object namespace as SYNC_ROOM");
    return createDurableObjectRealtime(env.SYNC_ROOM, region === "eu" ? "eu" : undefined);
  },
});
