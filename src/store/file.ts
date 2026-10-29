import { join } from "node:path";
import { type AdapterOptions, type Blobs, type Store, StoreConflictError } from "agentic-identity";
import { type FileBlobsOptions, createFileBlobs as identityBlobs, createFileStore as identityStore } from "agentic-identity/file";

const MAX_ATTEMPTS = 50;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The identity file store reports a write from another process as a conflict. The Store port wants the call to run again. */
async function again<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof StoreConflictError) || attempt >= MAX_ATTEMPTS) throw error;
      await sleep(Math.random() * Math.min(5 * attempt, 100));
    }
  }
}

/** A Store kept in one JSON file under `dir`. It is the file adapter of `agentic-identity`, and a write from another process runs the call again. */
export function createFileStore(dir: string, options: AdapterOptions = {}): Store {
  const store = identityStore({ ...options, path: join(dir, "store.json") });
  return {
    region: store.region,
    get: (collection, id) => store.get(collection, id),
    query: (collection, query) => store.query(collection, query),
    put: (collection, id, doc) => again(() => store.put(collection, id, doc)),
    delete: (collection, id) => again(() => store.delete(collection, id)),
    transaction: (fn) => again(() => store.transaction(fn)),
  };
}

/** Blobs kept as files under `dir`. It is the file adapter of `agentic-identity`. */
export function createFileBlobs(dir: string, options: Omit<FileBlobsOptions, "dir"> = {}): Blobs {
  return identityBlobs({ ...options, dir });
}
