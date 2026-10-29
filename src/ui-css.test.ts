import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

describe("ui/app.css", () => {
  test("holds no hex color: every color is an agentic-design token", () => {
    const css = readFileSync(new URL("../ui/app.css", import.meta.url), "utf8");
    expect(css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
  });
});
