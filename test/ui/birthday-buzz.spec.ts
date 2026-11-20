import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "@playwright/test";
import type { BrowserContext, Page } from "playwright-core";
import { UA, useHangry } from "./harness.js";
import { skipWhatsNew } from "./whats-new-seen.js";
import { testEmail } from "../http.js";

const ADMIN = "a".repeat(32);
const hangry = useHangry({ env: { ADMIN_TOKEN: ADMIN } });
const SHOTS = new URL("./screenshots/birthday-buzz/", import.meta.url);
const ROTATION = ["shockwave", "slam", "flood", "bell"];

/** Mia (flagged), Noa (receiver) and Cy (normal) share one circle. Fake names only. */
async function seed() {
  const mia = await hangry.call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Mia" });
  const circle = (await hangry.call("POST", "/api/circles", mia.token, { name: "Lunch" })).circle;
  const noa = await hangry.call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Noa", code: circle.inviteCode });
  const cy = await hangry.call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Cy", code: circle.inviteCode });
  await hangry.call("POST", `/api/admin/users/${mia.user.id}/buzz-animation`, ADMIN, { buzzAnimation: "birthday" });
  const link = (who: { buzzToken: string }) => `${hangry.baseUrl}/api/buzz/${who.buzzToken}`;
  return { mia, noa, cy, miaLink: link(mia), cyLink: link(cy) };
}

async function phone(token: string, reducedMotion?: "reduce", size = { width: 390, height: 844 }): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const context = await hangry.browser.newContext({
    viewport: size,
    isMobile: true,
    hasTouch: true,
    userAgent: UA,
    ...(reducedMotion ? { reducedMotion } : {}),
  });
  await skipWhatsNew(context);
  await context.addInitScript(`
    window.__buzzFrames = 0;
    (function () {
      var raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = function (cb) {
        if (String(cb).indexOf("clearRect") >= 0) window.__buzzFrames += 1;
        return raf(cb);
      };
    })();
  `);
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
  return { context, page, errors };
}

const press = async (link: string) => assert.ok([200, 201].includes((await fetch(link, { method: "POST" })).status));
const frames = (page: Page) => page.evaluate("window.__buzzFrames") as Promise<number>;
const rotationIndex = (page: Page) => page.evaluate(() => localStorage.getItem("fn_buzz_index"));

/** Waits for the overlay (the 3s poll finds the buzz) and returns its animation name. */
async function seeBuzz(page: Page): Promise<string> {
  const overlay = page.locator(".buzzer");
  await overlay.waitFor({ timeout: 6000 });
  return (await overlay.getAttribute("data-animation")) ?? "";
}

async function paintedShare(page: Page) {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(".buzzer canvas")!;
    const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) count += 1;
    return count / (canvas.width * canvas.height);
  });
}

test("a flagged press plays the birthday overlay for a member, ends by itself and skips the rotation", { timeout: 90_000 }, async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const { noa, miaLink, cyLink } = await seed();
  const { context, page, errors } = await phone(noa.token);
  try {
    await press(miaLink);
    assert.equal(await seeBuzz(page), "birthday");
    assert.equal(await page.locator(".buzzer .buzzer-sr").textContent(), "Happy birthday Mia");
    assert.equal(await page.locator(".buzzer canvas").count(), 1);
    await page.waitForTimeout(1300);
    assert.ok((await paintedShare(page)) > 0.2, "the birthday scene is painted");
    await page.screenshot({ path: new URL("birthday-390.png", SHOTS).pathname });
    // Finite: it removes itself and stops asking for frames.
    await page.locator(".buzzer").waitFor({ state: "detached", timeout: 4000 });
    const before = await frames(page);
    assert.ok(before > 30, `ran ${before} frames`);
    await page.waitForTimeout(300);
    assert.equal(await frames(page), before, "no frames after the end");
    assert.equal(await rotationIndex(page), null, "a birthday buzz uses no rotation slot");

    // A normal user's buzz still plays one of the four rotating animations, starting at the first.
    await press(cyLink);
    const normal = await seeBuzz(page);
    assert.ok(ROTATION.includes(normal), normal);
    assert.equal(normal, "shockwave");
    assert.equal(await page.locator(".buzzer .buzzer-sr").textContent(), "Cy is free now");
    await page.touchscreen.tap(195, 420);
    await page.locator(".buzzer").waitFor({ state: "detached", timeout: 2000 });
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("a birthday buzz between normal ones leaves the rotation order alone", { timeout: 90_000 }, async () => {
  const { noa, miaLink, cyLink } = await seed();
  const { context, page, errors } = await phone(noa.token);
  try {
    const seen: string[] = [];
    for (const link of [cyLink, miaLink, cyLink]) {
      await press(link);
      seen.push(await seeBuzz(page));
      await page.touchscreen.tap(195, 420);
      await page.locator(".buzzer").waitFor({ state: "detached", timeout: 2000 });
    }
    assert.deepEqual(seen, ["shockwave", "birthday", "slam"]);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("reduced motion shows the still birthday overlay with the name as text, and it ends", { timeout: 60_000 }, async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const { noa, miaLink } = await seed();
  const { context, page, errors } = await phone(noa.token, "reduce");
  try {
    await press(miaLink);
    assert.equal(await seeBuzz(page), "birthday");
    const overlay = page.locator(".buzzer.reduced");
    await overlay.waitFor();
    assert.equal(await overlay.locator("canvas").count(), 0);
    await page.waitForTimeout(900);
    assert.equal(await overlay.locator(".buzzer-name").textContent(), "Happy birthday Mia");
    assert.equal(await overlay.locator(".buzzer-sr").textContent(), "Happy birthday Mia");
    assert.equal(await overlay.evaluate((el) => Number(getComputedStyle(el).opacity)), 1);
    await page.screenshot({ path: new URL("birthday-reduced.png", SHOTS).pathname });
    await page.locator(".buzzer").waitFor({ state: "detached", timeout: 3000 });
    assert.equal(await frames(page), 0);
    assert.equal(await rotationIndex(page), null);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("a long name fits on a small screen and the HTML in it stays text", { timeout: 60_000 }, async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const { context, page, errors } = await phone((await seed()).noa.token, undefined, { width: 320, height: 568 });
  try {
    const started = await page.evaluate(`(async () => {
      const m = await import("/js/buzzer.js");
      return m.playBuzzer({ name: "<b>Bartholomew Maximilian Featherstonehaugh</b>", animation: "birthday" });
    })()`);
    assert.equal(started, true);
    await page.waitForTimeout(1300);
    assert.equal(await page.locator(".buzzer-sr").textContent(), "Happy birthday <b>Bartholomew Maximilia");
    assert.equal(await page.locator(".buzzer b").count(), 0, "the name is canvas text, not HTML");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 0, true);
    await page.screenshot({ path: new URL("birthday-long-320.png", SHOTS).pathname });
    await page.keyboard.press("Escape");
    await page.locator(".buzzer").waitFor({ state: "detached", timeout: 2000 });
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});
