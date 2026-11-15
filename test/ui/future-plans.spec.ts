import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Page } from "playwright-core";
import { addDays, dayLabel, isoDate } from "../../src/lib/time.js";
import { skipWhatsNew } from "./whats-new-seen.js";
import { openPlanSheet } from "./plan-sheet.js";
import { UA as CHROME_UA, useHangry } from "./harness.js";

const TZ = "Europe/Berlin";
/** Set to a folder to keep screenshots, for example WN_SHOT_DIR=.oc/shots. */
const SHOT_DIR = process.env.WN_SHOT_DIR ? path.resolve(process.env.WN_SHOT_DIR) : "";

const hangry = useHangry({ tz: TZ });

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

    await openPlanSheet(page);
    const sheet = page.locator(".sheet");
    assert.equal(await sheet.getByRole("button", { name: "Plan for another day" }).getAttribute("aria-pressed"), "true");
    const date = page.locator("#plan-date");
    assert.equal(await date.inputValue(), addDays(d.today, 3));
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

    await page.locator(".card-plan").getByRole("heading", { name: "Sushi night" }).waitFor();
    assert.match(await planLine(page, "Sushi night"), new RegExp(`^${d.nextWeekLabel} · 19:30 · Hana$`));
    assert.deepEqual(await planOrder(page), ["Tomorrow walk", "Sushi night"]);
    assert.equal(await page.getByRole("heading", { name: "Upcoming" }).count(), 0);
    assert.equal(await page.getByRole("heading", { name: "Tomorrow", exact: true }).count(), 0);

    // Next week -> tomorrow.
    await page.getByRole("button", { name: "More for Sushi night" }).click();
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
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
    await page.getByRole("button", { name: "More for Sushi night" }).click();
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
    assert.equal(await page.locator(".sheet").getByRole("button", { name: "Tomorrow", exact: true }).getAttribute("aria-pressed"), "true");
    await page.locator(".sheet").getByRole("button", { name: "Pick a date" }).click();
    await page.locator("#admin-date").fill(d.nextWeek);
    patched = page.waitForResponse((response) => response.request().method() === "PATCH");
    await page.locator(".sheet").getByRole("button", { name: "Save" }).click();
    assert.equal((await patched).request().postDataJSON().date, d.nextWeek);
    await page.waitForFunction((label) => Array.from(document.querySelectorAll(".card-plan"))
      .some((card) => card.querySelector("h3")?.textContent === "Sushi night" && card.querySelector(".card-body > p")?.textContent?.startsWith(label)), d.nextWeekLabel);
    assert.match(await planLine(page, "Sushi night"), new RegExp(`^${d.nextWeekLabel} · 19:30`));

    // End it.
    await page.getByRole("button", { name: "More for Sushi night" }).click();
    await page.getByRole("menuitem", { name: "End plan" }).click();
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
    await openPlanSheet(page);
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

test("at 320x568 the when choice, date input and time picker are visible and clear of each other", { timeout: 90_000 }, async () => {
  const page = await phone(320, 568);
  try {
    const d = days();
    await signIn(page, "Hana");
    await openPlanSheet(page);
    await page.locator("#plan-date").fill(d.nextWeek);
    await assertFieldsClear(page, [".sheet .segment", "#plan-date", "#plan-time"]);
    await page.locator("#sheet-note").fill("Tiny screen");
    await page.locator(".sheet-dock").getByRole("button", { name: "Add plan" }).click();
    await page.getByRole("heading", { name: "Tiny screen" }).waitFor();
    await page.getByRole("button", { name: "More for Tiny screen" }).click();
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
    await page.locator("#admin-date").waitFor();
    await assertFieldsClear(page, [".sheet .segment-3", "#admin-date", "#admin-time"]);
  } finally {
    await page.context().close();
  }
});

test("Now is one list: no section headings, no Plan button, plans in day order at 320, 360 and 412", { timeout: 120_000 }, async () => {
  for (const [width, height] of [[320, 568], [360, 640], [412, 915]]) {
    const page = await phone(width, height);
    try {
      const d = days();
      await signIn(page, `Ida ${width}`);
      const token = await page.evaluate(() => localStorage.getItem("fn_token") as string);
      for (const [note, date] of [["Sushi night", d.nextWeek], ["Long walk by the river", d.tomorrow], ["Movie", addDays(d.today, 3)]]) {
        const response = await fetch(`${hangry.baseUrl}/api/plans`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ note, date, time: "19:00" }),
        });
        assert.equal(response.status, 201);
      }
      await page.reload();
      await page.getByRole("heading", { name: "Sushi night" }).waitFor({ timeout: 10_000 });
      for (const name of ["Later today", "Today & tomorrow", "Upcoming"]) {
        assert.equal(await page.getByRole("heading", { name, exact: true }).count(), 0, `${name} at ${width}`);
      }
      assert.equal(await page.locator(".text-btn", { hasText: /^Plan$/ }).count(), 0);
      assert.equal(await page.getByRole("button", { name: "Nothing planned yet" }).count(), 0);
      assert.equal(await page.locator(".cards").count(), 1);
      assert.deepEqual(await planOrder(page), ["Long walk by the river", "Movie", "Sushi night"]);
      await page.getByRole("button", { name: "Past events" }).waitFor();
      const scroll = await page.evaluate(() => ({ viewport: window.innerWidth, scrollWidth: document.documentElement.scrollWidth }));
      assert.ok(scroll.scrollWidth <= scroll.viewport, `Now tab scrolls sideways at ${width}`);
      if (SHOT_DIR) {
        fs.mkdirSync(SHOT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(SHOT_DIR, `now-list-${width}.png`) });
      }
    } finally {
      await page.context().close();
    }
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
      // Each field may scroll the sheet. Compare in content coordinates, not viewport ones.
      const scrolled = sheet.querySelector(".sheet-scroll")?.scrollTop ?? 0;
      boxes.push({ name: selector, box: new DOMRect(box.left, box.top + scrolled, box.width, box.height) });
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
  await openPlanSheet(page);
  await page.locator("#plan-date").fill(day === "today" ? days().today : days().tomorrow);
  await page.locator("#sheet-note").fill(note);
  await page.locator("#plan-time").fill(time);
  await page.locator(".sheet-dock").getByRole("button", { name: "Add plan" }).click();
  await page.getByRole("heading", { name: note }).waitFor();
}

async function planOrder(page: Page) {
  return page.locator(".card-plan h3").allInnerTexts();
}

async function planLine(page: Page, note: string) {
  return page.locator(".card-plan", { has: page.getByRole("heading", { name: note }) }).locator(".card-body > p").first().innerText();
}

async function phone(width = 390, height = 844) {
  const context = await hangry.browser.newContext({
    viewport: { width, height },
    isMobile: true,
    hasTouch: true,
    userAgent: CHROME_UA,
    timezoneId: TZ,
  });
  await skipWhatsNew(context);
  return context.newPage();
}

async function dismiss(page: Page) {
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
}

async function signIn(page: Page, name: string) {
  await page.goto(hangry.baseUrl);
  await page.locator("#name").fill(name);
  await page.getByRole("button", { name: "Continue" }).click();
  await dismiss(page);
  await page.locator("#circle-name").fill("friends");
  await page.getByRole("button", { name: "Create circle" }).click();
  await dismiss(page);
  await page.getByRole("button", { name: "Let friends know you're free now" }).waitFor();
}
