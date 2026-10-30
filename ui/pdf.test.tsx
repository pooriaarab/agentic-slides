import { PDFDocument } from "@cantoo/pdf-lib";
import { expect, test } from "vitest";
import { Deck } from "../src/index.js";
import * as ui from "./embed.js";

// Failure cases: the mount entry lacks the renderer, host edits are stale,
// missing image bytes give no warning, or export changes the host document.
test("the mount entry exports the current host deck as PDF bytes", async () => {
  expect(ui).toHaveProperty("renderPdf");
  const author = { kind: "human" as const, name: "Ada" };
  const deck = Deck.create({ title: "Host deck", author });
  const hostDeck = new Deck(deck.doc);
  deck.addSlidesFromOutline("# First", { author });
  deck.addSlidesFromOutline("# Second\n![Picture](picture.png)", {
    author,
    images: { "picture.png": `blob:sha256-${"a".repeat(64)}` },
  });
  const before = hostDeck.encode();
  const { bytes, warnings } = await ui.renderPdf(hostDeck.outline(), new Map());
  expect(bytes).toBeInstanceOf(Uint8Array);
  const pdf = await PDFDocument.load(bytes);
  expect(pdf.getTitle()).toBe("Host deck");
  expect(pdf.getPages().map((page) => page.getSize())).toEqual([
    { width: 1280, height: 720 },
    { width: 1280, height: 720 },
  ]);
  expect(warnings.join(" ")).toMatch(/unavailable.*placeholder/i);
  expect(hostDeck.encode()).toEqual(before);
  deck.doc.destroy();
});
