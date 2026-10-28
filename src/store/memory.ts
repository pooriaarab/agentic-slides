import type { Blobs, BlobObject, Doc, Store } from "../ports.js";

/** A store in memory. It lasts as long as the process or the Worker isolate. */
export class MemoryStore implements Store {
  private readonly docs = new Map<string, string>();

  async get<T extends Doc = Doc>(collection: string, id: string): Promise<T | null> {
    const saved = this.docs.get(`${collection}/${id}`);
    return saved === undefined ? null : (JSON.parse(saved) as T);
  }

  async put<T extends Doc = Doc>(collection: string, id: string, doc: T): Promise<void> {
    this.docs.set(`${collection}/${id}`, JSON.stringify(doc));
  }

  async delete(collection: string, id: string): Promise<void> {
    this.docs.delete(`${collection}/${id}`);
  }
}

export class MemoryBlobs implements Blobs {
  private readonly objects = new Map<string, BlobObject>();

  async put(key: string, data: Uint8Array, options: { contentType?: string } = {}): Promise<void> {
    this.objects.set(key, { data: data.slice(), ...(options.contentType ? { contentType: options.contentType } : {}) });
  }

  async get(key: string): Promise<BlobObject | null> {
    const found = this.objects.get(key);
    return found ? { ...found, data: found.data.slice() } : null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}
