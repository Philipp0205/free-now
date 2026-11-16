import assert from "node:assert/strict";
import path from "node:path";
import { test } from "@playwright/test";
import type { Page } from "playwright-core";
import { SIZES, UA, openYouSection, useHangry } from "./harness.js";
import { skipWhatsNew } from "./whats-new-seen.js";

const hangry = useHangry();
const SHOT_DIR = path.resolve("test/ui/screenshots/payment-link");
const LINK = "https://paypal.me/beafriend";

async function phone(token: string, width: number, height: number) {
  const context = await hangry.browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: UA });
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
const shot = (page: Page, name: string, width: number, height: number) =>
  page.screenshot({ path: path.join(SHOT_DIR, `${name}-${width}x${height}.png`) });

test("set a payment link, circle mates get a Pay link, bad links are refused, clearing removes it", async () => {
  const phil = await hangry.call("POST", "/api/auth/start", undefined, { name: "Philipp" });
  const circle = (await hangry.call("POST", "/api/circles", phil.token, { name: "Tennis" })).circle;
  const bea = await hangry.call("POST", "/api/auth/start", undefined, { name: "Bea", code: circle.inviteCode });

  // Bea saves her link on the profile, with a refusal first.
  const own = await phone(bea.token, 360, 640);
  try {
    await openYouSection(own.page, "Profile");
    const input = own.page.locator("#payment-url");
    await input.fill("https://example.com/bea");
    await own.page.getByRole("button", { name: "Save payment link" }).click();
    await own.page.locator(".toast", { hasText: "Use a paypal.me link" }).waitFor();
    await shot(own.page, "profile-refused", 360, 640);
    assert.equal((await hangry.call("GET", "/api/me", bea.token)).user.paymentUrl, null, "nothing saved");

    await input.fill(LINK);
    await own.page.getByRole("button", { name: "Save payment link" }).click();
    await own.page.locator(".toast", { hasText: "Payment link saved" }).waitFor();
    assert.equal(await own.page.locator("#payment-url").inputValue(), LINK);
    await shot(own.page, "profile-saved", 360, 640);
    assert.equal((await hangry.call("GET", "/api/me", bea.token)).user.paymentUrl, LINK);

    // Her own row never offers to pay herself.
    await circleTab(own.page);
    await own.page.locator(".member-row", { hasText: "Philipp" }).waitFor();
    assert.equal(await own.page.locator("a.pay-link").count(), 0);
  } finally {
    await own.context.close();
  }

  // Philipp, in the same circle, sees Pay next to Bea (not himself) at each phone size.
  for (const [width, height] of SIZES) {
    const friend = await phone(phil.token, width, height);
    try {
      await circleTab(friend.page);
      const row = friend.page.locator(".member-row", { hasText: "Bea" });
      const pay = row.locator("a.pay-link");
      await pay.waitFor();
      assert.equal(await pay.getAttribute("href"), LINK);
      assert.equal(await pay.getAttribute("target"), "_blank");
      assert.match((await pay.getAttribute("rel")) ?? "", /noopener/);
      assert.equal(await friend.page.locator(".member-row", { hasText: "Philipp" }).locator("a.pay-link").count(), 0);
      const box = await row.boundingBox();
      const payBox = await pay.boundingBox();
      assert.ok(box && payBox && payBox.x >= box.x && payBox.x + payBox.width <= box.x + box.width + 1, `Pay stays inside the row at ${width}`);
      assert.ok(payBox.height >= 24, "tappable height");
      await pay.scrollIntoViewIfNeeded();
      await friend.page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {}))));
      await shot(friend.page, "members", width, height);

      await row.getByRole("button", { name: "Details for Bea" }).click();
      const sheet = friend.page.locator(".sheet[aria-label='Bea']");
      await sheet.locator("a.action", { hasText: "Pay" }).waitFor();
      await friend.page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {}))));
      assert.equal(await sheet.locator("a.action", { hasText: "Pay" }).getAttribute("href"), LINK);
      await shot(friend.page, "member-sheet", width, height);
    } finally {
      await friend.context.close();
    }
  }

  // Someone in another circle sees no Pay link anywhere.
  const stranger = await hangry.call("POST", "/api/auth/start", undefined, { name: "Cam" });
  await hangry.call("POST", "/api/circles", stranger.token, { name: "Climbing" });
  const outsider = await phone(stranger.token, 360, 640);
  try {
    await circleTab(outsider.page);
    await outsider.page.locator(".member-row").first().waitFor();
    assert.equal(await outsider.page.locator("a.pay-link").count(), 0);
    assert.equal(await outsider.page.getByText("Bea").count(), 0);
  } finally {
    await outsider.context.close();
  }

  // Clearing the field removes the link for everyone.
  const again = await phone(bea.token, 360, 640);
  try {
    await openYouSection(again.page, "Profile");
    await again.page.locator("#payment-url").fill("");
    await again.page.getByRole("button", { name: "Save payment link" }).click();
    await again.page.locator(".toast", { hasText: "Payment link removed" }).waitFor();
  } finally {
    await again.context.close();
  }
  assert.equal((await hangry.call("GET", "/api/me", bea.token)).user.paymentUrl, null);
  const after = await phone(phil.token, 360, 640);
  try {
    await circleTab(after.page);
    await after.page.locator(".member-row", { hasText: "Bea" }).waitFor();
    assert.equal(await after.page.locator("a.pay-link").count(), 0);
  } finally {
    await after.context.close();
  }
});
