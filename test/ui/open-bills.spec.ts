import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA, openYou, openYouSection, useHangry } from "./harness.js";
import { testEmail } from "../http.js";

// Fake people only. Screenshots go to test/ui/screenshots (gitignored).
const SHOT_DIR = path.resolve("test/ui/screenshots/open-bills");
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
 * Alex hosts Ramen (10.00) in Friends with Bea and Sam in. Cleo hosts Climbing (8.00) in Work with Alex and Dan in.
 * Alex is in both circles. Alex and Cleo have PayPal and Wero.
 */
async function seed() {
  const alex = await start("Alex");
  const friends = (await call("POST", "/api/circles", alex.token, { name: "Friends" })).circle;
  const bea = await start("Bea", friends.inviteCode);
  const sam = await start("Sam", friends.inviteCode);
  const cleo = await start("Cleo");
  const work = (await call("POST", "/api/circles", cleo.token, { name: "Work" })).circle;
  const dan = await start("Dan", work.inviteCode);
  await call("POST", "/api/circles/join", alex.token, { code: work.inviteCode });
  hangry.confirmEmails();
  await call("PATCH", "/api/me", alex.token, { paymentUrl: "https://paypal.me/HangryAlex", weroEmail: "alex.wero@example.com" });
  await call("PATCH", "/api/me", cleo.token, { paymentUrl: "https://paypal.me/HangryCleo", weroEmail: "cleo.wero@example.com" });

  const ramen = (await call("POST", `/api/socials?circle=${friends.id}`, alex.token, { note: "Ramen" })).social;
  await call("PATCH", `/api/socials/${ramen.id}?circle=${friends.id}`, alex.token, { price: "10" });
  for (const person of [bea, sam]) await call("POST", `/api/socials/${ramen.id}/reply`, person.token, { reply: "in" });

  const climbing = (await call("POST", "/api/plans", cleo.token, { note: "Climbing", date: tomorrow() })).plan;
  await call("PATCH", `/api/plans/${climbing.id}`, cleo.token, { price: "8" });
  await call("POST", `/api/plans/${climbing.id}/reply?circle=${work.id}`, alex.token, { reply: "in" });
  await call("POST", `/api/plans/${climbing.id}/reply`, dan.token, { reply: "in" });
  return { alex, bea, sam, cleo, dan, friends, work };
}

async function openAs(token: string, width: number, height: number): Promise<Page> {
  const context = await hangry.browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: UA });
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
  return page;
}

const region = (page: Page, name: string) => page.getByRole("region", { name, exact: true });

async function noSideways(page: Page, tag: string) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, `${tag}: nothing runs off sideways`);
}

test("the Bills row on You sums both circles, and the screen lists what I owe and what I am owed", { timeout: 300_000 }, async () => {
  const { alex } = await seed();
  const errors: string[] = [];
  for (const [width, height] of SIZES) {
    const tag = `${width}x${height}`;
    const page = await openAs(alex.token, width, height);
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await openYou(page);
      await page.locator(".page").getByText("€8.00 to pay · €20.00 owed to you").waitFor();
      await shot(page, "menu", width, height);

      await openYouSection(page, "Bills");
      const totals = region(page, "Totals");
      await totals.getByText("€8.00").waitFor();
      await totals.getByText("€20.00").waitFor();

      // What I owe: Cleo's plan in the other circle, with her pay options and a Mark paid button.
      const owe = region(page, "You owe");
      const climbing = owe.locator(".bill", { hasText: "Climbing" });
      await climbing.getByText(/Work/).waitFor();
      await climbing.getByText(/Cleo collects/).waitFor();
      const paypal = climbing.getByRole("link", { name: "Pay €8.00 with PayPal" });
      assert.equal(await paypal.getAttribute("href"), "https://www.paypal.me/HangryCleo/8.00EUR", tag);
      await climbing.getByText("cleo.wero@example.com").waitFor();
      await climbing.getByRole("button", { name: "Mark Climbing paid" }).waitFor();

      // What I am owed: Alex collects for Ramen, and Bea and Sam are each €10.00 short.
      const owed = region(page, "Owed to you");
      const ramen = owed.locator(".bill", { hasText: "Ramen" });
      await ramen.getByText(/Friends/).waitFor();
      await ramen.getByText("2 to pay").waitFor();
      await ramen.getByRole("button", { name: "Mark Bea paid" }).waitFor();
      await ramen.getByRole("button", { name: "Mark Sam paid" }).waitFor();
      assert.equal(await ramen.getByText("€10.00").count(), 2, `${tag}: one share per person`);
      assert.equal(await ramen.locator(".bill-amount").innerText(), "€20.00", tag);
      await noSideways(page, tag);
      await shot(page, "bills", width, height);
    } finally {
      await page.context().close();
    }
  }
  assert.deepEqual(errors, []);
});

test("marking someone paid from Bills updates the totals, the event and the other list", { timeout: 300_000 }, async () => {
  const { alex, bea } = await seed();
  const errors: string[] = [];
  const page = await openAs(alex.token, 360, 640);
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await openYouSection(page, "Bills");
    const owed = region(page, "Owed to you");
    await owed.getByRole("button", { name: "Mark Bea paid" }).click();
    await region(page, "Totals").getByText("€10.00").waitFor();
    await owed.getByText("1 to pay").waitFor();
    assert.equal(await owed.getByRole("button", { name: "Mark Bea paid" }).count(), 0, "Bea's share left the list");
    await shot(page, "after-mark-paid", 360, 640);

    // The event says the same: Bea paid, Sam did not.
    await owed.locator(".bill-head").click();
    const details = page.getByRole("dialog", { name: "Details" });
    await details.waitFor();
    // The "Marked paid" toast sits over the sheet for a few seconds. Wait it out so the shot shows the list.
    await page.getByText("Marked paid", { exact: true }).waitFor({ state: "detached" });
    const group = details.getByRole("group", { name: "Who paid" });
    assert.equal(await group.getByRole("checkbox", { name: "Mark Bea paid" }).isChecked(), true);
    assert.equal(await group.getByRole("checkbox", { name: "Mark Sam paid" }).isChecked(), false);
    await shot(page, "event-from-bills", 360, 640);

    // Sam's tick from the sheet reaches the right circle (Alex is in two) and settles the event.
    await group.getByRole("checkbox", { name: "Mark Sam paid" }).check();
    await group.getByText("Paid · by Alex").nth(1).waitFor();
    await page.locator(".scrim").click({ position: { x: 10, y: 10 } });
    await details.waitFor({ state: "detached" });
    await owed.waitFor({ state: "detached" });
    await region(page, "Totals").getByText("€0.00").waitFor();
    await shot(page, "owed-settled", 360, 640);
  } finally {
    await page.context().close();
  }
  const stored = await call("GET", "/api/bills", bea.token);
  assert.deepEqual(stored.owe, [], "Bea is settled on the server too");
  assert.deepEqual(errors, []);
});

test("marking my own share paid clears it and the You row follows", { timeout: 300_000 }, async () => {
  const { sam } = await seed();
  const errors: string[] = [];
  const page = await openAs(sam.token, 360, 640);
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await openYou(page);
    await page.locator(".page").getByText("€10.00 to pay").waitFor();
    await openYouSection(page, "Bills");
    const owe = region(page, "You owe");
    const ramen = owe.locator(".bill", { hasText: "Ramen" });
    await ramen.getByText(/Alex collects/).waitFor();
    await ramen.getByRole("link", { name: "Pay €10.00 with PayPal" }).waitFor();
    await shot(page, "owe-only", 360, 640);
    await ramen.getByRole("button", { name: "Mark Ramen paid" }).click();
    await region(page, "Totals").getByText("All settled").waitFor();
    await page.getByText("Nothing to pay and nobody owes you.").waitFor();
    await shot(page, "settled", 360, 640);
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await page.locator(".page").getByRole("button", { name: "Bills", exact: true }).getByText("All settled").waitFor();
  } finally {
    await page.context().close();
  }
  assert.deepEqual(errors, []);
});

test("someone with nothing priced sees All settled", { timeout: 120_000 }, async () => {
  const eve = await start("Eve");
  await call("POST", "/api/circles", eve.token, { name: "Quiet" });
  hangry.confirmEmails();
  const page = await openAs(eve.token, 360, 640);
  try {
    await openYou(page);
    await page.locator(".page").getByRole("button", { name: "Bills", exact: true }).getByText("All settled").waitFor();
    await openYouSection(page, "Bills");
    await region(page, "Totals").getByText("All settled").waitFor();
    assert.equal(await page.locator(".bill").count(), 0);
    await shot(page, "empty", 360, 640);
  } finally {
    await page.context().close();
  }
});
