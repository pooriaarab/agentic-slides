import { expect, test } from "@playwright/test";
import { AGENT } from "../playwright.config.js";
import { agentDeck, api, checkView, signIn } from "./helpers.js";

const SCHEMES = ["light", "dark"] as const;

// One test, because each view is checked in order on one empty Worker: the empty list comes before any deck exists.
test("every view passes axe WCAG 2.2 AA in light and dark, and a screenshot is kept", async ({ page, baseURL }) => {
  await page.goto("/");
  for (const scheme of SCHEMES) await checkView(page, "sign-in", scheme);

  await signIn(page);
  await expect(page.getByRole("heading", { name: "No decks yet" })).toBeVisible();
  for (const scheme of SCHEMES) await checkView(page, "decks-empty", scheme);

  const id = await agentDeck(baseURL, "Launch plan");
  await api(baseURL, "/decks", AGENT, { method: "POST", body: JSON.stringify({ title: "Empty deck", id: "empty" }) });
  await page.reload();
  await expect(page.getByRole("link", { name: "Launch plan" })).toBeVisible();
  for (const scheme of SCHEMES) await checkView(page, "decks", scheme);

  await page.goto(`/#/deck/${id}`);
  await expect(page.getByRole("button", { name: /^Text box 1/ })).toBeVisible();
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Text box 1/ }).click();
  for (const scheme of SCHEMES) await checkView(page, "editor", scheme);

  await page.goto("/#/deck/empty");
  await expect(page.getByRole("heading", { name: "This deck has no slides" })).toBeVisible();
  for (const scheme of SCHEMES) await checkView(page, "editor-empty", scheme);

  await page.goto("/#/deck/nosuchdeck");
  await expect(page.getByRole("heading", { name: "The deck did not load" })).toBeVisible();
  for (const scheme of SCHEMES) await checkView(page, "error", scheme);

  await page.goto(`/#/deck/${id}/present/1`);
  await expect(page.locator("main.present p[role=status]")).toContainText("Slide 1 of 2");
  for (const scheme of SCHEMES) await checkView(page, "present", scheme);
});
