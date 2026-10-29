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
const ROBOT = "robot-token-0123456789-abcdefghij";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
let workers: { server: ChildProcess; base: string }[] = [];
let base = "";
const home = mkdtempSync(join(tmpdir(), "slides-wrangler-"));
const persist = join(home, "state");

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
// The agent owns what it makes. It lets the person edit, so both tokens can work on the deck.
async function make(id: string, title: string) {
  const made = await call("POST", "/decks", { token: AGENT, body: { title, id } });
  const shared = await call("POST", `/decks/${id}/grants`, { token: AGENT, body: { subjectKind: "human", subjectId: "ada", role: "editor" } });
  return made.status === 201 && shared.status === 200 ? made : shared;
}

// The persist directory holds the local D1 database and R2 bucket. A restart on the same directory sees the same data.
async function start(attempts = 3): Promise<string> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  let log = "";
  const server = spawn(
    "npx",
    ["wrangler", "dev", "--port", String(port), "--ip", "127.0.0.1", "--inspector-port", String(port + 100), "--persist-to", persist, "--var", "SLIDES_REGION:unknown", "--var", `SLIDES_TOKENS:${HUMAN}=human:ada,${AGENT}=agent_of_human:bot,${ROBOT}=agent:robot`],
    { env: { ...process.env, WRANGLER_SEND_METRICS: "false", HOME: home, XDG_CONFIG_HOME: home, CI: "1" }, detached: true },
  );
  workers.push({ server, base: url });
  server.stdout?.on("data", (chunk: Buffer) => (log += chunk));
  server.stderr?.on("data", (chunk: Buffer) => (log += chunk));
  for (let i = 0; i < 180 && server.exitCode === null; i++) {
    if (await fetch(`${url}/health`).then((r) => r.ok, () => false)) return url;
    await new Promise((r) => setTimeout(r, 500));
  }
  // freePort() releases its port before wrangler binds it, so another process can take it first. Try a new port.
  if (log.includes("Address already in use") && attempts > 1) {
    await stop({ server });
    return start(attempts - 1);
  }
  throw new Error(`wrangler dev did not start:\n${log.slice(-2000)}`);
}

const stop = (worker: { server: ChildProcess }) =>
  new Promise<void>((resolve) => {
    worker.server.once("exit", () => resolve());
    // npx starts wrangler, which starts workerd. A signal to the group stops all three.
    try {
      process.kill(-worker.server.pid!, "SIGTERM");
    } catch {
      resolve();
    }
    setTimeout(resolve, 10_000);
  });

beforeAll(async () => {
  base = await start();
}, 120_000);

afterAll(async () => {
  await Promise.all(workers.map(stop));
});

describe("slides Worker API", () => {
  test("health answers, and the API needs a token", async () => {
    expect(await json(await fetch(`${base}/health`))).toMatchObject({ ok: true, pack: "agentic-slides" });
    expect((await call("GET", "/decks/x")).status).toBe(401);
    expect((await call("GET", "/decks/x", { token: "wrong-token-0123456789-abcdefghij" })).status).toBe(401);
  });

  test("builds, edits, renders, and exports a deck", async () => {
    expect((await make("plan", "Launch plan")).status).toBe(201);
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
    await make("bad", "Bad");
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

  test("decks and images live in D1 and R2: concurrent edits add up, and a restart sees them", async () => {
    await make("shared", "Shared");
    const added = await call("POST", "/decks/shared/slides", { token: AGENT, body: { outline: "# Pic\n![A cat](cat.png)", images: { "cat.png": PNG } } });
    expect(added.status).toBe(201);
    // One Worker serves the whole test. Two workerd processes on one local D1 file can fail with a SQLite lock error that real D1 does not raise.
    const both = await Promise.all([0, 1, 2, 3].map((n) => call("POST", "/decks/shared/slides", { token: AGENT, body: { outline: `# S${n}` } })));
    expect(both.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    for (const worker of workers.splice(0)) await stop(worker);
    base = await start();
    const outline = await json(await call("GET", "/decks/shared", { token: HUMAN }));
    expect(outline.slides).toHaveLength(5);
    expect(outline.slides[0]).toMatchObject({ createdBy: { kind: "agent_of_human", name: "bot" }, machineMade: true });
    const html = await (await call("GET", "/decks/shared/render", { token: HUMAN })).text();
    expect(html).toContain("data:image/png;base64,");
  }, 180_000);

  test("roles, invites, and links live in D1, and a restart keeps them", async () => {
    // The person makes a deck. The agent has no role yet, so it sees no deck.
    expect((await call("POST", "/decks", { token: HUMAN, body: { title: "Private", id: "private" } })).status).toBe(201);
    expect((await call("GET", "/decks/private", { token: ROBOT })).status).toBe(404);
    const invite = await json(await call("POST", "/decks/private/invites", { token: HUMAN, body: { role: "viewer", handle: "robot" } }));
    // A delegated token has the name of an agent, but not its identity: it cannot accept.
    expect((await call("POST", "/invites/accept", { token: AGENT, body: { id: invite.id } })).status).toBe(403);
    expect((await call("POST", "/invites/accept", { token: ROBOT, body: { id: invite.id } })).status).toBe(200);
    expect((await call("GET", "/decks/private", { token: ROBOT })).status).toBe(200);
    expect((await call("POST", "/decks/private/slides", { token: ROBOT, body: { outline: "# No" } })).status).toBe(403);
    const link = await json(await call("POST", "/decks/private/links", { token: HUMAN, body: { role: "viewer" } }));
    for (const worker of workers.splice(0)) await stop(worker);
    base = await start();
    const visit = (token: string) => fetch(`${base}/api/v1/slides/shared/private`, { headers: { "x-link-token": token } });
    expect((await visit(link.token)).status).toBe(200);
    expect((await call("GET", "/decks/private", { token: ROBOT })).status).toBe(200);
    expect((await call("DELETE", `/decks/private/links/${link.id}`, { token: HUMAN })).status).toBe(200);
    expect((await visit(link.token)).status).toBe(404);
    expect((await call("DELETE", "/decks/private/grants?subjectKind=agent&subjectId=robot", { token: HUMAN })).status).toBe(200);
    expect((await call("GET", "/decks/private", { token: ROBOT })).status).toBe(404);
    expect((await call("GET", "/decks/private/access", { token: ROBOT })).status).toBe(404);
  }, 180_000);
});
