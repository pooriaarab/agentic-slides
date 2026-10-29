import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { toBase64 } from "./bytes.js";
import { z } from "zod";
import { COMMAND } from "./brand.js";
import { SlidesError, checkAuthor, fail, type Principal } from "./core/principal.js";
import { decodeImages, images, patch } from "./schemas.js";
import { createService, type Service } from "./service.js";
import { createFileBlobs, createFileStore } from "./store/file.js";
import { VERSION } from "./version.js";

export interface McpDeps {
  service: Service;
  /** The author of every edit. The server sets it, so a model cannot claim to be a human. */
  author?: Principal;
}

type Result = { content: { type: "text"; text: string }[]; isError?: true };

const ok = (value: unknown): Result => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

const slide = z.union([z.string(), z.number()]).describe("A slide id, or its 1-based position.");
const deck = z.string().describe("The deck id.");

export function createMcpServer({ service, author = { kind: "agent", name: "mcp-client" } }: McpDeps): McpServer {
  if (checkAuthor(author).kind === "human") fail("INVALID_AUTHOR", "an MCP server acts for a model, so it cannot write as a human. Use agent, agent_of_human, agent_of_agent, or user_token");
  const server = new McpServer({ name: COMMAND, version: VERSION });
  const edit = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
  const read = { readOnlyHint: true, openWorldHint: false } as const;

  const tool = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    inputSchema: S,
    annotations: Record<string, boolean>,
    run: (args: z.objectOutputType<S, z.ZodTypeAny>) => Promise<unknown>,
  ) =>
    server.registerTool(name, { description, inputSchema, annotations }, (async (args: z.objectOutputType<S, z.ZodTypeAny>): Promise<Result> => {
      try {
        return ok(await run(args));
      } catch (error) {
        if (!(error instanceof SlidesError)) throw error;
        const failure = { error: { code: error.code, message: error.message, issues: error.issues } };
        return { ...ok(failure), isError: true };
      }
    }) as never);

  tool("create_deck", "Create an empty deck. Returns its id.", { title: z.string(), id: z.string().optional() }, edit, (a) => service.create({ ...a, author }));
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
  tool("render_deck", "Render the deck as one self-contained HTML page. Pass present for the present page.", { deck, present: z.boolean().optional() }, read, async (a) => ({ html: await service.render(a.deck, { present: a.present }) }));
  tool("export_pdf", "Export the deck as a PDF. Returns it as base64, with warnings.", { deck }, read, async (a) => {
    const { bytes, warnings } = await service.exportPdf(a.deck);
    return { pdfBase64: toBase64(bytes), bytes: bytes.length, warnings };
  });
  return server;
}

export async function startMcp(options: { dir?: string; author?: Principal } = {}): Promise<void> {
  const dir = options.dir ?? process.env.SLIDES_DIR ?? ".slides";
  const service = createService({ store: createFileStore(dir), blobs: createFileBlobs(dir) });
  await createMcpServer({ service, author: options.author }).connect(new StdioServerTransport());
}
