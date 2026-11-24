import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "@playwright/test";
import type { BrowserContext, Page } from "playwright-core";
import { UA, useHangry } from "./harness.js";
import { skipWhatsNew } from "./whats-new-seen.js";
import { testEmail } from "../http.js";

const hangry = useHangry();
const SHOTS = new URL("./screenshots/flic-press/", import.meta.url);

/** Alex (owns the Flic link) and Bea share one circle. Fake names only. */
async function seed() {
  const alex = await hangry.call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Alex" });
  const circle = (await hangry.call("POST", "/api/circles", alex.token, { name: "Lunch" })).circle;
  const bea = await hangry.call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Bea", code: circle.inviteCode });
  return { alex, bea };
}

/** Counts every media play(), so the lizard clip is observable without sound. */
const SPY = `
  window.__plays = [];
  HTMLMediaElement.prototype.play = function () {
    window.__plays.push(this.currentSrc || this.src);
    return Promise.resolve();
  };
`;

async function phone(token: string): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const context = await hangry.browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: UA });
  await skipWhatsNew(context);
  await context.addInitScript(SPY);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.stack || String(error)));
  await page.goto(`${hangry.baseUrl}/robots.txt`);
  await page.evaluate((value) => {
    localStorage.clear();
    localStorage.setItem("fn_token", value);
    localStorage.setItem("fn_installed", "1");
    localStorage.setItem("fn_install_later", String(Date.now()));
  }, token);
  await page.goto(hangry.baseUrl);
  await page.locator("nav.tabbar").waitFor();
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
  await page.getByRole("button", { name: "Let friends know you're free now" }).waitFor();
  // The first gesture unlocks the shared clip with a play() of its own. Do it now, then count only real buzzes.
  await page.evaluate(() => document.dispatchEvent(new Event("click")));
  await page.evaluate("window.__plays = []");
  return { context, page, errors };
}

const plays = (page: Page) => page.evaluate("window.__plays") as Promise<string[]>;
const bell = (page: Page) => page.locator('.screen-head button.icon-btn[aria-label^="Alerts"]');

async function dismiss(page: Page) {
  await page.locator(".buzzer").waitFor({ timeout: 6000 });
  await page.touchscreen.tap(195, 420);
  await page.locator(".buzzer").waitFor({ state: "detached", timeout: 2000 });
}

test("a Flic press with location headers plays the lizard for both phones, notifies Bea and shows the place on the card", { timeout: 90_000 }, async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const { alex, bea } = await seed();
  const mine = await phone(alex.token);
  const friend = await phone(bea.token);
  try {
    const sent = await fetch(`${hangry.baseUrl}/api/buzz/${alex.buzzToken}`, {
      method: "POST",
      headers: { "button-name": "Desk", latitude: "52.5204", longitude: "13.4051" },
    });
    assert.equal(sent.status, 201);
    for (const { page } of [mine, friend]) {
      await page.locator(".buzzer").waitFor({ timeout: 6000 });
      await page.waitForTimeout(400);
      const heard = await plays(page);
      assert.equal(heard.length, 1);
      assert.ok(heard[0].endsWith("/sounds/lizard.m4a"), heard[0]);
    }
    await dismiss(mine.page);
    await dismiss(friend.page);

    const place = friend.page.locator("button.place-line");
    await place.first().waitFor({ timeout: 6000 });
    assert.match((await place.first().getAttribute("aria-label")) ?? "", /on the map/);
    await friend.page.screenshot({ path: new URL("card-390.png", SHOTS).pathname });

    await bell(friend.page).click();
    const note = friend.page.locator(".alert-card", { hasText: "Alex pressed the button" });
    await note.first().waitFor({ timeout: 6000 });
    assert.equal(await note.first().locator("h3").textContent(), "Buzz");
    await friend.page.screenshot({ path: new URL("alerts-bea-390.png", SHOTS).pathname });

    await bell(mine.page).click();
    await mine.page.locator(".alert-card", { hasText: "Your button press went out to" }).first().waitFor({ timeout: 6000 });
    await mine.page.screenshot({ path: new URL("alerts-alex-390.png", SHOTS).pathname });
    assert.deepEqual([...mine.errors, ...friend.errors], []);
  } finally {
    await mine.context.close();
    await friend.context.close();
  }
});
