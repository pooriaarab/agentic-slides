import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { type AdapterOptions, type Blobs, type Store, StoreConflictError } from "agentic-identity";
import { type FileBlobsOptions, createFileBlobs as identityBlobs, createFileStore as identityStore } from "agentic-identity/file";

export interface FileStoreOptions extends AdapterOptions {
  /** How long a call that keeps conflicting runs again before it fails. Default 30 seconds. */
  waitMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const wait = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Version 0.8.0 kept `{ clock, tables: { collection: { id: { v, doc } } } }`. The identity adapter reads
 * `{ format, collections: { collection: { id: doc } } }`. Convert an old file once, under the lock of the
 * identity adapter, so a decks folder from 0.8.0 still opens.
 */
function migrateStoreFile(path: string) {
  if (!existsSync(path)) return;
  const convert = (text: string): string | null => {
    const raw: unknown = JSON.parse(text);
    if (!isObject(raw) || "format" in raw || !isObject(raw.tables)) return null;
    const collections: Record<string, Record<string, unknown>> = {};
    for (const [name, rows] of Object.entries(raw.tables)) {
      if (!isObject(rows)) throw new Error(`"${path}" is not an agentic-slides data file`);
      collections[name] = {};
      for (const [id, row] of Object.entries(rows)) {
        if (!isObject(row) || !isObject(row.doc)) throw new Error(`"${path}" is not an agentic-slides data file`);
        collections[name]![id] = row.doc;
      }
    }
    return JSON.stringify({ format: 1, collections });
  };
  if (convert(readFileSync(path, "utf8")) === null) return;
  const lock = `${path}.lock`;
  const mine = `${process.pid}:${randomBytes(8).toString("hex")}`;
  for (const start = Date.now(); ; wait(10)) {
    try {
      writeFileSync(lock, mine, { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 3_000) unlinkSync(lock);
      } catch {}
      if (Date.now() - start > 10_000) throw new StoreConflictError("the store file is locked by another process");
    }
  }
  try {
    // Another process can have converted the file while this one waited, so read it again.
    const next = convert(readFileSync(path, "utf8"));
    if (next === null) return;
    const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(temp, next, { mode: 0o600 });
    renameSync(temp, path);
  } finally {
    try {
      if (readFileSync(lock, "utf8") === mine) unlinkSync(lock);
    } catch {}
  }
}

/** The identity file store reports a write from another process as a conflict. The Store port wants the call to run again. */
async function again<T>(waitMs: number, run: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + waitMs;
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof StoreConflictError) || Date.now() >= deadline) throw error;
      await sleep(Math.random() * Math.min(5 * attempt, 100));
    }
  }
}

/**
 * A Store kept in one JSON file under `dir`. It is the file adapter of `agentic-identity`. A write or a
 * transaction that conflicts with another process runs again until `waitMs` has passed. A read does not
 * conflict, so it does not run again.
 */
export function createFileStore(dir: string, options: FileStoreOptions = {}): Store {
  const { waitMs = 30_000, ...rest } = options;
  const path = join(dir, "store.json");
  migrateStoreFile(path);
  const store = identityStore({ ...rest, path });
  return {
    region: store.region,
    get: (collection, id) => store.get(collection, id),
    query: (collection, query) => store.query(collection, query),
    put: (collection, id, doc) => again(waitMs, () => store.put(collection, id, doc)),
    delete: (collection, id) => again(waitMs, () => store.delete(collection, id)),
    transaction: (fn) => again(waitMs, () => store.transaction(fn)),
  };
}

/** The blob files of 0.8.0 are `<dir>/blobs/<sha256 of the key>`, with an optional `.type` file. Every key is `sha256-<hex of the bytes>`. */
async function migrateBlobs(dir: string, blobs: Blobs) {
  const root = join(dir, "blobs");
  if (!existsSync(root)) return;
  for (const name of readdirSync(root)) {
    if (!/^[0-9a-f]{64}$/.test(name)) continue;
    const file = join(root, name);
    let data: Uint8Array;
    try {
      data = new Uint8Array(readFileSync(file));
    } catch {
      continue;
    }
    const typeFile = `${file}.type`;
    const contentType = existsSync(typeFile) ? readFileSync(typeFile, "utf8") || undefined : undefined;
    await blobs.put(`sha256-${createHash("sha256").update(data).digest("hex")}`, data, { contentType, ifNoneMatch: "*" });
    rmSync(file, { force: true });
    rmSync(typeFile, { force: true });
  }
}

/** Blobs kept as files under `<dir>/blobs`. It is the file adapter of `agentic-identity`. `signedUrl` needs `urlBase` and `urlSecret`. */
export function createFileBlobs(dir: string, options: Omit<FileBlobsOptions, "dir"> = {}): Blobs {
  const blobs = identityBlobs({ ...options, dir });
  let ready: Promise<void> | undefined;
  const migrated = () => (ready ??= migrateBlobs(dir, blobs).catch((error: unknown) => {
    ready = undefined;
    throw error;
  }));
  return {
    region: blobs.region,
    put: async (key, data, opts) => (await migrated(), blobs.put(key, data, opts)),
    get: async (key) => (await migrated(), blobs.get(key)),
    head: async (key) => (await migrated(), blobs.head(key)),
    delete: async (key) => (await migrated(), blobs.delete(key)),
    signedUrl: (key, opts) => blobs.signedUrl(key, opts),
  };
}
