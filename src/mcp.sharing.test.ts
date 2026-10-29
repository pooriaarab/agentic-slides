import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMemoryBlobs, createMemoryStore } from "agentic-identity";
import { describe, expect, test } from "vitest";
import { SlidesApiError } from "./client.js";
import { createMcpServer, type McpDeps } from "./mcp.js";
import { createService } from "./service.js";

// The sharing tools of the MCP server, against a stand-in for the HTTP client. The real flow is in src/e2e/sharing.test.ts.
const SHARING_TOOLS = ["list_access", "grant_access", "revoke_access", "invite", "accept_invite", "create_share_link", "revoke_share_link"];

async function connect(sharing?: McpDeps["sharing"]) {
  const server = createMcpServer({ service: createService({ store: createMemoryStore(), blobs: createMemoryBlobs() }), sharing });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "probe", version: "0.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { isError: result.isError === true, body: JSON.parse(result.content[0]!.text) as Record<string, any> };
  };
  return { client, call };
}

describe("the sharing tools of the MCP server", () => {
  test("a server with no sharing client (a local store) has none of them", async () => {
    const { client } = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const name of SHARING_TOOLS) expect(names).not.toContain(name);
    expect(names).toContain("create_deck");
  });

  test("a refusal from the API, such as a token that expired while the server ran, is a coded error result", async () => {
    const refuse = (status: number, code: "UNAUTHORIZED" | "FORBIDDEN") => async () => Promise.reject(new SlidesApiError(status, code, "refused"));
    const sharing = {
      access: refuse(401, "UNAUTHORIZED"),
      grant: refuse(403, "FORBIDDEN"),
      revoke: refuse(401, "UNAUTHORIZED"),
      invite: refuse(403, "FORBIDDEN"),
      acceptInvite: refuse(401, "UNAUTHORIZED"),
      createShareLink: refuse(403, "FORBIDDEN"),
      revokeShareLink: refuse(401, "UNAUTHORIZED"),
    } as unknown as NonNullable<McpDeps["sharing"]>;
    const { call } = await connect(sharing);
    const subject = { kind: "human", id: "bob" };
    const cases: [string, Record<string, unknown>, string][] = [
      ["list_access", { deck: "d" }, "UNAUTHORIZED"],
      ["grant_access", { deck: "d", subject, role: "viewer" }, "FORBIDDEN"],
      ["revoke_access", { deck: "d", subject }, "UNAUTHORIZED"],
      ["invite", { deck: "d", role: "viewer", handle: "bot" }, "FORBIDDEN"],
      ["accept_invite", { id: "x" }, "UNAUTHORIZED"],
      ["create_share_link", { deck: "d", role: "viewer" }, "FORBIDDEN"],
      ["revoke_share_link", { deck: "d", link: "l" }, "UNAUTHORIZED"],
    ];
    for (const [name, args, code] of cases) {
      const result = await call(name, args);
      expect(result.isError, name).toBe(true);
      expect(result.body.error.code, name).toBe(code);
    }
  });

  test("list_access sends only the page fields, not the deck id, and a bad role is refused by the schema", async () => {
    const seen: unknown[] = [];
    const sharing = { access: async (deck: string, input: unknown) => (seen.push([deck, input]), { grants: [], invites: [], links: [] }) } as unknown as NonNullable<McpDeps["sharing"]>;
    const { client } = await connect(sharing);
    await client.callTool({ name: "list_access", arguments: { deck: "d", limit: 5 } });
    expect(seen).toEqual([["d", { limit: 5, cursor: undefined, inviteCursor: undefined, linkCursor: undefined }]]);
    const bad = (await client.callTool({ name: "grant_access", arguments: { deck: "d", subject: { kind: "human", id: "b" }, role: "boss" } })) as { isError?: boolean };
    expect(bad.isError).toBe(true);
  });
});
