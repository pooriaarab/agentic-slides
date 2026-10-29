import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { extname } from "node:path";
import { checkView } from "./helpers.js";

// The host page is a fake origin. The test builds it from source and serves it, so the page cannot reach a slides server.
const ORIGIN = "http://host.test";
const TYPES: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".html": "text/html" };

test("a host page edits its own Yjs document with no request to a slides server, and passes axe in light and dark", async ({ page }) => {
  const built = await build({
    entryPoints: { main: "e2e/host/main.ts" },
    bundle: true,
    format: "esm",
    outdir: "/out",
    write: false,
    jsx: "automatic",
    loader: { ".woff2": "file" },
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
  });
  const files = new Map(built.outputFiles.map((f) => [f.path.replace(/^\/out/, ""), f.contents]));
  const requests: string[] = [];
  // Every request the page makes, to any origin, so a call to a slides server or a CDN cannot hide.
  const urls: string[] = [];
  page.on("request", (request) => urls.push(request.url()));
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    requests.push(path);
    if (path === "/") {
      return route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Host app</title><link rel="stylesheet" href="/main.css"></head><body><main><div id="slides"></div></main><script type="module" src="/main.js"></script></body></html>' });
    }
    const body = files.get(path);
    return body ? route.fulfill({ contentType: TYPES[extname(path)] ?? "application/octet-stream", body: Buffer.from(body) }) : route.fulfill({ status: 404 });
  });

  await page.goto(`${ORIGIN}/`);
  await expect(page.getByRole("heading", { name: "Host deck" })).toBeVisible();
  await page.getByRole("button", { name: /^Text box 1/ }).first().click();
  for (const scheme of ["light", "dark"] as const) await checkView(page, "host-editor", scheme);

  // An edit lands in the host document, and an outside edit shows with no poll.
  await page.getByRole("button", { name: "Add slide" }).click();
  await expect.poll(() => page.evaluate(() => (window as never as { hostDeck: { outline(): { slides: unknown[] } } }).hostDeck.outline().slides.length)).toBe(3);
  await page.evaluate(() => (window as never as { hostDeck: { addSlide(o: object, a: object): string } }).hostDeck.addSlide({}, { kind: "agent", name: "peer" }));
  await expect(page.locator(".sorter li")).toHaveCount(4);

  // Only the page and its own bundle loaded. No slides API call, no other origin.
  expect(urls.filter((u) => !u.startsWith(`${ORIGIN}/`) && !u.startsWith("data:"))).toEqual([]);
  expect(requests.filter((p) => p.startsWith("/api"))).toEqual([]);
  expect([...new Set(requests.map((p) => extname(p)))].every((e) => ["", ".js", ".css", ".woff2"].includes(e))).toBe(true);
});
