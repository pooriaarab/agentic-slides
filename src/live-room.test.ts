import { createMemoryBlobs, createMemoryStore } from "agentic-identity";
import type { Grant, Realtime } from "agentic-realtime";
import * as Y from "yjs";
import { describe, expect, test } from "vitest";
import { createApp } from "./api.js";
import { parseTokens, tokenAuth } from "./auth.js";
import { Deck } from "./core/deck.js";
import { createService } from "./service.js";

// Ways the live room routes can fail, on the real app over a memory store.
// The wrangler E2E in src/e2e/live.test.ts runs the real Durable Object room.
const HUMAN = "human-token-0123456789-abcdefghij";
const AGENT = "agent-token-0123456789-abcdefghij";
const WATCHER = "watcher-token-0123456789-abcdefghij";
const TOKENS = `${HUMAN}=human:ada,${AGENT}=agent_of_human:bot,${WATCHER}=human:eve;viewer`;
const BASE = "http://slides.test/api/v1/slides";
const ada = { kind: "human", name: "ada" } as const;
const bot = { kind: "agent_of_human", name: "bot" } as const;

function setup(options: { live?: boolean } = {}) {
  const grants: { id: string; grant: Grant }[] = [];
  const live: Realtime = {
    connect: async (id, _request, grant) => (grants.push({ id, grant }), new Response("joined", { status: 200 })),
    meta: async () => ({ updates: 0, compactions: 0, contributors: [] }),
    createSnapshot: async () => null,
    listSnapshots: async () => [],
    getSnapshot: async () => null,
  };
  const service = createService({ store: createMemoryStore(), blobs: createMemoryBlobs() });
  const app = createApp({ service, auth: tokenAuth(parseTokens(TOKENS)), live: options.live === false ? undefined : () => live });
  const call = (method: string, path: string, init: { token?: string; body?: BodyInit | Uint8Array; headers?: Record<string, string> } = {}) =>
    app.request(`${BASE}${path}`, { method, headers: { ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), ...init.headers }, body: init.body as BodyInit | undefined });
  return { service, call, grants, app };
}

const json = async (response: Response) => (await response.json()) as Record<string, any>;

describe("token roles", () => {
  test("a token takes a role after a semicolon, and any other role is refused", () => {
    expect(() => parseTokens(`${HUMAN}=human:ada;owner`)).toThrow();
    expect(() => parseTokens(`${HUMAN}=human:ada;`)).toThrow();
    expect(parseTokens(`${HUMAN}=human:ada;viewer,${AGENT}=agent:bot;editor`)).toHaveLength(2);
  });

  test("a viewer reads, and every write by a viewer is a 403 that changes nothing", async () => {
    const { call, service } = setup();
    await service.create({ title: "T", id: "t", author: ada });
    expect((await call("GET", "/decks/t", { token: WATCHER })).status).toBe(200);
    expect((await call("POST", "/decks", { token: WATCHER, body: JSON.stringify({ title: "x" }) })).status).toBe(403);
    expect((await call("POST", "/decks/t/slides", { token: WATCHER, body: JSON.stringify({ layout: "blank" }) })).status).toBe(403);
    expect((await call("DELETE", "/decks/t/slides/1", { token: WATCHER })).status).toBe(403);
    expect((await service.outline("t")).slides).toHaveLength(0);
  });
});

describe("who am I", () => {
  test("says the kind, the name, and the role of the token", async () => {
    const { call } = setup();
    expect(await json(await call("GET", "/me", { token: AGENT }))).toEqual({ kind: "agent_of_human", name: "bot", role: "editor" });
    expect(await json(await call("GET", "/me", { token: WATCHER }))).toEqual({ kind: "human", name: "eve", role: "viewer" });
    expect((await call("GET", "/me")).status).toBe(401);
  });
});

describe("the room route checks the caller before it joins", () => {
  const ws = { upgrade: "websocket" };

  test("no token is a 401 and the room is never reached", async () => {
    const { call, grants } = setup();
    await call("GET", "/decks/t/ws", { headers: ws });
    expect((await call("GET", "/decks/t/ws", { headers: ws })).status).toBe(401);
    expect(grants).toEqual([]);
  });

  test("a deck that does not exist has no room", async () => {
    const { call, grants } = setup();
    const response = await call("GET", "/decks/missing/ws", { token: HUMAN, headers: ws });
    expect(response.status).toBe(404);
    expect(grants).toEqual([]);
  });

  test("a bad id is a 400, and a plain request is a 426", async () => {
    const { call, service } = setup();
    await service.create({ title: "T", id: "t", author: ada });
    expect((await call("GET", "/decks/a.b/ws", { token: HUMAN, headers: ws })).status).toBe(400);
    expect((await call("GET", "/decks/t/ws", { token: HUMAN })).status).toBe(426);
  });

  test("a server with no rooms answers 404", async () => {
    const { call, service } = setup({ live: false });
    await service.create({ title: "T", id: "t", author: ada });
    expect((await call("GET", "/decks/t/ws", { token: HUMAN, headers: ws })).status).toBe(404);
  });

  test("the grant comes from the token: its kind, its name, its role", async () => {
    const { call, service, grants } = setup();
    await service.create({ title: "T", id: "t", author: ada });
    for (const token of [AGENT, WATCHER]) expect((await call("GET", "/decks/t/ws", { token, headers: { ...ws, "x-principal": "human:ada" } })).status).toBe(200);
    expect(grants.map((g) => g.grant)).toEqual([
      { principal: { id: "bot", kind: "agent_of_human" }, role: "editor", name: "bot" },
      { principal: { id: "eve", kind: "human" }, role: "viewer", name: "eve" },
    ]);
    expect(grants.every((g) => g.id === "t")).toBe(true);
  });
});

describe("a checkpoint saves the room state", () => {
  const update = (build: (deck: Deck) => void, from?: Uint8Array) => {
    const deck = from ? Deck.fromUpdate(from) : new Deck();
    build(deck);
    return deck.encode();
  };

  test("the state of a new deck is its stored update, and a missing deck is a 404", async () => {
    const { call, service } = setup();
    await service.create({ title: "T", id: "t", author: ada });
    const state = new Uint8Array(await (await call("GET", "/decks/t/state", { token: HUMAN })).arrayBuffer());
    expect(Deck.fromUpdate(state).outline().title).toBe("T");
    expect((await call("GET", "/decks/none/state", { token: HUMAN })).status).toBe(404);
  });

  test("two checkpoints from two copies merge, and neither loses its slide", async () => {
    const { call, service } = setup();
    await service.create({ title: "T", id: "t", author: ada });
    const state = new Uint8Array(await (await call("GET", "/decks/t/state", { token: HUMAN })).arrayBuffer());
    const one = update((d) => d.addSlide({ layout: "blank" }, ada), state);
    const two = update((d) => d.addSlide({ layout: "title" }, bot), state);
    for (const [token, body] of [[HUMAN, one], [AGENT, two]] as const) {
      expect((await call("POST", "/decks/t/checkpoint", { token, body, headers: { "content-type": "application/octet-stream" } })).status).toBe(200);
    }
    const outline = await service.outline("t");
    expect(outline.slides.map((s) => s.layout).sort()).toEqual(["blank", "title"]);
    expect(outline.slides.map((s) => s.createdBy.kind).sort()).toEqual(["agent_of_human", "human"]);
  });

  test.each([
    ["bytes that are not an update", () => new Uint8Array([1, 2, 3, 250, 9]), 400, "INVALID_UPDATE"],
    ["an empty body", () => new Uint8Array(), 400, "INVALID_UPDATE"],
    [
      "an image that points at the network",
      () => {
        const doc = new Y.Doc();
        const deck = new Deck(doc);
        deck.addSlide({ layout: "blank" }, ada);
        const slide = doc.getMap("slides").get(doc.getArray<string>("order").get(0)!) as Y.Map<unknown>;
        const element = new Y.Map<unknown>();
        element.set("kind", "image");
        element.set("src", "https://evil.example/a.png");
        (slide.get("elements") as Y.Array<Y.Map<unknown>>).push([element]);
        return Y.encodeStateAsUpdate(doc);
      },
      422,
      "REMOTE_ASSET",
    ],
    ["a layout that does not exist", () => {
      const doc = new Y.Doc();
      const deck = new Deck(doc);
      deck.addSlide({ layout: "blank" }, ada);
      (doc.getMap("slides").get(doc.getArray<string>("order").get(0)!) as Y.Map<unknown>).set("layout", "zigzag");
      return Y.encodeStateAsUpdate(doc);
    }, 422, "UNKNOWN_LAYOUT"],
  ])("%s is refused and the stored deck stays as it was", async (_label, make, status, code) => {
    const { call, service } = setup();
    await service.create({ title: "T", id: "t", author: ada });
    const before = await service.outline("t");
    const response = await call("POST", "/decks/t/checkpoint", { token: AGENT, body: make(), headers: { "content-type": "application/octet-stream" } });
    expect(response.status).toBe(status);
    expect((await json(response)).error.code).toBe(code);
    expect(await service.outline("t")).toEqual(before);
  });

  test("an update over the cap is a 413, with or without a length header", async () => {
    const { call, service, app } = setup();
    await service.create({ title: "T", id: "t", author: ada });
    const big = new Uint8Array(1_600_000);
    expect((await call("POST", "/decks/t/checkpoint", { token: AGENT, body: big, headers: { "content-length": String(big.length) } })).status).toBe(413);
    // No length header: the body is cut off at the cap and never read whole.
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({ pull: (c) => void (sent++ < 100 ? c.enqueue(new Uint8Array(400_000)) : c.close()) });
    const request = new Request(`${BASE}/decks/t/checkpoint`, { method: "POST", headers: { authorization: `Bearer ${AGENT}` }, body: stream, duplex: "half" } as RequestInit);
    expect((await app.fetch(request)).status).toBe(413);
    expect(sent).toBeLessThan(10);
  });

  test("a viewer cannot save, and a deck that does not exist cannot be made by a checkpoint", async () => {
    const { call, service } = setup();
    await service.create({ title: "T", id: "t", author: ada });
    const body = update((d) => d.addSlide({ layout: "blank" }, ada));
    expect((await call("POST", "/decks/t/checkpoint", { token: WATCHER, body })).status).toBe(403);
    expect((await call("POST", "/decks/new/checkpoint", { token: HUMAN, body })).status).toBe(404);
    await expect(service.outline("new")).rejects.toMatchObject({ code: "NO_DECK" });
  });
});
