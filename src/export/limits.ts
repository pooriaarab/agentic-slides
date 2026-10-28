import type { DeckOutline } from "../core/deck.js";
import { fail } from "../core/principal.js";

export interface Limits {
  maxSlides: number;
  maxElements: number;
  /** Width times height of one image. Checked from the file header, before any decode. */
  maxImagePixels: number;
  maxImageBytes: number;
  /** Images in one request that carries image files. */
  maxImagesPerRequest: number;
  /** Bytes of all distinct images that one export holds in memory. */
  maxTotalImageBytes: number;
  /** Bytes of image data that one HTML page inlines, counting every use of an image. */
  maxRenderBytes: number;
  maxMillis: number;
}

const MiB = 1024 * 1024;

export const DEFAULT_LIMITS: Limits = {
  maxSlides: 200,
  maxElements: 4000,
  maxImagePixels: 25_000_000,
  maxImageBytes: 10 * MiB,
  maxImagesPerRequest: 20,
  maxTotalImageBytes: 64 * MiB,
  maxRenderBytes: 64 * MiB,
  maxMillis: 20_000,
};

/** Width and height from a PNG or JPEG header, or undefined when the header is not readable. */
export function imageSize(data: Uint8Array): { width: number; height: number } | undefined {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data[0] === 0x89 && data[1] === 0x50) {
    const ihdr = data[12] === 0x49 && data[13] === 0x48 && data[14] === 0x44 && data[15] === 0x52;
    return data.length >= 24 && ihdr ? { width: view.getUint32(16), height: view.getUint32(20) } : undefined;
  }
  if (data[0] !== 0xff || data[1] !== 0xd8) return undefined;
  for (let i = 2; i + 9 < data.length; ) {
    if (data[i] !== 0xff) i++;
    else if (data[i + 1] === 0xff || data[i + 1] === 0x00) i++;
    else if (data[i + 1]! >= 0xc0 && data[i + 1]! <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(data[i + 1]!)) {
      return { height: view.getUint16(i + 5), width: view.getUint16(i + 7) };
    } else if (data[i + 1] === 0xd8 || (data[i + 1]! >= 0xd0 && data[i + 1]! <= 0xd7) || data[i + 1] === 0x01) i += 2;
    else i += 2 + view.getUint16(i + 2);
  }
  return undefined;
}

/** True when the header is readable and the image holds more pixels than the limit. */
export const tooManyPixels = (data: Uint8Array, limits: Limits): boolean => {
  const size = imageSize(data);
  return size !== undefined && size.width * size.height > limits.maxImagePixels;
};

export function checkDeckSize(outline: DeckOutline, limits: Limits): void {
  if (outline.slides.length > limits.maxSlides) fail("EXPORT_LIMIT", `the deck has ${outline.slides.length} slides, the limit is ${limits.maxSlides}`);
  const elements = outline.slides.reduce((sum, s) => sum + s.elements.length, 0);
  if (elements > limits.maxElements) fail("EXPORT_LIMIT", `the deck has ${elements} elements, the limit is ${limits.maxElements}`);
}
