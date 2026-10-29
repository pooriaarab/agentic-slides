import { createMemoryBlobs, createMemoryStore } from "agentic-identity";
import { describe, expect, test } from "vitest";
import { createApp } from "./api.js";
import { parseTokens, tokenAuth } from "./auth.js";
import { createService } from "./service.js";

// Roles on decks, over the real app and a memory store. Each caller has its own token.
const ADA = "ada-token-0123456789-abcdefghijklmn";
const BOB = "bob-token-0123456789-abcdefghijklmn";
const BOT = "bot-token-0123456789-abcdefghijklmn";
const EVE = "eve-token-0123456789-abcdefghijklmn";
const VIEW = "view-token-0123456789-abcdefghijklm";
const TOKENS = `${ADA}=human:ada,${BOB}=human:bob,${BOT}=agent:bot,${EVE}=agent_of_human:eve,${VIEW}=human:vic;viewer`;
const BASE = "http://slides.test/api/v1/slides";

function setup() {
  const store = createMemoryStore();
  const service = createService({ store, blobs: createMemoryBlobs() });
  const app = createApp({ service, auth: tokenAuth(parseTokens(TOKENS)), store });
  const call = async (method: string, path: string, init: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const response = await app.request(`${BASE}${path}`, {
      method,
      headers: { ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await response.text();
    return { status: response.status, json: text.startsWith("{") ? JSON.parse(text) : undefined, text };
  };
  return { call, service, store };
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
