import assert from "node:assert/strict";
import path from "node:path";
import { test } from "@playwright/test";
import type { Locator, Page } from "playwright-core";
import { SIZES, UA, useHangry, testEmail } from "./harness.js";
import { skipWhatsNew } from "./whats-new-seen.js";

const hangry = useHangry();
const SHOT_DIR = path.resolve("test/ui/screenshots/circle-pay-rows");
const LINK = "https://paypal.me/beafriend";
const WERO = "bea.wero@example.com";

async function phone(token: string, width: number, height: number) {
  const context = await hangry.browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: UA });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: hangry.baseUrl });
  await skipWhatsNew(context);
  await context.addInitScript((value) => {
    localStorage.setItem("fn_token", value);
    localStorage.setItem("fn_installed", "1");
    localStorage.setItem("fn_install_later", String(Date.now()));
  }, token);
  const page = await context.newPage();
  await page.goto(hangry.baseUrl);
  await page.locator("nav.tabbar").waitFor();
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
  return { context, page };
}

const circleTab = (page: Page) => page.locator("nav.tabbar").getByRole("button", { name: "Circle", exact: true }).click();
const settle = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {}))));
const shot = (page: Page, name: string, width: number, height: number) =>
  page.screenshot({ path: path.join(SHOT_DIR, `${name}-${width}x${height}.png`) });

type Box = { x: number; y: number; width: number; height: number };
const boxOf = async (locator: Locator): Promise<Box> => {
  const box = await locator.boundingBox();
  assert.ok(box, "element has a box");
  return box;
};

/** Both payment rows share one layout: tag at the same x, value after it, action at the right edge, same height. */
async function assertMatchingRows(paypal: Locator, wero: Locator, label: string) {
  assert.equal(await paypal.locator(".wero-tag").textContent(), "PayPal", label);
  assert.equal(await paypal.locator(".wero-email").textContent(), "paypal.me/beafriend", label);
  assert.equal(await wero.locator(".wero-tag").textContent(), "Wero", label);
  assert.equal(await wero.locator(".wero-email").textContent(), WERO, label);
  const [p, w] = [await boxOf(paypal), await boxOf(wero)];
  assert.ok(Math.abs(p.height - w.height) <= 1, `${label}: same row height, ${p.height} vs ${w.height}`);
  assert.ok(Math.abs(p.x - w.x) <= 1, `${label}: same indent`);
  assert.ok(Math.abs(p.width - w.width) <= 1, `${label}: same width`);
  const [pTag, wTag] = [await boxOf(paypal.locator(".wero-tag")), await boxOf(wero.locator(".wero-tag"))];
  assert.ok(Math.abs(pTag.x - wTag.x) <= 1, `${label}: tags start at the same x`);
  const [pAct, wAct] = [await boxOf(paypal.locator(".text-btn")), await boxOf(wero.locator(".text-btn"))];
  assert.ok(Math.abs(pAct.x + pAct.width - (wAct.x + wAct.width)) <= 1, `${label}: actions end at the same x`);
  assert.ok(pAct.height >= 24 && wAct.height >= 24, `${label}: tappable height`);
  const [pFont, wFont] = await Promise.all([paypal, wero].map((row) => row.locator(".wero-tag").evaluate((node) => getComputedStyle(node).fontSize)));
  assert.equal(pFont, wFont, `${label}: same tag type size`);
}

async function assertPayAndCopy(paypal: Locator, wero: Locator) {
  const pay = paypal.getByRole("link", { name: "Pay Bea" });
  assert.equal(await pay.textContent(), "Pay");
  assert.equal(await pay.getAttribute("href"), LINK);
  assert.equal(await pay.getAttribute("target"), "_blank");
  assert.match((await pay.getAttribute("rel")) ?? "", /noopener/);
  assert.equal(await wero.getByRole("button", { name: "Copy Wero email for Bea" }).textContent(), "Copy");
  assert.equal(await paypal.getByRole("button").count(), 0, "PayPal has no copy button");
}

test("PayPal and Wero rows match on the circle list, the member sheet and event details", async () => {
  const phil = await hangry.call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Philipp" });
  const circle = (await hangry.call("POST", "/api/circles", phil.token, { name: "Tennis" })).circle;
  const bea = await hangry.call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Bea", code: circle.inviteCode });
  await hangry.call("PATCH", "/api/me", bea.token, { paymentUrl: LINK, weroEmail: WERO });
  await hangry.call("POST", "/api/socials", bea.token, { note: "Coffee" });

  for (const [width, height] of SIZES) {
    const { context, page } = await phone(phil.token, width, height);
    try {
      await circleTab(page);
      const row = page.locator(".member-row", { hasText: "Bea" });
      const paypal = row.locator(".paypal-entry");
      const wero = row.locator(".wero-entry", { hasText: "Wero" });
      await paypal.waitFor();
      await wero.waitFor();
      await assertMatchingRows(paypal, wero, `list @${width}`);
      await assertPayAndCopy(paypal, wero);
      // Philipp never sees rows for himself.
      assert.equal(await page.locator(".member-row", { hasText: "Philipp" }).locator(".wero-entry").count(), 0);
      await row.scrollIntoViewIfNeeded();
      await page.evaluate(() => window.scrollBy(0, 120));
      await settle(page);
      await shot(page, "list", width, height);

      await row.getByRole("button", { name: "Details for Bea" }).click();
      const sheet = page.locator(".sheet[aria-label='Bea']");
      const sheetPaypal = sheet.locator(".paypal-entry");
      const sheetWero = sheet.locator(".wero-entry", { hasText: "Wero" });
      await sheetPaypal.waitFor();
      await settle(page);
      await assertMatchingRows(sheetPaypal, sheetWero, `sheet @${width}`);
      await assertPayAndCopy(sheetPaypal, sheetWero);
      await sheetWero.getByRole("button", { name: "Copy Wero email for Bea" }).click();
      await page.locator(".toast", { hasText: "Copied" }).waitFor();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), WERO);
      await page.locator(".toast").waitFor({ state: "detached" });
      await settle(page);
      await shot(page, "sheet", width, height);
      await page.keyboard.press("Escape");
      await sheet.waitFor({ state: "detached" });

      await page.locator("nav.tabbar").getByRole("button", { name: "Now", exact: true }).click();
      const card = page.locator(".card-now, .card-plan").filter({ hasText: "Coffee" });
      await card.getByRole("button", { name: "Open details" }).click();
      const guest = page.getByRole("dialog", { name: "Details" }).locator(".guest-row", { hasText: "Bea" });
      const guestPaypal = guest.locator(".paypal-entry");
      await guestPaypal.waitFor();
      await page.locator(".toast").waitFor({ state: "detached" }).catch(() => {});
      await guest.scrollIntoViewIfNeeded();
      await settle(page);
      await assertMatchingRows(guestPaypal, guest.locator(".wero-entry", { hasText: "Wero" }), `event @${width}`);
      await shot(page, "event-details", width, height);
    } finally {
      await context.close();
    }
  }
});

test("the switch-circle menu lists only circles, and New circle and Join with link stay on the Circle tab", async () => {
  const dana = await hangry.call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Dana" });
  await hangry.call("POST", "/api/circles", dana.token, { name: "Tennis" });
  await hangry.call("POST", "/api/circles", dana.token, { name: "Climbing" });

  const { context, page } = await phone(dana.token, 360, 640);
  try {
    await circleTab(page);
    await page.getByRole("button", { name: "Switch circle" }).click();
    const menu = page.locator(".circle-menu");
    await menu.waitFor();
    await settle(page);
    const labels = (await menu.getByRole("button").allInnerTexts()).map((text) => text.trim()).sort();
    assert.deepEqual(labels, ["Climbing", "Tennis"]);
    assert.equal(await menu.getByRole("button", { name: "Join with link" }).count(), 0);
    assert.equal(await menu.getByRole("button", { name: "New circle" }).count(), 0);
    await shot(page, "switch-menu", 360, 640);
    await page.getByRole("button", { name: "Switch circle" }).click();
    await menu.waitFor({ state: "detached" });

    // Both actions are still on the Circle tab and open their sheets.
    await page.getByRole("button", { name: "New circle", exact: true }).click();
    await page.getByRole("dialog", { name: "New circle" }).waitFor();
    await page.locator("#new-circle-name").waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: "New circle" }).waitFor({ state: "detached" });

    await page.getByRole("button", { name: "Join with link", exact: true }).click();
    await page.locator("#invite-code").waitFor();
    await shot(page, "join-sheet", 360, 640);
  } finally {
    await context.close();
  }
});
