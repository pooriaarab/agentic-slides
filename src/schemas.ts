import { fromBase64 } from "./bytes.js";
import { z } from "zod";
import { COLOR_TOKENS } from "./core/layouts.js";
import { fail } from "./core/principal.js";
import { DEFAULT_LIMITS, type Limits } from "./export/limits.js";

/** Input shapes that the MCP server and the HTTP API share. */
export const images = z.record(z.string(), z.string()).optional().describe("Image files for the outline: path -> base64 PNG or JPEG.");

export const patch = z
  .object({
    x: z.number(),
    y: z.number(),
    w: z.number(),
    h: z.number(),
    text: z.string().describe("Text with **bold** and *italic* marks."),
    fontSize: z.number(),
    color: z.enum(COLOR_TOKENS),
    fill: z.enum(COLOR_TOKENS),
    alt: z.string(),
    src: z.string(),
    rows: z.array(z.array(z.string())),
  })
  .partial()
  .strict();

/** Decode image files. The count and the sizes are checked from the base64 length first, so nothing big is allocated for a refused request. */
export function decodeImages(files?: Record<string, string>, limits: Limits = DEFAULT_LIMITS): Record<string, Uint8Array> | undefined {
  if (!files) return undefined;
  const entries = Object.entries(files);
  if (entries.length > limits.maxImagesPerRequest) fail("TOO_LARGE", `a request holds at most ${limits.maxImagesPerRequest} images`);
  let total = 0;
  for (const [path, data] of entries) {
    const bytes = Math.ceil((data.length * 3) / 4);
    if (bytes > limits.maxImageBytes) fail("TOO_LARGE", `image "${path}" is over ${limits.maxImageBytes} bytes`);
    total += bytes;
    if (total > limits.maxTotalImageBytes) fail("TOO_LARGE", `the images are over ${limits.maxTotalImageBytes} bytes in total`);
  }
  return Object.fromEntries(entries.map(([path, data]) => [path, fromBase64(data)]));
}
