import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SlidesApiError, createClient } from "../client.js";
import { worker, type Server } from "./server.js";

// End to end: the SDK, the built CLI, and the built MCP server share decks on a real Worker (wrangler dev, D1).
// Needs `npm run build`.
const ADA = "ada-token-0123456789-abcdefghijklmn";
const BOB = "bob-token-0123456789-abcdefghijklmn";
const BOT = "bot-token-0123456789-abcdefghijklmn";
const work = mkdtempSync(join(tmpdir(), "slides-share-"));
let server: Server;
let mcp: Client;

const as = (token: string) => createClient({ baseUrl: server.url, token });
const cli = (args: string[], token?: string) => {
  const env = { PATH: process.env.PATH, ...(token ? { SLIDES_LIVE_URL: server.url, SLIDES_LIVE_TOKEN: token } : {}) };
  const result = spawnSync("node", [join(process.cwd(), "dist", "cli.js"), ...args], { cwd: work, encoding: "utf8", env });
  return { code: result.status, out: result.stdout, err: result.stderr };
};
const failed = async (call: Promise<unknown>) => {
  const error = await call.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(SlidesApiError);
  return error as SlidesApiError;
};
async function tool(name: string, args: Record<string, unknown>) {
  const result = (await mcp.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  return { isError: result.isError === true, body: JSON.parse(result.content[0]!.text) as Record<string, any> };
}

beforeAll(async () => {
  server = await worker(`${ADA}=human:ada,${BOB}=human:bob,${BOT}=agent:bot`);
  await server.start();
  mcp = new Client({ name: "probe", version: "0.0.0" });
  await mcp.connect(new StdioClientTransport({ command: "node", args: [join(process.cwd(), "dist", "mcp-bin.js")], env: { PATH: process.env.PATH ?? "", SLIDES_LIVE_URL: server.url, SLIDES_LIVE_TOKEN: BOT }, cwd: work }));
}, 120_000);

afterAll(async () => {
  await mcp?.close();
  await server?.dispose();
});

describe("the SDK shares a deck", () => {
  test("grant, read, refuse, revoke", async () => {
    const ada = as(ADA);
    const bob = as(BOB);
    await ada.createDeck({ title: "Plan", id: "plan" });
    expect(await ada.me()).toMatchObject({ subject: { kind: "human", id: "ada" } });
    expect(await failed(bob.outline("plan"))).toMatchObject({ status: 404, code: "NO_DECK" });

    await ada.grant("plan", { subject: { kind: "human", id: "bob" }, role: "viewer" });
    expect((await bob.outline("plan")).title).toBe("Plan");
    expect(await failed(bob.addSlides("plan", { layout: "blank" }))).toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(await failed(bob.access("plan"))).toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(await failed(bob.grant("plan", { subject: { kind: "human", id: "bob" }, role: "owner" }))).toMatchObject({ status: 403 });

    const access = await ada.access("plan");
    expect(access.grants.map((g) => `${g.subjectKind}:${g.subjectId}:${g.role}`).sort()).toEqual(["human:ada:owner", "human:bob:viewer"]);
    await ada.revoke("plan", { kind: "human", id: "bob" });
    expect(await failed(bob.outline("plan"))).toMatchObject({ status: 404 });
    expect(await failed(ada.revoke("plan", { kind: "human", id: "ada" }))).toMatchObject({ status: 400, code: "INVALID_SHARE" });
  }, 60_000);

  test("a bad token is a 401 on every sharing call", async () => {
    const nobody = as(`${ADA}x`);
    const subject = { kind: "human", id: "bob" } as const;
    const calls = [() => nobody.access("plan"), () => nobody.grant("plan", { subject, role: "viewer" }), () => nobody.revoke("plan", subject), () => nobody.invite("plan", { role: "viewer", handle: "bot" }), () => nobody.acceptInvite("x"), () => nobody.createShareLink("plan", { role: "viewer" }), () => nobody.revokeShareLink("plan", "x")];
    for (const call of calls) {
      expect(await failed(call())).toMatchObject({ status: 401, code: "UNAUTHORIZED" });
    }
  });
});

describe("the CLI shares a deck", () => {
  test("grant, access, link, and the refusals", async () => {
    expect(cli(["new", "Talk", "--id", "talk"], ADA).code).toBe(0);
    expect(cli(["grant", "talk", "--subject", "agent:bot", "--role", "editor"], ADA).code).toBe(0);
    const access = JSON.parse(cli(["access", "talk"], ADA).out);
    expect(access.grants.map((g: any) => `${g.subjectKind}:${g.subjectId}:${g.role}`).sort()).toEqual(["agent:bot:editor", "human:ada:owner"]);

    // An editor is not an owner. A bad token is a 401. A person with no role sees no deck.
    const editor = cli(["access", "talk"], BOT);
    expect(editor.code).toBe(1);
    expect(JSON.parse(editor.err).error.code).toBe("FORBIDDEN");
    expect(JSON.parse(cli(["access", "talk"], `${ADA}x`).err).error.code).toBe("UNAUTHORIZED");
    expect(JSON.parse(cli(["grant", "talk", "--subject", "human:bob", "--role", "viewer"], BOB).err).error.code).toBe("NO_DECK");

    // Local files have no roles, and a bad flag is a usage error.
    expect(cli(["grant", "talk", "--subject", "human:bob", "--role", "viewer", "--as", "human:ada"]).code).toBe(2);
    expect(cli(["grant", "talk", "--subject", "bob", "--role", "viewer"], ADA).code).toBe(2);
    expect(cli(["grant", "talk", "--subject", "human:bob", "--role", "boss"], ADA).code).toBe(2);

    const link = JSON.parse(cli(["share-link", "talk", "--role", "viewer", "--expires-in-ms", "600000"], ADA).out);
    expect(link.token).toEqual(expect.any(String));
    expect((await as(BOB).readShared("talk", link.token)).title).toBe("Talk");
    expect(JSON.parse(cli(["access", "talk"], ADA).out).links).toMatchObject([{ id: link.id, role: "viewer", revoked: false }]);
    expect(cli(["revoke-link", "talk", "--link", link.id], ADA).code).toBe(0);
    expect(await failed(as(BOB).readShared("talk", link.token))).toMatchObject({ status: 404 });

    expect(cli(["revoke", "talk", "--subject", "agent:bot"], ADA).code).toBe(0);
    expect(JSON.parse(cli(["outline", "talk"], BOT).err).error.code).toBe("NO_DECK");
  }, 60_000);

  test("invite an agent by handle, and the agent accepts", async () => {
    await as(ADA).createDeck({ title: "Invite", id: "invite" });
    const made = JSON.parse(cli(["invite", "invite", "--role", "editor", "--handle", "bot"], ADA).out);
    expect(made.id).toEqual(expect.any(String));
    expect(JSON.parse(cli(["invite", "invite", "--role", "editor"], ADA).err).error.code).toBe("INVALID_SHARE");
    expect(JSON.parse(cli(["accept-invite", made.id], BOB).err).error.code).toBe("FORBIDDEN");
    expect(cli(["accept-invite", made.id], BOT).code).toBe(0);
    expect((await as(BOT).outline("invite")).title).toBe("Invite");
  }, 60_000);
});

describe("the MCP server shares a deck", () => {
  test("the tools exist in a live setting, and each follows the role", async () => {
    const { tools } = await mcp.listTools();
    for (const name of ["list_access", "grant_access", "revoke_access", "invite", "accept_invite", "create_share_link", "revoke_share_link"]) expect(tools.map((t) => t.name)).toContain(name);

    // The agent owns what it makes.
    const made = await tool("create_deck", { title: "Agent deck", id: "agentdeck" });
    expect(made.isError).toBe(false);
    expect((await tool("grant_access", { deck: "agentdeck", subject: { kind: "human", id: "bob" }, role: "editor" })).isError).toBe(false);
    const access = await tool("list_access", { deck: "agentdeck" });
    expect(access.body.grants.map((g: any) => `${g.subjectKind}:${g.subjectId}:${g.role}`).sort()).toEqual(["agent:bot:owner", "human:bob:editor"]);
    expect((await as(BOB).addSlides("agentdeck", { layout: "blank" })).slideIds).toHaveLength(1);

    const invite = await tool("invite", { deck: "agentdeck", role: "viewer", email: "ada@example.com" });
    expect(invite.body.id).toEqual(expect.any(String));
    const link = await tool("create_share_link", { deck: "agentdeck", role: "viewer" });
    expect((await as(ADA).readShared("agentdeck", link.body.token)).title).toBe("Agent deck");
    expect((await tool("revoke_share_link", { deck: "agentdeck", link: link.body.id })).isError).toBe(false);
    expect((await tool("revoke_access", { deck: "agentdeck", subject: { kind: "human", id: "bob" } })).isError).toBe(false);
    expect(await failed(as(BOB).outline("agentdeck"))).toMatchObject({ status: 404 });

    // The agent holds no role on a deck of the person: a coded error, not a crash.
    const refused = await tool("list_access", { deck: "plan" });
    expect(refused.isError).toBe(true);
    expect(refused.body.error.code).toBe("NO_DECK");
    await as(ADA).grant("plan", { subject: { kind: "agent", id: "bot" }, role: "editor" });
    const editor = await tool("grant_access", { deck: "plan", subject: { kind: "human", id: "kit" }, role: "viewer" });
    expect(editor.isError).toBe(true);
    expect(editor.body.error.code).toBe("FORBIDDEN");
  }, 60_000);
});
