import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA, dismissPaymentReminder, useHangry } from "./harness.js";
import { testEmail } from "../http.js";

// Fake people only. Screenshots go to test/ui/screenshots (gitignored).
const SHOT_DIR = path.resolve("test/ui/screenshots/joining-filter");
const hangry = useHangry({ tz: "UTC" });
const call = hangry.call;
const KEY = "fn_joining_only";
const KEPT = ["Hosted plan", "Joined plan", "Maybe plan"];
const HIDDEN = ["Declined plan", "Quiet plan"];

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

/** Hana is the viewer. Bea hosts four plans for Hana: In, Maybe, Can't join and no reply. Hana hosts one. Cy only watches. */
async function seed() {
  const hana = await start("Hana");
  const { circle } = await call("POST", "/api/circles", hana.token, { name: "Test crew" });
  const bea = await start("Bea", circle.inviteCode);
  const cy = await start("Cy", circle.inviteCode);
  hangry.confirmEmails();
  const date = daysAhead(1);
  await call("POST", "/api/plans", hana.token, { note: "Hosted plan", date, time: "10:00" });
  const replies: [string, string, string][] = [
    ["Joined plan", "11:00", "in"],
    ["Maybe plan", "12:00", "maybe"],
    ["Declined plan", "13:00", "declined"],
    ["Quiet plan", "14:00", ""],
  ];
  for (const [note, time, reply] of replies) {
    const plan = (await call("POST", "/api/plans", bea.token, { note, date, time })).plan;
    if (reply) await call("POST", `/api/plans/${plan.id}/reply`, hana.token, { reply });
  }
  return { hana, cy, date };
}

async function openAs(token: string, width: number, height: number, scheme: "dark" | "light" = "dark"): Promise<Page> {
  const context = await hangry.browser.newContext({
    viewport: { width, height },
    colorScheme: scheme,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: UA,
  });
  await skipWhatsNew(context);
  await context.addInitScript((value) => {
    if (!localStorage.getItem("fn_token")) localStorage.setItem("fn_token", value);
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

const chip = (page: Page) => page.getByRole("button", { name: "Joining only", exact: true });

async function expectHome(page: Page, shown: string[], gone: string[], tag: string) {
  for (const name of shown) await page.locator(".card", { hasText: name }).first().waitFor();
  for (const name of gone) assert.equal(await page.locator(".card", { hasText: name }).count(), 0, `${tag}: ${name} hidden`);
}

async function openCalendarDay(page: Page, date: string) {
  await page.locator(".tabbar").getByRole("button", { name: "Events", exact: true }).click();
  await page.locator(`.cal-cell[data-day="${date}"]`).click();
  await page.locator(".cal-below").waitFor();
}

async function expectRows(page: Page, shown: string[], gone: string[], tag: string) {
  for (const name of shown) await page.locator(".cal-event", { hasText: name }).waitFor();
  for (const name of gone) assert.equal(await page.locator(".cal-event", { hasText: name }).count(), 0, `${tag}: ${name} hidden`);
}

test("Now: the chip is off by default, filters on tap, survives a reload and turns off again", { timeout: 300_000 }, async () => {
  const { hana } = await seed();
  const errors: string[] = [];
  for (const [width, height] of SIZES) {
    const tag = `${width}x${height}`;
    const page = await openAs(hana.token, width, height, width === 360 ? "light" : "dark");
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await expectHome(page, [...KEPT, ...HIDDEN], [], tag);
      await chip(page).waitFor();
      assert.equal(await chip(page).getAttribute("aria-pressed"), "false");
      const box = await chip(page).boundingBox();
      assert.ok(box && box.height >= 32, `${tag}: the chip is tappable`);
      assert.equal(await page.evaluate((key) => localStorage.getItem(key), KEY), null);
      await shot(page, `home-off-${tag}`);

      await chip(page).click();
      assert.equal(await chip(page).getAttribute("aria-pressed"), "true");
      await expectHome(page, KEPT, HIDDEN, tag);
      assert.equal(await page.evaluate((key) => localStorage.getItem(key), KEY), "1");
      await shot(page, `home-on-${tag}`);

      await page.reload();
      await chip(page).waitFor();
      await dismissPaymentReminder(page, 500);
      assert.equal(await chip(page).getAttribute("aria-pressed"), "true", `${tag}: still on after reload`);
      await expectHome(page, KEPT, HIDDEN, `${tag} reloaded`);

      await chip(page).click();
      assert.equal(await chip(page).getAttribute("aria-pressed"), "false");
      await expectHome(page, [...KEPT, ...HIDDEN], [], `${tag} off`);
      assert.equal(await page.evaluate((key) => localStorage.getItem(key), KEY), "0");
    } finally {
      await page.context().close();
    }
  }
  assert.deepEqual(errors, []);
});

test("Events: Calendar and Map show the chip, the day list follows it, and the choice is shared with Now", { timeout: 300_000 }, async () => {
  const { hana, date } = await seed();
  for (const [width, height] of SIZES) {
    const tag = `${width}x${height}`;
    const page = await openAs(hana.token, width, height);
    try {
      await openCalendarDay(page, date);
      await expectRows(page, [...KEPT, ...HIDDEN], [], tag);
      assert.equal(await chip(page).getAttribute("aria-pressed"), "false");
      await shot(page, `calendar-off-${tag}`);

      await chip(page).click();
      await expectRows(page, KEPT, HIDDEN, tag);
      assert.match(await page.locator(`.cal-cell[data-day="${date}"]`).getAttribute("aria-label") || "", /3 events/, `${tag}: the cell matches`);
      await shot(page, `calendar-on-${tag}`);

      // Same flag on the map view and back on Now.
      await page.getByRole("button", { name: "Map", exact: true }).click();
      await chip(page).waitFor();
      assert.equal(await chip(page).getAttribute("aria-pressed"), "true", `${tag}: shared with the map view`);
      await shot(page, `map-on-${tag}`);
      await page.getByRole("button", { name: "Calendar", exact: true }).click();
      await page.locator(".tabbar").getByRole("button", { name: "Now", exact: true }).click();
      assert.equal(await chip(page).getAttribute("aria-pressed"), "true", `${tag}: shared with Now`);
      await expectHome(page, KEPT, HIDDEN, tag);

      await page.reload();
      await dismissPaymentReminder(page, 500);
      await openCalendarDay(page, date);
      await expectRows(page, KEPT, HIDDEN, `${tag} reloaded`);

      await chip(page).click();
      await expectRows(page, [...KEPT, ...HIDDEN], [], `${tag} off`);
    } finally {
      await page.context().close();
    }
  }
});

test("a filter that hides everything keeps the chip and says why, on Now and on Events", { timeout: 300_000 }, async () => {
  const { cy, date } = await seed();
  for (const [width, height] of SIZES) {
    const tag = `${width}x${height}`;
    const page = await openAs(cy.token, width, height);
    try {
      await page.locator(".card", { hasText: "Quiet plan" }).first().waitFor();
      await chip(page).click();
      await page.getByText("Nothing you're joining. Turn off Joining only to see the rest.", { exact: true }).waitFor();
      assert.equal(await page.locator(".card").count(), 0, `${tag}: no cards`);
      assert.equal(await chip(page).getAttribute("aria-pressed"), "true", `${tag}: the chip stays`);
      await shot(page, `home-empty-${tag}`);

      await openCalendarDay(page, date);
      await page.getByRole("heading", { name: "Nothing you're joining this month." }).waitFor();
      await chip(page).waitFor();
      assert.equal(await page.getByText("Nothing planned this month.").count(), 0);
      await shot(page, `calendar-empty-${tag}`);

      await chip(page).click();
      await page.locator(".cal-event", { hasText: "Quiet plan" }).waitFor();
    } finally {
      await page.context().close();
    }
  }
});
