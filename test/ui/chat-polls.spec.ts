import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA as CHROME_UA, useHangry, waitForEventChat } from "./harness.js";
import { testEmail } from "../http.js";
// Fake people and polls only. Screenshots go to test/ui/screenshots (gitignored).
const shotsDir = path.resolve("test/ui/screenshots/chat-polls");
const hangry = useHangry({ tz: "UTC" });
const DESKTOP_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

type Layout = { name: string; width: number; height: number; touch: boolean };
const LAYOUTS: Layout[] = [
  ...SIZES.map(([width, height]) => ({ name: `${width}`, width, height, touch: true })),
  { name: "desktop", width: 1280, height: 800, touch: false },
];

for (const layout of LAYOUTS) {
  test(`post a poll, vote, change a vote and see the others vote at ${layout.name}`, { timeout: 150_000 }, async () => {
    const alex = await post("/api/auth/start", { email: testEmail(), name: "Alex" });
    const circle = await post("/api/circles", { name: "Testers" }, alex.token);
    const ada = await post("/api/auth/start", { email: testEmail(), name: "Ada", code: circle.circle.inviteCode });
    const social = (await post("/api/socials", { note: "Dinner" }, alex.token)).social;
    await post(`/api/socials/${social.id}/reply`, { reply: "in" }, ada.token);
    fs.mkdirSync(shotsDir, { recursive: true });
    const shot = (page: Page, name: string) => page.screenshot({ path: path.join(shotsDir, `${name}-${layout.name}.png`) });

    const page = await openEventChat(alex.token, social.id, layout);
    try {
      await postPoll(page, layout, shot);
      const poll = page.locator(".chat-poll");
      const options = poll.locator(".chat-poll-option");
      assert.equal(await options.count(), 3);
      assert.equal(await poll.locator(".chat-poll-question").textContent(), "Where to eat?");
      await options.nth(0).getByRole("button").click();
      await options.nth(0).locator(".chat-poll-who", { hasText: "Alex" }).waitFor();
      assert.equal(await options.nth(0).getByRole("button").getAttribute("aria-pressed"), "true");
      assert.equal(await options.nth(1).getByRole("button").getAttribute("aria-pressed"), "false");
      await shot(page, "voted");

      // Ada votes for the same and then changes; Alex sees both through the API-backed thread.
      const messageId = await poll.locator("xpath=ancestor::*[@data-id][1]").getAttribute("data-id");
      assert.ok(messageId);
      await post(`/api/messages/${messageId}/vote`, { choice: 0 }, ada.token);
      await post(`/api/messages/${messageId}/vote`, { choice: 2 }, ada.token);
      await page.goto(`${hangry.baseUrl}/?chat=social:${social.id}`);
      await dismissLater(page);
      await waitForEventChat(page, "Dinner");
      await page.locator(".chat-poll").waitFor();
      const after = page.locator(".chat-poll .chat-poll-option");
      assert.equal((await after.nth(0).locator(".chat-poll-count").textContent())?.trim(), "1");
      assert.equal((await after.nth(2).locator(".chat-poll-count").textContent())?.trim(), "1");
      assert.equal((await after.nth(2).locator(".chat-poll-who").textContent())?.trim(), "Ada");
      assert.equal(await after.nth(0).locator(".chat-poll-who").textContent(), "Alex");
      await shot(page, "counts-and-names");

      // Alex moves their own vote.
      await after.nth(1).getByRole("button").click();
      await after.nth(1).locator(".chat-poll-who", { hasText: "Alex" }).waitFor();
      assert.equal((await after.nth(0).locator(".chat-poll-count").textContent())?.trim(), "0");
      assert.equal(await after.nth(0).locator(".chat-poll-who").count(), 0);
    } finally {
      await page.context().close();
    }
  });
}

test("the circle chat has no poll button and an event chat does", async () => {
  const alex = await post("/api/auth/start", { email: testEmail(), name: "Alex" });
  await post("/api/circles", { name: "Testers" }, alex.token);
  const social = (await post("/api/socials", { note: "Dinner" }, alex.token)).social;
  const layout = LAYOUTS[1];
  const event = await openEventChat(alex.token, social.id, layout);
  try {
    assert.equal(await event.getByRole("button", { name: "Start a poll" }).count(), 1);
  } finally {
    await event.context().close();
  }
  const context = await hangry.browser.newContext({ viewport: { width: layout.width, height: layout.height }, userAgent: CHROME_UA });
  await skipWhatsNew(context);
  await context.addInitScript((value) => localStorage.setItem("fn_token", value), alex.token);
  const page = await context.newPage();
  try {
    await page.goto(`${hangry.baseUrl}/?chat=circle`);
    await dismissLater(page);
    await page.locator("#chat-input").waitFor();
    assert.equal(await page.getByRole("button", { name: "Start a poll" }).count(), 0);
  } finally {
    await context.close();
  }
});

/** Opens the poll sheet, checks Post is held back until the poll is valid, then posts "Where to eat?". */
async function postPoll(page: Page, layout: Layout, shot: (page: Page, name: string) => Promise<unknown>) {
  await page.getByRole("button", { name: "Start a poll" }).click();
  const sheet = page.getByRole("dialog", { name: "New poll" });
  await sheet.waitFor();
  const post = sheet.getByRole("button", { name: "Post poll" });
  assert.ok(await post.isDisabled(), "empty poll cannot be posted");
  await sheet.getByLabel("Question").fill("Where to eat?");
  await sheet.getByRole("textbox", { name: "Option 1", exact: true }).fill("Ramen");
  assert.ok(await post.isDisabled(), "one option is not enough");
  await sheet.getByRole("textbox", { name: "Option 2", exact: true }).fill("Tacos");
  assert.ok(await post.isEnabled());
  await sheet.getByRole("button", { name: "Add option" }).click();
  await sheet.getByRole("textbox", { name: "Option 3", exact: true }).fill("Pizza");
  const box = await sheet.boundingBox();
  const view = page.viewportSize()!;
  assert.ok(box && box.y >= 0 && box.y + box.height <= view.height + 1, "the sheet fits the screen");
  await shot(page, "sheet");
  await post.click();
  await sheet.waitFor({ state: "detached" });
  await page.locator(".chat-poll").waitFor();
  assert.equal(await page.locator(".chat-poll-option").count(), 3);
  await shot(page, "posted");
}

async function openEventChat(token: string, socialId: string, layout: Layout): Promise<Page> {
  const context = await hangry.browser.newContext({
    viewport: { width: layout.width, height: layout.height },
    isMobile: layout.touch,
    hasTouch: layout.touch,
    userAgent: layout.touch ? CHROME_UA : DESKTOP_UA,
    colorScheme: "dark",
  });
  await skipWhatsNew(context);
  await context.addInitScript((value) => localStorage.setItem("fn_token", value), token);
  const page = await context.newPage();
  await page.goto(`${hangry.baseUrl}/?chat=social:${socialId}`);
  await dismissLater(page);
  await waitForEventChat(page, "Dinner");
  return page;
}

/** The install prompt sheet can cover the chat on a cold start; close it with Not now. */
async function dismissLater(page: Page) {
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
}

async function post(pathname: string, body: unknown, token?: string) {
  return hangry.call("POST", pathname, token, body);
}
