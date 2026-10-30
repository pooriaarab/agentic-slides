import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { VERSION } from "./version.js";

describe("VERSION", () => {
  test("matches package.json without a build", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });

  test("matches the registry, lockfile, and README versions", () => {
    const read = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
    const server = JSON.parse(read("server.json")) as { version: string; packages: { version: string }[] };
    const lock = JSON.parse(read("package-lock.json")) as { version: string; packages: { "": { version: string } } };
    expect(server.version).toBe(VERSION);
    expect(server.packages[0].version).toBe(VERSION);
    expect(lock.version).toBe(VERSION);
    expect(lock.packages[""].version).toBe(VERSION);
    expect(read("README.md")).toContain(`> Status: ${VERSION},`);
    expect(read("CHANGELOG.md")).toContain(`## ${VERSION} - `);
  });
});
