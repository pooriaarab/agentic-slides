import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

// End to end: the built MCP server over stdio, on the same store the CLI writes.
const work = mkdtempSync(join(tmpdir(), "slides-mcp-"));
let client: Client;

async function call(name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  return { isError: result.isError === true, body: JSON.parse(result.content[0]!.text) as Record<string, any> };
}

beforeAll(async () => {
  spawnSync("node", [join(process.cwd(), "dist", "cli.js"), "new", "Shared", "--id", "shared", "--as", "human:ada"], { cwd: work, env: { PATH: process.env.PATH } });
  const transport = new StdioClientTransport({
    command: "node",
    args: [join(process.cwd(), "dist", "mcp-bin.js")],
    env: { PATH: process.env.PATH ?? "", SLIDES_DIR: join(work, ".slides") },
    cwd: work,
  });
  client = new Client({ name: "probe", version: "0.0.0" });
  await client.connect(transport);
  writeFileSync(join(work, "unused"), "");
});

afterAll(async () => {
  await client.close();
});

describe("slides MCP server", () => {
  test("lists the tools that mirror the CLI", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["add_slides", "create_deck", "delete_slide", "edit_element", "export_pdf", "move_slide", "read_outline", "render_deck", "set_slide"]);
  });

  test("edits a deck that the CLI made, and labels every edit as an agent's", async () => {
    const added = await call("add_slides", { deck: "shared", outline: "# One\n- a\n---\n# Two\n- b", author: { kind: "human", name: "ada" } });
    expect(added.isError).toBe(false);
    const outline = (await call("read_outline", { deck: "shared" })).body;
    expect(outline.slides).toHaveLength(2);
    expect(outline.slides[0]).toMatchObject({ createdBy: { kind: "agent", name: "mcp-client" }, machineMade: true });
    const title = outline.slides[0].elements.find((e: any) => e.slot === "title");
    expect((await call("edit_element", { deck: "shared", slide: 1, element: title.id, patch: { text: "Changed", x: 90 } })).isError).toBe(false);
    expect((await call("move_slide", { deck: "shared", slide: 2, to: 1 })).isError).toBe(false);
    expect((await call("read_outline", { deck: "shared" })).body.slides.map((s: any) => s.title)).toEqual(["Two", "Changed"]);
    expect((await call("delete_slide", { deck: "shared", slide: 1 })).isError).toBe(false);
    expect((await call("set_slide", { deck: "shared", slide: 1, outline: "# Three" })).isError).toBe(false);
    expect((await call("add_slides", { deck: "shared", layout: "blank" })).isError).toBe(false);
  });

  test("a failed call is an error result with the issue list, never a success", async () => {
    const bad = await call("add_slides", { deck: "shared", outline: "layout: zigzag\n# A" });
    expect(bad.isError).toBe(true);
    expect(bad.body.error).toMatchObject({ code: "UNKNOWN_LAYOUT", issues: [{ slide: 1 }] });
    expect((await call("read_outline", { deck: "missing" })).body.error.code).toBe("NO_DECK");
    const wrongField = await call("edit_element", { deck: "shared", slide: 1, element: "x", patch: { bogus: 1 } }).catch((e: Error) => e);
    expect(wrongField instanceof Error || (wrongField as { isError: boolean }).isError).toBe(true);
  });

  test("renders and exports", async () => {
    const html = (await call("render_deck", { deck: "shared", present: true })).body.html as string;
    expect(html).toContain("<!doctype html>");
    const pdf = (await call("export_pdf", { deck: "shared" })).body;
    expect(Buffer.from(pdf.pdfBase64, "base64").subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.warnings).toEqual([]);
  });
});
