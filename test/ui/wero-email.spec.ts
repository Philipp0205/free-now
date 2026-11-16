import assert from "node:assert/strict";
import path from "node:path";
import { test } from "@playwright/test";
import type { Page } from "playwright-core";
import { SIZES, UA, openYouSection, useHangry, testEmail } from "./harness.js";
import { skipWhatsNew } from "./whats-new-seen.js";

const hangry = useHangry();
const SHOT_DIR = path.resolve("test/ui/screenshots/wero-email");
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

test("set a Wero email, circle mates get it with a copy button, bad values are refused, clearing removes it", async () => {
  const phil = await hangry.call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Philipp" });
  const circle = (await hangry.call("POST", "/api/circles", phil.token, { name: "Tennis" })).circle;
  const bea = await hangry.call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Bea", code: circle.inviteCode });
  // An event Bea hosts, so Philipp can open its details.
  await hangry.call("POST", "/api/socials", bea.token, { note: "Coffee" });

  // Bea saves her Wero email on the profile, with a refusal first.
  const own = await phone(bea.token, 360, 640);
  try {
    await openYouSection(own.page, "Profile");
    const input = own.page.locator("#wero-email");
    await input.fill("not-an-email");
    await own.page.getByRole("button", { name: "Save Wero email" }).click();
    await own.page.locator(".toast", { hasText: "Enter a valid email" }).waitFor();
    await shot(own.page, "profile-refused", 360, 640);
    assert.equal((await hangry.call("GET", "/api/me", bea.token)).user.weroEmail, null, "nothing saved");

    await input.fill(`  ${WERO.toUpperCase()}  `);
    await own.page.getByRole("button", { name: "Save Wero email" }).click();
    await own.page.locator(".toast", { hasText: "Wero email saved" }).waitFor();
    assert.equal(await own.page.locator("#wero-email").inputValue(), WERO);
    await shot(own.page, "profile-saved", 360, 640);
    assert.equal((await hangry.call("GET", "/api/me", bea.token)).user.weroEmail, WERO);

    await own.page.reload();
    await openYouSection(own.page, "Profile");
    assert.equal(await own.page.locator("#wero-email").inputValue(), WERO, "persisted after a reload");

    // Her own rows never offer to copy her own address.
    await circleTab(own.page);
    await own.page.locator(".member-row", { hasText: "Philipp" }).waitFor();
    assert.equal(await own.page.locator(".wero-entry").count(), 0);
    await own.page.getByRole("button", { name: "Details for Bea" }).click();
    await own.page.locator(".sheet[aria-label='Bea']").waitFor();
    assert.equal(await own.page.locator(".wero-entry").count(), 0);
  } finally {
    await own.context.close();
  }

  // Philipp, in the same circle, sees the address and a Copy button at each phone size.
  for (const [width, height] of SIZES) {
    const friend = await phone(phil.token, width, height);
    try {
      await circleTab(friend.page);
      const row = friend.page.locator(".member-row", { hasText: "Bea" });
      const entry = row.locator(".wero-entry");
      await entry.waitFor();
      assert.equal(await entry.locator(".wero-email").textContent(), WERO);
      assert.equal(await friend.page.locator(".member-row", { hasText: "Philipp" }).locator(".wero-entry").count(), 0);
      const box = await row.boundingBox();
      const copyBox = await entry.getByRole("button", { name: "Copy" }).boundingBox();
      assert.ok(box && copyBox && copyBox.x >= box.x && copyBox.x + copyBox.width <= box.x + box.width + 1, `Copy stays inside the row at ${width}`);
      assert.ok(copyBox.height >= 24, "tappable height");
      await row.scrollIntoViewIfNeeded();
      await entry.scrollIntoViewIfNeeded();
      await friend.page.evaluate(() => window.scrollBy(0, 120));
      await settle(friend.page);
      await shot(friend.page, "members", width, height);

      await row.getByRole("button", { name: "Details for Bea" }).click();
      const sheet = friend.page.locator(".sheet[aria-label='Bea']");
      await sheet.locator(".wero-entry .wero-email", { hasText: WERO }).waitFor();
      await settle(friend.page);
      await sheet.getByRole("button", { name: "Copy Wero email for Bea" }).click();
      await friend.page.locator(".toast", { hasText: "Copied" }).waitFor();
      assert.equal(await friend.page.evaluate(() => navigator.clipboard.readText()), WERO);
      await shot(friend.page, "member-sheet-copied", width, height);
      await friend.page.keyboard.press("Escape");
      await sheet.waitFor({ state: "detached" });

      // The event details people list.
      await friend.page.locator("nav.tabbar").getByRole("button", { name: "Now", exact: true }).click();
      const card = friend.page.locator(".card-now, .card-plan").filter({ hasText: "Coffee" });
      await card.getByRole("button", { name: "Open details" }).click();
      const details = friend.page.getByRole("dialog", { name: "Details" });
      const guest = details.locator(".guest-row", { hasText: "Bea" });
      await guest.locator(".wero-email", { hasText: WERO }).waitFor();
      await friend.page.locator(".toast").waitFor({ state: "detached" }).catch(() => {});
      await guest.scrollIntoViewIfNeeded();
      await settle(friend.page);
      await shot(friend.page, "event-details", width, height);
      await guest.getByRole("button", { name: "Copy Wero email for Bea" }).click();
      await friend.page.locator(".toast", { hasText: "Copied" }).waitFor();
    } finally {
      await friend.context.close();
    }
  }

  // Someone in another circle sees the address nowhere.
  const stranger = await hangry.call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Cam" });
  await hangry.call("POST", "/api/circles", stranger.token, { name: "Climbing" });
  const outsider = await phone(stranger.token, 360, 640);
  try {
    await circleTab(outsider.page);
    await outsider.page.locator(".member-row").first().waitFor();
    assert.equal(await outsider.page.locator(".wero-entry").count(), 0);
    assert.equal(await outsider.page.getByText(WERO).count(), 0);
    assert.equal(JSON.stringify(await hangry.call("GET", "/api/me", stranger.token)).includes(WERO), false);
  } finally {
    await outsider.context.close();
  }

  // Clearing the field removes the address for everyone.
  const again = await phone(bea.token, 360, 640);
  try {
    await openYouSection(again.page, "Profile");
    await again.page.locator("#wero-email").fill("");
    await again.page.getByRole("button", { name: "Save Wero email" }).click();
    await again.page.locator(".toast", { hasText: "Wero email removed" }).waitFor();
  } finally {
    await again.context.close();
  }
  assert.equal((await hangry.call("GET", "/api/me", bea.token)).user.weroEmail, null);
  const after = await phone(phil.token, 360, 640);
  try {
    await circleTab(after.page);
    await after.page.locator(".member-row", { hasText: "Bea" }).waitFor();
    assert.equal(await after.page.locator(".wero-entry").count(), 0);
  } finally {
    await after.context.close();
  }
});
