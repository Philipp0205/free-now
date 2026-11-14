import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { openPlanSheet } from "./plan-sheet.js";
import { SIZES, UA, useHangry } from "./harness.js";

// Tue 10 Nov 2026, 12:00 in Berlin. Server and browser share this clock.
const NOW = Date.parse("2026-11-10T11:00:00Z");
const SHOT_DIR = path.resolve("test/ui/screenshots/feedback-batch-1");

const hangry = useHangry({ tz: "Europe/Berlin", now: () => NOW });
const { call } = hangry;

async function phone(width: number, height: number, token: string, circleId: string): Promise<Page> {
  const context = await hangry.browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: UA });
  await skipWhatsNew(context);
  await context.addInitScript(([value, circle]) => {
    localStorage.setItem("fn_install_later", String(Date.now()));
    localStorage.setItem("fn_installed", "1");
    localStorage.setItem("fn_token", value);
    localStorage.setItem("fn_circle", circle);
  }, [token, circleId]);
  await context.route(/arcgisonline|tile\.openstreetmap|basemaps\.cartocdn|protomaps|\.pmtiles/, (route) => route.fulfill({ status: 204, body: "" }));
  const page = await context.newPage();
  await page.clock.setFixedTime(NOW);
  await page.goto(hangry.baseUrl);
  await page.getByRole("heading", { name: "Now", exact: true, level: 1 }).waitFor();
  return page;
}

async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}-w${page.viewportSize()!.width}.png`) });
}

async function signUp(name: string) {
  const host = await call("POST", "/api/auth/start", undefined, { name });
  const { circle } = await call("POST", "/api/circles", host.token, { name: `Batch ${name}` });
  return { host, circle };
}

const scrollTop = (page: Page) => page.evaluate(() => document.scrollingElement!.scrollTop);

test("at 390x844: Plan for this day is visible above the tab bar without scrolling", { timeout: 90_000 }, async () => {
  const { host, circle } = await signUp("Dana");
  const page = await phone(390, 844, host.token, circle.id);
  try {
    await page.locator(".tabbar").getByRole("button", { name: "Events", exact: true }).click();
    await page.locator(".cal-grid").waitFor();
    await page.locator('.cal-cell[data-day="2026-11-12"]').click();
    const add = page.getByRole("button", { name: "Plan for this day", exact: true });
    await add.waitFor();
    const box = await add.boundingBox();
    const bar = await page.locator(".tabbar").boundingBox();
    assert.ok(box && bar, "button and tab bar have boxes");
    assert.equal(await page.evaluate(() => document.scrollingElement!.scrollTop), 0, "page is not scrolled");
    assert.ok(box.y >= 0, `button top ${box.y} is on screen`);
    assert.ok(box.y + box.height <= bar.y, `button bottom ${box.y + box.height} clears the tab bar at ${bar.y}`);
    assert.ok(box.height >= 48, `button is ${box.height}px tall`);
    assert.ok(box.width >= 390 - 40, `button is ${box.width}px wide`);
    await shot(page, "calendar-day-button-390x844");
  } finally {
    await page.context().close();
  }
});

for (const [width, height] of SIZES) {
  test(`at ${width}: the plan note placeholder suggests the tacos`, { timeout: 90_000 }, async () => {
    const { host, circle } = await signUp("Tess");
    const page = await phone(width, height, host.token, circle.id);
    try {
      await openPlanSheet(page);
      assert.equal(await page.locator("#sheet-note").getAttribute("placeholder"), "Amanda's inviting everyone for free tacos");
      await shot(page, "plan-placeholder");
    } finally {
      await page.context().close();
    }
  });

  test(`at ${width}: Plan for this day starts a plan on the picked calendar day`, { timeout: 90_000 }, async () => {
    const { host, circle } = await signUp("Cara");
    const page = await phone(width, height, host.token, circle.id);
    try {
      await page.locator(".tabbar").getByRole("button", { name: "Events", exact: true }).click();
      await page.locator(".cal-grid").waitFor();
      const add = page.getByRole("button", { name: "Plan for this day", exact: true });

      // A past day cannot be planned.
      await page.locator('.cal-cell[data-day="2026-11-03"]').click();
      await page.locator('.cal-cell[data-day="2026-11-03"][aria-pressed="true"]').waitFor();
      assert.equal(await add.count(), 0, "no button on a past day");

      // Today and later can, also when the month is empty.
      await page.locator('.cal-cell[data-day="2026-11-12"]').click();
      await add.waitFor();
      // Prominent: a big tap target at every size.
      const box = await add.boundingBox();
      assert.ok(box, "button has a box");
      assert.ok(box.height >= 44, `button is ${box.height}px tall`);
      await shot(page, "calendar-day-button");
      await add.click();
      await page.locator("#plan-date").waitFor();
      assert.equal(await page.locator("#plan-date").inputValue(), "2026-11-12");
      assert.equal(await page.locator("#plan-time").inputValue(), "");
      await page.locator("#sheet-note").fill("Tacos at Amanda's");
      await shot(page, "calendar-day-sheet");
      await page.getByRole("button", { name: "Add plan" }).click();
      await page.locator("form.sheet").waitFor({ state: "detached" });

      // The plan shows on that day, and the day's cell shows an event.
      const row = page.locator(".cal-day .cal-event", { hasText: "Tacos at Amanda's" });
      await row.waitFor();
      assert.equal(await page.locator('.cal-cell[data-day="2026-11-12"] .cal-crowd').count(), 1, "cell shows the event");
      assert.equal(await page.locator('.cal-cell[data-day="2026-11-12"]').getAttribute("aria-pressed"), "true");
      await shot(page, "calendar-day-added");

      // The button is also there on a day that already has plans.
      assert.equal(await add.count(), 1);
    } finally {
      await page.context().close();
    }
  });

  test(`at ${width}: Back from a card, its chat and a place keeps the scroll on Now`, { timeout: 120_000 }, async () => {
    const { host, circle } = await signUp("Hana");
    for (let i = 1; i <= 8; i++) {
      await call("POST", "/api/plans", host.token, { note: `Plan number ${i}`, date: `2026-11-${String(10 + i).padStart(2, "0")}` });
    }
    await call("POST", "/api/socials", host.token, { note: "Coffee now", place: "Schlossplatz", lat: 48.7784, lng: 9.18 });
    const page = await phone(width, height, host.token, circle.id);
    try {
      await page.locator("[data-plan]").nth(7).waitFor();
      const scrollTo = async () => {
        await page.evaluate(() => window.scrollTo(0, 500));
        await page.waitForFunction(() => document.scrollingElement!.scrollTop === 500);
      };
      const near = async (tag: string) => {
        await page.waitForTimeout(250);
        const y = await scrollTop(page);
        assert.ok(Math.abs(y - 500) <= 2, `${tag}: scrollTop ${y}`);
      };

      // Card details sheet, closed with the phone's Back.
      await scrollTo();
      await page.locator("[data-plan] .card-body").nth(2).evaluate((node) => (node as HTMLElement).click());
      await page.locator("form.sheet, .sheet").first().waitFor();
      await page.evaluate(() => history.back());
      await page.locator(".sheet").waitFor({ state: "detached" });
      await near("details sheet");
      await shot(page, "back-keeps-scroll");

      // Event chat, closed with the in-app Back.
      await page.locator("[data-plan] .chat-row").nth(2).evaluate((node) => (node as HTMLElement).click());
      await page.locator(".chat-screen").waitFor();
      await page.locator(".chat-screen .chat-back").click();
      await page.locator(".chat-screen").waitFor({ state: "detached" });
      await near("chat screen");

      // A place jumps to the Events map; Android Back returns to Now where it was.
      await page.getByRole("button", { name: "Show Schlossplatz on the map" }).evaluate((node) => (node as HTMLElement).click());
      await page.locator(".map-card").waitFor({ timeout: 8000 });
      await page.goBack();
      await page.locator(".map-card").waitFor({ state: "detached" });
      await page.getByRole("heading", { name: "Now", exact: true, level: 1 }).waitFor();
      await near("place and back");

      // A tab bar switch still starts at the top of the other page.
      await page.locator(".tabbar").getByRole("button", { name: "Events", exact: true }).click();
      await page.locator(".events-view").waitFor();
      assert.equal(await scrollTop(page), 0, "tab switch starts at the top");
    } finally {
      await page.context().close();
    }
  });
}
