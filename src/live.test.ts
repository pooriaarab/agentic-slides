import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import * as Y from "yjs";
import { Deck } from "./core/deck.js";
import { createLiveService, isLiveServer, whoAmI, type LiveOptions } from "./live.js";

// Ways the live client can fail before it reaches a room. The E2E in src/e2e/live-client.test.ts joins real rooms.
const TOKEN = "agent-token-0123456789-abcdefghij";
const requests: string[] = [];
let server: Server | undefined;

async function fake(routes: Record<string, (request: IncomingMessage) => { status: number; body?: unknown; bytes?: Uint8Array; location?: string }>): Promise<string> {
  requests.length = 0;
  server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    const route = routes[`${request.method} ${request.url}`];
    const { status, body, bytes, location } = route ? route(request) : { status: 404, body: { error: { code: "NOT_FOUND", message: "no" } } };
    response.writeHead(status, { "content-type": bytes ? "application/octet-stream" : "application/json", ...(location ? { location } : {}) });
    response.end(bytes ?? JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  server = undefined;
});

const ME = "GET /api/v1/slides/me";
const agent = { status: 200, body: { kind: "agent_of_human", name: "bot", role: "editor" } };

describe("who am I", () => {
  test("reads the kind, the name, and the role from the server", async () => {
    const url = await fake({ [ME]: () => agent });
    expect(await whoAmI(url, TOKEN)).toEqual({ author: { kind: "agent_of_human", name: "bot" }, role: "editor" });
  });

  test.each([
    ["a refused token", { status: 401, body: { error: { code: "UNAUTHORIZED", message: "no" } } }, "FORBIDDEN"],
    ["a kind that this package does not know", { status: 200, body: { kind: "robot", name: "x", role: "editor" } }, "LIVE_UNAVAILABLE"],
    ["a role that this package does not know", { status: 200, body: { kind: "human", name: "x", role: "owner" } }, "LIVE_UNAVAILABLE"],
    ["a name that is not text", { status: 200, body: { kind: "human", name: 7, role: "editor" } }, "LIVE_UNAVAILABLE"],
    ["a server error", { status: 500, body: { error: { code: "INTERNAL", message: "boom" } } }, "LIVE_UNAVAILABLE"],
  ])("%s is a coded error", async (_label, reply, code) => {
    const url = await fake({ [ME]: () => reply });
    await expect(whoAmI(url, TOKEN)).rejects.toMatchObject({ code });
  });

  test("a server that cannot be reached is a coded error, not a raw network error", async () => {
    await expect(whoAmI("http://127.0.0.1:1", TOKEN)).rejects.toMatchObject({ code: "LIVE_UNAVAILABLE" });
  });
});

describe("a redirect and a refused token are not read as a live server", () => {
  test("a redirect is not followed: the client never reads the reply at the other address", async () => {
    const url = await fake({
      [ME]: () => ({ status: 302, body: "", location: "/api/v1/slides/elsewhere" }),
      "GET /api/v1/slides/elsewhere": () => agent,
    });
    await expect(whoAmI(url, TOKEN)).rejects.toMatchObject({ code: "LIVE_UNAVAILABLE" });
    expect(requests).toEqual([`GET ${ME.slice(4)}`]);
  });

  test.each([
    ["a deck read", (url: string) => createLiveService({ server: url, token: TOKEN }).outline("d"), "GET /api/v1/slides/decks/d/state"],
    ["a deck create", (url: string) => createLiveService({ server: url, token: TOKEN }).create({ title: "T", author: { kind: "agent", name: "x" } }), "POST /api/v1/slides/decks"],
  ])("a token the server refuses after /me is FORBIDDEN, on %s", async (_label, run, route) => {
    const url = await fake({ [ME]: () => agent, [route]: () => ({ status: 401, body: { error: { code: "UNAUTHORIZED", message: "Send a valid bearer token." } } }) });
    await expect(run(url)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  test.each([
    ["a 403 with an unknown code", { status: 403, body: { error: { code: "SOMETHING_NEW", message: "no" } } }],
    ["a 403 with no JSON body, as a proxy may send", { status: 403 }],
  ])("%s is FORBIDDEN", async (_label, reply) => {
    const url = await fake({ [ME]: () => agent, "GET /api/v1/slides/decks/d/state": () => reply });
    await expect(createLiveService({ server: url, token: TOKEN }).outline("d")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("a live call fails before it opens a room", () => {
  const live = (url: string) => createLiveService({ server: url, token: TOKEN });

  test("a deck that does not exist is NO_DECK, and no WebSocket is opened", async () => {
    const url = await fake({ [ME]: () => agent, "GET /api/v1/slides/decks/gone/state": () => ({ status: 404, body: { error: { code: "NO_DECK", message: 'no deck "gone"' } } }) });
    await expect(live(url).addSlides("gone", { layout: "blank", author: { kind: "agent", name: "x" } })).rejects.toMatchObject({ code: "NO_DECK" });
    expect(requests.some((r) => r.includes("/ws"))).toBe(false);
  });

  test("a viewer's edit fails before any request for the room", async () => {
    const url = await fake({ [ME]: () => ({ status: 200, body: { kind: "human", name: "eve", role: "viewer" } }) });
    await expect(live(url).deleteSlide("d", 1, { kind: "human", name: "eve" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(requests).toEqual([`GET ${ME.slice(4)}`]);
  });

  test("an image file is refused, since a room holds no blobs", async () => {
    const url = await fake({ [ME]: () => agent });
    const images = { "a.png": new Uint8Array([1]) };
    const author = { kind: "agent", name: "x" } as const;
    await expect(live(url).addSlides("d", { outline: "# A\n![x](a.png)", images, author })).rejects.toMatchObject({ code: "UNSUPPORTED_IMAGE" });
    await expect(live(url).setSlide("d", 1, { outline: "# A", images, author })).rejects.toMatchObject({ code: "UNSUPPORTED_IMAGE" });
    await expect(live(url).editElement("d", 1, "e", { src: `blob:sha256-${"a".repeat(64)}` }, author)).rejects.toMatchObject({ code: "UNSUPPORTED_IMAGE" });
  });

  test("a deck id that is not valid never leaves the process", async () => {
    const url = await fake({ [ME]: () => agent });
    await expect(live(url).outline("../x")).rejects.toMatchObject({ code: "INVALID_ID" });
    expect(requests).toEqual([]);
  });

  test("the token goes in a header, never in the URL", async () => {
    const seen: string[] = [];
    const url = await fake({ [ME]: (request) => (seen.push(String(request.headers.authorization)), agent) });
    await whoAmI(url, TOKEN);
    expect(seen).toEqual([`Bearer ${TOKEN}`]);
    expect(requests.join(" ")).not.toContain(TOKEN);
  });
});

describe("the library sends a token only over https, or over http to this machine", () => {
  const author = { kind: "agent", name: "x" } as const;

  test.each(["http://example.com", "http://127.0.0.1.example.com", "ftp://example.com", "not a url", ""])("%j gets no request", async (server) => {
    const sent: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => (sent.push(String(input)), new Response("{}"))) as typeof fetch;
    try {
      await expect(whoAmI(server, TOKEN)).rejects.toMatchObject({ code: "LIVE_UNAVAILABLE" });
      await expect(createLiveService({ server, token: TOKEN }).create({ title: "T", author })).rejects.toMatchObject({ code: "LIVE_UNAVAILABLE" });
      await expect(createLiveService({ server, token: TOKEN }).outline("d")).rejects.toMatchObject({ code: "LIVE_UNAVAILABLE" });
      expect(sent).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("https and this machine are accepted", () => {
    expect(["https://slides.example.com", "http://127.0.0.1:8787", "http://localhost:8787", "http://[::1]:8787"].map(isLiveServer)).toEqual([true, true, true, true]);
  });
});

describe("a connection that the server closed while it was idle", () => {
  // Node reuses a connection, and a server may close it between two requests. The client tries once more, except for create.
  async function dropFirst(): Promise<string> {
    let drops = 0;
    requests.length = 0;
    server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      if (drops++ === 0) return void request.socket.destroy();
      response.writeHead(request.url?.endsWith("/me") ? 200 : 201, { "content-type": "application/json" });
      response.end(JSON.stringify(request.url?.endsWith("/me") ? agent.body : { id: "made" }));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  }

  test("a read is tried once more", async () => {
    const url = await dropFirst();
    expect(await whoAmI(url, TOKEN)).toMatchObject({ role: "editor" });
    expect(requests).toHaveLength(2);
  });

  test("a create is not repeated, since the first try may have made the deck", async () => {
    const url = await dropFirst();
    await expect(createLiveService({ server: url, token: TOKEN }).create({ title: "T", author: { kind: "agent", name: "x" } })).rejects.toMatchObject({ code: "LIVE_UNAVAILABLE" });
    expect(requests).toHaveLength(1);
  });
});

describe("a server that sends the wrong shape", () => {
  const live = (url: string) => createLiveService({ server: url, token: TOKEN });
  const author = { kind: "agent", name: "x" } as const;

  test("a deck id that is not text is a coded error", async () => {
    const url = await fake({ "POST /api/v1/slides/decks": () => ({ status: 201, body: { id: 7 } }) });
    await expect(live(url).create({ title: "T", author })).rejects.toMatchObject({ code: "LIVE_UNAVAILABLE" });
  });

  test("an export with no PDF is a coded error", async () => {
    const url = await fake({ "GET /api/v1/slides/decks/d/export?envelope=json": () => ({ status: 200, body: { warnings: [] } }) });
    await expect(live(url).exportPdf("d")).rejects.toMatchObject({ code: "LIVE_UNAVAILABLE" });
  });
});

describe("a connection that drops during an edit", () => {
  // A room client whose first flush works (the seed) and whose next one fails, as a dropped socket does.
  function dropping() {
    const calls = { flush: 0, disconnect: 0 };
    const doc = new Y.Doc();
    const client = {
      doc,
      denied: [] as string[],
      peers: [],
      flush: async () => {
        if (++calls.flush > 1) throw new Error("connection closed");
      },
      disconnect: async () => void calls.disconnect++,
    };
    return { calls, connect: (async () => client) as unknown as LiveOptions["connect"] };
  }

  test("is LIVE_UNAVAILABLE and says that the room can hold the change, so a caller does not repeat it", async () => {
    const state = new Deck();
    state.addSlide({ layout: "blank" }, { kind: "human", name: "ada" });
    const url = await fake({ [ME]: () => agent, "GET /api/v1/slides/decks/d/state": () => ({ status: 200, bytes: state.encode() }) });
    const { calls, connect } = dropping();
    const error = await createLiveService({ server: url, token: TOKEN, connect }).deleteSlide("d", 1, { kind: "agent", name: "x" }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "LIVE_UNAVAILABLE" });
    expect((error as Error).message).toContain("Do not repeat the change");
    expect(calls.disconnect).toBe(1);
    expect(requests.some((r) => r.startsWith("POST") && r.includes("checkpoint"))).toBe(false);
  });
});

describe("an MCP server in a live room", () => {
  test("a person's token is refused, since the server acts for a model", async () => {
    const url = await fake({ [ME]: () => ({ status: 200, body: { kind: "human", name: "ada", role: "editor" } }) });
    const { startLiveMcp } = await import("./mcp.js");
    await expect(startLiveMcp({ server: url, token: TOKEN })).rejects.toMatchObject({ code: "INVALID_AUTHOR" });
  });
});
