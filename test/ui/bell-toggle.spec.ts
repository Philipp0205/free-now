import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { Locator, Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA, useHangry } from "./harness.js";

/** Screenshots always land in .oc/shots/ (git-ignored); BELL_SHOT_DIR overrides. */
const SHOT_DIR = path.resolve(process.env.BELL_SHOT_DIR || ".oc/shots");
/** Set to a folder to record a webm per width, for example BELL_VIDEO_DIR=/tmp/bell-video. */
const VIDEO_DIR = process.env.BELL_VIDEO_DIR ? path.resolve(process.env.BELL_VIDEO_DIR) : "";

const hangry = useHangry();
const { call } = hangry;

async function phone(width: number, height: number, token: string) {
  const context = await hangry.browser.newContext({
    viewport: { width, height },
    isMobile: true,
    hasTouch: true,
    userAgent: UA,
    ...(VIDEO_DIR ? { recordVideo: { dir: VIDEO_DIR, size: { width, height } } } : {}),
  });
  await skipWhatsNew(context);
  await context.addInitScript((value) => {
    localStorage.setItem("fn_install_later", String(Date.now()));
    localStorage.setItem("fn_token", value);
  }, token);
  await context.route("https://*.tile.openstreetmap.org/**", (route) => route.fulfill({ status: 204, body: "" }));
  return context.newPage();
}

async function dismiss(page: Page) {
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
}

async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}-w${page.viewportSize()!.width}.png`) });
}

const bell = (page: Page) => page.locator('.screen-head button.icon-btn[aria-label^="Alerts"]');
const heading = (page: Page, text: string) => page.locator("h1.screen-title", { hasText: new RegExp(`^${text}$`) });
const tab = (page: Page, name: string) => page.locator("nav.tabbar").getByRole("button", { name, exact: true });

async function expectBell(button: Locator, open: boolean) {
  assert.equal(await button.getAttribute("aria-expanded"), open ? "true" : "false");
  const cls = (await button.getAttribute("class")) || "";
  assert.equal(cls.split(/\s+/).includes("on"), open, `bell class "${cls}"`);
  assert.match((await button.getAttribute("aria-label")) || "", /^Alerts(, \d+ unread)?$/);
}

for (const [width, height] of SIZES) {
  test(`at ${width}: the bell opens Alerts, a second tap closes it back to the previous tab, the tabbar still leaves Alerts`, { timeout: 120_000 }, async () => {
    const host = await call("POST", "/api/auth/start", undefined, { name: "Hana" });
    const { circle } = await call("POST", "/api/circles", host.token, { name: `Bell ${width}` });
    const friend = await call("POST", "/api/auth/start", undefined, { name: "Finn", code: circle.inviteCode });
    await call("POST", "/api/socials", friend.token, { note: `Coffee ${width}` });

    const page = await phone(width, height, host.token);
    try {
      await page.goto(hangry.baseUrl);
      await dismiss(page);
      await heading(page, "Now").waitFor();
      await expectBell(bell(page), false);
      assert.match((await bell(page).getAttribute("aria-label")) || "", /^Alerts, \d+ unread$/, "the free alert is unread");
      await shot(page, "bell-before");

      // 1. First tap opens Alerts.
      await bell(page).click();
      await heading(page, "Alerts").waitFor();
      await page.locator(".alert-card").first().waitFor();
      assert.ok((await page.locator(".alert-card").count()) >= 1);
      await expectBell(bell(page), true);
      await page.waitForFunction(() => document.querySelector(".screen-head .icon-btn.on")?.getAttribute("aria-label") === "Alerts");
      await shot(page, "bell-open");

      // 2. Second tap closes Alerts and brings back Now.
      await bell(page).click();
      await heading(page, "Now").waitFor();
      assert.equal(await heading(page, "Alerts").count(), 0);
      assert.equal(await page.locator(".alert-card").count(), 0);
      await expectBell(bell(page), false);
      assert.equal(await tab(page, "Now").getAttribute("aria-current"), "page");
      await shot(page, "bell-closed");

      // The return tab follows where the bell was tapped from: You → Alerts → bell → You.
      await tab(page, "You").click();
      await heading(page, "You").waitFor();
      await bell(page).click();
      await heading(page, "Alerts").waitFor();
      await bell(page).click();
      await heading(page, "You").waitFor();
      await expectBell(bell(page), false);
      await shot(page, "bell-closed-you");

      // 3. Open again, 4. leave through the tabbar.
      await bell(page).click();
      await heading(page, "Alerts").waitFor();
      await expectBell(bell(page), true);
      await shot(page, "bell-reopen");
      await tab(page, "Now").click();
      await heading(page, "Now").waitFor();
      assert.equal(await heading(page, "Alerts").count(), 0);
      await expectBell(bell(page), false);
      await shot(page, "bell-tabbar-leave");
    } finally {
      await page.context().close();
    }
  });
}
