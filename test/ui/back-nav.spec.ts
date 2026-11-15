import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { openPlanSheet } from "./plan-sheet.js";
import { SIZES, UA, useHangry } from "./harness.js";

/** Screenshots always land in .oc/shots/ (git-ignored); BACK_SHOT_DIR overrides. */
const SHOT_DIR = path.resolve(process.env.BACK_SHOT_DIR || ".oc/shots");
/** Set to a folder to record a webm per width, for example BACK_VIDEO_DIR=/tmp/back-video. */
const VIDEO_DIR = process.env.BACK_VIDEO_DIR ? path.resolve(process.env.BACK_VIDEO_DIR) : "";

const hangry = useHangry();
const { call } = hangry;

async function phone(width: number, height: number, token: string, circleId: string) {
  const context = await hangry.browser.newContext({
    viewport: { width, height },
    isMobile: true,
    hasTouch: true,
    userAgent: UA,
    ...(VIDEO_DIR ? { recordVideo: { dir: VIDEO_DIR, size: { width, height } } } : {}),
  });
  await skipWhatsNew(context);
  await context.addInitScript(([value, circle]) => {
    localStorage.setItem("fn_install_later", String(Date.now()));
    localStorage.setItem("fn_token", value);
    localStorage.setItem("fn_circle", circle);
  }, [token, circleId]);
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

const heading = (page: Page, text: string) => page.locator("h1.screen-title", { hasText: new RegExp(`^${text}$`) });
const subHeading = (page: Page, text: string) => page.locator(".you-section h1", { hasText: new RegExp(`^${text}$`) });
const tab = (page: Page, name: string) => page.locator("nav.tabbar").getByRole("button", { name, exact: true });
const bell = (page: Page) => page.locator('.screen-head button.icon-btn[aria-label^="Alerts"]');

/** The phone's Back button: one history step, then the app must still be on screen. */
async function back(page: Page) {
  const url = page.url();
  await page.evaluate(() => history.back());
  await page.waitForTimeout(120);
  assert.equal(page.url(), url, "Back stayed inside the app");
  await page.locator("#app .phone").waitFor();
}

/** On Now with nothing open, no overlay entry is left above the page the app was opened on. */
async function atRest(page: Page) {
  await heading(page, "Now").waitFor();
  await page.waitForFunction(() => !(history.state && "hangryOverlay" in history.state));
  assert.equal(await page.locator(".sheet, .guide, .chat-screen, .past-screen, .circle-menu").count(), 0);
}

for (const [width, height] of SIZES) {
  test(`at ${width}: Back closes sheets, panels and tabs one at a time instead of leaving the app`, { timeout: 180_000 }, async () => {
    const host = await call("POST", "/api/auth/start", undefined, { name: "Hana" });
    const { circle } = await call("POST", "/api/circles", host.token, { name: `Back ${width}` });
    await call("POST", "/api/circles", host.token, { name: `Other ${width}` });
    const friend = await call("POST", "/api/auth/start", undefined, { name: "Finn", code: circle.inviteCode });
    await call("POST", "/api/socials", friend.token, { note: `Coffee ${width}`, place: "Schlossplatz", lat: 48.7784, lng: 9.18 });
    await call("POST", `/api/socials?circle=${circle.id}`, host.token, { note: "Around" });

    const page = await phone(width, height, host.token, circle.id);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(hangry.baseUrl);
      await dismiss(page);
      await atRest(page);
      const start = await page.evaluate(() => history.length);

      // Free sheet.
      await page.getByRole("button", { name: "Let friends know you're free now" }).click();
      await page.locator("form.sheet").waitFor();
      await shot(page, "back-free");
      await back(page);
      await page.locator("form.sheet").waitFor({ state: "detached" });
      await atRest(page);

      // Confirm over the free sheet: Back closes the confirm, then the sheet underneath.
      await page.getByRole("button", { name: "Let friends know you're free now" }).click();
      await page.locator("form.sheet").getByRole("button", { name: "End", exact: true }).click();
      const confirm = page.getByRole("dialog", { name: "End this?" });
      await confirm.waitFor();
      await shot(page, "back-confirm");
      await back(page);
      await confirm.waitFor({ state: "detached" });
      await page.locator("form.sheet").waitFor();
      await back(page);
      await page.locator("form.sheet").waitFor({ state: "detached" });
      await atRest(page);

      // Plan sheet.
      await openPlanSheet(page);
      await page.locator("form.sheet").waitFor();
      await shot(page, "back-plan");
      await back(page);
      await page.locator("form.sheet").waitFor({ state: "detached" });
      await atRest(page);

      // Alerts from Now.
      await bell(page).click();
      await heading(page, "Alerts").waitFor();
      await shot(page, "back-alerts");
      await back(page);
      await atRest(page);

      // Alerts from You: Back returns to You, then Now.
      await tab(page, "You").click();
      await heading(page, "You").waitFor();
      await bell(page).click();
      await heading(page, "Alerts").waitFor();
      await back(page);
      await heading(page, "You").waitFor();
      await back(page);
      await atRest(page);

      // Circle chat.
      await tab(page, "Chat").click();
      await page.locator(".chat-screen").waitFor();
      await shot(page, "back-chat");
      await back(page);
      await page.locator(".chat-screen").waitFor({ state: "detached" });
      await atRest(page);

      // Past events.
      await page.getByRole("button", { name: "Past events", exact: true }).click();
      await page.locator(".past-screen").waitFor();
      await shot(page, "back-past");
      await back(page);
      await page.locator(".past-screen").waitFor({ state: "detached" });
      await atRest(page);

      // Circle switcher menu.
      await page.getByRole("button", { name: "Switch circle" }).click();
      await page.locator(".circle-menu").waitFor();
      await shot(page, "back-circle-menu");
      await back(page);
      await page.locator(".circle-menu").waitFor({ state: "detached" });
      await atRest(page);

      // Notifications sheet on You: Back closes the sheet, then You.
      await tab(page, "You").click();
      await heading(page, "You").waitFor();
      await shot(page, "back-you-menu");
      await page.locator(".page").getByRole("button", { name: "Notifications", exact: true }).click();
      await page.locator("button.notif-row").click();
      const notifications = page.getByRole("dialog", { name: "Notifications" });
      await notifications.waitFor();
      await shot(page, "back-notifications");
      await back(page);
      await notifications.waitFor({ state: "detached" });
      await subHeading(page, "Notifications").waitFor();
      await back(page);
      await heading(page, "You").waitFor();
      await back(page);
      await atRest(page);

      // Closing in the UI drops the entry too, so the next Back still lands one layer down.
      await tab(page, "You").click();
      await page.locator(".page").getByRole("button", { name: "Notifications", exact: true }).click();
      await page.locator("button.notif-row").click();
      await notifications.waitFor();
      await page.keyboard.press("Escape");
      await notifications.waitFor({ state: "detached" });
      await subHeading(page, "Notifications").waitFor();
      await back(page);
      await heading(page, "You").waitFor();
      await back(page);
      await atRest(page);

      // Plain tabs.
      for (const [name, title] of [["Events", "Events"], ["Circle", "Circle"]] as const) {
        await tab(page, name).click();
        await heading(page, title).waitFor();
        await back(page);
        await atRest(page);
      }

      // A place opens its pin on the map; Back returns to Now.
      await page.getByRole("button", { name: "Show Schlossplatz on the map" }).click();
      await page.locator(".map-card").getByText(`Coffee ${width}`).waitFor({ timeout: 8000 });
      await shot(page, "back-place-map");
      await back(page);
      await page.locator(".map-card").waitFor({ state: "detached" });
      await atRest(page);

      // An alert that opens the map: Back returns to Alerts, then Now.
      await bell(page).click();
      await heading(page, "Alerts").waitFor();
      await page.locator(".alert-card", { hasText: `Coffee ${width}` }).first().click();
      await page.locator(".map-card").getByText(`Coffee ${width}`).waitFor({ timeout: 8000 });
      await back(page);
      await heading(page, "Alerts").waitFor();
      await back(page);
      await atRest(page);

      // Nothing piled up: every pushed entry was used or taken back.
      assert.ok((await page.evaluate(() => history.length)) <= start + 3, "history did not grow per overlay");
      await shot(page, "back-rest");
      assert.deepEqual(errors, []);
    } finally {
      await page.context().close();
    }
  });
}
