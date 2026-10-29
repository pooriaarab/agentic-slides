import type { Store } from "agentic-identity";
import { fromBase64, toBase64 } from "./bytes.js";

// A list cursor that stands after a deck that the caller cannot see would show that deck: its id and its save time.
// Such a cursor is sealed with a key that only the server holds, so the caller can pass it back and cannot read it.
const SECRETS = "slides_secrets";
const KEY_ID = "cursor";
const PREFIX = "s1.";

const keys = new WeakMap<Store, Promise<CryptoKey>>();

const base64url = (bytes: Uint8Array) => toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromBase64url = (text: string) => fromBase64(text.replace(/-/g, "+").replace(/_/g, "/"));

/** The sealing key. The store holds its 32 random bytes, made once, so every isolate of the Worker has the same key. */
function keyFor(store: Store): Promise<CryptoKey> {
  let key = keys.get(store);
  if (!key) {
    key = (async () => {
      const made = toBase64(globalThis.crypto.getRandomValues(new Uint8Array(32)));
      const secret = await store.transaction(async (tx) => {
        const found = await tx.get<{ key?: string }>(SECRETS, KEY_ID);
        if (typeof found?.key === "string" && found.key.length > 0) return found.key;
        await tx.put(SECRETS, KEY_ID, { key: made });
        return made;
      });
      return globalThis.crypto.subtle.importKey("raw", fromBase64(secret) as Uint8Array<ArrayBuffer>, "AES-GCM", false, ["encrypt", "decrypt"]);
    })();
    key.catch(() => keys.delete(store));
    keys.set(store, key);
  }
  return key;
}

export async function sealCursor(store: Store, raw: string): Promise<string> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv }, await keyFor(store), new TextEncoder().encode(raw)));
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv);
  out.set(sealed, iv.length);
  return PREFIX + base64url(out);
}

/** The cursor that was sealed, or null when the text is not a sealed cursor of this server. A cursor with no prefix is not sealed. */
export async function openCursor(store: Store, text: string): Promise<string | null> {
  if (!text.startsWith(PREFIX)) return text;
  try {
    const bytes = fromBase64url(text.slice(PREFIX.length));
    const plain = await globalThis.crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, 12) as Uint8Array<ArrayBuffer> }, await keyFor(store), bytes.subarray(12) as Uint8Array<ArrayBuffer>);
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}
