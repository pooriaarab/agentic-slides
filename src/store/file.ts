import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fail } from "../core/principal.js";
import { assertKey, type Blobs, type BlobObject, type Doc, type Store } from "../ports.js";

const missing = (error: unknown): boolean => (error as { code?: string }).code === "ENOENT";

async function write(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, data);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** A lock file older than this is left over from a process that died. A held lock is touched much more often. */
const STALE_MS = 30_000;

/** A store on disk: `<root>/store/<collection>/<id>.json`. Several processes can share it. */
export class FileStore implements Store {
  private readonly lockTimeoutMs: number;

  constructor(
    private readonly root: string,
    options: { lockTimeoutMs?: number } = {},
  ) {
    this.lockTimeoutMs = options.lockTimeoutMs ?? 10_000;
  }

  private path(collection: string, id: string): string {
    assertKey(collection);
    assertKey(id);
    return join(this.root, "store", collection, `${id}.json`);
  }

  async get<T extends Doc = Doc>(collection: string, id: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(this.path(collection, id), "utf8")) as T;
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }

  async put<T extends Doc = Doc>(collection: string, id: string, doc: T): Promise<void> {
    await write(this.path(collection, id), JSON.stringify(doc));
  }

  async delete(collection: string, id: string): Promise<void> {
    await rm(this.path(collection, id), { force: true });
  }

  /** One lock file per doc, made with O_EXCL. The holder writes a token and removes the file only if the token is still its own. */
  async exclusive<R>(collection: string, id: string, fn: () => Promise<R>): Promise<R> {
    const lock = `${this.path(collection, id)}.lock`;
    const token = randomUUID();
    const deadline = Date.now() + this.lockTimeoutMs;
    await mkdir(dirname(lock), { recursive: true });
    for (let wait = 5; ; wait = Math.min(wait * 2, 100)) {
      try {
        const handle = await open(lock, "wx");
        await handle.writeFile(token);
        await handle.close();
        break;
      } catch (error) {
        if ((error as { code?: string }).code !== "EEXIST") throw error;
      }
      const age = await stat(lock).then((s) => Date.now() - s.mtimeMs, () => 0);
      if (age > STALE_MS) await rm(lock, { force: true });
      else if (Date.now() >= deadline) fail("STORE_BUSY", `"${id}" is locked by another writer. Try again`);
      else await sleep(wait);
    }
    try {
      return await fn();
    } finally {
      if ((await readFile(lock, "utf8").catch(() => "")) === token) await rm(lock, { force: true });
    }
  }
}

/** Blobs on disk: `<root>/blobs/<key>`, with the content type beside it. */
export class FileBlobs implements Blobs {
  constructor(private readonly root: string) {}

  private path(key: string): string {
    assertKey(key);
    return join(this.root, "blobs", key);
  }

  async put(key: string, data: Uint8Array, options: { contentType?: string } = {}): Promise<void> {
    await write(this.path(key), data);
    await write(`${this.path(key)}.type`, options.contentType ?? "");
  }

  async get(key: string): Promise<BlobObject | null> {
    try {
      const data = new Uint8Array(await readFile(this.path(key)));
      const contentType = await readFile(`${this.path(key)}.type`, "utf8").catch(() => "");
      return { data, ...(contentType ? { contentType } : {}) };
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
    await rm(`${this.path(key)}.type`, { force: true });
  }
}
