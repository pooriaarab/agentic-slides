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

  test("a revoke closes the open socket of an agent, and the agent cannot connect again", async () => {
    expect((await api("/decks", HUMAN, { method: "POST", body: JSON.stringify({ title: "Revoke", id: "revoke" }) })).status).toBe(201);
    await shareAll(server.url, HUMAN, "revoke", "ada");
    const statuses: string[] = [];
    const socket = await SyncClient.connect({
      url: `${server.url.replace("http", "ws")}/api/v1/slides/decks/revoke/ws`,
      headers: { authorization: `Bearer ${AGENT}` },
      presence: { name: "probe" },
      onStatus: (status) => statuses.push(status),
    });
    try {
      expect((await api("/decks/revoke/grants?subjectKind=agent&subjectId=agent_of_human_bot", HUMAN, { method: "DELETE" })).status).toBe(200);
      for (let i = 0; i < 100 && statuses.at(-1) !== "disconnected"; i++) await new Promise((r) => setTimeout(r, 100));
      expect(statuses.at(-1)).toBe("disconnected");
      // The grant is gone, so the role refuses a new connect. The ban is not checked here.
      await expect(room("revoke", AGENT)).rejects.toThrow();
    } finally {
      await socket.disconnect();
    }
  }, 60_000);

  test("a grant of viewer to an open agent socket drops its writes", async () => {
    expect((await api("/decks", HUMAN, { method: "POST", body: JSON.stringify({ title: "Cap", id: "cap" }) })).status).toBe(201);
    await shareAll(server.url, HUMAN, "cap", "ada");
    const socket = await room("cap", AGENT);
    try {
      const granted = await api("/decks/cap/grants", HUMAN, { method: "POST", body: JSON.stringify({ subjectKind: "agent", subjectId: "agent_of_human_bot", role: "viewer" }) });
      expect(granted.status).toBe(200);
      await socket.edit((doc) => new Deck(doc).addSlide({ layout: "blank" }, bot));
      await socket.flush();
      expect(socket.denied.length).toBeGreaterThan(0);
    } finally {
      await socket.disconnect();
    }
    // A second person reads the room. The refused write is not in it.
    const reader = await room("cap", HUMAN);
    try {
      expect(new Deck(reader.doc).outline().slides).toHaveLength(0);
    } finally {
      await reader.disconnect();
    }
  }, 60_000);

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
