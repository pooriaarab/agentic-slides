import { fail } from "./core/principal.js";

/** Base64 with `btoa` and `atob`, which Node and Workers both have. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  try {
    return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  } catch {
    return fail("UNSUPPORTED_IMAGE", "image data is not valid base64");
  }
}
