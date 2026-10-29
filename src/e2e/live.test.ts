import { SyncClient } from "agentic-realtime/client";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Deck } from "../core/deck.js";
import { shareAll, worker, type Server } from "./server.js";

// End to end: the live room in the Worker under `wrangler dev`, with a real Durable Object.
const HUMAN = "human-token-0123456789-abcdefghij";
const AGENT = "agent-token-0123456789-abcdefghij";
const WATCHER = "watcher-token-0123456789-abcdefghij";
const ada = { kind: "human", name: "ada" } as const;
const bot = { kind: "agent_of_human", name: "bot" } as const;
let server: Server;

const api = (path: string, token: string, init: RequestInit = {}) =>
  fetch(`${server.url}/api/v1/slides${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers } });
const room = (id: string, token: string) =>
  SyncClient.connect({ url: `${server.url.replace("http", "ws")}/api/v1/slides/decks/${id}/ws`, headers: { authorization: `Bearer ${token}` }, presence: { name: "probe" } });

beforeAll(async () => {
  server = await worker(`${HUMAN}=human:ada,${AGENT}=agent_of_human:bot,${WATCHER}=human:eve;viewer`);
  await server.start();
}, 120_000);

afterAll(async () => {
  await server.dispose();
});

describe("a deck in a live room", () => {
  test("a person and an agent edit one deck at once, both converge, and a restart keeps it", async () => {
    expect((await api("/decks", HUMAN, { method: "POST", body: JSON.stringify({ title: "Talk", id: "talk" }) })).status).toBe(201);
    await shareAll(server.url, HUMAN, "talk", "ada");
    const [one, two] = await Promise.all([room("talk", HUMAN), room("talk", AGENT)]);
    try {
      const seed = new Uint8Array(await (await api("/decks/talk/state", HUMAN)).arrayBuffer());
      // Both copies start from the stored deck. The room holds the same state after the merge.
      const a = new Deck(one.doc);
      const b = new Deck(two.doc);
      a.applyUpdate(seed);
      await one.flush();
      await two.flush();
      await Promise.all([one.edit(() => a.addSlide({ layout: "blank" }, ada)), two.edit(() => b.addSlide({ layout: "title" }, bot))]);
      await Promise.all([one.flush(), two.flush()]);
      await new Promise((r) => setTimeout(r, 300));
      expect(a.outline().slides.map((s) => s.layout).sort()).toEqual(["blank", "title"]);
      expect(b.outline().slides.map((s) => s.layout).sort()).toEqual(["blank", "title"]);
      // The room marks who is a machine from the token, not from the client.
      expect(one.peers.map((p) => [p.name, p.kind, p.machine])).toContainEqual(["bot", "agent_of_human", true]);
      const save = await api("/decks/talk/checkpoint", AGENT, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: new Uint8Array(a.encode()) });
      expect(save.status).toBe(200);
    } finally {
      await Promise.all([one.disconnect(), two.disconnect()]);
    }
    await server.stop();
    await server.start();
    // The stored deck has both slides, and so does the room after the restart.
    const stored = (await (await api("/decks/talk", HUMAN)).json()) as { slides: { layout: string; machineMade: boolean }[] };
    expect(stored.slides.map((s) => s.layout).sort()).toEqual(["blank", "title"]);
    expect(stored.slides.map((s) => s.machineMade).sort()).toEqual([false, true]);
    const again = await room("talk", HUMAN);
    try {
      expect(new Deck(again.doc).outline().slides).toHaveLength(2);
    } finally {
      await again.disconnect();
    }
  }, 120_000);

  test("the room refuses a missing token, a missing deck, and a viewer's edit", async () => {
    await expect(room("talk", "wrong-token-0123456789-abcdefghijk")).rejects.toThrow();
    await expect(room("nodeck", HUMAN)).rejects.toThrow();
    const watcher = await room("talk", WATCHER);
    try {
      await watcher.edit((doc) => new Deck(doc).addSlide({ layout: "blank" }, ada));
      expect(watcher.denied.length).toBeGreaterThan(0);
    } finally {
      await watcher.disconnect();
    }
    const outline = (await (await api("/decks/talk", HUMAN)).json()) as { slides: unknown[] };
    expect(outline.slides).toHaveLength(2);
    const fresh = await room("talk", HUMAN);
    try {
      expect(new Deck(fresh.doc).outline().slides).toHaveLength(2);
    } finally {
      await fresh.disconnect();
    }
  }, 60_000);
});
