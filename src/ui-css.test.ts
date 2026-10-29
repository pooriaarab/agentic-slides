import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

describe("ui/app.css", () => {
  test("holds no hex color: every color is an agentic-design token", () => {
    const css = readFileSync(new URL("../ui/app.css", import.meta.url), "utf8");
    expect(css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
  });
});

describe("the CSS in the render modules", () => {
  // The render modules hold no hex color, no old --agd-color-present-* name, and no `ad-` name.
  // Every value comes from the agentic-design tokens that tokenCss() inlines.
  for (const file of ["present.ts", "html.ts"]) {
    test(`${file} holds no hex color and no made-up token`, () => {
      const source = readFileSync(new URL(`./render/${file}`, import.meta.url), "utf8");
      // Character references such as &#8249; and element ids such as #notes are not colors: a color has 3, 4, 6, or 8 hex digits after a declaration colon or a space.
      expect(source.match(/[:\s,(]#[0-9a-fA-F]{3,8}\b(?![\w-])/g) ?? []).toEqual([]);
      expect(source).not.toMatch(/--agd-color-present/);
      expect(source).not.toMatch(/(?<![a-z])--?ad-|\bad-/);
    });
  }
});
