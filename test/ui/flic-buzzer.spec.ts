import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import type { BrowserContext, Page } from "playwright-core";
import { UA, openYouSection, useHangry } from "./harness.js";
import { skipWhatsNew } from "./whats-new-seen.js";

const hangry = useHangry();
const SHOTS = new URL("./screenshots/flic-buzzer/", import.meta.url);
const ORDER = ["shockwave", "slam", "flood", "bell"];

/** Alex (who owns the Flic link) and Bea share one circle. Fake names only. */
async function seed() {
  const alex = await hangry.call("POST", "/api/auth/start", undefined, { name: "Alex" });
  const circle = (await hangry.call("POST", "/api/circles", alex.token, { name: "Lunch" })).circle;
  const bea = await hangry.call("POST", "/api/auth/start", undefined, { name: "Bea", code: circle.inviteCode });
  return { alex, bea, link: `${hangry.baseUrl}/api/buzz/${alex.buzzToken}` };
}

async function phone(token: string, width = 390, height = 844): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const context = await hangry.browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: UA });
  await skipWhatsNew(context);
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
  await ready(page);
  return { context, page, errors };
}

async function ready(page: Page) {
  await page.locator("nav.tabbar").waitFor();
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
  await page.getByRole("button", { name: "Let friends know you're free now" }).waitFor();
}

const press = async (link: string) => assert.ok([200, 201].includes((await fetch(link, { method: "POST" })).status));

/** Waits for the overlay (the 3s poll finds the buzz) and returns its animation name. */
async function seeBuzz(page: Page): Promise<string> {
  const overlay = page.locator(".buzzer");
  await overlay.waitFor({ timeout: 6000 });
  return (await overlay.getAttribute("data-animation")) ?? "";
}

async function dismiss(page: Page) {
  await page.touchscreen.tap(195, 420);
  await page.locator(".buzzer").waitFor({ state: "detached", timeout: 2000 });
}

const socialCount = async (token: string) => (await hangry.call("GET", "/api/socials", token)).socials.length as number;

test("a Flic press shows the overlay to a friend, a tap clears it, and the Now tab still works", { timeout: 60_000 }, async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const { bea, link } = await seed();
  const { context, page, errors } = await phone(bea.token);
  try {
    await press(link);
    assert.equal(await seeBuzz(page), "shockwave");
    assert.equal(await page.locator(".buzzer .buzzer-sr").textContent(), "Alex is free now");
    await page.waitForTimeout(1100);
    await page.screenshot({ path: new URL("overlay.png", SHOTS).pathname });
    await dismiss(page);

    // Nothing is left behind: the orb takes a tap and opens its sheet.
    await page.getByRole("button", { name: "Let friends know you're free now" }).click();
    await page.locator("form.sheet").waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("four presses cycle shockwave, slam, flood, bell, then start over, across a reload", { timeout: 90_000 }, async () => {
  const { bea, link } = await seed();
  const { context, page, errors } = await phone(bea.token);
  try {
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) {
      if (i === 2) {
        await page.reload();
        await ready(page);
      }
      await press(link);
      seen.push(await seeBuzz(page));
      await dismiss(page);
    }
    assert.deepEqual(seen, [...ORDER, "shockwave"]);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("the in-app free now orb plays no overlay for anyone", { timeout: 60_000 }, async () => {
  const { alex, bea } = await seed();
  const friend = await phone(bea.token);
  const mine = await phone(alex.token);
  try {
    await mine.page.getByRole("button", { name: "Let friends know you're free now" }).click();
    await mine.page.getByRole("button", { name: "I'm free", exact: true }).click();
    await mine.page.locator("form.sheet").waitFor({ state: "detached" });
    assert.equal(await socialCount(bea.token), 1);
    // Two polls on each phone.
    await friend.page.waitForTimeout(7000);
    assert.equal(await friend.page.locator(".buzzer").count(), 0);
    assert.equal(await mine.page.locator(".buzzer").count(), 0);
    assert.deepEqual([...friend.errors, ...mine.errors], []);
  } finally {
    await friend.context.close();
    await mine.context.close();
  }
});

test("the presser's own open page plays the overlay for their own press", { timeout: 60_000 }, async () => {
  const { alex, link } = await seed();
  const { context, page, errors } = await phone(alex.token);
  try {
    await press(link);
    assert.equal(await seeBuzz(page), "shockwave");
    assert.equal(await page.locator(".buzzer .buzzer-sr").textContent(), "Alex is free now");
    await dismiss(page);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("Test buzzer plays locally, sends nothing, and shares the cycle", { timeout: 90_000 }, async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const { alex, bea } = await seed();
  for (const [width, height] of [[390, 844], [360, 640]] as const) {
    const { context, page, errors } = await phone(alex.token, width, height);
    try {
      await page.evaluate(() => localStorage.removeItem("fn_buzz_index"));
      await openYouSection(page, "Account");
      await page.getByRole("button", { name: "Set up a Flic button" }).click();
      const test = page.getByRole("button", { name: "Test buzzer", exact: true });
      await test.scrollIntoViewIfNeeded();
      await page.getByText("Plays the next buzzer animation here. Nothing is sent.", { exact: true }).waitFor();

      const box = await test.boundingBox();
      assert.ok(box && box.height >= 44, `tap target is ${box?.height}px`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 0, `horizontal overflow of ${overflow}px`);
      await page.screenshot({ path: new URL(`panel-${width}.png`, SHOTS).pathname, mask: [page.locator("pre.curl")] });

      assert.equal(await socialCount(alex.token), 0);
      const seen: string[] = [];
      for (let i = 0; i < 4; i++) {
        await test.scrollIntoViewIfNeeded();
        await test.click();
        seen.push(await seeBuzz(page));
        if (i === 0) {
          // A second click while one plays does nothing, and does not use up an animation.
          await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent === "Test buzzer")!.click());
          assert.equal(await page.locator(".buzzer").count(), 1);
          assert.equal(await page.evaluate(() => localStorage.getItem("fn_buzz_index")), "1");
          await page.waitForTimeout(1000);
          if (width === 390) await page.screenshot({ path: new URL("test-buzzer-overlay.png", SHOTS).pathname });
        }
        await dismiss(page);
      }
      assert.deepEqual(seen, ORDER);
      assert.equal(await socialCount(alex.token), 0);
      assert.equal(await socialCount(bea.token), 0);
      assert.equal(await page.locator("pre.curl").count(), 1, "the panel is still open");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
});
