import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "@playwright/test";
import type { BrowserContext, Page } from "playwright-core";
import { UA, openYouSection, useHangry } from "./harness.js";
import { skipWhatsNew } from "./whats-new-seen.js";
import { testEmail } from "../http.js";

const hangry = useHangry();
const SHOTS = new URL("./screenshots/lizard-sound/", import.meta.url);

/** Alex (owns the Flic link) and Bea share one circle. Fake names only. */
async function seed() {
  const alex = await hangry.call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Alex" });
  const circle = (await hangry.call("POST", "/api/circles", alex.token, { name: "Lunch" })).circle;
  const bea = await hangry.call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Bea", code: circle.inviteCode });
  return { alex, bea, link: `${hangry.baseUrl}/api/buzz/${alex.buzzToken}` };
}

/** Records every media play() (the sources it was asked for), and can make play() reject like iOS without a gesture. */
const SPY = (blocked: boolean) => `
  window.__plays = [];
  HTMLMediaElement.prototype.play = function () {
    window.__plays.push(this.currentSrc || this.src);
    return ${blocked ? 'Promise.reject(new DOMException("blocked", "NotAllowedError"))' : "Promise.resolve()"};
  };
`;

async function phone(token: string, blocked = false): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const context = await hangry.browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: UA });
  await skipWhatsNew(context);
  await context.addInitScript(SPY(blocked));
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

const press = async (link: string) => assert.ok([200, 201].includes((await fetch(link, { method: "POST" })).status));
const plays = (page: Page) => page.evaluate("window.__plays") as Promise<string[]>;

async function dismiss(page: Page) {
  await page.touchscreen.tap(195, 420);
  await page.locator(".buzzer").waitFor({ state: "detached", timeout: 2000 });
}

test("a buzz from another member plays the lizard clip with the overlay, and the file is served as audio", { timeout: 60_000 }, async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const { bea, link } = await seed();
  const { context, page, errors } = await phone(bea.token);
  try {
    assert.deepEqual(await plays(page), []);
    await press(link);
    await page.locator(".buzzer").waitFor({ timeout: 6000 });
    assert.equal(await page.locator(".buzzer .buzzer-sr").textContent(), "Alex is free now");
    const heard = await plays(page);
    assert.equal(heard.length, 1);
    assert.ok(heard[0].endsWith("/sounds/lizard.m4a"), heard[0]);
    await page.waitForTimeout(1100);
    await page.screenshot({ path: new URL("received-390.png", SHOTS).pathname });
    const file = await page.request.get(`${hangry.baseUrl}/sounds/lizard.m4a`);
    assert.equal(file.status(), 200);
    assert.equal(file.headers()["content-type"], "audio/mp4");
    assert.ok((await file.body()).length < 256 * 1024);
    await page.locator(".buzzer").waitFor({ state: "detached", timeout: 4000 });
    assert.equal((await plays(page)).length, 1, "one clip for one buzz");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("the presser's own open page shows the overlay for their own press and plays no sound", { timeout: 60_000 }, async () => {
  const { alex, link } = await seed();
  const { context, page, errors } = await phone(alex.token);
  try {
    await press(link);
    await page.locator(".buzzer").waitFor({ timeout: 6000 });
    assert.equal(await page.locator(".buzzer .buzzer-sr").textContent(), "Alex is free now");
    await page.waitForTimeout(500);
    assert.deepEqual(await plays(page), []);
    await dismiss(page);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("Test buzzer plays the lizard clip and keeps the signed-in name on the overlay", { timeout: 60_000 }, async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const { alex } = await seed();
  const { context, page, errors } = await phone(alex.token);
  try {
    await openYouSection(page, "Account");
    await page.getByRole("button", { name: "Set up a Flic button" }).click();
    const test = page.getByRole("button", { name: "Test buzzer", exact: true });
    await test.scrollIntoViewIfNeeded();
    await test.click();
    await page.locator(".buzzer").waitFor();
    assert.equal(await page.locator(".buzzer .buzzer-sr").textContent(), "Alex is free now");
    const heard = await plays(page);
    assert.equal(heard.length, 1);
    assert.ok(heard[0].endsWith("/sounds/lizard.m4a"), heard[0]);
    await page.waitForTimeout(1000);
    await page.screenshot({ path: new URL("test-buzzer-390.png", SHOTS).pathname, mask: [page.locator("pre.curl")] });
    await dismiss(page);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("a blocked play() breaks nothing: no page error and the overlay still shows and ends", { timeout: 60_000 }, async () => {
  const { bea, link } = await seed();
  const { context, page, errors } = await phone(bea.token, true);
  try {
    await press(link);
    await page.locator(".buzzer").waitFor({ timeout: 6000 });
    assert.equal(await page.locator(".buzzer .buzzer-sr").textContent(), "Alex is free now");
    assert.equal((await plays(page)).length, 1, "play() was tried");
    await page.waitForTimeout(300);
    await page.locator(".buzzer").waitFor({ state: "detached", timeout: 5000 });
    assert.equal(await page.locator("text=/blocked|NotAllowed/i").count(), 0, "no toast about the sound");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});
