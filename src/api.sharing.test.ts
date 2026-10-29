import { createMemoryBlobs, createMemoryStore } from "agentic-identity";
import { describe, expect, test } from "vitest";
import worker from "./worker.js";
import { createApp } from "./api.js";
import { parseTokens, tokenAuth } from "./auth.js";
import { createService } from "./service.js";

// Roles on decks, over the real app and a memory store. Each caller has its own token.
const ADA = "ada-token-0123456789-abcdefghijklmn";
const BOB = "bob-token-0123456789-abcdefghijklmn";
const BOT = "bot-token-0123456789-abcdefghijklmn";
const EVE = "eve-token-0123456789-abcdefghijklmn";
const CLASH = "clash-token-0123456789-abcdefghijkl";
const VIEW = "view-token-0123456789-abcdefghijklm";
const TOKENS = `${ADA}=human:ada,${BOB}=human:bob,${BOT}=agent:bot,${EVE}=agent_of_human:eve,${VIEW}=human:vic;viewer,${CLASH}=agent:agent_of_human_eve`;
const BASE = "http://slides.test/api/v1/slides";

function setup() {
  const store = createMemoryStore();
  const service = createService({ store, blobs: createMemoryBlobs() });
  // A room stub that records what the routes tell it.
  const room: string[] = [];
  const live = {
    connect: async (id: string, _request: Request, grant: { principal: { id: string }; role: string }) => (room.push(`connect ${id} ${grant.principal.id} ${grant.role}`), new Response("joined", { status: 200 })),
    revoke: async (id: string, who: string) => (room.push(`revoke ${id} ${who}`), { closed: 0, stored: true }),
    updateRole: async (id: string, who: string, role: string | null) => (room.push(`role ${id} ${who} ${role}`), true),
    erase: async (id: string) => (room.push(`erase ${id}`), { sockets: 0 }),
    meta: async () => ({ updates: 0, compactions: 0, contributors: [] }),
  };
  const app = createApp({ service, auth: tokenAuth(parseTokens(TOKENS)), store, live: () => live as never });
  const call = async (method: string, path: string, init: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const response = await app.request(`${BASE}${path}`, {
      method,
      headers: { ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await response.text();
    return { status: response.status, json: text.startsWith("{") ? JSON.parse(text) : undefined, text };
  };
  return { call, service, store, room, app };
}
const OUTLINE = { outline: "# Hello\n- one" };

describe("roles on decks", () => {
  test("the creator owns a deck, and a caller with no role gets the answer for a missing deck", async () => {
    const { call } = setup();
    expect((await call("POST", "/decks", { token: ADA, body: { title: "Plan", id: "plan" } })).status).toBe(201);
    expect((await call("GET", "/decks/plan", { token: ADA })).status).toBe(200);
    const none = await call("GET", "/decks/plan", { token: BOB });
    const missing = await call("GET", "/decks/nothing", { token: BOB });
    expect(none.status).toBe(404);
    expect(none.json.error.code).toBe(missing.json.error.code);
    for (const [method, path] of [["POST", "/decks/plan/slides"], ["DELETE", "/decks/plan"], ["GET", "/decks/plan/render"], ["GET", "/decks/plan/export"], ["GET", "/decks/plan/state"], ["GET", "/decks/plan/access"]]) {
      expect((await call(method!, path!, { token: BOB, body: method === "POST" ? OUTLINE : undefined })).status, `${method} ${path}`).toBe(404);
    }
    expect((await call("GET", "/decks", { token: BOB })).json.decks).toEqual([]);
    expect((await call("GET", "/decks", { token: ADA })).json.decks.map((d: { id: string }) => d.id)).toEqual(["plan"]);
  });

  test("viewer reads, commenter reads, editor writes, only the owner deletes and shares", async () => {
    const { call } = setup();
    await call("POST", "/decks", { token: ADA, body: { title: "Plan", id: "plan" } });
    const give = (role: string) => call("POST", "/decks/plan/grants", { token: ADA, body: { subjectKind: "human", subjectId: "bob", role } });

    for (const role of ["viewer", "commenter"]) {
      expect((await give(role)).status).toBe(200);
      expect((await call("GET", "/decks/plan", { token: BOB })).status).toBe(200);
      const write = await call("POST", "/decks/plan/slides", { token: BOB, body: OUTLINE });
      expect(write.status, role).toBe(403);
      expect(write.json.error.code).toBe("FORBIDDEN");
    }
    expect((await give("editor")).status).toBe(200);
    expect((await call("POST", "/decks/plan/slides", { token: BOB, body: OUTLINE })).status).toBe(201);
    expect((await call("GET", "/decks", { token: BOB })).json.decks).toHaveLength(1);
    // An editor still cannot delete the deck or touch its sharing.
    expect((await call("DELETE", "/decks/plan", { token: BOB })).status).toBe(403);
    expect((await call("GET", "/decks/plan/access", { token: BOB })).status).toBe(403);
    expect((await call("POST", "/decks/plan/grants", { token: BOB, body: { subjectKind: "human", subjectId: "kit", role: "owner" } })).status).toBe(403);
    expect((await call("POST", "/decks/plan/invites", { token: BOB, body: { role: "viewer", handle: "bot" } })).status).toBe(403);
    expect((await call("POST", "/decks/plan/links", { token: BOB, body: { role: "viewer" } })).status).toBe(403);
    expect((await call("DELETE", "/decks/plan/grants?subjectKind=human&subjectId=ada", { token: BOB })).status).toBe(403);
  });

  test("revoke removes access at once", async () => {
    const { call } = setup();
    await call("POST", "/decks", { token: ADA, body: { title: "Plan", id: "plan" } });
    await call("POST", "/decks/plan/grants", { token: ADA, body: { subjectKind: "human", subjectId: "bob", role: "editor" } });
    expect((await call("GET", "/decks/plan", { token: BOB })).status).toBe(200);
    expect((await call("DELETE", "/decks/plan/grants?subjectKind=human&subjectId=bob", { token: ADA })).status).toBe(200);
    expect((await call("GET", "/decks/plan", { token: BOB })).status).toBe(404);
  });

  test("a person and an agent with one name hold separate roles, and a delegated agent has its own subject", async () => {
    const { call } = setup();
    await call("POST", "/decks", { token: ADA, body: { title: "Plan", id: "plan" } });
    await call("POST", "/decks/plan/grants", { token: ADA, body: { subjectKind: "human", subjectId: "bot", role: "editor" } });
    expect((await call("GET", "/decks/plan", { token: BOT })).status).toBe(404);
    expect((await call("GET", "/me", { token: EVE })).json.subject).toEqual({ kind: "agent", id: "agent_of_human_eve" });
    await call("POST", "/decks/plan/grants", { token: ADA, body: { subjectKind: "agent", subjectId: "agent_of_human_eve", role: "viewer" } });
    expect((await call("GET", "/decks/plan", { token: EVE })).status).toBe(200);
    expect((await call("POST", "/decks/plan/slides", { token: EVE, body: OUTLINE })).status).toBe(403);
  });

  test("a viewer token cannot write, even for an owner, and cannot make a deck", async () => {
    const { call } = setup();
    await call("POST", "/decks", { token: ADA, body: { title: "Plan", id: "plan" } });
    await call("POST", "/decks/plan/grants", { token: ADA, body: { subjectKind: "human", subjectId: "vic", role: "owner" } });
    expect((await call("GET", "/decks/plan", { token: VIEW })).status).toBe(200);
    expect((await call("POST", "/decks/plan/slides", { token: VIEW, body: OUTLINE })).status).toBe(403);
    expect((await call("POST", "/decks/plan/grants", { token: VIEW, body: { subjectKind: "human", subjectId: "kit", role: "viewer" } })).status).toBe(403);
    expect((await call("POST", "/decks", { token: VIEW, body: { title: "x" } })).status).toBe(403);
  });

  test("the last owner cannot be removed, and bad input is a 400", async () => {
    const { call } = setup();
    await call("POST", "/decks", { token: ADA, body: { title: "Plan", id: "plan" } });
    const last = await call("DELETE", "/decks/plan/grants?subjectKind=human&subjectId=ada", { token: ADA });
    expect(last.status).toBe(400);
    expect(last.json.error.code).toBe("INVALID_SHARE");
    for (const body of [{ subjectKind: "human", subjectId: "bob", role: "boss" }, { subjectKind: "robot", subjectId: "bob", role: "viewer" }, { subjectKind: "human", subjectId: "b o b", role: "viewer" }, {}]) {
      expect((await call("POST", "/decks/plan/grants", { token: ADA, body })).status).toBe(400);
    }
    expect((await call("GET", "/decks/plan/access?limit=0", { token: ADA })).status).toBe(400);
  });

  test("deleting a deck erases its roles, so a new deck with the same id starts clean", async () => {
    const { call } = setup();
    await call("POST", "/decks", { token: ADA, body: { title: "Plan", id: "plan" } });
    await call("POST", "/decks/plan/grants", { token: ADA, body: { subjectKind: "human", subjectId: "bob", role: "editor" } });
    expect((await call("DELETE", "/decks/plan", { token: ADA })).status).toBe(200);
    expect((await call("POST", "/decks", { token: BOB, body: { title: "Mine", id: "plan" } })).status).toBe(201);
    expect((await call("GET", "/decks/plan", { token: ADA })).status).toBe(404);
    const access = await call("GET", "/decks/plan/access", { token: BOB });
    expect(access.json.grants).toEqual([{ resourceId: "plan", subjectKind: "human", subjectId: "bob", role: "owner" }]);
  });

  test("a deck made before sharing keeps the token check and cannot be shared", async () => {
    const { call, service } = setup();
    await service.create({ title: "Old", id: "old", author: { kind: "human", name: "ada" } });
    expect((await call("GET", "/decks/old", { token: BOB })).status).toBe(200);
    expect((await call("POST", "/decks/old/slides", { token: BOB, body: OUTLINE })).status).toBe(201);
    expect((await call("POST", "/decks/old/grants", { token: BOB, body: { subjectKind: "human", subjectId: "kit", role: "owner" } })).status).toBe(403);
    expect((await call("POST", "/decks", { token: BOB, body: { title: "Again", id: "old" } })).status).toBe(409);
    expect((await call("POST", "/decks/ghost/grants", { token: BOB, body: { subjectKind: "human", subjectId: "kit", role: "owner" } })).status).toBe(404);
  });
});

describe("share routes refuse a caller with no valid token", () => {
  test.each([
    ["GET", "/decks/plan/access"],
    ["POST", "/decks/plan/grants"],
    ["DELETE", "/decks/plan/grants?subjectKind=human&subjectId=bob"],
    ["POST", "/decks/plan/invites"],
    ["POST", "/decks/plan/links"],
    ["DELETE", "/decks/plan/links/x"],
    ["POST", "/invites/accept"],
  ])("%s %s is a 401", async (method, path) => {
    const { call } = setup();
    await call("POST", "/decks", { token: ADA, body: { title: "Plan", id: "plan" } });
    for (const token of [undefined, `${ADA}x`]) expect((await call(method, path, { token, body: method === "POST" ? {} : undefined })).status).toBe(401);
  });
});

describe("invites", () => {
  test("an owner invites an agent by handle, and only that agent accepts, once", async () => {
    const { call } = setup();
    await call("POST", "/decks", { token: ADA, body: { title: "Plan", id: "plan" } });
    const made = await call("POST", "/decks/plan/invites", { token: ADA, body: { role: "editor", handle: "bot", expiresInMs: 60_000 } });
    expect(made.status).toBe(201);
    const { id } = made.json;
    expect((await call("GET", "/decks/plan", { token: BOT })).status).toBe(404);
    // Another agent, and a person, cannot use it.
    expect((await call("POST", "/invites/accept", { token: EVE, body: { id } })).status).toBe(403);
    expect((await call("POST", "/invites/accept", { token: BOB, body: { id } })).status).toBe(403);
    expect((await call("POST", "/invites/accept", { token: BOT, body: { id } })).status).toBe(200);
    expect((await call("POST", "/decks/plan/slides", { token: BOT, body: OUTLINE })).status).toBe(201);
    expect((await call("POST", "/invites/accept", { token: BOT, body: { id } })).status).toBe(403);
  });

  test("an invite by email is listed without the address, and a token cannot accept it", async () => {
    const { call } = setup();
    await call("POST", "/decks", { token: ADA, body: { title: "Plan", id: "plan" } });
    const made = await call("POST", "/decks/plan/invites", { token: ADA, body: { role: "viewer", email: "bob@example.com" } });
    expect(made.status).toBe(201);
    expect((await call("POST", "/invites/accept", { token: BOB, body: { id: made.json.id } })).status).toBe(403);
    const access = await call("GET", "/decks/plan/access", { token: ADA });
    expect(access.json.invites).toHaveLength(1);
    expect(access.text).not.toContain("example.com");
  });

  test("bad invites are a 400", async () => {
    const { call } = setup();
    await call("POST", "/decks", { token: ADA, body: { title: "Plan", id: "plan" } });
    for (const body of [{ role: "viewer" }, { role: "viewer", email: "a@b.c", handle: "bot" }, { role: "viewer", handle: "bot", expiresInMs: -1 }, { role: "viewer", email: "nope" }]) {
      expect((await call("POST", "/decks/plan/invites", { token: ADA, body })).status, JSON.stringify(body)).toBe(400);
    }
  });

  test("an expired invite is refused", async () => {
    const { call } = setup();
    await call("POST", "/decks", { token: ADA, body: { title: "Plan", id: "plan" } });
    const { json } = await call("POST", "/decks/plan/invites", { token: ADA, body: { role: "editor", handle: "bot", expiresInMs: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await call("POST", "/invites/accept", { token: BOT, body: { id: json.id } })).status).toBe(403);
  });
});

describe("share links", () => {
  test("a link reads the deck with no account, and never writes", async () => {
    const { call } = setup();
    await call("POST", "/decks", { token: ADA, body: { title: "Plan", id: "plan" } });
    const link = await call("POST", "/decks/plan/links", { token: ADA, body: { role: "viewer", expiresInMs: 60_000 } });
    expect(link.status).toBe(201);
    const { id, token } = link.json;
    const visit = (path: string, headers: Record<string, string>) => call("GET", `/shared/plan${path}`, { headers });

    expect((await visit("", { "x-link-token": token })).json.title).toBe("Plan");
    const page = await visit("/render?present=1", { "x-link-token": token });
    expect(page.status).toBe(200);
    expect(page.text).toContain("<html");
    expect((await visit("", {})).status).toBe(404);
    expect((await visit("", { "x-link-token": `${token}x` })).status).toBe(404);
    expect((await call("GET", "/shared/other", { headers: { "x-link-token": token } })).status).toBe(404);
    // The token opens only the shared routes. It is no bearer token.
    expect((await call("GET", "/decks/plan", { headers: { "x-link-token": token } })).status).toBe(401);
    expect((await call("POST", "/decks/plan/slides", { headers: { "x-link-token": token }, body: OUTLINE })).status).toBe(401);
    // A bad bearer token is a 401, not a silent fall back to the link.
    expect((await visit("", { "x-link-token": token, authorization: `Bearer ${ADA}x` })).status).toBe(401);

    const access = await call("GET", "/decks/plan/access", { token: ADA });
    expect(access.text).not.toContain(token);
    expect(access.json.links).toEqual([{ id, role: "viewer", signedInOnly: false, expiresAt: expect.any(Number), revoked: false }]);

    expect((await call("DELETE", `/decks/plan/links/${id}`, { token: BOB })).status).toBe(404);
    expect((await call("DELETE", `/decks/plan/links/${id}`, { token: ADA })).status).toBe(200);
    expect((await visit("", { "x-link-token": token })).status).toBe(404);
  });

  test("a signed-in-only link needs a valid bearer token, and an expired link is refused", async () => {
    const { call } = setup();
    await call("POST", "/decks", { token: ADA, body: { title: "Plan", id: "plan" } });
    const { json } = await call("POST", "/decks/plan/links", { token: ADA, body: { role: "viewer", signedInOnly: true } });
    expect((await call("GET", "/shared/plan", { headers: { "x-link-token": json.token } })).status).toBe(404);
    expect((await call("GET", "/shared/plan", { token: BOB, headers: { "x-link-token": json.token } })).status).toBe(200);

    const soon = await call("POST", "/decks/plan/links", { token: ADA, body: { role: "viewer", expiresInMs: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await call("GET", "/shared/plan", { headers: { "x-link-token": soon.json.token } })).status).toBe(404);
  });

  test("a link on a deck made before sharing opens nothing", async () => {
    const { call, service } = setup();
    await service.create({ title: "Old", id: "old", author: { kind: "human", name: "ada" } });
    expect((await call("GET", "/shared/old", { headers: { "x-link-token": "anything" } })).status).toBe(404);
  });
});

describe("review fixes", () => {
  test("a list with no role gives no cursor of a deck that it hides", async () => {
    const { call } = setup();
    for (const id of ["one", "two", "three"]) await call("POST", "/decks", { token: ADA, body: { title: id, id } });
    const page = await call("GET", "/decks?limit=1", { token: BOB });
    expect(page.json).toEqual({ decks: [] });
    // A caller with one role among hidden decks gets exactly that deck, and no cursor into the others.
    await call("POST", "/decks/two/grants", { token: ADA, body: { subjectKind: "human", subjectId: "bob", role: "viewer" } });
    const mixed = await call("GET", "/decks?limit=1", { token: BOB });
    expect(mixed.json.decks.map((d: { id: string }) => d.id)).toEqual(["two"]);
    // The cursor stands after the deck that it returned, never after one that Bob cannot see.
    expect(JSON.parse(Buffer.from(mixed.json.nextCursor, "base64url").toString())[1]).toBe("two");
    expect(mixed.text).not.toMatch(/three/);
    // The owner pages through all three decks, and the cursors work.
    const first = await call("GET", "/decks?limit=2", { token: ADA });
    expect(first.json.decks).toHaveLength(2);
    const rest = await call("GET", `/decks?limit=2&cursor=${encodeURIComponent(first.json.nextCursor)}`, { token: ADA });
    expect(rest.json.decks).toHaveLength(1);
  });

  test("a deck id that has an owner record is refused, and no deck is made", async () => {
    const { call, service, store } = setup();
    await store.put("resources", "taken", { id: "taken", type: "deck" });
    const made = await call("POST", "/decks", { token: BOB, body: { title: "Mine", id: "taken" } });
    expect(made.status).toBe(409);
    await expect(service.exists("taken")).rejects.toMatchObject({ code: "NO_DECK" });
    expect((await call("POST", "/decks", { token: BOB, body: { title: "Mine", id: "bad id" } })).status).toBe(400);
    expect((await call("POST", "/decks", { token: BOB, body: { title: "No id" } })).status).toBe(201);
  });

  test("two callers that make one id: one wins, and the owner is the winner", async () => {
    const { call } = setup();
    const both = await Promise.all([call("POST", "/decks", { token: ADA, body: { title: "A", id: "race" } }), call("POST", "/decks", { token: BOB, body: { title: "B", id: "race" } })]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
    const winner = both[0]!.status === 201 ? ADA : BOB;
    expect((await call("GET", "/decks/race/access", { token: winner })).status).toBe(200);
  });

  test("a delete that stopped after the deck can be finished by the owner", async () => {
    const { call, service } = setup();
    await call("POST", "/decks", { token: ADA, body: { title: "Plan", id: "plan" } });
    await service.deleteDeck("plan", { kind: "human", name: "ada" });
    expect((await call("DELETE", "/decks/plan", { token: BOB })).status).toBe(404);
    expect((await call("DELETE", "/decks/plan", { token: ADA })).status).toBe(200);
    expect((await call("DELETE", "/decks/plan", { token: ADA })).status).toBe(404);
    expect((await call("POST", "/decks", { token: BOB, body: { title: "New", id: "plan" } })).status).toBe(201);
  });

  test("a revoke closes the room of that person, and a grant tells the room the new role", async () => {
    const { call, room } = setup();
    await call("POST", "/decks", { token: ADA, body: { title: "Plan", id: "plan" } });
    const give = (subjectKind: string, subjectId: string, role: string) => call("POST", "/decks/plan/grants", { token: ADA, body: { subjectKind, subjectId, role } });
    await give("human", "bob", "commenter");
    await give("human", "bob", "editor");
    await give("agent", "agent_of_human_eve", "viewer");
    await call("DELETE", "/decks/plan/grants?subjectKind=human&subjectId=bob", { token: ADA });
    await call("DELETE", "/decks/plan/grants?subjectKind=agent&subjectId=agent_of_human_eve", { token: ADA });
    expect(room).toEqual([
      "role plan human.bob viewer",
      "role plan human.bob null",
      "role plan agent.agent_of_human_eve viewer",
      "role plan agent_of_human.eve viewer",
      "revoke plan human.bob",
      "revoke plan agent.agent_of_human_eve",
      "revoke plan agent_of_human.eve",
    ]);
  });

  test("a commenter and a viewer join the room as a viewer, and an editor as an editor", async () => {
    const { app, call, room } = setup();
    await call("POST", "/decks", { token: ADA, body: { title: "Plan", id: "plan" } });
    for (const role of ["viewer", "commenter", "editor"]) {
      await call("POST", "/decks/plan/grants", { token: ADA, body: { subjectKind: "human", subjectId: "bob", role } });
      room.length = 0;
      const response = await app.request(`${BASE}/decks/plan/ws`, { headers: { authorization: `Bearer ${BOB}`, upgrade: "websocket" } });
      expect(response.status, role).toBe(200);
      expect(room, role).toEqual([`connect plan human.bob ${role === "editor" ? "editor" : "viewer"}`]);
    }
    expect((await app.request(`${BASE}/decks/plan/ws`, { headers: { authorization: `Bearer ${EVE}`, upgrade: "websocket" } })).status).toBe(404);
  });

  test("an editor cannot revoke a link, and a link of another deck is not revoked through this deck", async () => {
    const { call } = setup();
    await call("POST", "/decks", { token: ADA, body: { title: "A", id: "a" } });
    await call("POST", "/decks", { token: BOB, body: { title: "B", id: "b" } });
    await call("POST", "/decks/a/grants", { token: ADA, body: { subjectKind: "human", subjectId: "bob", role: "editor" } });
    const link = (await call("POST", "/decks/a/links", { token: ADA, body: { role: "viewer" } })).json;
    expect((await call("DELETE", `/decks/a/links/${link.id}`, { token: BOB })).status).toBe(403);
    // Bob owns b, not a. The link of a stays valid.
    expect((await call("DELETE", `/decks/b/links/${link.id}`, { token: BOB })).status).toBe(403);
    expect((await call("GET", "/shared/a", { headers: { "x-link-token": link.token } })).status).toBe(200);
  });

  test("a link visitor makes no audit row for an id that has no deck, or for a record that is not a deck", async () => {
    const { call, store } = setup();
    await store.put("resources", "file1", { id: "file1", type: "file" });
    for (const id of ["ghost", "file1"]) expect((await call("GET", `/shared/${id}`, { headers: { "x-link-token": "x" } })).status).toBe(404);
    expect((await store.query("audit", { limit: 10 })).items).toEqual([]);
    expect((await call("GET", "/shared/ghost", { headers: { "x-link-token": "x" } })).status).toBe(404);
  });

  test("only an agent token accepts an invite by handle, and one agent name cannot take the subject of a delegated token", async () => {
    const { call } = setup();
    await call("POST", "/decks", { token: ADA, body: { title: "Plan", id: "plan" } });
    const { id } = (await call("POST", "/decks/plan/invites", { token: ADA, body: { role: "editor", handle: "eve" } })).json;
    // `agent_of_human:eve` has the name of the handle, but not the identity of an agent.
    expect((await call("POST", "/invites/accept", { token: EVE, body: { id } })).status).toBe(403);
    expect((await call("GET", "/decks/plan", { token: EVE })).status).toBe(404);
    // The token `agent:agent_of_human_eve` would share the subject of `agent_of_human:eve`, so it holds no role at all.
    expect((await call("GET", "/me", { token: CLASH })).json.subject).toBeNull();
    await call("POST", "/decks/plan/grants", { token: ADA, body: { subjectKind: "agent", subjectId: "agent_of_human_eve", role: "editor" } });
    expect((await call("GET", "/decks/plan", { token: CLASH })).status).toBe(404);
    expect((await call("POST", "/decks", { token: CLASH, body: { title: "x" } })).status).toBe(403);
  });

  test("access pages through grants, invites, and links", async () => {
    const { call } = setup();
    await call("POST", "/decks", { token: ADA, body: { title: "Plan", id: "plan" } });
    for (const n of [1, 2, 3]) {
      await call("POST", "/decks/plan/invites", { token: ADA, body: { role: "viewer", handle: `bot${n}` } });
      await call("POST", "/decks/plan/links", { token: ADA, body: { role: "viewer" } });
      await call("POST", "/decks/plan/grants", { token: ADA, body: { subjectKind: "human", subjectId: `kit${n}`, role: "viewer" } });
    }
    const first = (await call("GET", "/decks/plan/access?limit=2", { token: ADA })).json;
    expect([first.grants.length, first.invites.length, first.links.length]).toEqual([2, 2, 2]);
    const second = (await call("GET", `/decks/plan/access?limit=2&cursor=${encodeURIComponent(first.nextCursor)}&inviteCursor=${encodeURIComponent(first.nextInviteCursor)}&linkCursor=${encodeURIComponent(first.nextLinkCursor)}`, { token: ADA })).json;
    expect([second.grants.length, second.invites.length, second.links.length]).toEqual([2, 1, 1]);
    const ids = new Set([...first.links, ...second.links].map((l: { id: string }) => l.id));
    expect(ids.size).toBe(3);
  });
});

describe("second review fixes", () => {
  test("a list writes no audit row, reads a bounded number of decks, and gives a cursor to go on", async () => {
    const { call, store } = setup();
    for (let n = 0; n < 205; n++) await call("POST", "/decks", { token: ADA, body: { title: `d${n}`, id: `deck${n}` } });
    await call("POST", "/decks/deck0/grants", { token: ADA, body: { subjectKind: "human", subjectId: "bob", role: "viewer" } });
    const ids: string[] = [];
    let cursor: string | undefined;
    let calls = 0;
    do {
      const page = await call("GET", `/decks?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { token: BOB });
      expect(page.status).toBe(200);
      ids.push(...page.json.decks.map((d: { id: string }) => d.id));
      cursor = page.json.nextCursor;
      calls++;
    } while (cursor && calls < 10);
    expect(ids).toEqual(["deck0"]);
    expect(calls).toBe(2);
    const rows = async () => {
      let total = 0;
      for (let at: string | undefined; ; ) {
        const page = await store.query("audit", { limit: 200, ...(at ? { cursor: at } : {}) });
        total += page.items.length;
        if (!(at = page.nextCursor)) return total;
      }
    };
    const written = await rows();
    expect((await call("GET", "/decks?limit=3", { token: BOB })).status).toBe(200);
    expect(await rows()).toBe(written);
  }, 60_000);

  test("an accepted invite ends a room ban from an earlier revoke", async () => {
    const { call, room } = setup();
    await call("POST", "/decks", { token: ADA, body: { title: "Plan", id: "plan" } });
    const { id } = (await call("POST", "/decks/plan/invites", { token: ADA, body: { role: "editor", handle: "bot" } })).json;
    room.length = 0;
    expect((await call("POST", "/invites/accept", { token: BOT, body: { id } })).status).toBe(200);
    expect(room).toEqual(["role plan agent.bot null"]);
  });

  test("an owner with a viewer token gets 403, not 404, on a route that needs an owner", async () => {
    const { call } = setup();
    await call("POST", "/decks", { token: ADA, body: { title: "Plan", id: "plan" } });
    await call("POST", "/decks/plan/grants", { token: ADA, body: { subjectKind: "human", subjectId: "vic", role: "owner" } });
    const refused = await call("GET", "/decks/plan/access", { token: VIEW });
    expect(refused.status).toBe(403);
    expect(refused.json.error.code).toBe("FORBIDDEN");
    expect((await call("GET", "/decks/other/access", { token: VIEW })).status).toBe(404);
  });

  test("every write route follows the role: a commenter gets 403, a caller with no role gets 404", async () => {
    const { call, app } = setup();
    await call("POST", "/decks", { token: ADA, body: { title: "Plan", id: "plan" } });
    const added = (await call("POST", "/decks/plan/slides", { token: ADA, body: { outline: "# Hello\n- one" } })).json;
    const outline = (await call("GET", "/decks/plan", { token: ADA })).json;
    const element = outline.slides[0].elements[0].id;
    await call("POST", "/decks/plan/grants", { token: ADA, body: { subjectKind: "human", subjectId: "bob", role: "commenter" } });
    const routes: [string, string, unknown][] = [
      ["PUT", `/decks/plan/slides/${added.slideIds[0]}`, { outline: "# New" }],
      ["PATCH", `/decks/plan/slides/1/elements/${element}`, { x: 10 }],
      ["POST", "/decks/plan/slides/1/move", { to: 1 }],
      ["DELETE", "/decks/plan/slides/1", undefined],
    ];
    for (const [method, path, body] of routes) {
      expect((await call(method, path, { token: BOB, body })).status, `${method} ${path} as commenter`).toBe(403);
      expect((await call(method, path, { token: EVE, body })).status, `${method} ${path} with no role`).toBe(404);
    }
    for (const [token, status] of [[BOB, 403], [EVE, 404]] as const) {
      const response = await app.request(`${BASE}/decks/plan/checkpoint`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" }, body: new Uint8Array([0]) });
      expect(response.status, `checkpoint as ${token === BOB ? "commenter" : "no role"}`).toBe(status);
    }
    // The deck stays whole.
    expect((await call("GET", "/decks/plan", { token: ADA })).json.slides).toHaveLength(1);
  });

  test("a link visitor writes no audit row for a deck with no link", async () => {
    const { call, store } = setup();
    await call("POST", "/decks", { token: ADA, body: { title: "Plan", id: "plan" } });
    for (let n = 0; n < 3; n++) expect((await call("GET", "/shared/plan", { headers: { "x-link-token": "x" } })).status).toBe(404);
    const rows = (await store.query("audit", { where: { resourceId: "plan", outcome: "denied" }, limit: 10 })).items;
    expect(rows).toEqual([]);
  });
});

describe("third review fixes", () => {
  test("a grant with a role that identity does not honor keeps the deck out of the list", async () => {
    const { call, store } = setup();
    await call("POST", "/decks", { token: ADA, body: { title: "Secret title", id: "plan" } });
    await store.put("grants", "plan:human:bob", { resourceId: "plan", subjectKind: "human", subjectId: "bob", role: "superuser" });
    expect((await call("GET", "/decks/plan", { token: BOB })).status).toBe(404);
    const listed = await call("GET", "/decks", { token: BOB });
    expect(listed.json.decks).toEqual([]);
    expect(listed.text).not.toContain("Secret title");
    expect((await call("GET", "/decks", { token: ADA })).json.decks).toHaveLength(1);
  });

  test("an invite for a lower role never caps the room of an editor", async () => {
    const { call, room } = setup();
    await call("POST", "/decks", { token: ADA, body: { title: "Plan", id: "plan" } });
    await call("POST", "/decks/plan/grants", { token: ADA, body: { subjectKind: "agent", subjectId: "bot", role: "editor" } });
    const { id } = (await call("POST", "/decks/plan/invites", { token: ADA, body: { role: "viewer", handle: "bot" } })).json;
    room.length = 0;
    expect((await call("POST", "/invites/accept", { token: BOT, body: { id } })).status).toBe(200);
    expect(room).toEqual(["role plan agent.bot null"]);
    expect((await call("POST", "/decks/plan/slides", { token: BOT, body: OUTLINE })).status).toBe(201);
  });

  test("a 403 for a viewer token writes no audit row that claims an allowed action", async () => {
    const { call, store } = setup();
    await call("POST", "/decks", { token: ADA, body: { title: "Plan", id: "plan" } });
    await call("POST", "/decks/plan/grants", { token: ADA, body: { subjectKind: "human", subjectId: "vic", role: "owner" } });
    expect((await call("GET", "/decks/plan/access", { token: VIEW })).status).toBe(403);
    const rows = (await store.query("audit", { where: { resourceId: "plan", outcome: "allowed" }, limit: 100 })).items.map((r) => r.data);
    expect(rows.filter((r) => (r as { principalId?: string }).principalId === "vic")).toEqual([]);
  });
});

describe("fourth review fixes", () => {
  test("a downgrade, then an accepted invite for the lower role, keeps the room read only", async () => {
    const { call, room } = setup();
    await call("POST", "/decks", { token: ADA, body: { title: "Plan", id: "plan" } });
    await call("POST", "/decks/plan/grants", { token: ADA, body: { subjectKind: "agent", subjectId: "bot", role: "editor" } });
    const { id } = (await call("POST", "/decks/plan/invites", { token: ADA, body: { role: "viewer", handle: "bot" } })).json;
    await call("POST", "/decks/plan/grants", { token: ADA, body: { subjectKind: "agent", subjectId: "bot", role: "viewer" } });
    room.length = 0;
    expect((await call("POST", "/invites/accept", { token: BOT, body: { id } })).status).toBe(200);
    expect(room).toEqual(["role plan agent.bot viewer"]);
  });

  test("a list that stops at its scan limit puts the cursor after the last deck that it returns", async () => {
    const { call } = setup();
    for (let n = 0; n < 205; n++) await call("POST", "/decks", { token: ADA, body: { title: `d${n}`, id: `old${n}` } });
    await call("POST", "/decks", { token: ADA, body: { title: "Mine", id: "mine" } });
    await call("POST", "/decks/mine/grants", { token: ADA, body: { subjectKind: "human", subjectId: "bob", role: "viewer" } });
    const page = await call("GET", "/decks?limit=5", { token: BOB });
    expect(page.json.decks.map((d: { id: string }) => d.id)).toEqual(["mine"]);
    expect(JSON.parse(Buffer.from(page.json.nextCursor, "base64url").toString())[1]).toBe("mine");
    // The cursor works.
    expect((await call("GET", `/decks?limit=5&cursor=${encodeURIComponent(page.json.nextCursor)}`, { token: BOB })).status).toBe(200);
  }, 60_000);

  test("a caller with no role writes no audit row on any deck route, and a link needs the deck of its URL", async () => {
    const { call, store } = setup();
    await call("POST", "/decks", { token: ADA, body: { title: "A", id: "a" } });
    await call("POST", "/decks", { token: ADA, body: { title: "B", id: "b" } });
    const rows = async () => (await store.query("audit", { limit: 200 })).items.length;
    const before = await rows();
    for (let n = 0; n < 3; n++) expect((await call("GET", "/decks/a", { token: BOB })).status).toBe(404);
    expect(await rows()).toBe(before);
    const link = (await call("POST", "/decks/b/links", { token: ADA, body: { role: "viewer" } })).json;
    expect((await call("DELETE", `/decks/a/links/${link.id}`, { token: ADA })).status).toBe(403);
    expect((await call("GET", "/shared/b", { headers: { "x-link-token": link.token } })).status).toBe(200);
    expect((await call("DELETE", `/decks/b/links/${link.id}`, { token: ADA })).status).toBe(200);
  });
});

describe("fifth review fixes", () => {
  test("a list cursor from a scan that found no deck is sealed, and a forged one is a 400", async () => {
    const { call } = setup();
    for (let n = 0; n < 205; n++) await call("POST", "/decks", { token: ADA, body: { title: `secret${n}`, id: `secret-merger-${n}` } });
    const first = await call("GET", "/decks?limit=3", { token: BOB });
    expect(first.json.decks).toEqual([]);
    const cursor: string = first.json.nextCursor;
    expect(cursor.startsWith("s1.")).toBe(true);
    // No plain form of a hidden id or time is in it, in the text or when decoded as base64url.
    expect(Buffer.from(cursor.slice(3), "base64url").toString("latin1")).not.toMatch(/secret|merger|17\d{11}/);
    expect(cursor).not.toMatch(/secret|merger/);
    // The cursor works, and the caller ends with no deck.
    let page = first;
    let calls = 1;
    while (page.json.nextCursor && calls < 5) {
      page = await call("GET", `/decks?limit=3&cursor=${encodeURIComponent(page.json.nextCursor)}`, { token: BOB });
      expect(page.status).toBe(200);
      expect(page.json.decks).toEqual([]);
      calls++;
    }
    expect(page.json.nextCursor).toBeUndefined();
    for (const forged of ["s1.AAAA", `${cursor.slice(0, -2)}AA`, "s1.", "s1.not base64"]) {
      expect((await call("GET", `/decks?cursor=${encodeURIComponent(forged)}`, { token: BOB })).status, forged).toBe(400);
    }
  }, 60_000);

  test("a deck with too many owners is not erased, so no owner record is left behind", async () => {
    const { call } = setup();
    await call("POST", "/decks", { token: ADA, body: { title: "Plan", id: "plan" } });
    for (let n = 0; n < 100; n++) await call("POST", "/decks/plan/grants", { token: ADA, body: { subjectKind: "human", subjectId: `own${n}`, role: "owner" } });
    const refused = await call("DELETE", "/decks/plan", { token: ADA });
    expect(refused.status).toBe(400);
    expect(refused.json.error.code).toBe("INVALID_SHARE");
    expect((await call("GET", "/decks/plan", { token: ADA })).status).toBe(200);
    await call("DELETE", "/decks/plan/grants?subjectKind=human&subjectId=own0", { token: ADA });
    expect((await call("DELETE", "/decks/plan", { token: ADA })).status).toBe(200);
  }, 60_000);

  test("a delete clears the room before and after the deck goes", async () => {
    const { call, room } = setup();
    await call("POST", "/decks", { token: ADA, body: { title: "Plan", id: "plan" } });
    room.length = 0;
    expect((await call("DELETE", "/decks/plan", { token: ADA })).status).toBe(200);
    expect(room).toEqual(["erase plan", "erase plan"]);
  });

  test("a deck with only revoked or expired links writes no audit row for a visitor", async () => {
    const { call, store } = setup();
    await call("POST", "/decks", { token: ADA, body: { title: "Plan", id: "plan" } });
    const revoked = (await call("POST", "/decks/plan/links", { token: ADA, body: { role: "viewer" } })).json;
    await call("DELETE", `/decks/plan/links/${revoked.id}`, { token: ADA });
    await call("POST", "/decks/plan/links", { token: ADA, body: { role: "viewer", expiresInMs: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (let n = 0; n < 3; n++) expect((await call("GET", "/shared/plan", { headers: { "x-link-token": revoked.token } })).status).toBe(404);
    expect((await store.query("audit", { where: { resourceId: "plan", outcome: "denied" }, limit: 10 })).items).toEqual([]);
  });

  test("the Worker refuses a token name that could hold no role", async () => {
    const bindings = { DB: { prepare: () => ({ run: async () => ({}) }), batch: async () => [] } as never, IMAGES: {} as never };
    for (const config of [`${ADA}=human:ada.lovelace`, `${ADA}=agent:agent_of_human_eve`, `${ADA}=agent:${"a".repeat(129)}`]) {
      const response = await worker.fetch(new Request(`${BASE}/decks/x`, { headers: { authorization: `Bearer ${ADA}` } }), { ...bindings, SLIDES_UNSAFE_STATIC_TOKENS: "1", SLIDES_TOKENS: config });
      expect(response.status, config).toBe(500);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("MISCONFIGURED");
    }
  });
});

describe("without a store", () => {
  test("the token role is the only check, and the share routes say sharing is off", async () => {
    const app = createApp({ service: createService({ store: createMemoryStore(), blobs: createMemoryBlobs() }), auth: tokenAuth(parseTokens(TOKENS)) });
    const send = (method: string, path: string, token: string, body?: unknown) => app.request(`${BASE}${path}`, { method, headers: { authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    expect((await send("POST", "/decks", ADA, { title: "t", id: "t" })).status).toBe(201);
    expect((await send("GET", "/decks/t", BOB)).status).toBe(200);
    const off = await send("POST", "/decks/t/grants", ADA, { subjectKind: "human", subjectId: "bob", role: "viewer" });
    expect(off.status).toBe(400);
  });
});
