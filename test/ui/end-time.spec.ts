import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { openMoreOptions, openPlanSheet } from "./plan-sheet.js";
import { SIZES, UA, dismissPaymentReminder, useHangry } from "./harness.js";
import { testEmail } from "../http.js";

// Tue 10 Nov 2026, 12:00 in Berlin (UTC+1). Server and browser share this clock. Fake people only.
const NOW = Date.parse("2026-11-10T11:00:00Z");
const SHOT_DIR = path.resolve("test/ui/screenshots/time-picker");

const hangry = useHangry({ tz: "Europe/Berlin", now: () => NOW });
const { call } = hangry;

async function phone(width: number, height: number, token: string, circleId: string, at = NOW): Promise<Page> {
  hangry.confirmEmails();
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
  await page.clock.setFixedTime(at);
  await page.goto(hangry.baseUrl);
  await page.getByRole("heading", { name: "Now", exact: true, level: 1 }).waitFor();
  await dismissPaymentReminder(page);
  return page;
}

async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}-w${page.viewportSize()!.width}.png`) });
}

async function signUp(name: string) {
  const host = await call("POST", "/api/auth/start", undefined, { email: testEmail(), name });
  const { circle } = await call("POST", "/api/circles", host.token, { name: `Ends ${name}` });
  return { host, circle };
}

const openFree = (page: Page) => page.getByRole("button", { name: "Let friends know you're free now" }).click();

test("the end time input fits every phone and starts empty", { timeout: 120_000 }, async () => {
  const { host, circle } = await signUp("Dana");
  for (const [width, height] of SIZES) {
    const page = await phone(width, height, host.token, circle.id);
    try {
      await openFree(page);
      await openMoreOptions(page);
      const sheet = page.locator("form.sheet");
      const end = sheet.getByLabel("End time", { exact: true });
      await end.scrollIntoViewIfNeeded();
      assert.equal(await end.inputValue(), "", "starts with no end");
      assert.equal(await sheet.locator('[data-end]').count(), 0, "no length buttons");
      await end.fill("14:00");
      const box = await end.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1, `the input fits ${width}: ${box?.x}+${box?.width}`);
      assert.ok(box.height >= 44, `a real tap target at ${width}`);
      await shot(page, "free-sheet-end");
    } finally {
      await page.context().close();
    }
  }
});

test("free now with an end of 14:00 shows the range on the card and the event sheet", { timeout: 120_000 }, async () => {
  const { host, circle } = await signUp("Mira");
  const page = await phone(360, 640, host.token, circle.id);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await openFree(page);
    await openMoreOptions(page);
    await page.locator("form.sheet").getByLabel("End time", { exact: true }).fill("14:00");
    await page.locator("form.sheet").getByRole("button", { name: "I'm free", exact: true }).click();
    const card = page.locator("[data-social]");
    await card.waitFor();
    await card.getByText("Mira · Now - 14:00").waitFor();
    await shot(page, "social-card-range");
    const saved = (await call("GET", "/api/socials", host.token)).socials[0];
    assert.equal(saved.endsAt, NOW + 120 * 60_000);
    assert.equal(saved.expiresAt, saved.endsAt, "the end is when the post stops");

    await card.getByRole("button", { name: "Open details" }).click();
    const details = page.getByRole("dialog", { name: "Details" });
    await details.getByText("Now - 14:00 · Mira").waitFor();
    await shot(page, "social-sheet-range");
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

test("a plan with an end shows 19:00 - 22:00, Edit prefills it, and clearing it takes it back", { timeout: 180_000 }, async () => {
  const { host, circle } = await signUp("Lena");
  const page = await phone(360, 640, host.token, circle.id);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await openPlanSheet(page);
    const sheet = page.locator("form.sheet");
    await sheet.locator("#sheet-note").fill("Ramen night");
    await openMoreOptions(page);
    const endInput = sheet.getByLabel("End time", { exact: true });

    // An end without a start time is refused before anything is sent.
    await endInput.fill("22:00");
    await sheet.getByRole("button", { name: "Add plan", exact: true }).click();
    await sheet.getByText("Pick a start time to set an end.").waitFor();
    await shot(page, "plan-sheet-needs-start");
    assert.equal((await call("GET", "/api/plans", host.token)).plans.length, 0, "nothing was created");

    await sheet.locator("#plan-time").fill("19:00");
    await endInput.fill("18:00");
    await sheet.getByRole("button", { name: "Add plan", exact: true }).click();
    await sheet.getByText("The end must be after the start.").waitFor();
    await endInput.fill("22:00");
    await shot(page, "plan-sheet-end");
    await sheet.getByRole("button", { name: "Add plan", exact: true }).click();

    const card = page.locator(".card-plan", { hasText: "Ramen night" });
    await card.getByText(/19:00 - 22:00 · Lena/).waitFor();
    await shot(page, "plan-card-range");
    const plan = (await call("GET", "/api/plans", host.token)).plans[0];
    assert.equal(plan.endsAt, Date.parse("2026-11-13T21:00:00Z"), "stored as the same day's 22:00 in Berlin");

    // Edit opens on the saved end.
    await card.locator(".card-more").click();
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
    const edit = page.getByRole("dialog", { name: "Edit" });
    const editEnd = edit.getByLabel("End time", { exact: true });
    assert.equal(await editEnd.inputValue(), "22:00");
    await editEnd.scrollIntoViewIfNeeded();
    await shot(page, "plan-edit-prefilled");

    // Moving the start alone keeps the length of the plan: the end moves with it.
    await edit.locator("#admin-time").fill("20:00");
    await edit.getByRole("button", { name: "Save", exact: true }).click();
    await edit.waitFor({ state: "detached" });
    await card.getByText(/20:00 - 23:00 · Lena/).waitFor();
    assert.equal((await call("GET", "/api/plans", host.token)).plans[0].endsAt, Date.parse("2026-11-13T22:00:00Z"), "the same 3 hours, from 20:00");

    // Clearing the end input removes it and the card goes back to the plain time.
    await card.locator(".card-more").click();
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
    await editEnd.fill("");
    await edit.getByRole("button", { name: "Save", exact: true }).click();
    await edit.waitFor({ state: "detached" });
    await card.getByText(/20:00 · Lena/).waitFor();
    assert.equal(await card.getByText(/ - /).count(), 0, "no range once the end is gone");
    assert.equal((await call("GET", "/api/plans", host.token)).plans[0].endsAt, null);
    await shot(page, "plan-card-no-end");
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

test("a plan is happening now only inside its window, and one with no end never is", { timeout: 120_000 }, async () => {
  const { host, circle } = await signUp("Noor");
  const friendJoin = await call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Kai", code: circle.inviteCode });
  // The server clock is 12:00, so both plans are for later today. The browser clock then moves to 12:45.
  const today = "2026-11-10";
  await call("POST", "/api/plans", host.token, { note: "Lunch run", date: today, time: "12:30", durationMin: 60 });
  await call("POST", "/api/plans", host.token, { note: "Plain walk", date: today, time: "12:30" });
  await call("POST", "/api/plans", host.token, { note: "Dinner", date: today, time: "19:00", durationMin: 60 });
  const page = await phone(360, 640, friendJoin.token, circle.id, Date.parse("2026-11-10T11:45:00Z"));
  try {
    const lunch = page.locator(".card-plan", { hasText: "Lunch run" });
    await lunch.getByText(/12:30 - 13:30 · Noor/).waitFor();
    assert.equal(await lunch.getAttribute("data-happening-now"), "1", "inside the window");
    const walk = page.locator(".card-plan", { hasText: "Plain walk" });
    await walk.waitFor();
    assert.equal(await walk.getAttribute("data-happening-now"), null, "a plan with no end is never now");
    const dinner = page.locator(".card-plan", { hasText: "Dinner" });
    await dinner.getByText(/19:00 - 20:00 · Noor/).waitFor();
    assert.equal(await dinner.getAttribute("data-happening-now"), null, "not started yet");
    await shot(page, "plan-happening-now");
  } finally {
    await page.context().close();
  }
});
