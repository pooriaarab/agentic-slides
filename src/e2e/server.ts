import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Test helper: the Worker under `wrangler dev`, with state that survives a stop and a start.
const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

export interface Server {
  url: string;
  start(): Promise<void>;
  /** Kills the Worker. The state on disk stays, so `start` brings the decks and the rooms back. */
  stop(): Promise<void>;
  dispose(): Promise<void>;
}

export async function worker(tokens: string): Promise<Server> {
  const home = mkdtempSync(join(tmpdir(), "slides-wrangler-"));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  let child: ChildProcess | undefined;
  const stop = () =>
    new Promise<void>((resolve) => {
      const running = child;
      child = undefined;
      if (!running?.pid) return resolve();
      running.once("exit", () => resolve());
      // npx starts wrangler, which starts workerd. A signal to the group stops all three.
      try {
        process.kill(-running.pid, "SIGKILL");
      } catch {
        resolve();
      }
      setTimeout(resolve, 10_000);
    });
  return {
    url,
    stop,
    async start() {
      let log = "";
      child = spawn(
        "npx",
        ["wrangler", "dev", "--port", String(port), "--ip", "127.0.0.1", "--inspector-port", String(await freePort()), "--persist-to", join(home, "state"), "--var", "SLIDES_REGION:unknown", "--var", `SLIDES_TOKENS:${tokens}`],
        { env: { ...process.env, WRANGLER_SEND_METRICS: "false", HOME: home, XDG_CONFIG_HOME: home, CI: "1" }, detached: true },
      );
      child.stdout?.on("data", (chunk: Buffer) => (log += chunk));
      child.stderr?.on("data", (chunk: Buffer) => (log += chunk));
      for (let i = 0; i < 180; i++) {
        if (await fetch(`${url}/health`).then((r) => r.ok, () => false)) return;
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error(`wrangler dev did not start:\n${log.slice(-2000)}`);
    },
    async dispose() {
      await stop();
      rmSync(home, { recursive: true, force: true });
    },
  };
}
