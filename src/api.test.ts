import { describe, expect, test } from "vitest";
import { createApp } from "./api.js";
import { parseTokens, tokenAuth } from "./auth.js";
import { createService } from "./service.js";
import { createMemoryBlobs, createMemoryStore } from "agentic-identity";
import { DEFAULT_LIMITS } from "./export/limits.js";
import { decodeImages } from "./schemas.js";
import { PRESENT_CSP } from "./render/present.js";
import { CSP } from "./render/html.js";
import worker from "./worker.js";

// Ways the API can fail, on the real app and the real service over a memory store.
// The wrangler E2E in src/e2e/worker.test.ts covers the full flow in a Worker runtime.
const HUMAN = "human-token-0123456789-abcdefghij";
const AGENT = "agent-token-0123456789-abcdefghij";
const TOKENS = `${HUMAN}=human:ada,${AGENT}=agent_of_human:bot`;
const BASE = "http://slides.test/api/v1/slides";

function appFor(config: string | undefined = TOKENS) {
  const app = createApp({ service: createService({ store: createMemoryStore(), blobs: createMemoryBlobs() }), auth: tokenAuth(parseTokens(config)) });
  return (method: string, path: string, init: { token?: string; body?: unknown; headers?: Record<string, string>; raw?: string } = {}) =>
    app.request(`${BASE}${path}`, {
      method,
      headers: { ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), ...init.headers },
      body: init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
    });
}

describe("auth fails closed", () => {
  test("with no token configured every API call is refused, and health still answers", async () => {
    const call = appFor("");
    for (const token of [undefined, HUMAN]) {
      expect((await call("GET", "/decks/x", { token })).status).toBe(401);
      expect((await call("POST", "/decks", { token, body: { title: "t" } })).status).toBe(401);
    }
    const app = createApp({ service: createService({ store: createMemoryStore(), blobs: createMemoryBlobs() }), auth: tokenAuth([]) });
    expect((await app.request("http://slides.test/health")).status).toBe(200);
  });

  test.each([
    ["no header", {}],
    ["wrong token", { authorization: `Bearer ${HUMAN}x` }],
    ["a prefix of a token", { authorization: `Bearer ${HUMAN.slice(0, -1)}` }],
    ["Basic scheme", { authorization: `Basic ${HUMAN}` }],
    ["bare token", { authorization: HUMAN }],
  ])("%s is a 401", async (_label, headers) => {
    const response = await appFor()("GET", "/decks/x", { headers });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
  });

  test("a token in the query string is not accepted", async () => {
    expect((await appFor()("GET", `/decks/x?token=${HUMAN}`)).status).toBe(401);
  });

  test.each(["short=human:ada", `${HUMAN}=robot:x`, `${HUMAN}=human`, `${HUMAN}=human:`, `${HUMAN}=human:a,${HUMAN}=agent:b`, "no-equals-sign-at-all-here"])(
    "a bad token setting %j is refused without echoing the token",
    (config) => {
      expect(() => parseTokens(config)).toThrow();
      try {
        parseTokens(config);
      } catch (error) {
        expect((error as Error).message).not.toContain(HUMAN);
      }
    },
  );

  test("a token needs 32 characters: 31 is refused and 32 is accepted", () => {
    expect(() => parseTokens(`${"a".repeat(31)}=human:ada`)).toThrow();
    expect(parseTokens(`${"a".repeat(32)}=human:ada`)).toHaveLength(1);
  });

  test("the Worker answers 500 MISCONFIGURED, not open access, on a bad token setting", async () => {
    const response = await worker.fetch(new Request(`${BASE}/decks/x`, { headers: { authorization: "Bearer short" } }), { SLIDES_TOKENS: "short=human:ada", SLIDES_UNSAFE_MEMORY_STORE: "1" });
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).toContain("MISCONFIGURED");
    expect((await worker.fetch(new Request("http://slides.test/health"), { SLIDES_TOKENS: "short=human:ada", SLIDES_UNSAFE_MEMORY_STORE: "1" })).status).toBe(200);
  });
});

describe("the author comes from the token", () => {
  test("a client cannot claim a different principal in the body or a header", async () => {
    const call = appFor();
    await call("POST", "/decks", { token: AGENT, body: { title: "Talk", id: "talk", author: { kind: "human", name: "ada" } }, headers: { "x-principal": "human:ada" } });
    await call("POST", "/decks/talk/slides", { token: AGENT, body: { outline: "# One", author: { kind: "human", name: "ada" } }, headers: { "x-principal": "human:ada" } });
    const outline = (await (await call("GET", "/decks/talk", { token: HUMAN })).json()) as { editedBy: unknown; machineMade: boolean; slides: { createdBy: unknown; machineMade: boolean }[] };
    expect(outline.editedBy).toEqual({ kind: "agent_of_human", name: "bot" });
    expect(outline.slides[0]).toMatchObject({ createdBy: { kind: "agent_of_human", name: "bot" }, machineMade: true });
  });
});

describe("bad requests", () => {
  test("bodies that are not valid get a 400 that does not echo the input", async () => {
    const call = appFor();
    expect((await call("POST", "/decks", { token: HUMAN, raw: "{not json" })).status).toBe(400);
    expect((await call("POST", "/decks", { token: HUMAN, raw: "" })).status).toBe(400);
    const wrong = await call("POST", "/decks", { token: HUMAN, body: { title: 42, secret: "do-not-echo-me" } });
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).not.toContain("do-not-echo-me");
    expect((await call("PATCH", "/decks/x/slides/1/elements/e", { token: HUMAN, body: { bogus: 1 } })).status).toBe(400);
    expect((await call("POST", "/decks/x/slides/1/move", { token: HUMAN, body: { to: "two" } })).status).toBe(400);
  });

  test("a body over the limit gets 413", async () => {
    const response = await appFor()("POST", "/decks", { token: HUMAN, raw: "x", headers: { "content-length": String(40 * 1024 * 1024) } });
    expect(response.status).toBe(413);
  });

  test("ids, selectors, and routes that do not exist", async () => {
    const call = appFor();
    await call("POST", "/decks", { token: HUMAN, body: { title: "T", id: "t" } });
    for (const id of ["a.b", "-x"]) expect((await call("GET", `/decks/${id}`, { token: HUMAN })).status).toBe(400);
    expect((await call("GET", "/decks/missing", { token: HUMAN })).status).toBe(404);
    expect((await call("DELETE", "/decks/t/slides/0", { token: HUMAN })).status).toBe(404);
    expect((await call("POST", "/decks", { token: HUMAN, body: { title: "T", id: "t" } })).status).toBe(409);
    expect((await call("GET", "/decks/t/export?format=odp", { token: HUMAN })).status).toBe(400);
    expect((await call("GET", "/nowhere", { token: HUMAN })).status).toBe(404);
  });

  test("every response carries nosniff and no-store", async () => {
    const response = await appFor()("GET", "/decks/x");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("the Worker is a stopgap", () => {
  test("it refuses every request, health included, until the in-memory store is chosen on purpose", async () => {
    for (const path of ["/health", "/api/v1/slides/decks/x"]) {
      const response = await worker.fetch(new Request(`http://slides.test${path}`, { headers: { authorization: `Bearer ${HUMAN}` } }), { SLIDES_TOKENS: `${HUMAN}=human:ada` });
      expect(response.status).toBe(500);
      expect(JSON.stringify(await response.json())).toContain("MISCONFIGURED");
    }
    const on = await worker.fetch(new Request("http://slides.test/health"), { SLIDES_TOKENS: `${HUMAN}=human:ada`, SLIDES_UNSAFE_MEMORY_STORE: "1" });
    expect(on.status).toBe(200);
  });
});

describe("export and render", () => {
  async function deckWithCjkTitles(call: ReturnType<typeof appFor>, slides: number) {
    await call("POST", "/decks", { token: HUMAN, body: { title: "T", id: "t" } });
    const outline = Array.from({ length: slides }, (_, i) => `# ${Array.from({ length: 40 }, (_, j) => String.fromCodePoint(0x4e00 + i * 40 + j)).join("")}`).join("\n---\n");
    expect((await call("POST", "/decks/t/slides", { token: HUMAN, body: { outline } })).status).toBe(201);
  }

  test("a deck with many replaced characters still exports, with a bounded warnings header", async () => {
    const call = appFor();
    await deckWithCjkTitles(call, 20);
    const response = await call("GET", "/decks/t/export", { token: HUMAN });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("x-slides-warnings-count")).toBe("20");
    expect(response.headers.get("x-slides-warnings")!.length).toBeLessThanOrEqual(1100);
    expect(JSON.parse(decodeURIComponent(response.headers.get("x-slides-warnings")!)).length).toBeGreaterThan(0);
    expect(Buffer.from(await response.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");
  });

  test("the JSON envelope returns the whole warning list with the PDF", async () => {
    const call = appFor();
    await deckWithCjkTitles(call, 20);
    const body = (await (await call("GET", "/decks/t/export?envelope=json", { token: HUMAN })).json()) as { pdfBase64: string; warnings: string[]; bytes: number };
    expect(body.warnings).toHaveLength(20);
    expect(Buffer.from(body.pdfBase64, "base64").subarray(0, 5).toString()).toBe("%PDF-");
  });

  test("the render route sends the policy that matches the page", async () => {
    const call = appFor();
    await call("POST", "/decks", { token: HUMAN, body: { title: "T", id: "t" } });
    await call("POST", "/decks/t/slides", { token: HUMAN, body: { outline: "# One\n> note" } });
    const deck = await call("GET", "/decks/t/render", { token: HUMAN });
    expect(deck.headers.get("content-security-policy")).toBe(CSP);
    const present = await call("GET", "/decks/t/render?present=1", { token: HUMAN });
    expect(present.headers.get("content-security-policy")).toBe(PRESENT_CSP);
    expect(await present.text()).toContain(PRESENT_CSP);
  });
});

describe("image volume", () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64").toString("base64");

  test("too many images in one request get 413, before any is decoded", async () => {
    const call = appFor();
    await call("POST", "/decks", { token: HUMAN, body: { title: "T", id: "t" } });
    const images = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`i${i}.png`, png]));
    const response = await call("POST", "/decks/t/slides", { token: HUMAN, body: { outline: "# a", images } });
    expect(response.status).toBe(413);
    expect(JSON.stringify(await response.json())).toContain("TOO_LARGE");
  });

  test("one image over its size, and images over the total, are refused by size alone", () => {
    const big = "A".repeat(Math.ceil((10 * 1024 * 1024 + 1) * 4 / 3));
    expect(() => decodeImages({ "a.png": big })).toThrow(/10485760/);
    const medium = "A".repeat(4000);
    expect(() => decodeImages({ a: medium, b: medium, c: medium }, { ...DEFAULT_LIMITS, maxTotalImageBytes: 8000 })).toThrow(/total/);
    expect(Object.keys(decodeImages({ a: png }) ?? {})).toEqual(["a"]);
  });
});
