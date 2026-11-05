import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { openDb } from "../../src/db.js";
import { createNoopPushSender } from "../../src/push.js";
import { addDays, dayLabel, isoDate } from "../../src/time.js";

const CHROME_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36";
const TZ = "Europe/Berlin";

let browser: Browser;
let baseUrl = "";
let closeServer: () => Promise<void> = async () => {};

test.before(async () => {
  const db = openDb(":memory:");
  const config = loadConfig({ PORT: "3000", DB_PATH: ":memory:", APP_TZ: TZ });
  const server = http.createServer(createApp({
    db,
    push: createNoopPushSender(),
    config: { ...config, dbPath: ":memory:" },
    now: () => Date.now(),
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closeServer = async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  };
  try { browser = await chromium.launch({ channel: "chrome", headless: true }); }
  catch { browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true }); }
});

test.after(async () => {
  await browser?.close();
  await closeServer();
});

function days() {
  const today = isoDate(Date.now(), TZ);
  const tomorrow = addDays(today, 1);
  const nextWeek = addDays(today, 8);
  return { today, tomorrow, nextWeek, max: addDays(today, 365), nextWeekLabel: dayLabel(nextWeek, today) };
}

test("a plan picked for next week is labelled, sorted, moved to tomorrow and back, then ended", { timeout: 90_000 }, async () => {
  const page = await phone();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  try {
    const d = days();
    await signIn(page, "Hana");
    await addPlan(page, "Tomorrow walk", "tomorrow", "18:00");

    await page.getByRole("button", { name: "Plan tomorrow" }).click();
    const sheet = page.locator(".sheet");
    assert.equal(await sheet.getByRole("button", { name: "Tomorrow", exact: true }).getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator("#plan-date").count(), 0);
    await sheet.getByRole("button", { name: "Pick a date" }).click();
    const date = page.locator("#plan-date");
    await date.waitFor();
    assert.equal(await date.getAttribute("min"), d.today);
    assert.equal(await date.getAttribute("max"), d.max);
    await date.fill(d.nextWeek);
    await sheet.getByRole("heading", { name: d.nextWeekLabel }).waitFor();
    await page.locator("#sheet-note").fill("Sushi night");
    await page.locator("#plan-time").fill("19:30");
    const created = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/plans"));
    await page.locator(".sheet-dock").getByRole("button", { name: "Add plan" }).click();
    const posted = (await created).request().postDataJSON();
    assert.equal(posted.date, d.nextWeek);
    assert.equal(posted.time, "19:30");

    const upcoming = page.locator("section.section", { has: page.getByRole("heading", { name: "Upcoming" }) });
    await upcoming.getByRole("heading", { name: "Sushi night" }).waitFor();
    assert.match(await upcoming.locator(".card-plan p").first().innerText(), new RegExp(`^${d.nextWeekLabel} · 19:30 · Hana$`));
    assert.deepEqual(await planOrder(page), ["Tomorrow walk", "Sushi night"]);

    // Next week -> tomorrow.
    await page.getByRole("button", { name: "Edit Sushi night" }).click();
    const edit = page.locator(".sheet");
    assert.equal(await edit.getByRole("button", { name: "Pick a date" }).getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator("#admin-date").inputValue(), d.nextWeek);
    await edit.getByRole("button", { name: "Tomorrow", exact: true }).click();
    assert.equal(await page.locator("#admin-date").count(), 0);
    let patched = page.waitForResponse((response) => response.request().method() === "PATCH");
    await edit.getByRole("button", { name: "Save" }).click();
    assert.equal((await patched).request().postDataJSON().date, d.tomorrow);
    await page.locator(".sheet").waitFor({ state: "detached" });
    assert.equal(await page.getByRole("heading", { name: "Upcoming" }).count(), 0);
    assert.deepEqual(await planOrder(page), ["Tomorrow walk", "Sushi night"]);
    assert.match(await planLine(page, "Sushi night"), /^Tomorrow · 19:30 · Hana$/);

    // Tomorrow -> next week again.
    await page.getByRole("button", { name: "Edit Sushi night" }).click();
    assert.equal(await page.locator(".sheet").getByRole("button", { name: "Tomorrow", exact: true }).getAttribute("aria-pressed"), "true");
    await page.locator(".sheet").getByRole("button", { name: "Pick a date" }).click();
    await page.locator("#admin-date").fill(d.nextWeek);
    patched = page.waitForResponse((response) => response.request().method() === "PATCH");
    await page.locator(".sheet").getByRole("button", { name: "Save" }).click();
    assert.equal((await patched).request().postDataJSON().date, d.nextWeek);
    await upcoming.getByRole("heading", { name: "Sushi night" }).waitFor();
    assert.match(await planLine(page, "Sushi night"), new RegExp(`^${d.nextWeekLabel} · 19:30`));

    // End it.
    await page.getByRole("button", { name: "End Sushi night" }).click();
    await page.locator(".sheet-confirm").getByRole("button", { name: "End", exact: true }).click();
    await page.getByRole("heading", { name: "Sushi night" }).waitFor({ state: "detached" });
    assert.equal(await page.getByRole("heading", { name: "Upcoming" }).count(), 0);
    await page.getByRole("button", { name: "Past events" }).click();
    await page.locator(".past-card", { hasText: "Sushi night" }).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

test("a date in the past is refused before it is sent", { timeout: 60_000 }, async () => {
  const page = await phone();
  try {
    await signIn(page, "Hana");
    await page.getByRole("button", { name: "Plan tomorrow" }).click();
    await page.locator(".sheet").getByRole("button", { name: "Pick a date" }).click();
    await page.locator("#plan-date").fill("");
    await page.locator("#sheet-note").fill("Nothing");
    let posted = false;
    page.on("request", (request) => { if (request.method() === "POST" && request.url().endsWith("/api/plans")) posted = true; });
    await page.locator(".sheet-dock").getByRole("button", { name: "Add plan" }).click();
    await page.locator(".toast", { hasText: "Pick a date from today on." }).waitFor();
    assert.equal(posted, false);
  } finally {
    await page.context().close();
  }
});

test("at 320x568 the day choice, date input and time picker are visible and clear of each other", { timeout: 90_000 }, async () => {
  const page = await phone(320, 568);
  try {
    const d = days();
    await signIn(page, "Hana");
    await page.getByRole("button", { name: "Plan tomorrow" }).click();
    await page.locator(".sheet").getByRole("button", { name: "Pick a date" }).click();
    await page.locator("#plan-date").fill(d.nextWeek);
    await assertFieldsClear(page, [".sheet .segment-3", "#plan-date", "#plan-time"]);
    await page.locator("#sheet-note").fill("Tiny screen");
    await page.locator(".sheet-dock").getByRole("button", { name: "Add plan" }).click();
    await page.getByRole("heading", { name: "Tiny screen" }).waitFor();
    await page.getByRole("button", { name: "Edit Tiny screen" }).click();
    await page.locator("#admin-date").waitFor();
    await assertFieldsClear(page, [".sheet .segment-3", "#admin-date", "#admin-time"]);
  } finally {
    await page.context().close();
  }
});

async function assertFieldsClear(page: Page, selectors: string[]) {
  const problems = await page.evaluate((targets) => {
    const out: string[] = [];
    const sheet = document.querySelector(".sheet")!;
    const head = sheet.querySelector(".sheet-head")!.getBoundingClientRect();
    const dock = sheet.querySelector(".sheet-dock")!.getBoundingClientRect();
    const boxes: Array<{ name: string; box: DOMRect }> = [];
    for (const selector of targets) {
      const node = document.querySelector(selector);
      if (!(node instanceof HTMLElement)) { out.push(`${selector} missing`); continue; }
      node.scrollIntoView({ block: "nearest" });
      const box = node.getBoundingClientRect();
      if (box.width < 200 || box.height < 44) out.push(`${selector} too small ${box.width}x${box.height}`);
      if (box.left < 0 || box.right > window.innerWidth) out.push(`${selector} clipped sideways ${box.left}-${box.right}`);
      if (box.top < head.bottom - 1 || box.bottom > dock.top + 1) out.push(`${selector} ${box.top}-${box.bottom} outside ${head.bottom}-${dock.top}`);
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      if (!hit || (hit !== node && !node.contains(hit))) out.push(`${selector} covered by ${hit?.className || hit?.tagName}`);
      if (node.scrollWidth > node.clientWidth + 1 && node.tagName !== "INPUT") out.push(`${selector} overflows ${node.scrollWidth} > ${node.clientWidth}`);
      for (const button of node.querySelectorAll("button")) {
        if (button.scrollWidth > button.clientWidth + 1) out.push(`${selector} "${button.textContent}" text clipped`);
      }
      boxes.push({ name: selector, box });
    }
    boxes.sort((a, b) => a.box.top - b.box.top);
    for (let i = 1; i < boxes.length; i += 1) {
      if (boxes[i - 1].box.bottom > boxes[i].box.top + 0.5) out.push(`${boxes[i - 1].name} overlaps ${boxes[i].name}`);
    }
    return out;
  }, selectors);
  assert.deepEqual(problems, []);
}

async function addPlan(page: Page, note: string, day: "today" | "tomorrow", time: string) {
  await page.getByRole("button", { name: "Plan tomorrow" }).click();
  if (day === "today") await page.locator(".sheet").getByRole("button", { name: "Today", exact: true }).click();
  await page.locator("#sheet-note").fill(note);
  await page.locator("#plan-time").fill(time);
  await page.locator(".sheet-dock").getByRole("button", { name: "Add plan" }).click();
  await page.getByRole("heading", { name: note }).waitFor();
}

async function planOrder(page: Page) {
  return page.locator(".card-plan h3").allInnerTexts();
}

async function planLine(page: Page, note: string) {
  return page.locator(".card-plan", { has: page.getByRole("heading", { name: note }) }).locator(".card-copy > p").first().innerText();
}

async function phone(width = 390, height = 844) {
  const context = await browser.newContext({
    viewport: { width, height },
    isMobile: true,
    hasTouch: true,
    userAgent: CHROME_UA,
    timezoneId: TZ,
  });
  return context.newPage();
}

async function dismiss(page: Page) {
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
}

async function signIn(page: Page, name: string) {
  await page.goto(baseUrl);
  await page.locator("#name").fill(name);
  await page.getByRole("button", { name: "Continue" }).click();
  await dismiss(page);
  await page.locator("#circle-name").fill("friends");
  await page.getByRole("button", { name: "Create circle" }).click();
  await dismiss(page);
  await page.getByRole("button", { name: "Let friends know you're free now" }).waitFor();
}
