import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import { describe, expect, test } from "vitest";
import { Deck } from "../core/deck.js";
import { DEFAULT_THEME } from "../core/layouts.js";
import { SlidesError, type Principal } from "../core/principal.js";
import { renderDeck, renderSlide } from "./html.js";
import { renderPresent } from "./present.js";

// Ways a render can fail, written before the code: injected markup, a theme
// from an untrusted update, a remote asset, a network fetch, and drift between runs.
const human: Principal = { kind: "human", name: "ada" };
const agent: Principal = { kind: "agent", name: "bot" };
const KEY = `sha256-${"ab".repeat(32)}`;
const images = { "cat.png": `blob:${KEY}` };
const OUTLINE = ["# Intro", "- one", "- **two**", "> say hi", "---", "# Pic", "![A cat](cat.png)", "---", "# Table", "|a|b|", "|1|2|"].join("\n");

function sample(author: Principal = human) {
  const deck = Deck.create({ title: "Talk", author });
  deck.addSlidesFromOutline(OUTLINE, { author, images });
  return deck;
}

describe("render safety", () => {
  test("text, alt, table cells, notes, and the deck title are escaped", () => {
    const deck = Deck.create({ title: "</title><b>t", author: human });
    const evil = `<script>alert(1)</script>`;
    deck.addSlidesFromOutline(`# ${evil}\n![x"onerror="1](cat.png)\n> ${evil}`, { author: human, images });
    deck.addSlidesFromOutline(`# T\n|${evil}|b|`, { author: human });
    const html = renderDeck(deck.outline());
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<b>t");
    expect(html).not.toContain(`alt="x"onerror`);
    expect(html).toContain("&lt;script&gt;");
  });

  test("a theme that did not pass checkTheme is refused", () => {
    const outline = sample().outline();
    outline.theme.colors.accent = "red;background:url(//evil.example/x)";
    expect(() => renderDeck(outline)).toThrow(SlidesError);
    const faces = sample().outline();
    faces.theme.fontFaces = [{ family: "X", src: "https://evil.example/x.woff2", weight: 400, style: "normal" }];
    expect(() => renderDeck(faces)).toThrow(/REMOTE|relative/i);
  });

  test("an image that is not a blob reference is drawn as a placeholder, and the rest of the deck renders", () => {
    const outline = sample().outline();
    const image = outline.slides[1]!.elements.find((e) => e.kind === "image")!;
    for (const src of ["https://cdn.example.com/cat.png", "blob:../x", "blob:sha256-dead"]) {
      if (image.kind === "image") image.src = src;
      for (const html of [renderDeck(outline), renderPresent(outline)]) {
        expect(html).not.toMatch(/cdn\.example|<img/);
        expect(html).toContain(`aria-label="A cat (image unavailable)"`);
        expect(html).toContain("Intro");
        expect(html).toContain("<th");
      }
    }
  });

  test("an image the resolver cannot find is a placeholder for that element only", () => {
    const html = renderDeck(sample().outline(), { imageUrl: () => undefined });
    expect(html).toContain("(image unavailable)");
    expect(html).toContain("Table");
  });

  test("a box with a non-number position is drawn at zero, not injected", () => {
    const outline = sample().outline();
    (outline.slides[0]!.elements[0] as { x: unknown }).x = "0;background:url(//e.com)";
    expect(renderSlide(outline.slides[0]!, outline.theme)).not.toContain("e.com");
  });
});

describe("render output", () => {
  test("holds no network address and no external reference", () => {
    const theme = { ...DEFAULT_THEME, fontFaces: [{ family: "Inter", src: "fonts/inter.woff2", weight: 400, style: "normal" as const }] };
    const deck = Deck.create({ title: "Talk", author: human, theme });
    deck.addSlidesFromOutline(OUTLINE, { author: human, images });
    for (const html of [renderDeck(deck.outline()), renderPresent(deck.outline())]) {
      expect(html).not.toMatch(/https?:|\/\/[a-z]/i);
      expect(html).toContain("fonts/inter.woff2");
      expect(html).toContain(`src="blobs/${KEY}"`);
      expect(html).toContain("connect-src 'none'");
    }
  });

  test("the same deck renders to the same bytes, also after a sync round trip", () => {
    const deck = sample();
    const first = renderPresent(deck.outline());
    expect(renderPresent(deck.outline())).toBe(first);
    expect(renderPresent(Deck.fromUpdate(deck.encode()).outline())).toBe(first);
  });

  test("an image resolver can inline assets", () => {
    const html = renderDeck(sample().outline(), { imageUrl: () => "data:image/png;base64,AA==" });
    expect(html).toContain(`src="data:image/png;base64,AA=="`);
  });

  test("titles are headings, images have alt text, tables have header cells, machine work is marked", () => {
    const html = renderDeck(sample(agent).outline());
    expect(html).toContain("<h2");
    expect(html).toContain(`alt="A cat"`);
    expect(html).toContain(`<th scope="col"`);
    expect(html).toContain(`data-machine-made="true"`);
    expect(renderDeck(sample(human).outline())).toContain(`data-machine-made="false"`);
  });

  test("an empty deck renders a page, not an error", () => {
    const deck = Deck.create({ title: "Empty", author: human });
    expect(renderDeck(deck.outline())).toContain("<main");
    expect(new JSDOM(renderPresent(deck.outline()), { runScripts: "dangerously" }).window.document.getElementById("status")!.textContent).toBe("No slides");
  });
});

describe("present mode", () => {
  function open(hash = "") {
    const dom = new JSDOM(renderPresent(sample(agent).outline()), { runScripts: "dangerously", url: `http://localhost/${hash}` });
    const { document } = dom.window;
    const press = (key: string) => document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    const visible = () => [...document.querySelectorAll<HTMLElement>(".slide")].flatMap((s, i) => (s.hidden ? [] : [i + 1]));
    const status = () => document.getElementById("status")!.textContent;
    return { dom, document, press, visible, status };
  }

  test("starts on slide 1 and shows one slide at a time", () => {
    const { visible, status } = open();
    expect(visible()).toEqual([1]);
    expect(status()).toBe("1 / 3");
  });

  test("arrow keys move, stop at both ends, and Home and End jump", () => {
    const { press, visible } = open();
    press("ArrowLeft");
    expect(visible()).toEqual([1]);
    for (const key of ["ArrowRight", "PageDown", " ", "ArrowRight"]) press(key);
    expect(visible()).toEqual([3]);
    press("ArrowUp");
    expect(visible()).toEqual([2]);
    press("Home");
    expect(visible()).toEqual([1]);
    press("End");
    expect(visible()).toEqual([3]);
  });

  test("a hash opens a slide and a bad hash is clamped", () => {
    expect(open("#2").visible()).toEqual([2]);
    expect(open("#99").visible()).toEqual([3]);
    expect(open("#abc").visible()).toEqual([1]);
  });

  test("N opens the speaker notes of the current slide, N again closes them", () => {
    const { press, document } = open();
    const panel = document.getElementById("notes")!;
    expect(panel.hidden).toBe(true);
    press("n");
    expect(panel.hidden).toBe(false);
    expect(document.getElementById("notes-text")!.textContent).toBe("say hi");
    press("ArrowRight");
    expect(document.getElementById("notes-text")!.textContent).toBe("");
    press("N");
    expect(panel.hidden).toBe(true);
  });

  test("the origin of machine-made content is announced", () => {
    expect(open().document.getElementById("origin")!.textContent).toMatch(/agent/);
  });

  test("keys with Ctrl or Meta are left to the browser", () => {
    const { dom, document, visible } = open();
    document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowRight", ctrlKey: true }));
    expect(visible()).toEqual([1]);
  });
});

// Ways the present page can run attacker text, written before the fix: notes and
// the title go into the page, and the CSP has to stop a script that slips past escaping.
describe("present page safety", () => {
  const evil = `</div></div><script>alert(1)</script><img src=x onerror=alert(2)>`;
  const title = `"><script>alert(3)</script>`;
  const present = () => {
    const deck = Deck.create({ title, author: human });
    deck.addSlidesFromOutline(`# T\n> ${evil}`, { author: human });
    return renderPresent(deck.outline());
  };
  const csp = (html: string) => /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)![1]!;
  const directive = (html: string, name: string) => csp(html).split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `));

  test("speaker notes and the deck title are escaped in the present page", () => {
    const html = present();
    expect(html).not.toContain("<script>alert");
    const { document } = new JSDOM(html).window;
    expect(document.querySelectorAll("script")).toHaveLength(1);
    expect(document.querySelector("img[onerror]")).toBeNull();
    expect(document.querySelector('[data-notes-for="1"]')!.textContent).toBe(evil);
    expect(document.getElementById("stage")!.getAttribute("aria-label")).toBe(title);
    expect(document.title).toBe(title);
  });

  test("the deck page allows no script at all", () => {
    expect(directive(renderDeck(sample().outline()), "script-src")).toBe("script-src 'none'");
  });

  test("the present page allows only its own script, by hash", () => {
    const html = present();
    const inline = /<script>([\s\S]*)<\/script>/.exec(html)![1]!;
    const hash = createHash("sha256").update(inline).digest("base64");
    expect(directive(html, "script-src")).toBe(`script-src 'sha256-${hash}'`);
    expect(directive(html, "script-src")).not.toContain("unsafe-inline");
  });

  test("a theme from a peer without fontFaces renders, not a TypeError", () => {
    const outline = sample().outline();
    delete (outline.theme as { fontFaces?: unknown }).fontFaces;
    expect(renderDeck(outline)).toContain("<main");
    expect(renderPresent(outline)).toContain('id="stage"');
  });

  test("the deck page carries print rules for one slide per page", () => {
    const html = renderDeck(sample().outline());
    expect(html).toMatch(/@page\{size:1280px 720px;margin:0\}/);
    expect(html).toContain("break-after:page");
  });
});
