import { describe, expect, test } from "vitest";
import { createClient } from "./client.js";

// The sharing calls send the right method, path, and body. The refusals are tested against a real Worker in src/e2e/sharing.test.ts.
describe("the sharing calls of the client", () => {
  test("each call has its own route, and every part of a path is encoded", async () => {
    const calls: { method: string; url: string; body?: unknown; headers: Record<string, string> }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ method: init.method!, url, body: init.body === undefined ? undefined : JSON.parse(init.body as string), headers: init.headers as Record<string, string> });
      return Response.json({ id: "i", token: "t", grants: [], invites: [], links: [], title: "T" });
    }) as unknown as typeof globalThis.fetch;
    const client = createClient({ baseUrl: "http://x.test/", token: "secret", fetch });

    await client.access("a b", { limit: 5, inviteCursor: "i c", linkCursor: "l" });
    await client.grant("a b", { subject: { kind: "agent", id: "bot" }, role: "editor" });
    await client.revoke("a b", { kind: "human", id: "x&y" });
    await client.invite("a b", { role: "viewer", handle: "bot" });
    await client.acceptInvite("i1");
    await client.createShareLink("a b", { role: "viewer", signedInOnly: true });
    await client.revokeShareLink("a b", "l/1");
    await client.readShared("a b", "link-token");

    const base = "http://x.test/api/v1/slides";
    expect(calls.map((c) => `${c.method} ${c.url.slice(base.length)}`)).toEqual([
      "GET /decks/a%20b/access?limit=5&inviteCursor=i+c&linkCursor=l",
      "POST /decks/a%20b/grants",
      "DELETE /decks/a%20b/grants?subjectKind=human&subjectId=x%26y",
      "POST /decks/a%20b/invites",
      "POST /invites/accept",
      "POST /decks/a%20b/links",
      "DELETE /decks/a%20b/links/l%2F1",
      "GET /shared/a%20b",
    ]);
    expect(calls[1]!.body).toEqual({ subjectKind: "agent", subjectId: "bot", role: "editor" });
    expect(calls[5]!.body).toEqual({ role: "viewer", signedInOnly: true });
    expect(calls[7]!.headers).toMatchObject({ "x-link-token": "link-token", authorization: "Bearer secret" });
  });
});
