import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { LiveDeck } from "../live.js";
import { shareAll, worker, type Server } from "./server.js";

// End to end: the built CLI and MCP server and the SDK join live rooms on a real Worker (wrangler dev, Durable Objects).
// Needs `npm run build`.
const HUMAN = "human-token-0123456789-abcdefghij";
const AGENT = "agent-token-0123456789-abcdefghij";
const WATCHER = "watcher-token-0123456789-abcdefghij";
const work = mkdtempSync(join(tmpdir(), "slides-live-"));
let server: Server;
let mcp: Client;

const cli = (args: string[], env: Record<string, string> = {}) => {
  const result = spawnSync("node", [join(process.cwd(), "dist", "cli.js"), ...args], { cwd: work, encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
  return { code: result.status, out: result.stdout, err: result.stderr };
};
const as = (token: string) => ({ SLIDES_LIVE_URL: server.url, SLIDES_LIVE_TOKEN: token });
const http = async (path: string, token = HUMAN) =>
  (await (await fetch(`${server.url}/api/v1/slides${path}`, { headers: { authorization: `Bearer ${token}` } })).json()) as Record<string, any>;
async function tool(name: string, args: Record<string, unknown>) {
  const result = (await mcp.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  return { isError: result.isError === true, body: JSON.parse(result.content[0]!.text) as Record<string, any> };
}
const connectMcp = async () => {
  const client = new Client({ name: "probe", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({ command: "node", args: [join(process.cwd(), "dist", "mcp-bin.js")], env: { PATH: process.env.PATH ?? "", ...as(AGENT) }, cwd: work }),
  );
  return client;
};

beforeAll(async () => {
  server = await worker(`${HUMAN}=human:ada,${AGENT}=agent_of_human:bot,${WATCHER}=human:eve;viewer`);
  await server.start();
  mcp = await connectMcp();
}, 120_000);

afterAll(async () => {
  await mcp?.close();
  await server?.dispose();
});

describe("the CLI refuses a live setting that it cannot use", () => {
  test.each([
    ["an empty address", ["outline", "x", "--live", ""], {}],
    ["an address that is not http", ["outline", "x", "--live", "ftp://example.com"], { SLIDES_LIVE_TOKEN: HUMAN }],
    ["--dir with --live", ["outline", "x", "--live", "http://127.0.0.1:1", "--dir", "d"], { SLIDES_LIVE_TOKEN: HUMAN }],
    ["--as with --live", ["outline", "x", "--live", "http://127.0.0.1:1", "--as", "human:ada"], { SLIDES_LIVE_TOKEN: HUMAN }],
    ["no token", ["outline", "x", "--live", "http://127.0.0.1:1"], {}],
    ["a token sent over plain http to a remote host", ["outline", "x", "--live", "http://slides.example.com"], { SLIDES_LIVE_TOKEN: HUMAN }],
    ["SLIDES_AUTHOR, which the token replaces", ["outline", "x", "--live", "http://127.0.0.1:1"], { SLIDES_LIVE_TOKEN: HUMAN, SLIDES_AUTHOR: "human:ada" }],
  ])("%s exits 2 and never falls back to files", (_label, args, env) => {
    const result = cli(args, env);
    expect(result.code).toBe(2);
    expect(result.out).toBe("");
  });

  test("a server that is down is a coded error with exit 1", () => {
    const result = cli(["outline", "x", "--live", "http://127.0.0.1:1"], { SLIDES_LIVE_TOKEN: HUMAN });
    expect(result.code).toBe(1);
    expect(JSON.parse(result.err).error.code).toBe("LIVE_UNAVAILABLE");
  });
});

describe("the MCP server refuses a live setting that it cannot use", () => {
  test.each([
    ["plain http to a remote host", { SLIDES_LIVE_URL: "http://slides.example.com", SLIDES_LIVE_TOKEN: HUMAN }],
    ["SLIDES_AUTHOR, which the token replaces", { SLIDES_LIVE_URL: "http://127.0.0.1:1", SLIDES_LIVE_TOKEN: AGENT, SLIDES_AUTHOR: "agent:x" }],
    ["no token", { SLIDES_LIVE_URL: "https://slides.example.com" }],
  ])("%s exits 1", (_label, env) => {
    const result = spawnSync("node", [join(process.cwd(), "dist", "mcp-bin.js")], { cwd: work, encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
    expect(result.status).toBe(1);
  });
});

describe("a person and an agent edit one deck in a live room", () => {
  test("the CLI makes the deck, the MCP server and the SDK edit it at once, and both converge", async () => {
    expect(cli(["new", "Shared", "--id", "shared", "--live", server.url], { SLIDES_LIVE_TOKEN: HUMAN }).code).toBe(0);
    await shareAll(server.url, HUMAN, "shared", "ada");
    const person = await LiveDeck.join("shared", { server: server.url, token: HUMAN });
    try {
      const [agent] = await Promise.all([
        tool("add_slides", { deck: "shared", outline: "# From the agent\n- one" }),
        person.edit((deck, author) => deck.addSlide({ layout: "section" }, author)),
      ]);
      expect(agent.isError).toBe(false);
      // The person's copy gets the agent's slide through the room. No poll of the store is needed.
      await waitFor(() => person.deck.outline().slides.length === 2);
      const seen = (await tool("read_outline", { deck: "shared" })).body;
      expect(seen.slides.map((s: any) => s.layout).sort()).toEqual(["section", "title-body"]);
      expect(person.deck.outline().slides.map((s) => s.layout).sort()).toEqual(["section", "title-body"]);
      // The person edits the agent's slide, and the store gets it with the next save.
      const title = person.deck.outline().slides.find((s) => s.title === "From the agent")!.elements.find((e) => e.kind === "text" && e.slot === "title")!;
      const at = person.deck.outline().slides.findIndex((s) => s.title === "From the agent");
      await person.edit((deck, author) => deck.editElement(at, title.id, { text: "Edited by a person" }, author));
      await person.save();
    } finally {
      await person.leave();
    }
    const stored = await http("/decks/shared");
    expect(stored.slides.map((s: any) => s.title).sort()).toEqual(["", "Edited by a person"]);
    // Who made what: the server read each kind from the token.
    expect(stored.slides.find((s: any) => s.layout === "section")).toMatchObject({ createdBy: { kind: "human", name: "ada" } });
    expect(stored.slides.find((s: any) => s.layout === "title-body")).toMatchObject({ createdBy: { kind: "agent_of_human", name: "bot" }, machineMade: true });
  }, 120_000);

  test("a restart keeps the deck, in the room and in the store", async () => {
    await server.stop();
    await server.start();
    const stored = await http("/decks/shared");
    expect(stored.slides).toHaveLength(2);
    const read = cli(["outline", "shared", "--live", server.url], { SLIDES_LIVE_TOKEN: AGENT });
    expect(read.code).toBe(0);
    expect(JSON.parse(read.out).slides).toHaveLength(2);
    // The MCP server was running before the restart. Its next call joins again.
    await mcp.close();
    mcp = await connectMcp();
    expect((await tool("read_outline", { deck: "shared" })).body.slides).toHaveLength(2);
  }, 120_000);

  test("a viewer reads but cannot change the deck, and a missing deck is NO_DECK", () => {
    expect(JSON.parse(cli(["outline", "shared", "--live", server.url], { SLIDES_LIVE_TOKEN: WATCHER }).out).slides).toHaveLength(2);
    const write = cli(["add", "shared", "--layout", "blank", "--live", server.url], { SLIDES_LIVE_TOKEN: WATCHER });
    expect(write.code).toBe(1);
    expect(JSON.parse(write.err).error.code).toBe("FORBIDDEN");
    const missing = cli(["outline", "nope", "--live", server.url], { SLIDES_LIVE_TOKEN: HUMAN });
    expect(JSON.parse(missing.err).error.code).toBe("NO_DECK");
  });

  test("a bad edit is a coded error and changes nothing in the room or the store", async () => {
    const bad = await tool("add_slides", { deck: "shared", outline: "layout: zigzag\n# A" });
    expect(bad.isError).toBe(true);
    expect(bad.body.error.code).toBe("UNKNOWN_LAYOUT");
    expect((await http("/decks/shared")).slides).toHaveLength(2);
    expect((await tool("read_outline", { deck: "shared" })).body.slides).toHaveLength(2);
  });

  test("render and export go through the live setting too", () => {
    expect(cli(["render", "shared", "--live", server.url], { SLIDES_LIVE_TOKEN: HUMAN }).out).toContain("<html");
    const out = join(work, "deck.pdf");
    expect(cli(["export", "shared", "--out", out, "--live", server.url], { SLIDES_LIVE_TOKEN: HUMAN }).code).toBe(0);
  });
});

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("the copies did not converge");
}
