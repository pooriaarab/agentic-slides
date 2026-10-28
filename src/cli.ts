#!/usr/bin/env node
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { COMMAND, DESCRIPTION } from "./brand.js";
import { imagePaths } from "./core/outline.js";
import { PRINCIPAL_KINDS, SlidesError, fail, parsePrincipal, type Principal } from "./core/principal.js";
import { DEFAULT_LIMITS } from "./export/limits.js";
import { createService } from "./service.js";
import { FileBlobs, FileStore } from "./store/file.js";
import { VERSION } from "./version.js";

class UsageError extends Error {}

const OPTIONS = {
  dir: { type: "string" },
  as: { type: "string" },
  id: { type: "string" },
  outline: { type: "string" },
  layout: { type: "string" },
  at: { type: "string" },
  slide: { type: "string" },
  to: { type: "string" },
  element: { type: "string" },
  patch: { type: "string" },
  out: { type: "string" },
  format: { type: "string" },
  present: { type: "boolean" },
} as const;

const HELP = `${COMMAND} ${VERSION}
${DESCRIPTION}

Usage: ${COMMAND} <command> [flags]

Commands:
  new <title> [--id <id>]                         Create a deck. Prints its id.
  outline <deck>                                  Print the deck as JSON.
  add <deck> (--outline <file|-> | --layout <name>) [--at <n>]
                                                  Add slides from an outline, or one empty slide.
  edit <deck> --slide <n|id> --outline <file|->   Replace one slide from an outline.
  edit <deck> --slide <n|id> --element <id> --patch <json>
                                                  Change one element (x, y, w, h, text, ...).
  move <deck> --slide <n|id> --to <n>             Move a slide.
  delete <deck> --slide <n|id>                    Delete a slide.
  render <deck> [--present] [--out <file>]        Print a self-contained HTML page.
  export <deck> --out <file> [--format pdf]       Write the deck as a PDF.
  mcp                                             Start the MCP server on stdio.

Flags:
  --dir <path>   The deck store. Default: $SLIDES_DIR or .slides
  --as <kind:name>  Who edits: ${PRINCIPAL_KINDS.join(", ")}. Or set $SLIDES_AUTHOR.
                 Pass the real kind. Edits by an agent are labeled as machine-made.`;

export function parseAuthor(value: string | undefined): Principal {
  if (!value) throw new UsageError(`say who edits: --as <kind:name> or SLIDES_AUTHOR. Kinds: ${PRINCIPAL_KINDS.join(", ")}`);
  return parsePrincipal(value);
}

async function readOutline(path: string): Promise<{ text: string; base: string }> {
  if (path === "-") {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return { text: Buffer.concat(chunks).toString("utf8"), base: process.cwd() };
  }
  return { text: await readFile(path, "utf8"), base: dirname(resolve(path)) };
}

/** Read the image files an outline names. Only regular files inside the outline's own folder count. */
async function readImages(text: string, base: string): Promise<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = {};
  const root = await realpath(base);
  for (const path of imagePaths(text)) {
    const full = await realpath(resolve(base, path)).catch(() => undefined);
    const inside = full !== undefined && !relative(root, full).startsWith("..") && !isAbsolute(relative(root, full));
    const info = inside ? await stat(full) : undefined;
    if (!info?.isFile()) continue;
    if (info.size > DEFAULT_LIMITS.maxImageBytes) fail("UNSUPPORTED_IMAGE", `image "${path}" is over ${DEFAULT_LIMITS.maxImageBytes} bytes`);
    files[path] = new Uint8Array(await readFile(full!));
  }
  return files;
}

export async function runCli(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    console.log(HELP);
    return 0;
  }
  if (command === "--version" || command === "-V") {
    console.log(VERSION);
    return 0;
  }
  try {
    const { values, positionals } = parseArgs({ args: rest, options: OPTIONS, allowPositionals: true });
    const dir = values.dir ?? env.SLIDES_DIR ?? ".slides";
    const author = () => parseAuthor(values.as ?? env.SLIDES_AUTHOR);
    const [deck = ""] = positionals;
    const need = <T>(value: T | undefined, flag: string): T => value ?? (() => { throw new UsageError(`${command} needs --${flag}`); })();
    const number = (value: string | undefined, flag: string): number | undefined => {
      if (value === undefined) return undefined;
      if (!/^\d+$/.test(value)) throw new UsageError(`--${flag} needs a whole number`);
      return Number(value);
    };
    if (command === "mcp") {
      const { startMcp } = await import("./mcp.js");
      const named = values.as ?? env.SLIDES_AUTHOR;
      await startMcp({ dir, author: named ? parsePrincipal(named) : undefined });
      return 0;
    }
    const service = createService({ store: new FileStore(dir), blobs: new FileBlobs(dir) });
    const print = (value: unknown) => console.log(JSON.stringify(value));
    switch (command) {
      case "new":
        print(await service.create({ title: need(positionals.join(" ") || undefined, "title"), id: values.id, author: author() }));
        break;
      case "outline":
        print(await service.outline(need(deck, "deck")));
        break;
      case "add":
        if (values.outline !== undefined) {
          const { text, base } = await readOutline(values.outline);
          print(await service.addSlides(deck, { outline: text, images: await readImages(text, base), at: number(values.at, "at"), author: author() }));
        } else print(await service.addSlides(deck, { layout: need(values.layout, "outline or --layout"), at: number(values.at, "at"), author: author() }));
        break;
      case "edit":
        if (values.element !== undefined) {
          const patch = JSON.parse(need(values.patch, "patch")) as Record<string, never>;
          await service.editElement(deck, need(values.slide, "slide"), values.element, patch, author());
        } else {
          const { text, base } = await readOutline(need(values.outline, "outline or --element"));
          await service.setSlide(deck, need(values.slide, "slide"), { outline: text, images: await readImages(text, base), author: author() });
        }
        print({ ok: true });
        break;
      case "move":
        await service.moveSlide(deck, need(values.slide, "slide"), need(number(values.to, "to"), "to"), author());
        print({ ok: true });
        break;
      case "delete":
        await service.deleteSlide(deck, need(values.slide, "slide"), author());
        print({ ok: true });
        break;
      case "render": {
        const html = await service.render(need(deck, "deck"), { present: values.present });
        if (values.out) await writeFile(values.out, html);
        else process.stdout.write(html);
        break;
      }
      case "export": {
        if ((values.format ?? "pdf") !== "pdf") throw new UsageError(`format "${values.format}" is not available yet. Use pdf`);
        const { bytes, warnings } = await service.exportPdf(need(deck, "deck"));
        const out = need(values.out, "out");
        await writeFile(out, bytes);
        print({ path: out, bytes: bytes.length, warnings });
        break;
      }
      default:
        throw new UsageError(`unknown command "${command}"`);
    }
    return 0;
  } catch (error) {
    if (error instanceof SlidesError) {
      console.error(JSON.stringify({ error: { code: error.code, message: error.message, issues: error.issues } }));
      return 1;
    }
    if (error instanceof UsageError || (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
      console.error(`${(error as Error).message}\nRun "${COMMAND} --help" for usage.`);
      return 2;
    }
    throw error;
  }
}

function isMainModule(): boolean {
  const invoked = process.argv[1];
  if (typeof invoked !== "string") return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(invoked)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  runCli(process.argv.slice(2)).then(
    (code) => {
      // Exit nonzero at once. On zero, fall off the end so a running server (mcp) keeps its stdio open.
      if (code !== 0) process.exit(code);
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
