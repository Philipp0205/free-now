import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA as CHROME_UA, useHangry } from "./harness.js";

const SHOT_DIR = path.join(import.meta.dirname, "screenshots", "admin-delete-events");

const hangry = useHangry({ tz: "UTC" });

function shot(name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  return path.join(SHOT_DIR, name);
}

/** Alex is the circle admin, Bea hosts the events, Sam is a plain member. */
async function circleOfThree() {
  const alex = await hangry.call("POST", "/api/auth/start", undefined, { name: "Alex" });
  const { circle } = await hangry.call("POST", "/api/circles", alex.token, { name: "Friends" });
  const bea = await hangry.call("POST", "/api/auth/start", undefined, { name: "Bea", code: circle.inviteCode });
  const sam = await hangry.call("POST", "/api/auth/start", undefined, { name: "Sam", code: circle.inviteCode });
  const plan = (await hangry.call("POST", "/api/plans", bea.token, { note: "Rooftop drinks", time: "19:30" })).plan;
  const social = (await hangry.call("POST", "/api/socials", bea.token, { note: "Quick coffee" })).social;
  return { alex, bea, sam, plan, social };
}

async function phone(width: number, height: number, token: string): Promise<Page> {
  const context = await hangry.browser.newContext({
    viewport: { width, height },
    isMobile: true,
    hasTouch: true,
    userAgent: CHROME_UA,
  });
  await skipWhatsNew(context);
  const page = await context.newPage();
  await page.goto(`${hangry.baseUrl}/robots.txt`);
  await page.evaluate((value) => {
    localStorage.clear();
    localStorage.setItem("fn_token", value);
    localStorage.setItem("fn_install_later", String(Date.now()));
  }, token);
  await page.goto(hangry.baseUrl);
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
  return page;
}

test("an admin ends someone else's plan from the card menu and it is gone for everyone", { timeout: 120_000 }, async () => {
  const { alex, sam, plan } = await circleOfThree();
  const page = await phone(360, 640, alex.token);
  try {
    const card = page.locator(".card-plan", { hasText: "Rooftop drinks" });
    await card.waitFor();
    await card.locator(".card-more").click();
    const menu = page.getByRole("menu");
    await menu.getByRole("menuitem", { name: "Edit" }).waitFor();
    await menu.getByRole("menuitem", { name: "End plan" }).waitFor();
    await page.screenshot({ path: shot("admin-plan-menu-w360.png") });
    await menu.getByRole("menuitem", { name: "End plan" }).click();
    const confirm = page.locator(".sheet-confirm");
    await confirm.getByText("Bea will be told this ended.").waitFor();
    await page.screenshot({ path: shot("admin-plan-confirm-w360.png") });
    await confirm.getByRole("button", { name: "End", exact: true }).click();
    await card.waitFor({ state: "detached" });
    await page.screenshot({ path: shot("admin-plan-ended-w360.png") });
  } finally {
    await page.context().close();
  }

  const other = await phone(360, 640, sam.token);
  try {
    await other.locator(".card-now", { hasText: "Quick coffee" }).waitFor();
    assert.equal(await other.locator(".card-plan", { hasText: "Rooftop drinks" }).count(), 0);
    await other.screenshot({ path: shot("member-after-plan-ended-w360.png") });
  } finally {
    await other.context().close();
  }
  const plans = await hangry.call("GET", "/api/plans", sam.token);
  assert.equal(plans.plans.some((row: { id: string }) => row.id === plan.id), false);
});

test("an admin ends someone else's free post from the details sheet, and a member has no End there", { timeout: 120_000 }, async () => {
  const { alex, sam, plan } = await circleOfThree();
  const admin = await phone(360, 640, alex.token);
  try {
    const card = admin.locator(".card-now", { hasText: "Quick coffee" });
    await card.waitFor();
    await card.locator(".card-more").click();
    await admin.getByRole("menuitem", { name: "End", exact: true }).waitFor();
    await admin.keyboard.press("Escape");

    await card.getByRole("button", { name: "Open details" }).click();
    const details = admin.getByRole("dialog", { name: "Details" });
    await details.waitFor();
    await details.getByRole("button", { name: "End", exact: true }).waitFor();
    await admin.screenshot({ path: shot("admin-details-social-w360.png") });
    await details.getByRole("button", { name: "End", exact: true }).click();
    await admin.locator(".sheet-confirm").getByRole("button", { name: "End", exact: true }).click();
    await details.waitFor({ state: "detached" });
    await card.waitFor({ state: "detached" });
    await admin.screenshot({ path: shot("admin-details-social-ended-w360.png") });
  } finally {
    await admin.context().close();
  }

  const member = await phone(360, 640, sam.token);
  try {
    assert.equal(await member.locator(".card-now", { hasText: "Quick coffee" }).count(), 0);
    const card = member.locator(".card-plan", { hasText: "Rooftop drinks" });
    await card.waitFor();
    await card.getByRole("button", { name: "Open details" }).click();
    const details = member.getByRole("dialog", { name: "Details" });
    await details.getByText("Who's in").waitFor();
    assert.equal(await details.getByRole("button", { name: /^End/ }).count(), 0);
    await member.screenshot({ path: shot("member-details-plan-w360.png") });
  } finally {
    await member.context().close();
  }
  const plans = await hangry.call("GET", "/api/plans", sam.token);
  assert.equal(plans.plans.some((row: { id: string }) => row.id === plan.id), true);
});

test("a regular member sees no End or Edit on someone else's plan or free post", { timeout: 120_000 }, async () => {
  const { sam } = await circleOfThree();
  for (const [width, height] of SIZES) {
    const page = await phone(width, height, sam.token);
    try {
      const plan = page.locator(".card-plan", { hasText: "Rooftop drinks" });
      await plan.waitFor();
      await plan.locator(".card-more").click();
      const menu = page.getByRole("menu");
      await menu.getByRole("menuitem", { name: "Pick arrival time" }).waitFor();
      assert.equal(await menu.getByRole("menuitem", { name: "End plan" }).count(), 0);
      assert.equal(await menu.getByRole("menuitem", { name: "End", exact: true }).count(), 0);
      assert.equal(await menu.getByRole("menuitem", { name: "Edit", exact: true }).count(), 0);
      await page.screenshot({ path: shot(`member-plan-menu-w${width}.png`) });
      await page.keyboard.press("Escape");

      const social = page.locator(".card-now", { hasText: "Quick coffee" });
      await social.locator(".card-more").click();
      await page.getByRole("menuitem", { name: "Maybe" }).waitFor();
      assert.equal(await page.getByRole("menuitem", { name: "End", exact: true }).count(), 0);
      assert.equal(await page.getByRole("menuitem", { name: "Edit", exact: true }).count(), 0);
      await page.screenshot({ path: shot(`member-social-menu-w${width}.png`) });
    } finally {
      await page.context().close();
    }
  }
});
