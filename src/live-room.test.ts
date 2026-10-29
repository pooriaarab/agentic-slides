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
  const contributors: { id: string; kind: string; machine: boolean }[] = [];
  const live: Realtime = {
    connect: async (id, _request, grant) => (grants.push({ id, grant }), new Response("joined", { status: 200 })),
    meta: async () => ({ updates: 0, compactions: 0, contributors: contributors as never }),
    createSnapshot: async () => null,
    listSnapshots: async () => [],
    getSnapshot: async () => null,
    // The routes under test never call these. They fail if a route starts to.
    revoke: async () => Promise.reject(new Error("not used by these routes")),
    updateRole: async () => Promise.reject(new Error("not used by these routes")),
    roleFor: async () => Promise.reject(new Error("not used by these routes")),
    erase: async () => Promise.reject(new Error("not used by these routes")),
    exportHistory: async () => Promise.reject(new Error("not used by these routes")),
    attribution: async () => Promise.reject(new Error("not used by these routes")),
  };
  const service = createService({ store: createMemoryStore(), blobs: createMemoryBlobs() });
  const tokens = parseTokens(TOKENS);
  const principals = tokens.filter(([, caller]) => caller.role === "editor").map(([, caller]) => caller.author);
  const app = createApp({ service, auth: tokenAuth(tokens), principals, live: options.live === false ? undefined : () => live });
  const call = (method: string, path: string, init: { token?: string; body?: BodyInit | Uint8Array; headers?: Record<string, string> } = {}) =>
    app.request(`${BASE}${path}`, { method, headers: { ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), ...init.headers }, body: init.body as BodyInit | undefined });
  return { service, call, grants, app, contributors };
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
      { principal: { id: "agent_of_human:bot", kind: "agent_of_human" }, role: "editor", name: "bot" },
      { principal: { id: "human:eve", kind: "human" }, role: "viewer", name: "eve" },
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
    const { call, service, contributors } = setup();
    await service.create({ title: "T", id: "t", author: ada });
    // Both wrote into one room, so the room saw both. The deck label is the one that the merge keeps.
    contributors.push({ id: "human:ada", kind: "human", machine: false }, { id: "agent_of_human:bot", kind: "agent_of_human", machine: true });
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
        for (const [key, value] of Object.entries({ id: "e1", kind: "image", x: 0, y: 0, w: 100, h: 100, alt: "", createdBy: bot, editedBy: bot, src: "https://evil.example/a.png" })) element.set(key, value);
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

// The room cannot read a deck, and a client writes the author labels in it. A checkpoint is where the server checks them.
describe("a checkpoint keeps the author labels honest", () => {
  const put = (call: ReturnType<typeof setup>["call"], token: string, body: Uint8Array) =>
    call("POST", "/decks/t/checkpoint", { token, body, headers: { "content-type": "application/octet-stream" } });
  const stateOf = async (call: ReturnType<typeof setup>["call"]) => new Uint8Array(await (await call("GET", "/decks/t/state", { token: HUMAN })).arrayBuffer());
  const first = (doc: Y.Doc) => doc.getMap("slides").get(doc.getArray<string>("order").get(0)!) as Y.Map<unknown>;

  test("an agent cannot save a change that says a person made it", async () => {
    const { call, service } = setup();
    await service.create({ title: "T", id: "t", author: ada });
    const deck = Deck.fromUpdate(await stateOf(call));
    deck.addSlide({ layout: "blank" }, bot);
    first(deck.doc).set("createdBy", ada);
    first(deck.doc).set("editedBy", ada);
    deck.doc.getMap("deck").set("editedBy", ada);
    const before = await service.outline("t");
    const response = await put(call, AGENT, deck.encode());
    expect(response.status).toBe(403);
    expect((await json(response)).error.code).toBe("FORBIDDEN");
    expect(await service.outline("t")).toEqual(before);
  });

  test("an agent cannot change a person's element and leave the person's label on it", async () => {
    const { call, service } = setup();
    await service.create({ title: "T", id: "t", author: ada });
    await service.addSlides("t", { outline: "# Title\n- point", author: ada });
    const deck = Deck.fromUpdate(await stateOf(call));
    const title = deck.outline().slides[0]!.elements.find((e) => e.kind === "text")!;
    deck.editElement(0, title.id, { text: "Forged" }, ada); // labeled as ada, by a copy that an agent holds
    const response = await put(call, AGENT, deck.encode());
    expect(response.status).toBe(403);
    expect((await service.outline("t")).slides[0]!.elements.some((e) => e.kind === "text" && e.runs.some((r) => r.text === "Forged"))).toBe(false);
  });

  test("a label that no one wrote is refused, not read as a person", async () => {
    const { call, service } = setup();
    await service.create({ title: "T", id: "t", author: ada });
    const deck = Deck.fromUpdate(await stateOf(call));
    deck.addSlide({ layout: "blank" }, bot);
    first(deck.doc).delete("editedBy");
    expect((await put(call, AGENT, deck.encode())).status).toBe(403);
  });

  test("a person who is in the room can have their own change saved by an agent's checkpoint", async () => {
    const { call, service, contributors } = setup();
    await service.create({ title: "T", id: "t", author: ada });
    const deck = Deck.fromUpdate(await stateOf(call));
    deck.addSlide({ layout: "blank" }, ada);
    deck.addSlide({ layout: "title" }, bot);
    expect((await put(call, AGENT, deck.encode())).status).toBe(403); // ada never sent anything to the room
    contributors.push({ id: "human:ada", kind: "human", machine: false });
    expect((await put(call, AGENT, deck.encode())).status).toBe(200);
    expect((await service.outline("t")).slides.map((s) => s.createdBy.name).sort()).toEqual(["ada", "bot"]);
  });

  test("a name from another kind does not pass for the same person", async () => {
    const { call, service, contributors } = setup();
    await service.create({ title: "T", id: "t", author: ada });
    contributors.push({ id: "agent_of_human:ada", kind: "agent_of_human", machine: true });
    const deck = Deck.fromUpdate(await stateOf(call));
    deck.addSlide({ layout: "blank" }, ada);
    expect((await put(call, AGENT, deck.encode())).status).toBe(403);
  });
});

describe("a contributor whose token is removed", () => {
  test("cannot have a change labeled with their name in a checkpoint", async () => {
    const { call, service, contributors } = setup();
    await service.create({ title: "T", id: "t", author: ada });
    // Zed sent updates to the room before the token was removed from the configuration.
    contributors.push({ id: "human:zed", kind: "human", machine: false });
    const state = new Uint8Array(await (await call("GET", "/decks/t/state", { token: HUMAN })).arrayBuffer());
    const deck = Deck.fromUpdate(state);
    deck.addSlide({ layout: "blank" }, { kind: "human", name: "zed" });
    const response = await call("POST", "/decks/t/checkpoint", { token: AGENT, body: deck.encode() });
    expect(response.status).toBe(403);
    expect((await service.outline("t")).slides).toHaveLength(0);
  });
});

describe("a viewer token does not make its name a trusted label", () => {
  test("a name whose token only reads cannot label a change in a checkpoint", async () => {
    const { call, service, contributors } = setup();
    await service.create({ title: "T", id: "t", author: ada });
    // Eve's token is a viewer's in the configuration, so she sent the room updates but cannot edit.
    contributors.push({ id: "human:eve", kind: "human", machine: false });
    const deck = Deck.fromUpdate(await service.state("t"));
    deck.addSlide({ layout: "blank" }, { kind: "human", name: "eve" });
    expect((await call("POST", "/decks/t/checkpoint", { token: AGENT, body: deck.encode() })).status).toBe(403);
    expect((await service.outline("t")).slides).toHaveLength(0);
  });
});

describe("a checkpoint runs the text-fit check that an edit runs", () => {
  test("a table that does not fit its box is refused as TEXT_OVERFLOW, and the stored deck stays as it was", async () => {
    const { call, service } = setup();
    await service.create({ title: "T", id: "t", author: ada });
    await service.addSlides("t", { outline: "|a|b|\n|c|d|", author: ada });
    const before = await service.outline("t");
    const deck = Deck.fromUpdate(await service.state("t"));
    const slide = deck.doc.getMap("slides").get(deck.doc.getArray<string>("order").get(0)!) as Y.Map<unknown>;
    const table = (slide.get("elements") as Y.Array<Y.Map<unknown>>).toArray().find((e) => e.get("kind") === "table")!;
    table.set("rows", Array.from({ length: 200 }, () => ["x", "y"]));
    const response = await call("POST", "/decks/t/checkpoint", { token: HUMAN, body: deck.encode() });
    expect(response.status).toBe(422);
    expect((await json(response)).error.code).toBe("TEXT_OVERFLOW");
    expect(await service.outline("t")).toEqual(before);
  });

  test("text that does not fit its box is refused as TEXT_OVERFLOW, and the stored deck stays as it was", async () => {
    const { call, service } = setup();
    await service.create({ title: "T", id: "t", author: ada });
    await service.addSlides("t", { outline: "# Title\n- point", author: ada });
    const before = await service.outline("t");
    const deck = Deck.fromUpdate(await service.state("t"));
    const slide = deck.doc.getMap("slides").get(deck.doc.getArray<string>("order").get(0)!) as Y.Map<unknown>;
    const text = (slide.get("elements") as Y.Array<Y.Map<unknown>>).toArray().find((e) => e.get("kind") === "text")!;
    text.set("fontSize", 2000);
    const response = await call("POST", "/decks/t/checkpoint", { token: HUMAN, body: deck.encode() });
    expect(response.status).toBe(422);
    expect((await json(response)).error.code).toBe("TEXT_OVERFLOW");
    expect(await service.outline("t")).toEqual(before);
  });
});

describe("a checkpoint holds every element to the rules of an edit", () => {
  test.each([
    ["a box outside the slide", (e: Y.Map<unknown>) => e.set("x", 99_999), "OUT_OF_BOUNDS"],
    ["a box with no size", (e: Y.Map<unknown>) => e.set("w", 0), "OUT_OF_BOUNDS"],
    ["a box that is not a number", (e: Y.Map<unknown>) => e.set("h", "tall"), "OUT_OF_BOUNDS"],
    ["a key that no element has", (e: Y.Map<unknown>) => e.set("evil", "<script>"), "BAD_PATCH"],
    ["a color that is not a token", (e: Y.Map<unknown>) => e.set("color", "#ff0000"), "BAD_PATCH"],
    ["a font size that is not a number", (e: Y.Map<unknown>) => e.set("fontSize", "big"), "BAD_PATCH"],
    ["a kind that does not exist", (e: Y.Map<unknown>) => (e.delete("text"), e.set("kind", "video")), "BAD_PATCH"],
    ["an element id that is not text", (e: Y.Map<unknown>) => e.set("id", 7), "INVALID_UPDATE"],
  ])("%s is refused and the stored deck stays as it was", async (_label, change, code) => {
    const { call, service } = setup();
    await service.create({ title: "T", id: "t", author: ada });
    const before = await service.outline("t");
    const deck = Deck.fromUpdate(await service.state("t"));
    deck.addSlidesFromOutline("# Title\n- point", { author: ada, images: {} });
    const slide = deck.doc.getMap("slides").get(deck.doc.getArray<string>("order").get(0)!) as Y.Map<unknown>;
    change((slide.get("elements") as Y.Array<Y.Map<unknown>>).get(0)!);
    const response = await call("POST", "/decks/t/checkpoint", { token: HUMAN, body: deck.encode() });
    expect(response.status).toBe(code === "OUT_OF_BOUNDS" ? 422 : 400);
    expect((await json(response)).error.code).toBe(code);
    expect(await service.outline("t")).toEqual(before);
  });
});

describe("a checkpoint holds the raw Yjs types to what the Deck class writes", () => {
  const first = (doc: Y.Doc) => doc.getMap("slides").get(doc.getArray<string>("order").get(0)!) as Y.Map<unknown>;
  const firstText = (doc: Y.Doc) => ((first(doc).get("elements") as Y.Array<Y.Map<unknown>>).toArray().find((e) => e.get("kind") === "text"))!;

  test.each([
    ["a title that is an object", (d: Y.Doc) => d.getMap("deck").set("title", { a: 1 })],
    ["a title that is a number", (d: Y.Doc) => d.getMap("deck").set("title", 5)],
    ["a title over the length cap", (d: Y.Doc) => d.getMap("deck").set("title", "x".repeat(5000))],
    ["notes that are plain text", (d: Y.Doc) => first(d).set("notes", "plain")],
    ["a text element with runs and no text", (d: Y.Doc) => (firstText(d).delete("text"), firstText(d).set("runs", [{ text: "plain" }]))],
    ["an element that is not a map", (d: Y.Doc) => (first(d).get("elements") as Y.Array<unknown>).push(["junk"])],
    ["an order that holds a number", (d: Y.Doc) => d.getArray("order").push([7])],
    ["an element id that is a Y.Text", (d: Y.Doc) => firstText(d).set("id", new Y.Text("e1"))],
  ])("%s is refused as INVALID_UPDATE and the stored deck stays as it was", async (_label, change) => {
    const { call, service } = setup();
    await service.create({ title: "T", id: "t", author: ada });
    const before = await service.outline("t");
    const deck = Deck.fromUpdate(await service.state("t"));
    deck.addSlidesFromOutline("# Title\n- point", { author: ada, images: {} });
    change(deck.doc);
    const response = await call("POST", "/decks/t/checkpoint", { token: HUMAN, body: deck.encode() });
    expect(response.status).toBe(400);
    expect((await json(response)).error.code).toBe("INVALID_UPDATE");
    expect(await service.outline("t")).toEqual(before);
    await expect(service.render("t")).resolves.toContain("<html");
  });
});

describe("a slide that the order does not hold", () => {
  test("is dropped, so it can neither hide a bad layout or label nor grow the deck", async () => {
    const { call, service } = setup();
    await service.create({ title: "T", id: "t", author: ada });
    const deck = Deck.fromUpdate(await service.state("t"));
    deck.addSlidesFromOutline("# Real", { author: ada, images: {} });
    const orphan = new Y.Map<unknown>();
    orphan.set("layout", "nope");
    orphan.set("createdBy", { kind: "human", name: "mallory" });
    orphan.set("notes", new Y.Text("x".repeat(1_000_000)));
    orphan.set("elements", new Y.Array());
    deck.doc.getMap<Y.Map<unknown>>("slides").set("orphan0", orphan);
    expect((await call("POST", "/decks/t/checkpoint", { token: HUMAN, body: deck.encode() })).status).toBe(200);
    const stored = Deck.fromUpdate(await service.state("t"));
    expect(stored.doc.getMap("slides").has("orphan0")).toBe(false);
    expect(stored.outline().slides).toHaveLength(1);
    expect((await service.state("t")).length).toBeLessThan(100_000);
  });
});

describe("a checkpoint cannot grow the stored deck past the room cap", () => {
  test("many small checkpoints stop at the cap", async () => {
    const { call, service } = setup();
    await service.create({ title: "T", id: "t", author: ada });
    const notes = (n: number) => `# S${n}\n> ${"n".repeat(90_000)}`;
    let status = 200;
    for (let i = 0; i < 40 && status === 200; i++) {
      const deck = Deck.fromUpdate(await service.state("t"));
      deck.addSlidesFromOutline(notes(i), { author: ada, images: {} });
      status = (await call("POST", "/decks/t/checkpoint", { token: HUMAN, body: deck.encode() })).status;
    }
    expect(status).toBe(413);
    expect((await service.state("t")).length).toBeLessThanOrEqual(1_572_864);
  });
});
