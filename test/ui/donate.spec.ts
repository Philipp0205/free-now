import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA, openYouSection, useHangry } from "./harness.js";
import { testEmail } from "../http.js";
/** Screenshots land in test/ui/screenshots/donate/ (git-ignored). */
const SHOT_DIR = path.resolve("test/ui/screenshots/donate");
const PAYPAL = "https://www.paypal.me/philippkurrle1";

const hangry = useHangry();
const { call } = hangry;

let people = 0;
/** A fake person with a circle, made through the real API. */
async function person(): Promise<string> {
  people += 1;
  const me = await call("POST", "/api/auth/start", undefined, { email: testEmail(), name: `Fake Cleo ${people}` });
  await call("POST", "/api/circles", me.token, { name: "Fake circle" });
  return me.token as string;
}

async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOT_DIR, name) });
}

for (const [width, height] of [...SIZES, [1280, 800] as const]) {
  test(`at ${width}: the tip button lives in You > Account, opens a quiet sheet and only links out`, { timeout: 60_000 }, async () => {
    const token = await person();
    const mobile = width < 600;
    const context = await hangry.browser.newContext({
      viewport: { width, height },
      isMobile: mobile,
      hasTouch: mobile,
      userAgent: UA,
    });
    await skipWhatsNew(context);
    await context.addInitScript((value) => {
      localStorage.setItem("fn_token", value);
      localStorage.setItem("fn_install_later", String(Date.now()));
    }, token);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(hangry.baseUrl);
    await page.locator("nav.tabbar").waitFor();

    // Not on the home screen, and nothing opens by itself.
    assert.equal(await page.getByRole("button", { name: "Donate", exact: true }).count(), 0, "no donate button on Now");
    assert.equal(await page.locator(".ak-sheet").count(), 0, "no sheet opens by itself");

    await openYouSection(page, "Account");
    const button = page.getByRole("button", { name: "Donate", exact: true });
    await button.waitFor();
    const hit = await button.boundingBox();
    assert.ok(hit && hit.height >= 44 && hit.x >= 0 && hit.x + hit.width <= width + 0.5, "the button is easy to tap and on screen");
    assert.equal(await page.locator(".ak-sheet").count(), 0, "the sheet is closed until the button is tapped");
    await shot(page, `account-w${width}.png`);

    await button.click();
    const sheet = page.locator(".ak-sheet");
    await sheet.waitFor();
    // The kit slides the sheet up in 220ms; measure the PayPal link only once it has landed.
    await sheet.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
    assert.match(await sheet.innerText(), /Hangry is free/);
    assert.match(await sheet.innerText(), /optional/i);
    assert.equal(await sheet.locator(".ak-chip").count(), 0, "no suggested amounts");
    const link = sheet.getByRole("link", { name: "Donate with PayPal" });
    assert.equal(await link.getAttribute("href"), PAYPAL);
    assert.equal(await link.getAttribute("target"), "_blank");
    assert.match((await link.getAttribute("rel")) ?? "", /noopener/);
    // Fake data only, and the link is never followed from a test run.
    const box = await link.boundingBox();
    assert.ok(box && box.y + box.height <= height + 0.5 && box.height >= 44, "the PayPal link is on screen and easy to tap");
    await shot(page, `sheet-w${width}.png`);

    await page.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
    assert.equal(page.url().startsWith(hangry.baseUrl), true, "still in the app");
    assert.deepEqual(errors, []);
    await context.close();
  });
}
