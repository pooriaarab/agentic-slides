import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { toBase64 } from "./bytes.js";
import { z } from "zod";
import { COMMAND } from "./brand.js";
import { SlidesError, checkAuthor, fail, type Principal } from "./core/principal.js";
import { decodeImages, images, patch } from "./schemas.js";
import { SlidesApiError, createClient, type SlidesClient } from "./client.js";
import { createLiveService, whoAmI, type LiveOptions } from "./live.js";
import { createService, type Operations } from "./service.js";
import { createFileBlobs, createFileStore } from "./store/file.js";
import { VERSION } from "./version.js";

export interface McpDeps {
  service: Operations;
  /** The author of every edit. The server sets it, so a model cannot claim to be a human. */
  author?: Principal;
  /**
   * The server that holds the roles. With it, the sharing tools exist. Without it (a local store has no roles), they do not.
   * The client holds the token, so a tool call never carries a credential.
   */
  sharing?: Pick<SlidesClient, "access" | "grant" | "revoke" | "invite" | "acceptInvite" | "createShareLink" | "revokeShareLink">;
}

type Result = { content: { type: "text"; text: string }[]; isError?: true };

const ok = (value: unknown): Result => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

const slide = z.union([z.string(), z.number()]).describe("A slide id, or its 1-based position.");
const deck = z.string().describe("The deck id.");

export function createMcpServer({ service, author = { kind: "agent", name: "mcp-client" }, sharing }: McpDeps): McpServer {
  if (checkAuthor(author).kind === "human") fail("INVALID_AUTHOR", "an MCP server acts for a model, so it cannot write as a human. Use agent, agent_of_human, agent_of_agent, or user_token");
  const server = new McpServer({ name: COMMAND, version: VERSION });
  const edit = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
  const read = { readOnlyHint: true, openWorldHint: false } as const;

  const tool = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    inputSchema: S,
    annotations: Record<string, boolean>,
    run: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
  ) =>
    server.registerTool(name, { description, inputSchema, annotations }, (async (args: z.infer<z.ZodObject<S>>): Promise<Result> => {
      try {
        return ok(await run(args));
      } catch (error) {
        if (!(error instanceof SlidesError) && !(error instanceof SlidesApiError)) throw error;
        const failure = { error: { code: error.code, message: error.message, issues: error.issues } };
        return { ...ok(failure), isError: true };
      }
    }) as never);

  tool("create_deck", "Create an empty deck. Returns its id.", { title: z.string(), id: z.string().optional() }, edit, (a) => service.create({ ...a, author }));
  tool(
    "list_decks",
    "List decks, newest edit first, with the last editor of each. Pass nextCursor of one page as cursor to read the next page.",
    { limit: z.number().optional().describe("The most decks to return, from 1 to 200."), cursor: z.string().optional() },
    read,
    (a) => service.list(a),
  );
  tool("read_outline", "Read a deck as structured JSON: slides, elements, notes, theme, and who edited what.", { deck }, read, (a) => service.outline(a.deck));
  tool(
    "add_slides",
    "Add slides from a text outline (slides split by '---', '# Title', '- item', '+++' column, '|a|b|' table, '![alt](path)', '> note'), or one empty slide of a layout. A bad outline returns every issue with its slide number.",
    { deck, outline: z.string().optional(), layout: z.string().optional(), at: z.number().optional().describe("1-based position."), images },
    edit,
    (a) => service.addSlides(a.deck, { outline: a.outline, layout: a.layout, at: a.at, images: decodeImages(a.images), author }),
  );
  tool(
    "set_slide",
    "Replace one slide from a text outline of one slide. All elements of the slide are replaced: element ids change and shapes or boxes added by hand are lost. Use edit_element to change one element in place.",
    { deck, slide, outline: z.string(), images },
    edit,
    async (a) => (await service.setSlide(a.deck, a.slide, { outline: a.outline, images: decodeImages(a.images), author }), { ok: true }),
  );
  tool(
    "edit_element",
    "Change one element: its box (x, y, w, h on a 1280x720 space) and its text, color, fill, alt, src, or rows.",
    { deck, slide, element: z.string().describe("The element id from read_outline."), patch },
    edit,
    async (a) => (await service.editElement(a.deck, a.slide, a.element, a.patch, author), { ok: true }),
  );
  tool("move_slide", "Move a slide to a 1-based position.", { deck, slide, to: z.number() }, edit, async (a) => (await service.moveSlide(a.deck, a.slide, a.to, author), { ok: true }));
  tool("delete_slide", "Delete a slide.", { deck, slide }, { readOnlyHint: false, destructiveHint: true, openWorldHint: false }, async (a) => (await service.deleteSlide(a.deck, a.slide, author), { ok: true }));
  tool("delete_deck", "Delete a whole deck and its list entry. This cannot be undone.", { deck }, { readOnlyHint: false, destructiveHint: true, openWorldHint: false }, async (a) => (await service.deleteDeck(a.deck, author), { ok: true }));
  tool("render_deck", "Render the deck as one self-contained HTML page. Pass present for the present page.", { deck, present: z.boolean().optional() }, read, async (a) => ({ html: await service.render(a.deck, { present: a.present }) }));
  tool("export_pdf", "Export the deck as a PDF. Returns it as base64, with warnings.", { deck }, read, async (a) => {
    const { bytes, warnings } = await service.exportPdf(a.deck);
    return { pdfBase64: toBase64(bytes), bytes: bytes.length, warnings };
  });
  if (sharing) {
    const role = z.enum(["owner", "editor", "commenter", "viewer"]).describe("owner may share and delete. editor may change slides. commenter and viewer may read.");
    const subject = z.object({ kind: z.enum(["human", "agent"]), id: z.string() }).describe("A person (human) or an agent. See `subject` in the answer of GET /me for a token.");
    const owner = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
    tool("list_access", "List who can reach a deck: grants, invites, and share links. Only an owner may. A link token and an invite email are never shown.", { deck, limit: z.number().int().optional(), cursor: z.string().optional(), inviteCursor: z.string().optional(), linkCursor: z.string().optional() }, read, (a) => sharing.access(a.deck, { limit: a.limit, cursor: a.cursor, inviteCursor: a.inviteCursor, linkCursor: a.linkCursor }));
    tool("grant_access", "Give a person or an agent a role on a deck. Only an owner may.", { deck, subject, role }, owner, async (a) => (await sharing.grant(a.deck, { subject: a.subject, role: a.role }), { ok: true }));
    tool("revoke_access", "Take a role away from a person or an agent. The last owner cannot be removed.", { deck, subject }, { readOnlyHint: false, destructiveHint: true, openWorldHint: false }, async (a) => (await sharing.revoke(a.deck, a.subject), { ok: true }));
    tool(
      "invite",
      "Invite a person by email, or an agent by handle. It sends no message: give the invite id to the invitee. Give email or handle, not both.",
      { deck, role, email: z.string().optional(), handle: z.string().optional(), expiresInMs: z.number().int().optional() },
      owner,
      (a) => sharing.invite(a.deck, { role: a.role, email: a.email, handle: a.handle, expiresInMs: a.expiresInMs }),
    );
    tool("accept_invite", "Accept an invite that names this agent's handle. The handle is the name of the token.", { id: z.string() }, owner, async (a) => (await sharing.acceptInvite(a.id), { ok: true }));
    tool(
      "create_share_link",
      "Make a share link for a deck. The token comes back once. A link gives read access only.",
      { deck, role, expiresInMs: z.number().int().optional(), signedInOnly: z.boolean().optional() },
      owner,
      (a) => sharing.createShareLink(a.deck, { role: a.role, expiresInMs: a.expiresInMs, signedInOnly: a.signedInOnly }),
    );
    tool("revoke_share_link", "Revoke a share link by its id.", { deck, link: z.string() }, { readOnlyHint: false, destructiveHint: true, openWorldHint: false }, async (a) => (await sharing.revokeShareLink(a.deck, a.link), { ok: true }));
  }
  return server;
}

export async function startMcp(options: { dir?: string; author?: Principal; live?: LiveOptions } = {}): Promise<void> {
  if (options.live) return startLiveMcp(options.live);
  const dir = options.dir ?? process.env.SLIDES_DIR ?? ".slides";
  const service = createService({ store: createFileStore(dir), blobs: createFileBlobs(dir) });
  await createMcpServer({ service, author: options.author }).connect(new StdioServerTransport());
}

/**
 * The MCP server in a live room. The token decides the author, so the server asks who it is and refuses a person's token:
 * an MCP server acts for a model.
 */
export async function startLiveMcp(live: LiveOptions): Promise<void> {
  const { author } = await whoAmI(live.server, live.token);
  await createMcpServer({ service: createLiveService(live), author, sharing: createClient({ baseUrl: live.server, token: live.token }) }).connect(new StdioServerTransport());
}
