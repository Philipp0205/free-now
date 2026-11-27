import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Download, Page } from "playwright-core";
import { CALENDAR_ADD, CALENDAR_OLD_TIME, CALENDAR_SAVED, CALENDAR_UPDATE } from "../../public/js/calendar-copy.js";
import { addDays, isoDate, zonedDateTime } from "../../src/lib/time.js";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA, testEmail, useHangry } from "./harness.js";

const TZ = "Europe/Berlin";
// Fake people only. Screenshots go to test/ui/screenshots (gitignored).
const SHOT_DIR = path.resolve("test/ui/screenshots/calendar-date-sync");

const hangry = useHangry({ tz: TZ });
const { call } = hangry;

async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) });
}

async function phone(width: number, height: number, token: string) {
  const context = await hangry.browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: UA });
  await skipWhatsNew(context);
  await context.addInitScript((value) => {
    localStorage.setItem("fn_install_later", String(Date.now()));
    // Only on the first load: a reload must keep what the app saved itself.
    if (!localStorage.getItem("fn_token")) localStorage.setItem("fn_token", value);
  }, token);
  await context.route("https://*.tile.openstreetmap.org/**", (route) => route.fulfill({ status: 204, body: "" }));
  return context.newPage();
}

async function dismiss(page: Page) {
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
}

/** A host with one plan two days out at 19:30. */
async function seedPlan(note: string) {
  const host = await call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Hana" });
  await call("POST", "/api/circles", host.token, { name: "Crew" });
  const date = addDays(isoDate(Date.now(), TZ), 2);
  await call("POST", "/api/plans", host.token, { note, date, time: "19:30" });
  return { token: host.token as string, date };
}

async function openCard(page: Page, note: string) {
  await page.goto(hangry.baseUrl);
  await dismiss(page);
  await page.locator(".card-plan", { hasText: note }).waitFor();
}

async function openMenu(page: Page, note: string) {
  await page.locator(".card-plan", { hasText: note }).locator(".card-more").click();
}

/** Taps the calendar item (by its exact name) and returns the saved file's text. */
async function saveFile(page: Page, note: string, itemName: string): Promise<string> {
  await openMenu(page, note);
  const downloading = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: itemName, exact: true }).click();
  const download: Download = await downloading;
  const file = await download.path();
  return fs.readFileSync(file, "utf8");
}

function field(text: string, name: string): string {
  const row = text.replace(/\r\n /g, "").split("\r\n").find((item) => item.startsWith(`${name}:`));
  return row?.slice(name.length + 1) ?? "";
}

function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** Edit sheet: pick a new day and/or a new start time, then Save. */
async function editPlan(page: Page, note: string, change: { date?: string; time?: string }) {
  await openMenu(page, note);
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
  const sheet = page.locator(".sheet");
  if (change.date) {
    await sheet.getByRole("button", { name: "Pick a date" }).click();
    await page.locator("#admin-date").fill(change.date);
  }
  if (change.time) await page.locator("#admin-time").fill(change.time);
  await sheet.getByRole("button", { name: "Save" }).click();
  await sheet.waitFor({ state: "detached" });
}

/** Opens the card menu, reads its item names (optionally with a screenshot), and closes it again. */
async function menuNames(page: Page, note: string, shotName = ""): Promise<string[]> {
  await openMenu(page, note);
  const items = page.getByRole("menuitem");
  await items.first().waitFor();
  if (shotName) await shot(page, shotName);
  const names = (await items.allInnerTexts()).map((text) => text.trim());
  await openMenu(page, note);
  await items.first().waitFor({ state: "detached" });
  return names;
}

async function menuHas(page: Page, note: string, name: string, shotName = ""): Promise<boolean> {
  return (await menuNames(page, note, shotName)).includes(name);
}

for (const [width, height] of SIZES) {
  test(`at ${width}: a moved day turns the calendar item into Update calendar copy, and the new file has the new day and a higher SEQUENCE`, { timeout: 120_000 }, async () => {
    const note = `Ramen ${width}`;
    const { token, date } = await seedPlan(note);
    const page = await phone(width, height, token);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    try {
      await openCard(page, note);
      assert.equal(await menuHas(page, note, CALENDAR_ADD, `menu-add-${width}`), true, "Add to calendar shows");
      assert.equal(await menuHas(page, note, CALENDAR_UPDATE), false);

      const first = await saveFile(page, note, CALENDAR_ADD);
      await page.getByText(CALENDAR_SAVED, { exact: true }).waitFor();
      assert.equal(field(first, "DTSTART"), stamp(zonedDateTime(date, "19:30", TZ)));
      const firstSequence = Number(field(first, "SEQUENCE"));

      const target = addDays(date, 3);
      await editPlan(page, note, { date: target });
      await page.getByText(CALENDAR_OLD_TIME, { exact: true }).waitFor();
      await shot(page, `notice-${width}`);

      assert.equal(await menuHas(page, note, CALENDAR_UPDATE, `menu-update-${width}`), true, "the item now says Update calendar copy");
      assert.equal(await menuHas(page, note, CALENDAR_ADD), false);

      await page.reload();
      await dismiss(page);
      await page.locator(".card-plan", { hasText: note }).waitFor();
      assert.equal(await menuHas(page, note, CALENDAR_UPDATE), true, "a reload keeps the stale state");

      const second = await saveFile(page, note, CALENDAR_UPDATE);
      assert.equal(field(second, "UID"), field(first, "UID"), "same UID, so the calendar replaces the event");
      assert.equal(field(second, "DTSTART"), stamp(zonedDateTime(target, "19:30", TZ)));
      assert.ok(Number(field(second, "SEQUENCE")) > firstSequence, "SEQUENCE is higher");
      await page.getByText("Saved again with the new time. Open the file to update your calendar.", { exact: true }).waitFor();

      assert.equal(await menuHas(page, note, CALENDAR_ADD), true, "back to Add to calendar once the copy is current");
      assert.equal(await menuHas(page, note, CALENDAR_UPDATE), false);
      assert.deepEqual(errors, []);
    } finally {
      await page.context().close();
    }
  });
}

test("editing only the start time also makes the saved file stale, and the new file has the new time", { timeout: 120_000 }, async () => {
  const note = "Tapas time-only";
  const { token, date } = await seedPlan(note);
  const page = await phone(360, 640, token);
  try {
    await openCard(page, note);
    const first = await saveFile(page, note, CALENDAR_ADD);
    await page.getByText(CALENDAR_SAVED, { exact: true }).waitFor();
    await editPlan(page, note, { time: "21:15" });
    await page.getByText(CALENDAR_OLD_TIME, { exact: true }).waitFor();
    assert.equal(await menuHas(page, note, CALENDAR_UPDATE), true);
    const second = await saveFile(page, note, CALENDAR_UPDATE);
    assert.equal(field(second, "DTSTART"), stamp(zonedDateTime(date, "21:15", TZ)));
    assert.ok(Number(field(second, "SEQUENCE")) > Number(field(first, "SEQUENCE")));
  } finally {
    await page.context().close();
  }
});

test("a plan the user never saved shows no notice after an edit, and keeps Add to calendar", { timeout: 120_000 }, async () => {
  const note = "Pizza never-saved";
  const { token } = await seedPlan(note);
  const page = await phone(360, 640, token);
  try {
    await openCard(page, note);
    await editPlan(page, note, { time: "20:45" });
    await page.locator(".card-plan", { hasText: note }).waitFor();
    await page.waitForTimeout(500);
    assert.equal(await page.getByText(CALENDAR_OLD_TIME, { exact: true }).count(), 0, "no notice");
    assert.equal(await menuHas(page, note, CALENDAR_ADD), true);
    assert.equal(await menuHas(page, note, CALENDAR_UPDATE), false);
  } finally {
    await page.context().close();
  }
});
