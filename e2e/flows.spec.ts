import { expect, test, type Page } from "@playwright/test";
import { AGENT, VIEWER } from "../playwright.config.js";
import { agentDeck, createDeck, signIn } from "./helpers.js";

const textBox = (page: Page, n: number) => page.getByRole("button", { name: new RegExp(`^Text box ${n}`) });
const toast = (page: Page, title: string) => page.locator(".ad-toast__title", { hasText: title });

test("create a deck, add a slide, edit text, reload keeps it, and present with the arrow keys", async ({ page }) => {
  await signIn(page);
  await createDeck(page, "Quarterly review");
  await expect(page.getByRole("heading", { name: "This deck has no slides" })).toBeVisible();

  await page.getByRole("button", { name: "Add first slide" }).click();
  await expect(textBox(page, 1)).toBeVisible();
  await textBox(page, 1).click();
  await page.getByLabel("Text", { exact: true }).fill("Revenue is **up**");
  await page.getByRole("button", { name: "Save text" }).click();
  await expect(toast(page, "Text saved")).toBeVisible();

  await page.getByRole("button", { name: "Add slide", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Slide sorter" }).getByRole("button")).toHaveCount(2);

  await page.reload();
  const sorter = page.getByRole("navigation", { name: "Slide sorter" });
  await expect(sorter.getByRole("button")).toHaveCount(2);
  await expect(sorter.getByRole("button").first()).toContainText("Revenue is up");

  await page.getByRole("button", { name: "Present" }).click();
  const status = page.locator("main.present p[role=status]");
  await expect(status).toContainText("Slide 1 of 2");
  await page.keyboard.press("ArrowRight");
  await expect(status).toContainText("Slide 2 of 2");
  await page.keyboard.press("ArrowRight");
  await expect(status).toContainText("Slide 2 of 2");
  await page.keyboard.press("ArrowLeft");
  await expect(status).toContainText("Slide 1 of 2");
  await expect(page).toHaveURL(/present\/1$/);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Quarterly review" })).toBeVisible();
});

test("the keyboard moves an element, and the move is saved", async ({ page }) => {
  await signIn(page);
  await createDeck(page, "Keys");
  await page.getByRole("button", { name: "Add first slide" }).click();
  await textBox(page, 1).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("X", { exact: true })).toHaveValue("80");
  // The save waits until the keys stop, then one PATCH carries the last place.
  const saved = page.waitForResponse((r) => r.request().method() === "PATCH" && r.url().includes("/elements/") && r.request().postDataJSON()?.y === 61 && r.ok());
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Shift+ArrowDown");
  await expect(page.getByLabel("X", { exact: true })).toHaveValue("110");
  await expect(page.getByLabel("Y", { exact: true })).toHaveValue("61");
  await saved;
  await page.reload();
  await textBox(page, 1).click();
  await expect(page.getByLabel("X", { exact: true })).toHaveValue("110");
  await expect(page.getByLabel("Y", { exact: true })).toHaveValue("61");
});

test("a failed save keeps what the person typed", async ({ page }) => {
  await signIn(page);
  await createDeck(page, "Busy");
  await page.getByRole("button", { name: "Add first slide" }).click();
  await textBox(page, 1).click();
  await page.route("**/elements/*", (route) => route.fulfill({ status: 503, json: { error: { code: "STORE_BUSY", message: "another writer changed the deck. Try again" } } }));
  await page.getByLabel("Text", { exact: true }).fill("My unsaved words");
  await page.getByRole("button", { name: "Save text" }).click();
  await expect(toast(page, "The change was not saved")).toBeVisible();
  await expect(page.getByLabel("Text", { exact: true })).toHaveValue("My unsaved words");
  await page.getByLabel("X", { exact: true }).fill("");
  await expect(page.getByText("Type a whole number.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save position" })).toBeDisabled();
});

test("presence shows an agent in the room, and an agent edit has a mark", async ({ page, browser, baseURL }) => {
  const id = await agentDeck(baseURL, "Agent deck");
  await signIn(page);
  await page.goto(`/#/deck/${id}`);
  await expect(page.getByRole("heading", { name: "Agent deck" })).toBeVisible();
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  await expect(page.getByText("Agent edit").first()).toBeVisible();
  await expect(page.getByRole("button", { name: /^Text box 1.*, Agent edit$/ })).toBeVisible();
  // The canvas tag is drawn by CSS, so read its text from the style. A bad escape there once made it "gent edit".
  const tag = await page.locator(".slide-el.is-agent").first().evaluate((el) => getComputedStyle(el, "::after").content);
  expect(tag).toBe('"\u2699\u00a0Agent edit"');

  const other = await (await browser.newContext({ baseURL })).newPage();
  await signIn(other, AGENT);
  await other.goto(`/#/deck/${id}`);
  await expect(other.getByText("Live", { exact: true })).toBeVisible();
  await expect(page.locator(".head-meta")).toContainText(/1 agent/i);
  await other.context().close();
});

test("a viewer reads and cannot change", async ({ page, baseURL }) => {
  const id = await agentDeck(baseURL, "Read only");
  await signIn(page, VIEWER);
  await expect(page.getByLabel("New deck title")).toHaveCount(0);
  await page.goto(`/#/deck/${id}`);
  await expect(page.getByRole("button", { name: "Add slide", exact: true })).toBeDisabled();
  await expect(page.getByText("This token can read decks. It cannot change them.")).toBeVisible();
});

test("a wrong token and a missing deck show errors", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Access token").fill("not-a-real-token-0123456789-abcdefghij");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toContainText("Send a valid bearer token.");
  await signIn(page, AGENT);
  await page.goto("/#/deck/nosuchdeck");
  await expect(page.getByRole("heading", { name: "The deck did not load" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});

