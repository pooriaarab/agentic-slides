import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

test("runtime agentic packages are present in production installs", () => {
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")) as {
    packages: Record<string, { dev?: boolean; version?: string }>;
  };
  for (const name of ["agentic-design", "agentic-formats", "agentic-identity", "agentic-realtime"]) {
    const runtime = lock.packages[`node_modules/${name}`];
    expect(runtime?.version, name).toBeDefined();
    expect(runtime?.dev, name).not.toBe(true);
    expect(runtime?.version, name).toBe(lock.packages[`node_modules/test-${name}`]?.version);
  }
});
