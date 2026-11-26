import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { openMoreOptions, openPlanSheet } from "./plan-sheet.js";
import { UA, dismissPaymentReminder, useHangry } from "./harness.js";
import { testEmail } from "../http.js";

// Fake people only. Screenshots go to test/ui/screenshots (gitignored).
const SHOT_DIR = path.resolve("test/ui/screenshots/add-event-more-options");
const hangry = useHangry({ tz: "UTC" });
const { call } = hangry;

async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) });
}

/** Hana hosts a circle with Bea. */
async function seed(label: string) {
  const host = await call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Hana" });
  const { circle } = await call("POST", "/api/circles", host.token, { name: `More ${label}` });
  await call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Bea", code: circle.inviteCode });
  hangry.confirmEmails();
  return { host, circle };
}

async function phone(token: string, circleId: string, scheme: "light" | "dark" = "dark"): Promise<Page> {
  const context = await hangry.browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: UA, colorScheme: scheme });
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

const openFree = (page: Page) => page.getByRole("button", { name: "Let friends know you're free now" }).click();
const moreRow = (page: Page) => page.locator("form.sheet").getByRole("button", { name: "More options", exact: true });

/** The folded fields, by the selector each one draws. */
const FOLDED = { description: "#sheet-description", photo: ".event-photo-field", ends: "#free-end-time", repeats: "#plan-repeat", who: ".invite-field" };

async function folded(page: Page, key: keyof typeof FOLDED): Promise<number> {
  return page.locator(`form.sheet ${FOLDED[key]}`).count();
}

/** Date, Time, Where and the More options row sit above the dock, with no scrolling needed. */
async function assertAboveTheFold(page: Page, ids: string[]) {
  const dock = await page.locator("form.sheet .sheet-dock").boundingBox();
  assert.ok(dock, "the dock is drawn");
  for (const selector of ids) {
    const box = await page.locator(`form.sheet ${selector}`).boundingBox();
    assert.ok(box, `${selector} is drawn`);
    assert.ok(box.y >= 0 && box.y + box.height <= dock.y + 1, `${selector} ${box.y}+${box.height} is above the dock at ${dock.y}`);
  }
  assert.equal(await page.locator("form.sheet .sheet-scroll").evaluate((node) => node.scrollTop), 0, "the sheet did not scroll");
}

test("the Plan sheet keeps date, time and where up front and folds the rest behind More options", { timeout: 180_000 }, async () => {
  const { host, circle } = await seed("plan");
  for (const scheme of ["dark", "light"] as const) {
    const page = await phone(host.token, circle.id, scheme);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await openPlanSheet(page);
      const sheet = page.locator("form.sheet");
      const row = moreRow(page);
      assert.equal(await row.getAttribute("aria-expanded"), "false", "starts closed");
      assert.equal(await sheet.getByRole("button", { name: /^(Hide|Fewer) options/ }).count(), 0, "one control only");
      assert.equal(await row.locator(".more-options-summary").count(), 0, "no summary when nothing is set");
      await assertAboveTheFold(page, ["#plan-date", "#plan-time", ".where", ".more-options-row"]);
      const rowBox = await row.boundingBox();
      assert.ok(rowBox && rowBox.height >= 44, `a real tap target: ${rowBox?.height}`);
      for (const key of Object.keys(FOLDED) as Array<keyof typeof FOLDED>) assert.equal(await folded(page, key), 0, `${key} is folded away`);
      await shot(page, `plan-closed-${scheme}`);

      await row.click();
      assert.equal(await row.getAttribute("aria-expanded"), "true");
      for (const key of Object.keys(FOLDED) as Array<keyof typeof FOLDED>) assert.equal(await folded(page, key), 1, `${key} shows once open`);
      await sheet.locator("#sheet-description").scrollIntoViewIfNeeded();
      await shot(page, `plan-open-${scheme}`);

      await sheet.locator("#plan-repeat").selectOption("weekly");
      await sheet.locator(".invite-field").getByRole("button", { name: "Bea", exact: true }).click();
      await row.scrollIntoViewIfNeeded();
      await row.click();
      assert.equal(await row.getAttribute("aria-expanded"), "false", "the user can collapse it");
      assert.equal(await folded(page, "repeats"), 0);
      await row.locator(".more-options-summary").waitFor();
      assert.equal(await row.locator(".more-options-summary").innerText(), "Weekly · Private · with Bea");
      assert.equal(await row.getAttribute("aria-label"), "More options");
      await shot(page, `plan-summary-${scheme}`);

      await row.click();
      assert.equal(await sheet.locator("#plan-repeat").inputValue(), "weekly", "closing kept the pick");
      assert.deepEqual(errors, []);
    } finally {
      await page.context().close();
    }
  }
});

test("a description alone shows on the closed Plan row, and a fresh Plan sheet starts closed again", { timeout: 120_000 }, async () => {
  const { host, circle } = await seed("desc");
  const page = await phone(host.token, circle.id);
  try {
    await openPlanSheet(page);
    await openMoreOptions(page);
    await page.locator("#sheet-description").fill("Bring a jacket");
    await moreRow(page).click();
    assert.equal(await moreRow(page).locator(".more-options-summary").innerText(), "Description");
    await page.locator(".scrim").dispatchEvent("click");
    await page.locator("form.sheet").waitFor({ state: "detached" });
    await openPlanSheet(page);
    assert.equal(await moreRow(page).getAttribute("aria-expanded"), "false");
    assert.equal(await moreRow(page).locator(".more-options-summary").count(), 0, "the old description is gone");
  } finally {
    await page.context().close();
  }
});

test("the Free now sheet folds photo, ends and who it is for, and opens on its own when one is set", { timeout: 180_000 }, async () => {
  const { host, circle } = await seed("free");
  const page = await phone(host.token, circle.id);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await openFree(page);
    const sheet = page.locator("form.sheet");
    const row = moreRow(page);
    assert.equal(await row.getAttribute("aria-expanded"), "false", "starts closed");
    await assertAboveTheFold(page, ["#sheet-note", ".where", ".more-options-row"]);
    for (const key of ["photo", "ends", "who"] as const) assert.equal(await folded(page, key), 0, `${key} is folded away`);
    for (const id of ["#sheet-description", "#plan-date", "#plan-repeat", "#plan-time"]) assert.equal(await sheet.locator(id).count(), 0, `${id} is Plan only`);
    await shot(page, "free-closed");

    await row.click();
    for (const key of ["photo", "ends", "who"] as const) assert.equal(await folded(page, key), 1, `${key} shows once open`);
    assert.equal(await folded(page, "description"), 0);
    assert.equal(await folded(page, "repeats"), 0);
    await shot(page, "free-open");

    await sheet.getByLabel("End time", { exact: true }).fill("21:00");
    await row.click();
    assert.equal(await row.locator(".more-options-summary").innerText(), "Until 21:00");
    await shot(page, "free-summary");
    await row.click();
    await sheet.locator(".invite-field").getByRole("button", { name: "Bea", exact: true }).click();
    await row.click();
    assert.equal(await row.locator(".more-options-summary").innerText(), "Until 21:00 · Private · with Bea");

    await sheet.getByRole("button", { name: "I'm free", exact: true }).click();
    await page.locator("[data-social]").waitFor();

    // Posted with an end and a friend: the update sheet opens More options by itself.
    await openFree(page);
    const again = moreRow(page);
    assert.equal(await again.getAttribute("aria-expanded"), "true", "opens on its own");
    assert.equal(await folded(page, "ends"), 1);
    await again.click();
    assert.equal(await again.getAttribute("aria-expanded"), "false", "still collapsible");
    assert.match(await again.locator(".more-options-summary").innerText(), /^Until \d\d:\d\d · Private · with Bea$/);
    await shot(page, "free-update-closed");
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});
