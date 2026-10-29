// The default auth of the Worker is agentic-identity: credentials and principals live in the Store.
// These tests run the real Worker over a SQLite stand-in for D1. The wrangler E2E in src/e2e/worker.test.ts runs real D1 and R2.
//
// Failure cases, written before the code:
//  1. No credential, an unknown one, or a revoked one gets in.
//  2. A principal with no slides scope, or a scope of another app, gets in (it must get 403, not 401).
//  3. `slides:read` writes.
//  4. The static list signs in without `SLIDES_UNSAFE_STATIC_TOKENS=1`, or a deploy that sets it by mistake runs silently.
//  5. A store that fails is answered as a 401, so the caller thinks its credential is wrong.
import { createD1Store, D1_SCHEMA, type D1Like, type R2Like } from "agentic-identity/cloudflare";
import { issueCredential, revokeCredential, type Store } from "agentic-identity";
import { beforeAll, describe, expect, test } from "vitest";
import { sqliteD1 } from "./sqlite-d1.js";
import { Deck } from "./core/deck.js";
import worker, { createWorker } from "./worker.js";

let db: D1Like;
const bucket = {} as R2Like;
let store: Store;
const tokens: Record<string, string> = {};
const STATIC = "static-token-0123456789-abcdefghij";

beforeAll(async () => {
  db = sqliteD1();
  await db.prepare(D1_SCHEMA).run();
  store = createD1Store(db, { region: "unknown" });
  const principals: Record<string, string | string[]>[] = [
    { id: "ada", kind: "human", scopes: ["slides:write"] },
    { id: "eve", kind: "human", scopes: ["slides:read"] },
    { id: "ned", kind: "human", scopes: ["docs:write"] },
    { id: "dotted.name", kind: "human", scopes: ["slides:write"] },
    { id: "all", kind: "human", scopes: ["*:admin"] },
    { id: "helper", kind: "agent_of_human", parentId: "ada", scopes: ["slides:write"] },
    { id: "gone", kind: "human", scopes: ["slides:write"] },
  ];
  for (const p of principals) {
    await store.transaction((tx) => tx.put("principals", p.id as string, p));
    tokens[p.id as string] = await store.transaction((tx) => issueCredential(tx, { principalId: p.id as string, kind: "api_key" }));
  }
  await revokeCredential(store, tokens.gone!, Date.now() - 1000);
});

const env = (extra: Record<string, string> = {}) => ({ DB: db, IMAGES: bucket, SLIDES_REGION: "unknown", ...extra }) as never;
const call = (token: string | null, path: string, init: RequestInit = {}, vars?: Record<string, string>) =>
  worker.fetch(new Request(`http://x/api/v1/slides${path}`, { ...init, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" } }), env(vars));
const create = (token: string, id: string) => call(token, "/decks", { method: "POST", body: JSON.stringify({ title: "T", id }) });

describe("identity credentials are the default", () => {
  test("no credential or an unknown one is a 401", async () => {
    expect((await call(null, "/me")).status).toBe(401);
    expect((await call("u".repeat(40), "/me")).status).toBe(401);
  });

  test("a valid principal gets 200, and its kind stays on the author", async () => {
    expect(await (await call(tokens.ada!, "/me")).json()).toMatchObject({ kind: "human", name: "ada", role: "editor" });
    expect(await (await call(tokens.helper!, "/me")).json()).toMatchObject({ kind: "agent_of_human", name: "helper", role: "editor" });
    expect((await call(tokens.all!, "/me")).status).toBe(200);
    expect((await create(tokens.ada!, "d1")).status).toBe(201);
  });

  test("a principal with no slides scope, or a scope of another app, is a 403", async () => {
    expect((await call(tokens.ned!, "/me")).status).toBe(403);
    expect((await call(tokens.ned!, "/decks/d1")).status).toBe(403);
  });

  test("slides:read is a viewer: it reads and cannot write", async () => {
    expect(await (await call(tokens.eve!, "/me")).json()).toMatchObject({ role: "viewer" });
    expect((await create(tokens.eve!, "d2")).status).toBe(403);
  });

  test("a session cookie alone does not sign in, and the bearer word is not case-sensitive", async () => {
    const post = (headers: Record<string, string>) => worker.fetch(new Request("http://x/api/v1/slides/decks", { method: "POST", headers: { "content-type": "text/plain", ...headers }, body: JSON.stringify({ title: "T", id: "cookie" }) }), env());
    expect((await post({ cookie: `session=${tokens.ada}` })).status).toBe(401);
    expect((await call(null, "/decks/cookie")).status).toBe(401);
    expect((await worker.fetch(new Request("http://x/api/v1/slides/me", { headers: { authorization: `bearer ${tokens.ada}` } }), env())).status).toBe(200);
  });

  test("a principal id that cannot hold a deck role is a 403, not an editor that fails later", async () => {
    expect((await call(tokens["dotted.name"]!, "/me")).status).toBe(403);
  });

  test("a revoked credential is a 401", async () => {
    expect((await call(tokens.gone!, "/me")).status).toBe(401);
  });

  test("a store that fails is a 500, never a 401", async () => {
    const broken = { ...db, prepare: (sql: string) => (sql === D1_SCHEMA ? db.prepare(sql) : { bind: () => ({ first: () => Promise.reject(new Error("boom")), all: () => Promise.reject(new Error("boom")), run: () => Promise.reject(new Error("boom")) }) }) } as unknown as D1Like;
    const response = await worker.fetch(new Request("http://x/api/v1/slides/me", { headers: { authorization: `Bearer ${tokens.ada}` } }), { ...(env() as object), DB: broken } as never);
    expect(response.status).toBe(500);
    const text = JSON.stringify(await response.json());
    expect(text).toContain("INTERNAL");
    expect(text).not.toContain("boom");
  });
});

describe("the static list is a dev fallback", () => {
  const list = `${STATIC}=human:dev`;
  test("it does not sign in without the switch, and a deploy that sets it answers 500 MISCONFIGURED", async () => {
    const response = await call(STATIC, "/me", {}, { SLIDES_TOKENS: list });
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).toContain("MISCONFIGURED");
    expect((await call(STATIC, "/me")).status).toBe(401);
    expect((await worker.fetch(new Request("http://x/health"), env({ SLIDES_TOKENS: list }))).status).toBe(200);
  });

  test.each(["true", "yes", "0", ""])("the switch value %j does not turn the list on", async (value) => {
    expect((await call(STATIC, "/me", {}, { SLIDES_TOKENS: list, SLIDES_UNSAFE_STATIC_TOKENS: value })).status).toBe(500);
  });

  test("with the switch it signs in, and the identity credentials still work", async () => {
    const vars = { SLIDES_TOKENS: list, SLIDES_UNSAFE_STATIC_TOKENS: "1" };
    expect(await (await call(STATIC, "/me", {}, vars)).json()).toMatchObject({ name: "dev", role: "editor" });
    expect((await call(tokens.ada!, "/me", {}, vars)).status).toBe(200);
    expect((await call("u".repeat(40), "/me", {}, vars)).status).toBe(401);
  });
});

describe("a checkpoint in a room with two identity users", () => {
  const label = (name: string) => ({ kind: "human", name }) as const;
  test("it keeps a slide of another user who holds slides:write, and refuses one who does not", async () => {
    await store.transaction((tx) => tx.put("principals", "bob", { id: "bob", kind: "human", scopes: ["slides:write"] }));
    const contributors = [{ id: "human:bob", kind: "human", machine: false }, { id: "human:ned", kind: "human", machine: false }];
    const live = createWorker({ live: () => ({ meta: async () => ({ updates: 0, compactions: 0, contributors }) }) as never });
    const send = (token: string, body: Uint8Array) => live.fetch(new Request("http://x/api/v1/slides/decks/room/checkpoint", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" }, body: body as BodyInit }), env());
    expect((await create(tokens.ada!, "room")).status).toBe(201);
    const state = new Uint8Array(await (await call(tokens.ada!, "/decks/room/state")).arrayBuffer());
    const copy = (author: ReturnType<typeof label>) => {
      const deck = Deck.fromUpdate(state);
      deck.addSlide({ layout: "blank" }, author);
      return deck.encode();
    };
    expect((await send(tokens.ada!, copy(label("bob")))).status).toBe(200);
    expect((await send(tokens.ada!, copy(label("ned")))).status).toBe(403);
  });
});
