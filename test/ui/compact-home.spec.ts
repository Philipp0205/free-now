import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA, dismissPaymentReminder, useHangry } from "./harness.js";
import { testEmail } from "../http.js";

// Fake people only. Screenshots go to test/ui/screenshots (gitignored).
const SHOT_DIR = path.resolve("test/ui/screenshots/compact-home");
const hangry = useHangry({ tz: "UTC" });
const call = hangry.call;

const LONG_NAME = "Annual neighbourhood board game marathon with snacks and too many house rules";
const KEY = "fn_compact_home";

function shot(page: Page, name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  return page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) });
}

function daysAhead(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function start(name: string, code?: string) {
  return call("POST", "/api/auth/start", undefined, { email: testEmail(), name, ...(code ? { code } : {}) });
}

/** Hana hosts Pizza night (five friends in), a long-named plan (two in) and a live Coffee run. Hana owes nothing. */
async function seed() {
  const host = await start("Hana");
  const { circle } = await call("POST", "/api/circles", host.token, { name: "Test crew" });
  const friends = [];
  for (const name of ["Alex", "Bea", "Cy", "Dee", "Eli"]) friends.push(await start(name, circle.inviteCode));
  hangry.confirmEmails();
  const pizza = (await call("POST", "/api/plans", host.token, { note: "Pizza night", date: daysAhead(1), time: "19:00" })).plan;
  for (const friend of friends) await call("POST", `/api/plans/${pizza.id}/reply`, friend.token, { reply: "in" });
  const long = (await call("POST", "/api/plans", host.token, { note: LONG_NAME, date: daysAhead(2), time: "20:00" })).plan;
  for (const friend of friends.slice(0, 2)) await call("POST", `/api/plans/${long.id}/reply`, friend.token, { reply: "in" });
  const coffee = (await call("POST", "/api/socials", host.token, { note: "Coffee run" })).social;
  await call("POST", `/api/socials/${coffee.id}/reply`, friends[0].token, { reply: "in" });
  return { host, friends, pizza, long, coffee };
}

async function openAs(token: string, width: number, height: number, opts: { mobile?: boolean; scheme?: "dark" | "light" } = {}): Promise<Page> {
  const mobile = opts.mobile ?? true;
  const context = await hangry.browser.newContext({
    viewport: { width, height },
    colorScheme: opts.scheme ?? "dark",
    ...(mobile ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: UA } : { deviceScaleFactor: 1 }),
  });
  await skipWhatsNew(context);
  await context.addInitScript((value) => {
    localStorage.setItem("fn_token", value);
    localStorage.setItem("fn_installed", "1");
    localStorage.setItem("fn_install_later", String(Date.now()));
  }, token);
  const page = await context.newPage();
  await page.goto(hangry.baseUrl);
  await page.locator(".tabbar").waitFor();
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
  await dismissPaymentReminder(page);
  return page;
}

const toggle = (page: Page) => page.getByRole("group", { name: "Event list" });

/** Every line is one row: one text line tall, inside the screen, with name, faces and date all visible. */
async function checkRows(page: Page, tag: string) {
  const rows = page.locator(".compact-row");
  assert.equal(await rows.count(), 3, `${tag}: one line per event`);
  const viewport = await page.evaluate(() => document.documentElement.clientWidth);
  for (let i = 0; i < 3; i += 1) {
    const row = rows.nth(i);
    const box = await row.boundingBox();
    assert.ok(box, `${tag}: row ${i} has a box`);
    assert.ok(box.height <= 56, `${tag}: row ${i} stays one line (${box.height}px)`);
    assert.ok(box.x >= -1 && box.x + box.width <= viewport + 1, `${tag}: row ${i} fits the screen`);
    for (const part of [".compact-title", ".compact-who", ".compact-when"]) {
      const inner = await row.locator(part).boundingBox();
      assert.ok(inner && inner.width > 0, `${tag}: row ${i} shows ${part}`);
      assert.ok(inner.x >= box.x - 1 && inner.x + inner.width <= box.x + box.width + 1, `${tag}: ${part} of row ${i} stays inside the row`);
    }
    assert.equal(await row.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true, `${tag}: row ${i} does not overflow sideways`);
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, `${tag}: the page does not scroll sideways`);
}

async function checkContent(page: Page, tag: string) {
  const [coffee, pizza, long] = [page.locator(".compact-row").nth(0), page.locator(".compact-row").nth(1), page.locator(".compact-row").nth(2)];
  assert.equal(await coffee.locator(".compact-title").innerText(), "Coffee run");
  assert.equal(await coffee.locator(".compact-when").innerText(), "Now");
  assert.equal(await coffee.locator(".compact-faces > :not(.compact-more)").count(), 2, `${tag}: host and Alex`);
  assert.equal(await coffee.locator(".compact-more").count(), 0);

  assert.equal(await pizza.locator(".compact-title").innerText(), "Pizza night");
  assert.equal(await pizza.locator(".compact-when").innerText(), "Tomorrow 19:00");
  assert.equal(await pizza.locator(".compact-faces > :not(.compact-more)").count(), 3, `${tag}: a few faces`);
  assert.equal(await pizza.locator(".compact-more").innerText(), "+3", `${tag}: the rest as +N`);
  assert.equal(await pizza.locator(".visually-hidden").textContent(), "Hana, Alex, Bea and 3 more");

  assert.equal(await long.locator(".compact-title").innerText(), LONG_NAME);
  const clipped = await long.locator(".compact-title").evaluate((node) => ({
    over: node.scrollWidth > node.clientWidth,
    ellipsis: getComputedStyle(node).textOverflow === "ellipsis" && getComputedStyle(node).whiteSpace === "nowrap",
  }));
  assert.equal(clipped.over, true, `${tag}: the long name is cut, not wrapped`);
  assert.equal(clipped.ellipsis, true, `${tag}: with an ellipsis`);
  assert.equal(await pizza.locator(".compact-title").evaluate((node) => node.scrollWidth <= node.clientWidth), true, `${tag}: a short name is whole`);
}

test("Now starts on cards, Compact shows one line per event, a tap opens it, and the choice survives a reload", { timeout: 300_000 }, async () => {
  const { host, pizza } = await seed();
  const errors: string[] = [];
  for (const [width, height] of SIZES) {
    const tag = `${width}x${height}`;
    const page = await openAs(host.token, width, height);
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      // Default: the cards, and nothing from the compact list.
      await page.locator(".card-plan").first().waitFor();
      assert.equal(await page.locator(".card").count(), 3, `${tag}: three cards`);
      assert.equal(await page.locator(".compact-row").count(), 0);
      const group = toggle(page);
      assert.equal(await group.getByRole("button", { name: "Cards" }).getAttribute("aria-pressed"), "true");
      assert.equal(await group.getByRole("button", { name: "Compact" }).getAttribute("aria-pressed"), "false");
      assert.equal(await page.evaluate((key) => localStorage.getItem(key), KEY), null, "nothing is saved until a choice is made");
      await shot(page, `cards-${tag}`);

      // Compact.
      await group.getByRole("button", { name: "Compact" }).click();
      await page.locator(".compact-row").first().waitFor();
      assert.equal(await page.locator(".card").count(), 0, `${tag}: no cards in compact`);
      assert.equal(await group.getByRole("button", { name: "Compact" }).getAttribute("aria-pressed"), "true");
      assert.equal(await group.getByRole("button", { name: "Cards" }).getAttribute("aria-pressed"), "false");
      assert.equal(await page.evaluate((key) => localStorage.getItem(key), KEY), "1");
      await checkRows(page, tag);
      await checkContent(page, tag);
      await shot(page, `compact-${tag}`);
      await page.locator(".compact-row", { hasText: "Annual neighbourhood" }).scrollIntoViewIfNeeded();
      await shot(page, `compact-long-name-${tag}`);

      // A tap opens the same details a card tap opens.
      await page.locator(".compact-row", { hasText: "Pizza night" }).click();
      const details = page.getByRole("dialog", { name: "Details" });
      await details.waitFor();
      await details.getByText("Pizza night").first().waitFor();
      await shot(page, `compact-opened-${tag}`);
      await page.keyboard.press("Escape");
      await details.waitFor({ state: "detached" });

      // Reload keeps compact.
      await page.reload();
      await page.locator(".compact-row").first().waitFor();
      await dismissPaymentReminder(page, 500);
      assert.equal(await page.locator(".card").count(), 0, `${tag}: still compact after a reload`);
      assert.equal(await toggle(page).getByRole("button", { name: "Compact" }).getAttribute("aria-pressed"), "true");
      await checkRows(page, `${tag} reloaded`);

      // Back to cards, and that is kept too.
      await toggle(page).getByRole("button", { name: "Cards" }).click();
      await page.locator(`.card-plan[data-plan="${pizza.id}"]`).waitFor();
      assert.equal(await page.locator(".compact-row").count(), 0);
      assert.equal(await page.evaluate((key) => localStorage.getItem(key), KEY), "0");
      await page.reload();
      await page.locator(".card-plan").first().waitFor();
      assert.equal(await page.locator(".compact-row").count(), 0, `${tag}: cards after a reload`);
    } finally {
      await page.context().close();
    }
  }
  assert.deepEqual(errors, []);
});

test("opening a compact row shows the full event, where I'm in works and can be undone", { timeout: 300_000 }, async () => {
  const { friends } = await seed();
  const errors: string[] = [];
  for (const [width, height] of SIZES) {
    const tag = `${width}x${height}`;
    // Bea is not in Coffee run yet, and the compact list has no In button of its own.
    const page = await openAs(friends[1].token, width, height);
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await toggle(page).getByRole("button", { name: "Compact" }).click();
      await page.locator(".compact-row", { hasText: "Coffee run" }).waitFor();
      assert.equal(await page.locator(".in-toggle").count(), 0, `${tag}: no In button on the list`);
      await page.locator(".compact-row", { hasText: "Coffee run" }).click();
      const details = page.getByRole("dialog", { name: "Details" });
      await details.waitFor();
      await details.getByRole("heading", { name: "Coffee run" }).waitFor();
      await details.getByRole("heading", { name: "Who's in" }).waitFor();
      const inButton = details.getByRole("button", { name: "I'm in" });
      await inButton.waitFor();
      assert.equal(await details.locator(".list", { hasText: "Alex" }).count(), 1, `${tag}: Alex is listed`);
      assert.equal(await details.getByText("You're in").count(), 0, `${tag}: not in yet`);
      await shot(page, `compact-open-before-${tag}`);

      await inButton.click();
      const done = details.getByRole("button", { name: "In ✓" });
      await done.waitFor();
      assert.equal(await done.getAttribute("aria-pressed"), "true");
      await details.locator(".reply-line", { hasText: "You're in" }).waitFor();
      await page.waitForTimeout(500);
      await shot(page, `compact-open-in-${tag}`);

      // The reply can be changed from the same sheet.
      await done.click();
      await details.getByRole("button", { name: "I'm in" }).waitFor();
      await details.locator(".reply-line", { hasText: "You're in" }).waitFor({ state: "detached" });
      await page.waitForTimeout(500);
      await shot(page, `compact-open-undone-${tag}`);
    } finally {
      await page.context().close();
    }
  }
  assert.deepEqual(errors, []);
});

test("the toggle works from the keyboard and names itself for assistive tech", { timeout: 120_000 }, async () => {
  const { host } = await seed();
  const page = await openAs(host.token, 360, 640);
  try {
    await page.locator(".card").first().waitFor();
    const group = toggle(page);
    assert.equal(await group.getAttribute("role"), "group");
    const compact = group.getByRole("button", { name: "Compact" });
    await compact.focus();
    await page.keyboard.press("Enter");
    await page.locator(".compact-row").first().waitFor();
    // The page rebuilds on a switch; focus returns to the same button, so Space can switch back.
    await group.getByRole("button", { name: "Cards" }).focus();
    await page.keyboard.press("Space");
    await page.locator(".card").first().waitFor();
    assert.equal(await page.locator(".compact-row").count(), 0);
    // A line is a real button: Tab reaches it and Enter opens it.
    await compact.focus();
    await page.keyboard.press("Space");
    const row = page.locator(".compact-row", { hasText: "Coffee run" });
    await row.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("dialog", { name: "Details" }).waitFor();
  } finally {
    await page.context().close();
  }
});

test("compact reads well on desktop and in the light scheme", { timeout: 180_000 }, async () => {
  const { host } = await seed();
  const desktop = await openAs(host.token, 1280, 800, { mobile: false });
  try {
    await desktop.locator(".card").first().waitFor();
    await shot(desktop, "cards-1280x800");
    await toggle(desktop).getByRole("button", { name: "Compact" }).click();
    await desktop.locator(".compact-row").first().waitFor();
    await checkRows(desktop, "1280");
    await checkContent(desktop, "1280");
    await shot(desktop, "compact-1280x800");
  } finally {
    await desktop.context().close();
  }
  const light = await openAs(host.token, 360, 640, { scheme: "light" });
  try {
    await light.locator(".card").first().waitFor();
    await shot(light, "cards-light-360x640");
    await toggle(light).getByRole("button", { name: "Compact" }).click();
    await light.locator(".compact-row").first().waitFor();
    await checkRows(light, "light");
    await checkContent(light, "light");
    await shot(light, "compact-light-360x640");
    const colors = await light.locator(".compact-row").first().evaluate((node) => ({
      bg: getComputedStyle(node).backgroundColor,
      page: getComputedStyle(document.body).backgroundColor,
    }));
    assert.notEqual(colors.bg, "rgba(0, 0, 0, 0)", "the row has a surface in light");
  } finally {
    await light.context().close();
  }
});

test("with no events there is no toggle, even when compact is saved", { timeout: 120_000 }, async () => {
  const lone = await start("Zed");
  await call("POST", "/api/circles", lone.token, { name: "Quiet crew" });
  const page = await openAs(lone.token, 360, 640);
  try {
    await page.evaluate((key) => localStorage.setItem(key, "1"), KEY);
    await page.reload();
    await page.getByRole("button", { name: "Past events" }).waitFor();
    await dismissPaymentReminder(page, 500);
    assert.equal(await toggle(page).count(), 0, "no toggle without events");
    assert.equal(await page.locator(".compact-row, .card").count(), 0);
    await shot(page, "empty-360x640");
  } finally {
    await page.context().close();
  }
});
