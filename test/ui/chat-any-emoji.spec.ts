import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Locator, Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA, useHangry } from "./harness.js";
import { testEmail } from "../http.js";

// Fake people and messages only. Screenshots go to test/ui/screenshots (gitignored).
const shotsDir = path.resolve("test/ui/screenshots/chat-any-emoji");
const hangry = useHangry({ tz: "UTC" });

async function post(pathname: string, body: unknown, token?: string) {
  return hangry.call("POST", pathname, token, body);
}

async function longPress(page: Page, locator: Locator) {
  const box = await locator.boundingBox();
  assert.ok(box, "message is on screen");
  const point = { x: Math.round(box.x + 20), y: Math.round(box.y + box.height / 2) };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
  await page.waitForTimeout(600);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

const reactionPost = (page: Page) => page.waitForResponse((response) => response.url().includes("/reactions") && response.request().method() === "POST");

for (const [width, height] of SIZES) {
  test(`react with any emoji from the + picker at ${width}x${height}`, { timeout: 150_000 }, async () => {
    const alex = await post("/api/auth/start", { email: testEmail(), name: "Alex" });
    const { circle } = await post("/api/circles", { name: "Friends" }, alex.token);
    const bea = await post("/api/auth/start", { email: testEmail(), name: "Bea", code: circle.inviteCode });
    hangry.confirmEmails();
    const social = await post("/api/socials", { note: "Ramen" }, alex.token);
    await post(`/api/socials/${social.social.id}/reply`, { reply: "in" }, bea.token);
    await post(`/api/socials/${social.social.id}/chat`, { text: "Who is bringing the party hats?" }, bea.token);

    const context = await hangry.browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: UA });
    await skipWhatsNew(context);
    await context.addInitScript((value) => {
      localStorage.setItem("fn_token", value);
      localStorage.setItem("fn_install_later", String(Date.now()));
    }, alex.token);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // The picker must not reach for anything outside the app.
    const outside: string[] = [];
    page.on("request", (request) => { if (!request.url().startsWith(hangry.baseUrl)) outside.push(request.url()); });
    try {
      fs.mkdirSync(shotsDir, { recursive: true });
      const shot = async (name: string) => {
        await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().endTime !== Infinity).map((a) => a.finished.catch(() => null))));
        await page.screenshot({ path: path.join(shotsDir, `${name}-${width}x${height}.png`) });
      };
      await page.goto(hangry.baseUrl);
      await page.locator(".tabbar").waitFor();
      await page.locator("article", { has: page.locator("h3", { hasText: "Ramen" }) }).locator(".chat-row").click();
      await page.locator(".chat-screen").waitFor();

      const row = page.locator(".chat-msg", { hasText: "party hats" });
      await row.waitFor();
      // The picker code is not loaded until someone taps +.
      assert.equal(await page.evaluate(() => performance.getEntriesByType("resource").some((entry) => entry.name.includes("emoji-picker"))), false, "picker not loaded on first paint");
      // The chat slides in and scrolls to its end: press only once the row has stopped moving.
      await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => null))));
      await page.waitForTimeout(500);

      // The six quick ones, then a + at the end of that row, and nothing extra on the Reply/Copy row.
      await longPress(page, row.locator("p"));
      const bar = row.locator(".react-bar");
      await bar.waitFor();
      await page.waitForTimeout(750);
      const quick = bar.locator(".react-row > button");
      assert.deepEqual(await quick.evaluateAll((nodes) => nodes.map((node) => node.textContent)), ["👍", "❤️", "😂", "😮", "😢", "🔥", "+"]);
      assert.equal(await bar.locator(".react-actions .react-more").count(), 0, "+ is not on the Reply/Copy row");
      assert.equal(await bar.locator(".react-more").getAttribute("aria-label"), "More emoji");
      const barBox = (await bar.boundingBox())!;
      assert.ok(barBox.x >= 0 && barBox.x + barBox.width <= width, `the bar fits the screen: ${JSON.stringify(barBox)}`);
      await shot("bar");

      // Open the picker with +. It has a search box and category tabs, and it follows the OS scheme.
      await bar.getByRole("button", { name: "More emoji" }).tap();
      const picker = row.locator("emoji-picker");
      await picker.waitFor();
      const search = picker.locator("input.search");
      await search.waitFor();
      await picker.locator('button.emoji[role="menuitem"]').first().waitFor({ timeout: 20_000 });
      assert.ok((await picker.locator('button[role="tab"]').count()) >= 8, "category tabs");
      assert.equal(await bar.locator(".react-more").getAttribute("aria-expanded"), "true");
      const pickerBox = (await picker.boundingBox())!;
      assert.ok(pickerBox.x >= 0 && pickerBox.x + pickerBox.width <= width + 0.5, `the picker fits the screen: ${JSON.stringify(pickerBox)}`);
      const background = await picker.evaluate((node) => getComputedStyle(node.shadowRoot!.querySelector(".picker")!).backgroundColor);
      // The context has no colour scheme set, so Playwright gives it a light OS: the picker takes our light surface.
      assert.equal(background, "rgb(242, 242, 247)", "light picker on a light OS");
      assert.equal(await page.evaluate(() => document.querySelector(".chat-log")!.scrollWidth <= document.querySelector(".chat-log")!.clientWidth), true, "no sideways scroll");
      await shot("picker");

      // Search for a non-quick emoji and pick it.
      await search.tap();
      await search.pressSequentially("party popper");
      await picker.locator('button.emoji[aria-label*="party popper"]').first().waitFor({ timeout: 10_000 });
      await shot("picker-search");
      const added = reactionPost(page);
      await picker.locator('button.emoji[aria-label*="party popper"]').first().tap();
      const response = await added;
      assert.equal(response.status(), 200);
      assert.deepEqual(response.request().postDataJSON(), { emoji: "🎉", on: true });
      assert.deepEqual((await response.json()).reactions, [{ emoji: "🎉", count: 1, mine: true, names: ["Alex"] }]);
      await bar.waitFor({ state: "detached" });
      await picker.waitFor({ state: "detached" });
      const pill = row.locator('.react-pill[data-emoji="🎉"]');
      await pill.waitFor();
      assert.equal(await pill.locator(".react-emoji").textContent(), "🎉");
      assert.equal(await pill.locator(".react-count").textContent(), "1");
      assert.equal(await pill.getAttribute("aria-pressed"), "true");
      assert.match((await pill.getAttribute("class")) || "", /\bmine\b/);
      assert.equal(await pill.getAttribute("title"), "Alex");
      await shot("pill");

      // A quick one still works and sorts before the custom one.
      await page.waitForTimeout(750);
      await longPress(page, row.locator("p"));
      await bar.waitFor();
      await page.waitForTimeout(750);
      const quickAdded = reactionPost(page);
      await bar.getByRole("button", { name: "React 🔥" }).tap();
      assert.equal((await quickAdded).status(), 200);
      await row.locator('.react-pill[data-emoji="🔥"]').waitFor();
      assert.deepEqual(await row.locator(".react-pill").evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.emoji)), ["🔥", "🎉"]);
      await shot("pills-sorted");

      // Pick from a category instead of searching: the bar shows the one already used as pressed in the quick row only.
      await page.waitForTimeout(750);
      await longPress(page, row.locator("p"));
      await bar.waitFor();
      await page.waitForTimeout(750);
      await bar.getByRole("button", { name: "More emoji" }).tap();
      await picker.waitFor();
      await picker.locator('button[role="tab"]').nth(1).tap();
      const grid = picker.locator('button.emoji[role="menuitem"]').first();
      await grid.waitFor();
      const second = reactionPost(page);
      await grid.tap();
      assert.equal((await second).status(), 200);
      await picker.waitFor({ state: "detached" });
      assert.equal(await row.locator(".react-pill").count(), 3, "a third reaction from a category");

      // Toggle the custom one off by tapping its pill.
      const off = reactionPost(page);
      await pill.tap();
      const done = await off;
      assert.equal(done.status(), 200);
      assert.equal(done.request().postDataJSON().on, false);
      await pill.waitFor({ state: "detached" });
      assert.equal(await row.locator(".react-pill").count(), 2);

      // Esc-less touch close: tapping + again closes the picker without reacting.
      await page.waitForTimeout(750);
      await longPress(page, row.locator("p"));
      await bar.waitFor();
      await page.waitForTimeout(750);
      await bar.getByRole("button", { name: "More emoji" }).tap();
      await picker.waitFor();
      await bar.getByRole("button", { name: "More emoji" }).tap();
      await picker.waitFor({ state: "detached" });
      assert.equal(await bar.count(), 1, "the bar stays");
      assert.equal(await row.locator(".react-pill").count(), 2, "closing the picker reacts with nothing");

      // Reply and Copy are still on the bar.
      assert.equal(await bar.getByRole("button", { name: "Copy" }).count(), 1);
      assert.equal(await bar.getByRole("button", { name: "Reply" }).count(), 1);

      assert.deepEqual(outside, [], "no request leaves the app");
      assert.deepEqual(errors, [], "no page errors");
    } finally {
      await context.close();
    }
  });
}
