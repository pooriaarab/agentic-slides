#!/usr/bin/env node
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { COMMAND, DESCRIPTION } from "./brand.js";
import { imagePaths } from "./core/outline.js";
import { PRINCIPAL_KINDS, SlidesError, fail, parsePrincipal, type Principal } from "./core/principal.js";
import { DEFAULT_LIMITS } from "./export/limits.js";
import { SlidesApiError, createClient, type Role, type SlidesClient, type Subject } from "./client.js";
import { createLiveService, isLiveServer, type LiveOptions } from "./live.js";
import { createService } from "./service.js";
import { createFileBlobs, createFileStore } from "./store/file.js";
import { VERSION } from "./version.js";

class UsageError extends Error {}

const OPTIONS = {
  dir: { type: "string" },
  live: { type: "string" },
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
  limit: { type: "string" },
  cursor: { type: "string" },
  present: { type: "boolean" },
  subject: { type: "string" },
  role: { type: "string" },
  email: { type: "string" },
  handle: { type: "string" },
  "expires-in-ms": { type: "string" },
  "signed-in-only": { type: "boolean" },
  link: { type: "string" },
  "invite-cursor": { type: "string" },
  "link-cursor": { type: "string" },
} as const;

const ROLES = ["owner", "editor", "commenter", "viewer"] as const;
const SHARE_COMMANDS = new Set(["access", "grant", "revoke", "invite", "accept-invite", "share-link", "revoke-link"]);

const HELP = `${COMMAND} ${VERSION}
${DESCRIPTION}

Usage: ${COMMAND} <command> [flags]

Commands:
  new <title> [--id <id>]                         Create a deck. Prints its id.
  list [--limit <n>] [--cursor <text>]            Print one page of decks as JSON, newest edit first.
  outline <deck>                                  Print the deck as JSON.
  add <deck> (--outline <file|-> | --layout <name>) [--at <n>]
                                                  Add slides from an outline, or one empty slide.
  edit <deck> --slide <n|id> --outline <file|->   Replace one slide from an outline.
  edit <deck> --slide <n|id> --element <id> --patch <json>
                                                  Change one element (x, y, w, h, text, ...).
  move <deck> --slide <n|id> --to <n>             Move a slide.
  delete <deck> --slide <n|id>                    Delete a slide.
  delete-deck <deck>                              Delete a deck and its list entry. Images stay in the store.
  render <deck> [--present] [--out <file>]        Print a self-contained HTML page.
  export <deck> --out <file> [--format pdf]       Write the deck as a PDF.
  access <deck> [--limit <n>] [--cursor <t>] [--invite-cursor <t>] [--link-cursor <t>]
                                                  Print who can reach a deck: grants, invites, links. Owner only.
  grant <deck> --subject <human|agent>:<id> --role <role>
                                                  Give a person or an agent a role. Owner only.
  revoke <deck> --subject <human|agent>:<id>      Take a role away.
  invite <deck> --role <role> (--email <e> | --handle <h>) [--expires-in-ms <n>]
                                                  Invite a person or an agent. Prints the invite id. Sends no message.
  accept-invite <id>                              Accept an invite by handle. The handle is the name of the token.
  share-link <deck> --role <role> [--expires-in-ms <n>] [--signed-in-only]
                                                  Make a share link. Prints the link token once.
  revoke-link <deck> --link <id>                  Revoke a share link.
  mcp                                             Start the MCP server on stdio.

The sharing commands (access to revoke-link) need --live: roles live on the server. A role is ${ROLES.join(", ")}.

Flags:
  --dir <path>   The deck store. Default: $SLIDES_DIR or .slides
  --live <url>   Join a live room on a server instead of using files. Or set $SLIDES_LIVE_URL.
                 The token is $SLIDES_LIVE_TOKEN. The token sets who edits, so --as, --dir, and $SLIDES_AUTHOR are refused. $SLIDES_DIR is not used.
  --as <kind:name>  Who edits: ${PRINCIPAL_KINDS.join(", ")}. Or set $SLIDES_AUTHOR.
                 Pass the real kind. Edits by an agent are labeled as machine-made.`;

/** The live room options, or undefined when no server is named. A server that is named but unusable is an error: never fall back to files. */
function liveOptions(server: string | undefined, env: NodeJS.ProcessEnv, values: { dir?: string; as?: string }): LiveOptions | undefined {
  if (server === undefined) return undefined;
  if (!isLiveServer(server)) throw new UsageError("--live needs an https:// address (http:// only for this machine): a token must not cross the network in the clear");
  if (values.dir !== undefined || values.as !== undefined || env.SLIDES_AUTHOR !== undefined) throw new UsageError("--dir, --as, and $SLIDES_AUTHOR do not work with --live: the token sets who edits");
  const token = env.SLIDES_LIVE_TOKEN;
  if (!token) throw new UsageError("a live room needs a token in $SLIDES_LIVE_TOKEN");
  return { server, token, name: env.SLIDES_LIVE_NAME };
}

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

function parseSubject(text: string | undefined): Subject {
  const cut = text?.indexOf(":") ?? -1;
  const kind = text?.slice(0, cut);
  if (text === undefined || cut < 1 || cut === text.length - 1 || (kind !== "human" && kind !== "agent")) throw new UsageError("--subject needs <human|agent>:<id>, for example human:bob");
  return { kind, id: text.slice(cut + 1) };
}

function parseRole(text: string | undefined): Role {
  if (!(ROLES as readonly (string | undefined)[]).includes(text)) throw new UsageError(`--role needs one of ${ROLES.join(", ")}`);
  return text as Role;
}

interface ShareArgs {
  deck: string;
  values: { limit?: string; cursor?: string; "invite-cursor"?: string; "link-cursor"?: string; subject?: string; role?: string; email?: string; handle?: string; link?: string; "expires-in-ms"?: string; "signed-in-only"?: boolean };
  positionals: string[];
  need: <T>(value: T | undefined, flag: string) => T;
  number: (value: string | undefined, flag: string) => number | undefined;
}

/** The sharing commands. They call the HTTP API, which checks every role. */
async function share(command: string, client: SlidesClient, { deck, values, positionals, need, number }: ShareArgs): Promise<void> {
  const print = (value: unknown) => console.log(JSON.stringify(value));
  const expiresInMs = number(values["expires-in-ms"], "expires-in-ms");
  if (expiresInMs === 0) throw new UsageError("--expires-in-ms needs a whole number above 0");
  const named = positionals[0];
  // `deck` is the first word. The commands that name a deck stop here, before any call, when it is missing.
  if (command !== "accept-invite" && !named) throw new UsageError(`${command} needs a deck id`);
  if (command === "accept-invite" && !named) throw new UsageError("accept-invite needs an invite id");
  switch (command) {
    case "access":
      return print(await client.access(need(deck, "deck"), { limit: number(values.limit, "limit"), cursor: values.cursor, inviteCursor: values["invite-cursor"], linkCursor: values["link-cursor"] }));
    case "grant":
      await client.grant(need(deck, "deck"), { subject: parseSubject(values.subject), role: parseRole(values.role) });
      return print({ ok: true });
    case "revoke":
      await client.revoke(need(deck, "deck"), parseSubject(values.subject));
      return print({ ok: true });
    case "invite":
      return print(await client.invite(need(deck, "deck"), { role: parseRole(values.role), email: values.email, handle: values.handle, expiresInMs }));
    case "accept-invite":
      await client.acceptInvite(named!);
      return print({ ok: true });
    case "share-link":
      return print(await client.createShareLink(need(deck, "deck"), { role: parseRole(values.role), expiresInMs, signedInOnly: values["signed-in-only"] }));
    default:
      await client.revokeShareLink(need(deck, "deck"), need(values.link, "link"));
      return print({ ok: true });
  }
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
    const live = liveOptions(values.live ?? env.SLIDES_LIVE_URL, env, values);
    // In a live room the server reads the author from the token. This stand-in fails `checkAuthor`, so a change that used it would fail closed.
    const author = () => (live ? { kind: "set-by-the-token" as never, name: "" } : parseAuthor(values.as ?? env.SLIDES_AUTHOR));
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
      await startMcp({ dir, author: named ? parsePrincipal(named) : undefined, live });
      return 0;
    }
    if (SHARE_COMMANDS.has(command)) {
      if (!live) throw new UsageError("sharing needs a server: set --live and $SLIDES_LIVE_TOKEN. Roles live on the server");
      await share(command, createClient({ baseUrl: live.server, token: live.token }), { deck, values, positionals, need, number });
      return 0;
    }
    const service = live ? createLiveService(live) : createService({ store: createFileStore(dir), blobs: createFileBlobs(join(dir, "blobs")) });
    const print = (value: unknown) => console.log(JSON.stringify(value));
    switch (command) {
      case "new":
        print(await service.create({ title: need(positionals.join(" ") || undefined, "title"), id: values.id, author: author() }));
        break;
      case "list":
        print(await service.list({ limit: number(values.limit, "limit"), cursor: values.cursor }));
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
      case "delete-deck":
        await service.deleteDeck(need(deck, "deck"), author());
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
    if (error instanceof SlidesApiError) {
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
