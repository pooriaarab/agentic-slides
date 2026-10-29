import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SlidesApiError, createClient } from "../client.js";
import { shareAll, worker, type Server } from "./server.js";

// End to end: the remote client against the real Worker (wrangler dev).
const HUMAN = "human-token-0123456789-abcdefghij";
const AGENT = "agent-token-0123456789-abcdefghij";
const WATCHER = "watcher-token-0123456789-abcdefghij";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
let server: Server;

const as = (token: string) => createClient({ baseUrl: server.url, token });
const refused = async (promise: Promise<unknown>) => {
  const error = await promise.then(() => undefined, (e) => e);
  expect(error).toBeInstanceOf(SlidesApiError);
  return error as SlidesApiError;
};

beforeAll(async () => {
  server = await worker(`${HUMAN}=human:ada,${AGENT}=agent_of_human:bot,${WATCHER}=human:eve;viewer`);
  await server.start();
}, 120_000);

afterAll(async () => {
  await server?.dispose();
});

describe("the remote client on a real Worker", () => {
  test("builds, edits, reads, renders, and exports a deck", async () => {
    const agent = as(AGENT);
    expect(await agent.health()).toMatchObject({ ok: true, pack: "agentic-slides" });
    expect(await agent.me()).toEqual({ kind: "agent_of_human", name: "bot", role: "editor", subject: { kind: "agent", id: "agent_of_human_bot" } });
    expect(await agent.createDeck({ title: "Plan", id: "plan" })).toEqual({ id: "plan" });
    await shareAll(server.url, AGENT, "plan", "bot");
    const { slideIds } = await agent.addSlides("plan", { outline: "# One\n- a\n---\n# Pic\n![cat](cat.png)\n---\n# Three\n- c", images: { "cat.png": PNG } });
    expect(slideIds).toHaveLength(3);
    await agent.addSlides("plan", { layout: "section", at: 2 });

    const human = as(HUMAN);
    let outline = await human.outline("plan");
    expect(outline.slides).toHaveLength(4);
    const title = outline.slides[0]!.elements.find((e) => e.kind === "text" && e.slot === "title")!;
    await human.editElement("plan", 1, title.id, { text: "One **now**" });
    await human.setSlide("plan", slideIds[2]!, { outline: "# Three v2\n- c" });
    await human.moveSlide("plan", 4, 1);
    await human.deleteSlide("plan", 3);
    outline = await human.outline("plan");
    expect(outline.slides.map((s) => s.title)).toEqual(["Three v2", "One now", "Pic"]);
    expect(outline.slides[1]!.elements.find((e) => e.kind === "text" && e.slot === "title")).toMatchObject({ editedBy: { kind: "human", name: "ada" } });

    expect(await human.render("plan")).toContain("<html");
    expect(await human.render("plan", { present: true })).toContain("<html");
    const pdf = await human.exportPdf("plan");
    expect(new TextDecoder().decode(pdf.bytes.subarray(0, 5))).toBe("%PDF-");
    const state = await human.state("plan");
    expect(state.length).toBeGreaterThan(0);
    await human.checkpoint("plan", state);
  }, 60_000);

  test("deletes a deck, and a viewer cannot", async () => {
    const human = as(HUMAN);
    await human.createDeck({ title: "Gone", id: "gone" });
    expect(await refused(as(WATCHER).deleteDeck("gone"))).toMatchObject({ status: 403, code: "FORBIDDEN" });
    await human.deleteDeck("gone");
    expect(await refused(human.outline("gone"))).toMatchObject({ status: 404, code: "NO_DECK" });
    expect(await refused(human.deleteDeck("gone"))).toMatchObject({ status: 404, code: "NO_DECK" });
    expect((await human.listDecks()).decks.map((d) => d.id)).not.toContain("gone");
  }, 60_000);

  test("a bad token is UNAUTHORIZED with status 401", async () => {
    const error = await refused(as("wrong-token-0123456789-abcdefghij").outline("plan"));
    expect(error).toMatchObject({ status: 401, code: "UNAUTHORIZED" });
  });

  test("a deck that does not exist is NO_DECK with status 404", async () => {
    const error = await refused(as(HUMAN).outline("missing"));
    expect(error).toMatchObject({ status: 404, code: "NO_DECK" });
    expect(await refused(as(HUMAN).deleteSlide("plan", "zzz"))).toMatchObject({ status: 404, code: "NO_SLIDE" });
  });

  test("a viewer write is FORBIDDEN, and a bad body is BAD_REQUEST", async () => {
    expect(await refused(as(WATCHER).createDeck({ title: "x" }))).toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(await refused(as(HUMAN).createDeck({ title: "" }))).toMatchObject({ status: 400, code: "BAD_REQUEST" });
    expect(await refused(as(HUMAN).createDeck({ title: "Plan", id: "plan" }))).toMatchObject({ status: 409, code: "DECK_EXISTS" });
  });

  test("an aborted call rejects", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(as(HUMAN).outline("plan", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("the remote client with a stub fetch", () => {
  const stub = (status: number, body: unknown) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    }) as typeof globalThis.fetch;
    return { calls, client: createClient({ baseUrl: "http://x.test/", token: "t", fetch }) };
  };

  test("a failed write is sent once, even when the server is busy", async () => {
    const { calls, client } = stub(503, { error: { code: "STORE_BUSY", message: "busy" } });
    const error = await refused(client.addSlides("d", { layout: "section" }));
    expect(error).toMatchObject({ status: 503, code: "STORE_BUSY" });
    expect(calls).toHaveLength(1);
  });

  test("an answer that is not JSON still gives a typed error", async () => {
    const { client } = stub(502, "<html>bad gateway</html>");
    expect(await refused(client.me())).toMatchObject({ status: 502, code: "UNKNOWN" });
  });

  test("the path is encoded and the token is sent", async () => {
    const { calls, client } = stub(200, { ok: true });
    await client.deleteSlide("a b", "s/1");
    expect(calls[0]!.url).toBe("http://x.test/api/v1/slides/decks/a%20b/slides/s%2F1");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer t");
  });

  test("the client has no Node import", () => {
    const source = readFileSync(new URL("../client.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from "node:|require\(|\bBuffer\b|process\./);
    expect([...source.matchAll(/^import (?!type)/gm)]).toHaveLength(0);
  });
});
