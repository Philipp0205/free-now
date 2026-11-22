import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { openPlanSheet } from "./plan-sheet.js";
import { SIZES, UA, dismissPaymentReminder, useHangry } from "./harness.js";
import { testEmail } from "../http.js";

// Fake people only. Screenshots go to test/ui/screenshots (gitignored).
const SHOT_DIR = path.resolve("test/ui/screenshots/recurring-events");
const hangry = useHangry({ tz: "UTC" });
const { call } = hangry;

async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}-w${page.viewportSize()!.width}.png`) });
}

function daysAhead(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** Alex hosts a circle with Bea. */
async function seed(label: string) {
  const host = await call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Alex" });
  const { circle } = await call("POST", "/api/circles", host.token, { name: `Repeat ${label}` });
  const bea = await call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Bea", code: circle.inviteCode });
  hangry.confirmEmails();
  return { host, bea, circle };
}

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
  await page.goto(hangry.baseUrl);
  await page.getByRole("heading", { name: "Now", exact: true, level: 1 }).waitFor();
  await dismissPaymentReminder(page);
  return page;
}

test("the plan sheet offers Repeats, and a weekly plan shows its line on the card and in the details", { timeout: 240_000 }, async () => {
  const { host, circle } = await seed("create");
  for (const [width, height] of SIZES) {
    const page = await phone(width, height, host.token, circle.id);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const note = `Climbing ${width}`;
    try {
      await openPlanSheet(page);
      const sheet = page.locator("form.sheet");
      const repeats = sheet.locator("#plan-repeat");
      await sheet.getByText("Repeats", { exact: true }).waitFor();
      await repeats.scrollIntoViewIfNeeded();
      assert.deepEqual(await repeats.locator("option").allInnerTexts(), ["Never", "Weekly", "Every 2 weeks", "Monthly"]);
      assert.equal(await repeats.inputValue(), "never", "starts on Never");

      await sheet.locator("#sheet-note").fill(note);
      await sheet.locator("#plan-date").fill(daysAhead(2));
      await sheet.locator("#plan-time").fill("18:00");
      await repeats.selectOption("weekly");
      const box = await repeats.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1, `the select fits ${width}`);
      await repeats.scrollIntoViewIfNeeded();
      await sheet.locator(".sheet-scroll").evaluate((node) => { node.scrollBy(0, 80); });
      await shot(page, "plan-sheet-weekly");
      await sheet.getByRole("button", { name: "Add plan", exact: true }).click();

      const card = page.locator(".card-plan", { hasText: note });
      await card.getByText("Repeats weekly", { exact: true }).waitFor();
      await shot(page, "plan-card-weekly");

      await card.getByRole("button", { name: "Open details" }).click();
      const details = page.getByRole("dialog", { name: "Details" });
      await details.getByText("Repeats weekly", { exact: true }).waitFor();
      await shot(page, "plan-details-weekly");
      assert.deepEqual(errors, []);

      const mine = (await call("GET", "/api/plans", host.token)).plans.find((plan: { note: string }) => plan.note === note);
      assert.equal(mine.recurrence, "weekly");
    } finally {
      await page.context().close();
    }
  }
});

test("a plan that does not repeat shows no line, and Edit lets the host change the rule and stop it", { timeout: 180_000 }, async () => {
  const { host, bea, circle } = await seed("edit");
  await call("POST", "/api/plans", host.token, { note: "Board games", date: daysAhead(1), time: "20:00" });
  const page = await phone(360, 640, host.token, circle.id);
  try {
    const card = page.locator(".card-plan", { hasText: "Board games" });
    await card.waitFor();
    assert.equal(await card.locator(".repeat-line").count(), 0, "no line when it does not repeat");

    await card.locator(".card-more").click();
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
    const edit = page.getByRole("dialog", { name: "Edit" });
    const repeats = edit.locator("#admin-repeat");
    assert.equal(await repeats.inputValue(), "never");
    assert.equal(await edit.getByRole("button", { name: "Stop repeating" }).count(), 0, "nothing to stop yet");
    await repeats.selectOption("biweekly");
    await edit.getByRole("button", { name: "Save", exact: true }).click();
    await edit.waitFor({ state: "detached" });
    await card.getByText("Repeats every 2 weeks", { exact: true }).waitFor();

    await card.locator(".card-more").click();
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
    assert.equal(await repeats.inputValue(), "biweekly", "Edit opens on the saved rule");
    const stop = edit.getByRole("button", { name: "Stop repeating", exact: true });
    await stop.scrollIntoViewIfNeeded();
    await shot(page, "plan-edit-stop");
    await stop.click();
    await edit.getByRole("button", { name: "Stop repeating" }).waitFor({ state: "detached" });
    await edit.getByRole("button", { name: "Save", exact: true }).click();
    await edit.waitFor({ state: "detached" });
    await card.waitFor();
    assert.equal(await card.locator(".repeat-line").count(), 0, "the line is gone after stopping");
    const plans = (await call("GET", "/api/plans", host.token)).plans;
    assert.equal(plans[0].recurrence, null, "the rule is cleared");
    assert.equal((await call("GET", "/api/plans", bea.token)).plans[0].recurrence, null);
  } finally {
    await page.context().close();
  }
});

test("a friend sees the line but gets no Repeats field when editing is not theirs", { timeout: 180_000 }, async () => {
  const { host, bea, circle } = await seed("friend");
  await call("POST", "/api/plans", host.token, { note: "Pottery", date: daysAhead(1), time: "17:00", recurrence: "monthly" });
  const page = await phone(360, 640, bea.token, circle.id);
  try {
    const card = page.locator(".card-plan", { hasText: "Pottery" });
    await card.getByText("Repeats monthly", { exact: true }).waitFor();
    await shot(page, "friend-card-monthly");
    await card.locator(".card-more").click();
    assert.equal(await page.getByRole("menuitem", { name: "Edit", exact: true }).count(), 0, "a friend cannot edit the host's plan");
  } finally {
    await page.context().close();
  }
});
