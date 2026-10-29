import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

describe("ui/app.css", () => {
  test("holds no hex color: every color is an agentic-design token", () => {
    const css = readFileSync(new URL("../ui/app.css", import.meta.url), "utf8");
    expect(css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
  });
});

describe("the CSS in the render modules", () => {
  // A hex color may stay only as the fallback of a var() token, as in the forms page.
  for (const file of ["present.ts", "html.ts"]) {
    test(`${file} holds no bare hex color: each one is a var() fallback`, () => {
      const source = readFileSync(new URL(`./render/${file}`, import.meta.url), "utf8");
      const bare = source.replace(/var\(--[a-z0-9-]+,\s*#[0-9a-fA-F]{3,8}\)/g, "");
      // Character references such as &#8249; and element ids such as #notes are not colors: a color has 3, 4, 6, or 8 hex digits after a declaration colon or a space.
      expect(bare.match(/[:\s,(]#[0-9a-fA-F]{3,8}\b(?![\w-])/g) ?? []).toEqual([]);
    });
  }
});
