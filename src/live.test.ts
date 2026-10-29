import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { createLiveService, whoAmI } from "./live.js";

// Ways the live client can fail before it reaches a room. The E2E in src/e2e/live-client.test.ts joins real rooms.
const TOKEN = "agent-token-0123456789-abcdefghij";
const requests: string[] = [];
let server: Server | undefined;

async function fake(routes: Record<string, (request: IncomingMessage) => { status: number; body?: unknown; bytes?: Uint8Array }>): Promise<string> {
  requests.length = 0;
  server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    const route = routes[`${request.method} ${request.url}`];
    const { status, body, bytes } = route ? route(request) : { status: 404, body: { error: { code: "NOT_FOUND", message: "no" } } };
    response.writeHead(status, { "content-type": bytes ? "application/octet-stream" : "application/json" });
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

describe("an MCP server in a live room", () => {
  test("a person's token is refused, since the server acts for a model", async () => {
    const url = await fake({ [ME]: () => ({ status: 200, body: { kind: "human", name: "ada", role: "editor" } }) });
    const { startLiveMcp } = await import("./mcp.js");
    await expect(startLiveMcp({ server: url, token: TOKEN })).rejects.toMatchObject({ code: "INVALID_AUTHOR" });
  });
});
