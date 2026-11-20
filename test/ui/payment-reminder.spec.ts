import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA, openYou, openYouSection, useHangry } from "./harness.js";
import { testEmail } from "../http.js";
import { DISMISS_KEY, REMINDER_LEVELS, REMINDER_THROTTLE_MS } from "../../public/js/payment-reminder.js";

// Fake people only. Screenshots go to test/ui/screenshots (gitignored).
const SHOT_DIR = path.resolve("test/ui/screenshots/payment-reminder");
const hangry = useHangry({ tz: "UTC" });
const call = hangry.call;

async function shot(page: Page, name: string, width: number, height: number) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.evaluate(() => Promise.all(document.getAnimations()
    .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime as number))
    .map((animation) => animation.finished.catch(() => {}))));
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}-${width}x${height}.png`) });
}

function tomorrow(): string {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

type Person = { token: string; user: { id: string } };

async function start(name: string, code?: string): Promise<Person> {
  return call("POST", "/api/auth/start", undefined, { email: testEmail(), name, ...(code ? { code } : {}) });
}

/**
 * Alex hosts Ramen (10.00) in Friends. Bea and Sam are in. Cleo hosts Climbing (8.00) in Work, and Sam is in that too.
 * So Sam owes two bills, Bea owes one, and Alex and Cleo are only owed money. Everyone with a bill can pay by PayPal or Wero.
 */
async function seed() {
  const alex = await start("Alex");
  const friends = (await call("POST", "/api/circles", alex.token, { name: "Friends" })).circle;
  const bea = await start("Bea", friends.inviteCode);
  const sam = await start("Sam", friends.inviteCode);
  const cleo = await start("Cleo");
  const work = (await call("POST", "/api/circles", cleo.token, { name: "Work" })).circle;
  await call("POST", "/api/circles/join", sam.token, { code: work.inviteCode });
  hangry.confirmEmails();
  await call("PATCH", "/api/me", alex.token, { paymentUrl: "https://paypal.me/HangryAlex", weroEmail: "alex.wero@example.com" });
  await call("PATCH", "/api/me", cleo.token, { paymentUrl: "https://paypal.me/HangryCleo", weroEmail: "cleo.wero@example.com" });

  const ramen = (await call("POST", `/api/socials?circle=${friends.id}`, alex.token, { note: "Ramen" })).social;
  await call("PATCH", `/api/socials/${ramen.id}?circle=${friends.id}`, alex.token, { price: "10" });
  for (const person of [bea, sam]) await call("POST", `/api/socials/${ramen.id}/reply?circle=${friends.id}`, person.token, { reply: "in" });

  const climbing = (await call("POST", "/api/plans", cleo.token, { note: "Climbing", date: tomorrow() })).plan;
  await call("PATCH", `/api/plans/${climbing.id}`, cleo.token, { price: "8" });
  await call("POST", `/api/plans/${climbing.id}/reply?circle=${work.id}`, sam.token, { reply: "in" });
  return { alex, bea, sam, cleo };
}

type Open = { dismissed?: number; skew?: boolean };

/**
 * A phone signed in as `token`. `dismissed` starts the device with that many dismissals, once per tab, so a reload keeps
 * whatever the app stored. `skew` lets a test move Date.now forward with window.__skew to cross the throttle window.
 */
async function openAs(token: string, width: number, height: number, options: Open = {}): Promise<Page> {
  const context = await hangry.browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: UA });
  await skipWhatsNew(context);
  await context.addInitScript(({ value, key, dismissed, skew }) => {
    localStorage.setItem("fn_token", value);
    localStorage.setItem("fn_installed", "1");
    localStorage.setItem("fn_install_later", String(Date.now()));
    if (!sessionStorage.getItem("seeded")) {
      sessionStorage.setItem("seeded", "1");
      if (dismissed !== undefined) localStorage.setItem(key, String(dismissed));
    }
    if (skew) {
      const realNow = Date.now.bind(Date);
      Date.now = () => realNow() + ((window as unknown as { __skew?: number }).__skew || 0);
    }
  }, { value: token, key: DISMISS_KEY, dismissed: options.dismissed, skew: Boolean(options.skew) });
  const page = await context.newPage();
  await load(page);
  return page;
}

async function load(page: Page, reload = false) {
  if (reload) await page.reload();
  else await page.goto(hangry.baseUrl);
  await page.locator(".tabbar").waitFor();
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
}

const reminder = (page: Page) => page.getByRole("dialog", { name: "Payment reminder" });
const stored = (page: Page) => page.evaluate((key) => localStorage.getItem(key), DISMISS_KEY);

async function noSideways(page: Page, tag: string) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, `${tag}: nothing runs off sideways`);
}

async function away(page: Page, hidden: boolean) {
  await page.evaluate((value) => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => value });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

test("a cold start with a bill to pay opens the reminder: who, how much, and how to pay", { timeout: 300_000 }, async () => {
  const { sam } = await seed();
  const errors: string[] = [];
  for (const [width, height] of SIZES) {
    const tag = `${width}x${height}`;
    const page = await openAs(sam.token, width, height);
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      const sheet = reminder(page);
      await sheet.waitFor({ timeout: 20_000 });
      assert.equal(await sheet.getAttribute("data-level"), "1", tag);
      await sheet.getByRole("heading", { name: "Quick reminder" }).waitFor();
      await sheet.getByText(REMINDER_LEVELS[0].body).waitFor();

      const ramen = sheet.locator(".bill", { hasText: "Ramen" });
      await ramen.getByText(/To Alex/).waitFor();
      await ramen.getByText(/Friends/).waitFor();
      assert.equal(await ramen.locator(".bill-amount").innerText(), "€10.00", tag);
      assert.equal(await ramen.getByRole("link", { name: "Pay €10.00 with PayPal" }).getAttribute("href"), "https://www.paypal.me/HangryAlex/10.00EUR", tag);
      await ramen.getByText("alex.wero@example.com").waitFor();
      await ramen.getByRole("button", { name: "Mark Ramen paid" }).waitFor();

      const climbing = sheet.locator(".bill", { hasText: "Climbing" });
      await climbing.getByText(/To Cleo/).waitFor();
      await climbing.getByText(/Work/).waitFor();
      assert.equal(await climbing.locator(".bill-amount").innerText(), "€8.00", tag);
      await climbing.getByRole("button", { name: "Mark Climbing paid" }).waitFor();

      await sheet.getByRole("button", { name: "Later" }).waitFor();
      assert.equal(await page.locator(".bill").count(), 2, `${tag}: one row per bill`);
      await noSideways(page, tag);
      await shot(page, "level-1", width, height);
    } finally {
      await page.context().close();
    }
  }
  assert.deepEqual(errors, []);
});

test("each time it is dismissed without paying, the next one is ruder, up to level 5", { timeout: 300_000 }, async () => {
  const { bea } = await seed();
  const errors: string[] = [];
  const page = await openAs(bea.token, 360, 640);
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    const levels: string[] = [];
    // Later, the scrim and the sheet's own Later all count the same.
    for (let round = 0; round < 6; round += 1) {
      const sheet = reminder(page);
      await sheet.waitFor({ timeout: 20_000 });
      const level = await sheet.getAttribute("data-level");
      levels.push(level ?? "");
      const copy = REMINDER_LEVELS[Number(level) - 1];
      await sheet.getByRole("heading", { name: copy.heading, exact: true }).waitFor();
      await sheet.getByText(copy.body).waitFor();
      await shot(page, `escalation-level-${level}${round === 5 ? "-again" : ""}`, 360, 640);
      if (round % 2 === 0) await sheet.getByRole("button", { name: "Later" }).click();
      else await page.locator(".scrim").click({ position: { x: 10, y: 10 } });
      await sheet.waitFor({ state: "detached" });
      assert.equal(await stored(page), String(Math.min(5, round + 1)), `round ${round}: the dismissal was counted`);
      await load(page, true);
    }
    assert.deepEqual(levels, ["1", "2", "3", "4", "5", "5"]);
  } finally {
    await page.context().close();
  }
  assert.deepEqual(errors, []);
});

test("every level reads well on the smallest and the biggest phone", { timeout: 300_000 }, async () => {
  const { bea } = await seed();
  const errors: string[] = [];
  for (const dismissed of [0, 4]) {
    for (const [width, height] of [SIZES[0], SIZES[2]]) {
      const tag = `${dismissed}-${width}x${height}`;
      const page = await openAs(bea.token, width, height, { dismissed });
      page.on("pageerror", (error) => errors.push(error.message));
      try {
        const sheet = reminder(page);
        await sheet.waitFor({ timeout: 20_000 });
        assert.equal(await sheet.getAttribute("data-level"), String(dismissed + 1), tag);
        await noSideways(page, tag);
        const box = await sheet.boundingBox();
        assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1 && box.y >= 0, `${tag}: the sheet fits the screen`);
        await shot(page, `level-${dismissed + 1}`, width, height);
      } finally {
        await page.context().close();
      }
    }
  }
  assert.deepEqual(errors, []);
});

test("the throttle: hiding and showing again inside the window does not reopen it, after the window it does", { timeout: 300_000 }, async () => {
  const { bea } = await seed();
  const errors: string[] = [];
  let billsRequests = 0;
  const page = await openAs(bea.token, 360, 640, { skew: true });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/bills") billsRequests += 1; });
  try {
    const sheet = reminder(page);
    await sheet.waitFor({ timeout: 20_000 });
    await sheet.getByRole("button", { name: "Later" }).click();
    await sheet.waitFor({ state: "detached" });
    const before = billsRequests;

    await away(page, true);
    await away(page, false);
    await page.waitForTimeout(1500);
    assert.equal(await reminder(page).count(), 0, "a quick hide and show stays quiet");
    assert.equal(billsRequests, before, "and does not even ask the server");

    await page.evaluate((ms) => { (window as unknown as { __skew: number }).__skew = ms + 1000; }, REMINDER_THROTTLE_MS);
    await away(page, true);
    await away(page, false);
    await reminder(page).waitFor({ timeout: 20_000 });
    assert.equal(await reminder(page).getAttribute("data-level"), "2", "it is ruder because it was dismissed once");
    await shot(page, "back-after-a-while", 360, 640);
  } finally {
    await page.context().close();
  }
  assert.deepEqual(errors, []);
});

test("paying from the sheet clears each bill, closes it at the end, and it stays away after", { timeout: 300_000 }, async () => {
  const { sam } = await seed();
  const errors: string[] = [];
  const page = await openAs(sam.token, 360, 640, { dismissed: 3 });
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    const sheet = reminder(page);
    await sheet.waitFor({ timeout: 20_000 });
    assert.equal(await sheet.getAttribute("data-level"), "4");
    assert.equal(await page.locator(".bill").count(), 2);

    await sheet.getByRole("button", { name: "Mark Ramen paid" }).click();
    await sheet.locator(".bill", { hasText: "Ramen" }).waitFor({ state: "detached" });
    assert.equal(await page.locator(".bill").count(), 1, "one bill left, and the sheet stays");
    assert.equal(await sheet.getAttribute("data-level"), "4", "the words do not change while paying");
    assert.equal(await stored(page), "3", "paying one of two is not a dismissal and not a reset");
    await page.getByText("Marked paid", { exact: true }).waitFor({ state: "detached" });
    await shot(page, "one-paid", 360, 640);

    await sheet.getByRole("button", { name: "Mark Climbing paid" }).click();
    await sheet.waitFor({ state: "detached" });
    assert.equal(await stored(page), "0", "settled: the count starts over");
    await shot(page, "all-paid", 360, 640);
    await page.waitForTimeout(3500);
    assert.equal(await reminder(page).count(), 0, "it does not come back on the next poll");

    await load(page, true);
    await page.waitForTimeout(3500);
    assert.equal(await reminder(page).count(), 0, "nothing to remind about on a fresh open");
  } finally {
    await page.context().close();
  }
  const bills = await call("GET", "/api/bills", sam.token);
  assert.deepEqual(bills.owe, [], "paid on the server too");
  assert.deepEqual(errors, []);
});

test("paying in Bills instead resets the count, so a new bill starts at level 1 again", { timeout: 300_000 }, async () => {
  const { bea } = await seed();
  const errors: string[] = [];
  const page = await openAs(bea.token, 360, 640);
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    const sheet = reminder(page);
    await sheet.waitFor({ timeout: 20_000 });
    await sheet.getByRole("button", { name: "Later" }).click();
    await sheet.waitFor({ state: "detached" });
    assert.equal(await stored(page), "1");

    await openYou(page);
    await openYouSection(page, "Bills");
    await page.getByRole("region", { name: "You owe", exact: true }).getByRole("button", { name: "Mark Ramen paid" }).click();
    await page.getByRole("region", { name: "Totals", exact: true }).getByText("All settled").waitFor();
    assert.equal(await stored(page), "0");
    assert.equal(await reminder(page).count(), 0);
  } finally {
    await page.context().close();
  }

  // The same person owes again, and the old dismissals do not count against the new bill.
  const alex = await start("Dora");
  const circle = (await call("POST", "/api/circles", alex.token, { name: "Again" })).circle;
  const eli = await start("Eli", circle.inviteCode);
  hangry.confirmEmails();
  const dinner = (await call("POST", `/api/socials?circle=${circle.id}`, alex.token, { note: "Dinner" })).social;
  await call("PATCH", `/api/socials/${dinner.id}?circle=${circle.id}`, alex.token, { price: "12" });
  await call("POST", `/api/socials/${dinner.id}/reply`, eli.token, { reply: "in" });
  const fresh = await openAs(eli.token, 360, 640, { dismissed: 0 });
  try {
    await reminder(fresh).waitFor({ timeout: 20_000 });
    assert.equal(await reminder(fresh).getAttribute("data-level"), "1");
  } finally {
    await fresh.context().close();
  }
  assert.deepEqual(errors, []);
});

test("someone who is only owed money, or owes nothing, never sees it", { timeout: 300_000 }, async () => {
  const { alex, cleo } = await seed();
  const errors: string[] = [];
  for (const person of [alex, cleo]) {
    const context = await hangry.browser.newContext({ viewport: { width: 360, height: 640 }, isMobile: true, hasTouch: true, userAgent: UA });
    await skipWhatsNew(context);
    await context.addInitScript((value) => {
      localStorage.setItem("fn_token", value);
      localStorage.setItem("fn_installed", "1");
      localStorage.setItem("fn_install_later", String(Date.now()));
    }, person.token);
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      const answered = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/bills");
      await page.goto(hangry.baseUrl);
      await page.locator(".tabbar").waitFor();
      await answered;
      await page.waitForTimeout(3500);
      assert.equal(await reminder(page).count(), 0);
      assert.equal(await page.locator(".sheet").count(), 0);
      assert.equal(await stored(page), null, "nothing was counted");
      if (person === alex) await shot(page, "only-owed", 360, 640);
    } finally {
      await context.close();
    }
  }
  assert.deepEqual(errors, []);
});
