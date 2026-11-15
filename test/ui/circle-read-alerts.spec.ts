import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Page } from "playwright-core";
import { flushChatNotices } from "../../src/chat/chat.js";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA, useHangry } from "./harness.js";

/** Screenshots go here. Override with CR_SHOT_DIR=/some/folder. */
const SHOT_DIR = path.resolve(process.env.CR_SHOT_DIR || ".oc/shots/circle-read");

const hangry = useHangry({ beforeClose: () => flushChatNotices(true) });
const { call } = hangry;

async function phone(width: number, height: number, token: string, circleId: string) {
  const context = await hangry.browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: UA });
  await skipWhatsNew(context);
  await context.addInitScript(([value, circle]) => {
    if (sessionStorage.getItem("cr_seeded")) return;
    sessionStorage.setItem("cr_seeded", "1");
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
  const size = page.viewportSize()!;
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}-${size.width}x${size.height}.png`) });
}

function bell(page: Page) {
  return page.locator(".screen-head .icon-btn[aria-label^='Alerts']");
}

async function openMenu(page: Page) {
  if (await page.locator(".circle-menu").count()) return;
  await page.getByRole("button", { name: "Switch circle" }).click();
  await page.locator(".circle-menu").waitFor();
}

async function closeMenu(page: Page) {
  if (await page.locator(".circle-menu").count()) await page.getByRole("button", { name: "Switch circle" }).click();
}

async function openAlerts(page: Page) {
  const read = page.waitForResponse((r) => r.url().endsWith("/api/notifications/read") && r.request().method() === "POST");
  await bell(page).click();
  await read;
  await page.locator(".alert-card").first().waitFor();
}

function menuDot(page: Page, name: string) {
  return page.locator(".circle-menu button", { hasText: name }).locator(".unread-dot");
}

for (const [width, height] of SIZES) {
  test(`at ${width}: a circle dot means unread alerts there, and opening Alerts clears it`, { timeout: 120_000 }, async () => {
    const home = `Home ${width}`;
    const uni = `Uni ${width}`;
    const finn = await call("POST", "/api/auth/start", undefined, { name: "Finn" });
    const a = (await call("POST", "/api/circles", finn.token, { name: home })).circle;
    const b = (await call("POST", "/api/circles", finn.token, { name: uni })).circle;
    const uma = await call("POST", "/api/auth/start", undefined, { name: "Uma", code: a.inviteCode });
    await call("POST", "/api/circles/join", uma.token, { code: b.inviteCode });

    const page = await phone(width, height, uma.token, b.id);
    try {
      await page.goto(hangry.baseUrl);
      await dismiss(page);
      await page.getByRole("button", { name: "Switch circle" }).waitFor();
      await openMenu(page);
      assert.equal(await menuDot(page, home).count(), 0);
      assert.equal(await menuDot(page, uni).count(), 0);
      await closeMenu(page);

      // Activity in Home only: a plan, and a new member.
      const plan = (await call("POST", `/api/plans?circle=${a.id}`, finn.token, { note: "Pizza night", time: "19:30" })).plan;
      await call("POST", "/api/auth/start", undefined, { name: "Cleo", code: a.inviteCode });

      // Still on Uni: Home has a dot, Uni does not, and Uni's bell has no badge.
      await page.locator(".circle-switch-btn .unread-dot").waitFor({ timeout: 10_000 });
      await openMenu(page);
      await menuDot(page, home).waitFor();
      assert.equal(await menuDot(page, uni).count(), 0);
      assert.equal(await bell(page).locator(".badge").count(), 0);
      await shot(page, "1-menu-dot-on-home");

      // Switch to Home. Switching alone does not mark anything read.
      await page.locator(".circle-menu button", { hasText: home }).click();
      await page.locator(".screen-head .badge").waitFor();
      assert.equal(await bell(page).getAttribute("aria-label"), "Alerts, 2 unread");
      // Switching is not news: no banner for the other circle's old alerts.
      assert.equal(await page.locator(".banner").count(), 0);
      const me = await call("GET", `/api/me?circle=${a.id}`, uma.token);
      assert.equal(me.circles.find((c: { id: string }) => c.id === a.id).alertUnread, 2);
      await shot(page, "2-home-bell-badge");

      // Open Alerts: the plan and the new member are there.
      await openAlerts(page);
      let texts = await page.locator(".alert-card").allInnerTexts();
      assert.ok(texts.some((t) => t.includes("New member") && t.includes(`Cleo joined ${home}`)), texts.join(" | "));
      assert.ok(texts.some((t) => t.includes("Finn: Pizza night")), texts.join(" | "));

      // Bell badge and the Home dot clear together. Uni never got one.
      await bell(page).locator(".badge").waitFor({ state: "detached" });
      await shot(page, "3a-alerts-list");
      assert.equal(await page.locator(".circle-switch-btn .unread-dot").count(), 0);
      await openMenu(page);
      assert.equal(await menuDot(page, home).count(), 0);
      assert.equal(await menuDot(page, uni).count(), 0);
      await shot(page, "3b-after-read-cleared");
      const after = await call("GET", `/api/me?circle=${a.id}`, uma.token);
      assert.deepEqual(after.circles.map((c: { alertUnread: number }) => c.alertUnread), [0, 0]);

      // Over in Uni, new Home activity brings the Home dot back: Uma is in, Finn ends a plan and writes in another.
      await page.locator(".circle-menu button", { hasText: uni }).click();
      await page.locator(".circle-menu").waitFor({ state: "detached" });
      const brunch = (await call("POST", `/api/plans?circle=${a.id}`, finn.token, { note: "Brunch" })).plan;
      await call("POST", `/api/plans/${plan.id}/reply?circle=${a.id}`, uma.token, { reply: "in" });
      await call("POST", `/api/plans/${brunch.id}/reply?circle=${a.id}`, uma.token, { reply: "in" });
      await call("POST", `/api/plans/${brunch.id}/chat?circle=${a.id}`, finn.token, { text: "Table for 4 booked" });
      await flushChatNotices(true);
      await call("DELETE", `/api/plans/${plan.id}?circle=${a.id}`, finn.token);
      await page.locator(".circle-switch-btn .unread-dot").waitFor({ timeout: 10_000 });
      await openMenu(page);
      await menuDot(page, home).waitFor();
      assert.equal(await menuDot(page, uni).count(), 0);
      await shot(page, "4-dot-returns");

      // Alerts is still open, so switching to Home shows Home's list and marks it read.
      const read = page.waitForResponse((r) => r.url().endsWith("/api/notifications/read") && r.request().method() === "POST");
      await page.locator(".circle-menu button", { hasText: home }).click();
      await read;
      await page.locator(".alert-card", { hasText: "Brunch" }).first().waitFor();
      texts = await page.locator(".alert-card").allInnerTexts();
      assert.ok(texts.some((t) => t.includes("Brunch") && t.includes("Finn: Table for 4 booked")), texts.join(" | "));
      assert.ok(texts.some((t) => t.includes("Ended") && t.includes("Finn ended Pizza night")), texts.join(" | "));
      await bell(page).locator(".badge").waitFor({ state: "detached" });
      await shot(page, "5-alerts-kinds");

      // The chat alert opens that chat. Once it is read too, the Home dot is gone.
      await page.locator(".alert-card", { hasText: "Table for 4 booked" }).click();
      await page.getByText("Table for 4 booked").last().waitFor();
      await page.getByRole("button", { name: "Back" }).click();
      await page.locator(".circle-switch-btn .unread-dot").waitFor({ state: "detached", timeout: 10_000 });
      await openMenu(page);
      assert.equal(await menuDot(page, home).count(), 0);
      assert.equal(await menuDot(page, uni).count(), 0);
      await shot(page, "6-all-read");
    } finally {
      await page.context().close();
    }
  });
}
