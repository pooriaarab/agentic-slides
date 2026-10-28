import { fromBase64 } from "./bytes.js";
import { z } from "zod";
import { COLOR_TOKENS } from "./core/layouts.js";

/** Input shapes that the MCP server and the HTTP API share. */
export const images = z.record(z.string()).optional().describe("Image files for the outline: path -> base64 PNG or JPEG.");

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

export const decodeImages = (files?: Record<string, string>): Record<string, Uint8Array> | undefined =>
  files && Object.fromEntries(Object.entries(files).map(([path, data]) => [path, fromBase64(data)]));
