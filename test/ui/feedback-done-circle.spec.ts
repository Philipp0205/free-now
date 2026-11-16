import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA, call, useHangry } from "./harness.js";
import { testEmail } from "../http.js";
/** Screenshots go here. Override with FDC_SHOT_DIR=/some/folder. */
const SHOT_DIR = path.resolve(process.env.FDC_SHOT_DIR || ".oc/shots/feedback-done-circle");
const ADMIN = "a".repeat(32);
const hangry = useHangry({ tz: "UTC", env: { ADMIN_TOKEN: ADMIN } });

async function phone(width: number, height: number, token: string, circleId: string) {
  const context = await hangry.browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: UA });
  await skipWhatsNew(context);
  await context.addInitScript(([value, circle]) => {
    if (sessionStorage.getItem("fdc_seeded")) return;
    sessionStorage.setItem("fdc_seeded", "1");
    localStorage.setItem("fn_install_later", String(Date.now()));
    localStorage.setItem("fn_token", value);
    localStorage.setItem("fn_circle", circle);
  }, [token, circleId]);
  await context.route("https://*.tile.openstreetmap.org/**", (route) => route.fulfill({ status: 204, body: "" }));
  await context.route("https://server.arcgisonline.com/**", (route) => route.fulfill({ status: 204, body: "" }));
  return context.newPage();
}

async function dismiss(page: Page) {
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
}

async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const size = page.viewportSize()!;
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}-${size.width}x${size.height}.png`) });
}

function bell(page: Page) {
  return page.locator(".screen-head .icon-btn[aria-label^='Alerts']");
}

/** Opening Alerts only posts a read when something is unread. */
async function openAlerts(page: Page, unread: boolean) {
  const read = unread
    ? page.waitForResponse((r) => r.url().endsWith("/api/notifications/read") && r.request().method() === "POST")
    : null;
  await bell(page).click();
  await read;
  await page.locator(".screen-title", { hasText: "Alerts" }).waitFor();
}

for (const [width, height] of SIZES) {
  test(`in a circle at ${width}px: only the submitter's Alerts show it, the other member's stay empty`, { timeout: 90_000 }, async () => {
    const alex = await hangry.call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Alex" });
    const circle = (await hangry.call("POST", "/api/circles", alex.token, { name: `Friends ${width}` })).circle;
    const bea = await hangry.call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Bea", code: circle.inviteCode });
    const text = `Group polls ${width} <i>please</i>`;
    const sent = await hangry.call("POST", "/api/feedback", bea.token, { text, circleId: circle.id });
    // Alex got "Bea joined". Clear it so an empty Alerts list proves nothing else arrived.
    hangry.db.prepare("DELETE FROM notifications WHERE user_id = ?").run(alex.user.id);

    const beaPage = await phone(width, height, bea.token, circle.id);
    const alexPage = await phone(width, height, alex.token, circle.id);
    const errors: string[] = [];
    for (const page of [beaPage, alexPage]) page.on("pageerror", (error) => errors.push(error.message));
    try {
      await beaPage.goto(hangry.baseUrl);
      await dismiss(beaPage);
      await alexPage.goto(hangry.baseUrl);
      await dismiss(alexPage);
      await bell(beaPage).waitFor();
      await bell(alexPage).waitFor();

      await call(hangry.baseUrl, "POST", `/api/admin/feedback/${sent.id}`, ADMIN, { status: "done" });

      // Bea: the 3 s poll brings a bell badge, then the Alerts list has it, as text.
      await bell(beaPage).locator(".badge").waitFor({ timeout: 10_000 });
      await openAlerts(beaPage, true);
      const card = beaPage.locator(".alert-card", { hasText: "Your suggestion is live" });
      await card.waitFor();
      assert.match(await card.innerText(), /Group polls \d+ <i>please<\/i>/);
      assert.equal(await card.locator("i").count(), 0, "feedback text is never HTML");
      await shot(beaPage, "1-submitter-alerts");

      // Alex: same circle, same time. Give the poll a few rounds, then check the UI.
      await alexPage.waitForTimeout(4000);
      assert.equal(await bell(alexPage).locator(".badge").count(), 0);
      await openAlerts(alexPage, false);
      await alexPage.getByText("When a friend is free, it shows up here.").waitFor();
      assert.equal(await alexPage.locator(".alert-card", { hasText: "Your suggestion is live" }).count(), 0);
      assert.equal((await alexPage.locator("body").innerText()).includes("Group polls"), false);
      assert.equal(await alexPage.locator(".banner").count(), 0);
      await shot(alexPage, "2-other-member-alerts-empty");

      // Bea taps it: What's new opens.
      await card.click();
      const dialog = beaPage.getByRole("dialog", { name: "What's new" });
      await dialog.waitFor();
      await shot(beaPage, "3-submitter-whats-new");
      await dialog.getByRole("button", { name: "Done" }).click();
      await dialog.waitFor({ state: "detached" });
      assert.deepEqual(errors, []);
    } finally {
      await beaPage.context().close();
      await alexPage.context().close();
    }
  });
}
