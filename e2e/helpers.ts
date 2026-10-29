import { writeFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { AGENT, HUMAN } from "../playwright.config.js";

export const api = (base: string | undefined, path: string, token: string, init: RequestInit = {}) =>
  fetch(`${base}/api/v1/slides${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers } });

/** Fails with the status and the body, so a setup call that breaks shows its own cause. */
export async function ok(call: Promise<Response>): Promise<Response> {
  const response = await call;
  if (!response.ok) throw new Error(`setup call failed: ${response.status} ${await response.text()}`);
  return response;
}

export async function signIn(page: Page, token = HUMAN) {
  await page.goto("/");
  await page.getByLabel("Access token").fill(token);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Decks", exact: true })).toBeVisible();
}

export async function createDeck(page: Page, title: string): Promise<string> {
  await page.getByLabel("New deck title").fill(title);
  await page.getByRole("button", { name: "Create deck" }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  return page.url().split("/deck/")[1]!;
}

/** A deck that an agent made, with two slides, so the page shows an agent mark. */
export async function agentDeck(base: string | undefined, title: string): Promise<string> {
  const made = (await (await ok(api(base, "/decks", AGENT, { method: "POST", body: JSON.stringify({ title }) }))).json()) as { id: string };
  const outline = "# Welcome\n- First point\n- Second point\n> Say hello\n---\nlayout: title\n# Thank you\n";
  await ok(api(base, `/decks/${made.id}/slides`, AGENT, { method: "POST", body: JSON.stringify({ outline }) }));
  return made.id;
}

export const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/** Fails on any WCAG 2.2 AA violation that axe can find, and, when UPDATE_SCREENSHOTS=1, keeps a screenshot as a review artifact. */
export async function checkView(page: Page, name: string, scheme: "light" | "dark") {
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
  // Wait until the page has taken the scheme and painted, so axe never reads colors half way through a change.
  await page.waitForFunction((dark) => matchMedia("(prefers-color-scheme: dark)").matches === dark, scheme === "dark");
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  // The images change a little from run to run, so only `npm run e2e:screenshots` writes them.
  if (process.env.UPDATE_SCREENSHOTS === "1") writeFileSync(`docs/screenshots/${name}-${scheme}.png`, await page.screenshot());
}
