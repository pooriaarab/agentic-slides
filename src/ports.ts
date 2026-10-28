// The parts of the agentic-identity ports that this package uses. The shapes
// match `Store` and `Blobs` there. Replace this file with an import once that
// package is on npm.
export type Scalar = string | number | boolean | null;
export type Json = Scalar | Json[] | { [key: string]: Json };
export type Doc = { [key: string]: Json };

export interface Store {
  get<T extends Doc = Doc>(collection: string, id: string): Promise<T | null>;
  /** Replaces the whole doc. */
  put<T extends Doc = Doc>(collection: string, id: string, doc: T): Promise<void>;
  /** Deleting a missing doc is not an error. */
  delete(collection: string, id: string): Promise<void>;
  /**
   * Run `fn` while no other caller changes this doc, in this process or in another one
   * that shares the backing data. A read inside `fn` sees every earlier write. A store
   * that cannot take the lock in time throws; it never runs `fn` unlocked.
   */
  exclusive<R>(collection: string, id: string, fn: () => Promise<R>): Promise<R>;
}

export interface BlobObject {
  data: Uint8Array;
  contentType?: string;
}

export interface Blobs {
  put(key: string, data: Uint8Array, options?: { contentType?: string }): Promise<void>;
  get(key: string): Promise<BlobObject | null>;
  delete(key: string): Promise<void>;
}

export function assertKey(key: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(key) || key.includes("..")) throw new Error(`invalid key "${key}"`);
}
