import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "@cantoo/pdf-lib";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

// End to end: the Worker under `wrangler dev` (workerd), driven over HTTP.
const HUMAN = "human-token-0123456789-abcdefghij";
const AGENT = "agent-token-0123456789-abcdefghij";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
let server: ChildProcess;
let base = "";
let log = "";

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

async function call(method: string, path: string, options: { token?: string; body?: unknown } = {}) {
  return fetch(`${base}/api/v1/slides${path}`, {
    method,
    headers: { ...(options.token ? { authorization: `Bearer ${options.token}` } : {}), "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}
const json = async (response: Response) => (await response.json()) as Record<string, any>;

beforeAll(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const home = mkdtempSync(join(tmpdir(), "slides-wrangler-"));
  server = spawn(
    "npx",
    ["wrangler", "dev", "--port", String(port), "--ip", "127.0.0.1", "--var", `SLIDES_TOKENS:${HUMAN}=human:ada,${AGENT}=agent_of_human:bot`, "--var", "SLIDES_UNSAFE_MEMORY_STORE:1"],
    { env: { ...process.env, WRANGLER_SEND_METRICS: "false", HOME: home, XDG_CONFIG_HOME: home, CI: "1" } },
  );
  server.stdout?.on("data", (chunk: Buffer) => (log += chunk));
  server.stderr?.on("data", (chunk: Buffer) => (log += chunk));
  for (let i = 0; i < 180; i++) {
    if (await fetch(`${base}/health`).then((r) => r.ok, () => false)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`wrangler dev did not start:\n${log.slice(-2000)}`);
}, 120_000);

afterAll(() => {
  server?.kill("SIGTERM");
});

describe("slides Worker API", () => {
  test("health answers, and the API needs a token", async () => {
    expect(await json(await fetch(`${base}/health`))).toMatchObject({ ok: true, pack: "agentic-slides" });
    expect((await call("GET", "/decks/x")).status).toBe(401);
    expect((await call("GET", "/decks/x", { token: "wrong-token-0123456789-abcdefghij" })).status).toBe(401);
  });

  test("builds, edits, renders, and exports a deck", async () => {
    expect((await call("POST", "/decks", { token: AGENT, body: { title: "Launch plan", id: "plan" } })).status).toBe(201);
    const added = await call("POST", "/decks/plan/slides", {
      token: AGENT,
      body: { outline: "# Launch\n- **Ship** it\n> hello\n---\n# Pic\n![A cat](cat.png)\n---\n# Facts\n|a|b|\n|1|2|", images: { "cat.png": PNG } },
    });
    expect(added.status).toBe(201);
    const { slideIds } = await json(added);
    expect(slideIds).toHaveLength(3);

    let outline = await json(await call("GET", "/decks/plan", { token: HUMAN }));
    expect(outline.slides.map((s: any) => s.title)).toEqual(["Launch", "Pic", "Facts"]);
    expect(outline.slides[0]).toMatchObject({ createdBy: { kind: "agent_of_human", name: "bot" }, machineMade: true });
    const title = outline.slides[0].elements.find((e: any) => e.slot === "title");

    expect((await call("PATCH", `/decks/plan/slides/1/elements/${title.id}`, { token: HUMAN, body: { text: "Launch **now**", x: 100 } })).status).toBe(200);
    expect((await call("PUT", `/decks/plan/slides/${slideIds[2]}`, { token: AGENT, body: { outline: "# Facts v2\n- one" } })).status).toBe(200);
    expect((await call("POST", "/decks/plan/slides/3/move", { token: AGENT, body: { to: 1 } })).status).toBe(200);
    expect((await call("POST", "/decks/plan/slides", { token: AGENT, body: { layout: "section", at: 2 } })).status).toBe(201);
    outline = await json(await call("GET", "/decks/plan", { token: HUMAN }));
    expect(outline.slides.map((s: any) => s.layout)).toEqual(["title-body", "section", "title-body", "image-right"]);
    const edited = outline.slides[2].elements.find((e: any) => e.slot === "title");
    expect(edited).toMatchObject({ x: 100, createdBy: { kind: "agent_of_human" }, editedBy: { kind: "human", name: "ada" } });
    expect((await call("DELETE", "/decks/plan/slides/2", { token: AGENT })).status).toBe(200);

    const page = await call("GET", "/decks/plan/render?present=1", { token: HUMAN });
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("content-security-policy")).toContain("connect-src 'none'");
    const html = await page.text();
    expect(html).toContain("Facts v2");
    expect(html).toContain("data:image/png;base64,");
    expect(html).not.toMatch(/https?:/);

    const pdf = await call("GET", "/decks/plan/export", { token: HUMAN });
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(JSON.parse(decodeURIComponent(pdf.headers.get("x-slides-warnings")!))).toEqual([]);
    const bytes = new Uint8Array(await pdf.arrayBuffer());
    expect(Buffer.from(bytes.subarray(0, 5)).toString()).toBe("%PDF-");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(3);
    expect(doc.getPage(0).getSize()).toEqual({ width: 1280, height: 720 });
    const again = new Uint8Array(await (await call("GET", "/decks/plan/export", { token: HUMAN })).arrayBuffer());
    expect(Buffer.from(again).equals(Buffer.from(bytes))).toBe(true);
  });

  test("a bad outline is a 422 with every issue, and the deck does not change", async () => {
    await call("POST", "/decks", { token: AGENT, body: { title: "Bad", id: "bad" } });
    const before = JSON.stringify(await json(await call("GET", "/decks/bad", { token: HUMAN })));
    const response = await call("POST", "/decks/bad/slides", {
      token: AGENT,
      body: { outline: "layout: zigzag\n# A\n---\n# B\n![x](missing.png)\n---\n# C\n![x](https://cdn.example.com/c.png)" },
    });
    expect(response.status).toBe(422);
    const { error } = await json(response);
    expect(error.issues.map((i: any) => [i.code, i.slide])).toEqual([["UNKNOWN_LAYOUT", 1], ["IMAGE_MISSING", 2], ["REMOTE_ASSET", 3]]);
    expect(JSON.stringify(await json(await call("GET", "/decks/bad", { token: HUMAN })))).toBe(before);
    const fake = await call("POST", "/decks/bad/slides", { token: AGENT, body: { outline: "# P\n![x](a.png)", images: { "a.png": Buffer.from("<svg onload=alert(1)>").toString("base64") } } });
    expect((await json(fake)).error.code).toBe("UNSUPPORTED_IMAGE");
    expect((await call("GET", "/decks/missing", { token: HUMAN })).status).toBe(404);
  });
});
