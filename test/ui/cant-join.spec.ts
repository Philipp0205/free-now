import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Locator, Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA, dismissPaymentReminder, useHangry } from "./harness.js";
import { testEmail } from "../http.js";

// Fake people only. Screenshots go to test/ui/screenshots (gitignored).
const SHOT_DIR = path.resolve("test/ui/screenshots/cant-join");
const hangry = useHangry({ tz: "UTC" });
const call = hangry.call;

function shot(page: Page, name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  return page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) });
}

function tomorrow(): string {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** Hana hosts Pizza night; Alex is a friend who has not answered. */
async function seed() {
  const host = await call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Hana" });
  const { circle } = await call("POST", "/api/circles", host.token, { name: "Test crew" });
  const alex = await call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Alex", code: circle.inviteCode });
  hangry.confirmEmails();
  const plan = (await call("POST", "/api/plans", host.token, { note: "Pizza night", date: tomorrow(), time: "19:00" })).plan;
  return { host, alex, plan };
}

async function openAs(token: string, width: number, height: number, opts: { compact?: boolean; scheme?: "dark" | "light" } = {}): Promise<Page> {
  const context = await hangry.browser.newContext({
    viewport: { width, height },
    colorScheme: opts.scheme ?? "dark",
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: UA,
  });
  await skipWhatsNew(context);
  await context.addInitScript(([value, compact]) => {
    localStorage.setItem("fn_token", value);
    localStorage.setItem("fn_installed", "1");
    localStorage.setItem("fn_install_later", String(Date.now()));
    if (compact) localStorage.setItem("fn_compact_home", "1");
  }, [token, opts.compact ? "1" : ""]);
  const page = await context.newPage();
  await page.goto(hangry.baseUrl);
  await page.locator(".tabbar").waitFor();
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
  await dismissPaymentReminder(page);
  return page;
}

const cant = (scope: Page | Locator) => scope.getByRole("button", { name: "Can't make it", exact: true });

async function assertTappable(button: Locator, label: string) {
  const box = await button.boundingBox();
  assert.ok(box && box.height >= 47.5 && box.width >= 48, `${label}: tappable ${JSON.stringify(box)}`);
}

async function assertRowFits(page: Page, row: Locator, label: string) {
  const width = await page.evaluate(() => document.documentElement.clientWidth);
  const count = await row.getByRole("button").count();
  for (let index = 0; index < count; index += 1) {
    const button = row.getByRole("button").nth(index);
    await button.waitFor();
    const box = await button.boundingBox();
    assert.ok(box && box.x >= -1 && box.x + box.width <= width + 1, `${label}: inside the screen ${JSON.stringify(box)}`);
    const clipped = await button.evaluate((node) => node.scrollWidth <= node.clientWidth + 1);
    assert.ok(clipped, `${label}: label not clipped`);
  }
}

test("the home card has Can't make it next to I'm in, and the menu no longer lists it", { timeout: 240_000 }, async () => {
  const { alex, plan } = await seed();
  for (const [width, height] of SIZES) {
    const page = await openAs(alex.token, width, height);
    try {
      const card = page.locator(`.card-plan[data-plan="${plan.id}"]`);
      const row = card.locator(".card-cta").first();
      const join = row.getByRole("button", { name: "I'm in", exact: true });
      await join.waitFor();
      const button = cant(row);
      assert.equal(await button.getAttribute("aria-pressed"), "false");
      assert.equal(await button.innerText(), "Can't make it");
      await assertTappable(button, `w${width}`);
      await assertRowFits(page, row, `w${width}`);
      const [a, b] = [await join.boundingBox(), await button.boundingBox()];
      assert.ok(a && b && Math.abs(a.y - b.y) < 2 && b.x > a.x, "same row, Can't after I'm in");
      assert.equal(await card.getByRole("button", { name: "Maybe", exact: true }).count(), 0, "no Maybe on the home card");
      await card.scrollIntoViewIfNeeded();
      await shot(page, `home-card-w${width}`);
      await card.locator(".card-more").click();
      await page.getByRole("menuitem", { name: "Pick arrival time" }).waitFor();
      assert.equal(await page.getByRole("menuitem", { name: "Can't make it" }).count(), 0);
      assert.equal(await page.getByRole("menuitem", { name: "Maybe" }).count(), 1, "Maybe stays in the menu");
    } finally {
      await page.context().close();
    }
  }
});

test("Can't make it marks you out, I'm in joins again, and a second tap undoes it", { timeout: 180_000 }, async () => {
  const { alex, plan } = await seed();
  const page = await openAs(alex.token, 360, 640);
  try {
    const card = page.locator(`.card-plan[data-plan="${plan.id}"]`);
    const join = card.getByRole("button", { name: /^(I'm in|In ✓)$/ });
    await cant(card).click();
    await card.locator(".cant-toggle.on").waitFor();
    assert.equal(await cant(card).getAttribute("aria-pressed"), "true");
    assert.equal(await cant(card).innerText(), "Can't ✓");
    await card.locator(".who-row", { hasText: "Waiting for friends" }).waitFor();
    assert.equal(await card.locator(".avatars > .avatar").count(), 1, "only the host is on the card");
    assert.equal(await join.getAttribute("aria-pressed"), "false");
    await shot(page, "declined-w360");
    await card.locator(".who-row").click();
    const details = page.getByRole("dialog", { name: "Details" });
    await details.getByRole("heading", { name: "Can't make it" }).waitFor();
    await details.getByText("You can't make it").waitFor();
    await cant(details).waitFor();
    await page.keyboard.press("Escape");
    await details.waitFor({ state: "detached" });

    await join.click();
    await card.locator(".in-toggle.on").waitFor();
    await card.locator(".who-row", { hasText: "You're in" }).waitFor();
    assert.equal(await cant(card).getAttribute("aria-pressed"), "false");
    assert.equal(await card.locator(".avatars > .avatar").count(), 2, "back on the card");

    await cant(card).click();
    await card.locator(".cant-toggle.on").waitFor();
    await cant(card).click();
    await card.locator(".cant-toggle:not(.on)").waitFor();
    assert.equal(await card.locator(".in-toggle").getAttribute("aria-pressed"), "false");
    const saved = await call("GET", "/api/plans", alex.token);
    assert.equal(saved.plans[0].joined.some((person: any) => person.reply === "declined"), false, "the decline was taken back");
  } finally {
    await page.context().close();
  }
});

test("the event sheet shows In, Maybe and Can't make it, in Dark and Light", { timeout: 240_000 }, async () => {
  for (const scheme of ["dark", "light"] as const) {
    for (const [width, height] of SIZES) {
      const { alex, plan } = await seed();
      const page = await openAs(alex.token, width, height, { scheme });
      try {
        await page.locator(`.card-plan[data-plan="${plan.id}"]`).getByRole("button", { name: "Open details" }).click();
        const details = page.getByRole("dialog", { name: "Details" });
        await details.waitFor();
        const tag = `${scheme}-w${width}`;
        const join = details.getByRole("button", { name: "I'm in", exact: true });
        const maybe = details.getByRole("button", { name: "Maybe", exact: true });
        await join.waitFor();
        for (const button of [join, maybe, cant(details)]) await assertTappable(button, tag);
        const rowAt = async (button: Locator) => (await button.boundingBox())!;
        const [a, b, c] = [await rowAt(join), await rowAt(maybe), await rowAt(cant(details))];
        assert.ok(b.y >= a.y - 2, `${tag}: Maybe is not above I'm in`);
        assert.ok(Math.abs(b.y - c.y) < 2 && c.x > b.x, `${tag}: Maybe and Can't share a row`);
        for (const box of [a, b, c]) assert.ok(box.x >= -1 && box.x + box.width <= width + 1, `${tag}: inside the screen`);
        await cant(details).click();
        await details.locator(".cant-toggle.on").waitFor();
        await details.getByText("You can't make it").waitFor();
        await page.waitForTimeout(300);
        await assertRowFits(page, details.locator(".card-cta").first(), tag);
        await shot(page, `sheet-${tag}`);
      } finally {
        await page.context().close();
      }
    }
  }
});

test("the host does not see Can't make it, and a compact row has no button", { timeout: 180_000 }, async () => {
  const { host, alex, plan } = await seed();
  const hostPage = await openAs(host.token, 360, 640);
  try {
    const card = hostPage.locator(`.card-plan[data-plan="${plan.id}"]`);
    await card.locator(".in-toggle.on").waitFor();
    assert.equal(await cant(hostPage).count(), 0, "not on the card");
    await card.getByRole("button", { name: "Open details" }).click();
    await hostPage.getByRole("dialog", { name: "Details" }).waitFor();
    assert.equal(await cant(hostPage).count(), 0, "not in the sheet");
    await shot(hostPage, "host-sheet-w360");
  } finally {
    await hostPage.context().close();
  }

  const compact = await openAs(alex.token, 360, 640, { compact: true });
  try {
    await compact.locator(`.compact-row[data-plan="${plan.id}"]`).waitFor();
    assert.equal(await cant(compact).count(), 0);
    assert.equal(await compact.getByRole("button", { name: "I'm in", exact: true }).count(), 0);
    await shot(compact, "compact-w360");
  } finally {
    await compact.context().close();
  }
});

test("a Free now card has Can't make it next to I'm in and no Share", { timeout: 120_000 }, async () => {
  const { host, alex } = await seed();
  const { social } = await call("POST", "/api/socials", host.token, { note: "Coffee run" });
  const page = await openAs(alex.token, 360, 640);
  try {
    const card = page.locator(`.card-now[data-social="${social.id}"]`);
    const row = card.locator(".card-cta");
    await row.getByRole("button", { name: "I'm in", exact: true }).waitFor();
    await cant(row).waitFor();
    assert.equal(await card.locator(".card-share").count(), 0);
    await shot(page, "social-w360");
    await cant(row).click();
    await card.locator(".cant-toggle.on").waitFor();
    await card.getByRole("button", { name: "I'm in", exact: true }).click();
    await card.locator(".in-toggle.on").waitFor();
  } finally {
    await page.context().close();
  }
});
