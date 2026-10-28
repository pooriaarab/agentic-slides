import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertKey, type Blobs, type BlobObject, type Doc, type Store } from "../ports.js";

const missing = (error: unknown): boolean => (error as { code?: string }).code === "ENOENT";

async function write(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, data);
  await rename(temp, path);
}

/** A store on disk: `<root>/store/<collection>/<id>.json`. One process at a time. */
export class FileStore implements Store {
  constructor(private readonly root: string) {}

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
