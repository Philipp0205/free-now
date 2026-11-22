import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Locator, Page } from "playwright-core";
import { gradientClass } from "../../public/js/card-grad.js";
import { openPlanSheet } from "./plan-sheet.js";
import { skipWhatsNew } from "./whats-new-seen.js";
import { UA, dismissPaymentReminder, useHangry } from "./harness.js";
import { testEmail } from "../http.js";

// Fake people only. Screenshots go to test/ui/screenshots (gitignored).
const SHOT_DIR = path.resolve("test/ui/screenshots/no-card-color");
const hangry = useHangry({ tz: "UTC" });
const call = hangry.call;

const gradOf = (node: Locator) => node.evaluate((el) => [...el.classList].find((name) => /^grad-\d+$/.test(name)) ?? "");
const planCard = (page: Page, id: string) => page.locator(`.card-plan[data-plan="${id}"]`);
const planRow = (page: Page, id: string) => page.locator(`.compact-row[data-plan="${id}"]`);
const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) });
}

/** Hana hosts a circle with Finn in it. */
async function seed() {
  const start = (name: string, code?: string) =>
    call("POST", "/api/auth/start", undefined, { email: testEmail(), name, ...(code ? { code } : {}) });
  const host = await start("Hana");
  const { circle } = await call("POST", "/api/circles", host.token, { name: "Test crew" });
  const friend = await start("Finn", circle.inviteCode);
  hangry.confirmEmails();
  return { host, friend };
}

async function openAs(token: string, width: number, height: number): Promise<Page> {
  const context = await hangry.browser.newContext({
    viewport: { width, height },
    colorScheme: "dark",
    isMobile: true,
    hasTouch: true,
    userAgent: UA,
  });
  await skipWhatsNew(context);
  await context.addInitScript((value) => {
    localStorage.setItem("fn_token", value);
    localStorage.setItem("fn_installed", "1");
    localStorage.setItem("fn_install_later", String(Date.now()));
  }, token);
  await context.route(/arcgisonline|tile\.openstreetmap|basemaps\.cartocdn/, (route) => route.abort());
  const page = await context.newPage();
  await page.goto(hangry.baseUrl);
  await page.locator(".tabbar").waitFor();
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
  await dismissPaymentReminder(page);
  return page;
}

async function showCompact(page: Page) {
  await page.getByRole("group", { name: "Event list" }).getByRole("button", { name: "Compact" }).click();
  await page.locator(".compact-row").first().waitFor();
}

async function showCards(page: Page) {
  await page.getByRole("group", { name: "Event list" }).getByRole("button", { name: "Cards" }).click();
  await page.locator(".card-plan").first().waitFor();
}

/** The card and the compact row both show this gradient class. */
async function assertCardAndRow(page: Page, id: string, cls: string, tag: string) {
  await showCards(page);
  assert.equal(await gradOf(planCard(page, id)), cls, `${tag}: card`);
  await showCompact(page);
  assert.equal(await gradOf(planRow(page, id)), cls, `${tag}: compact row`);
  await showCards(page);
}

/** No palette, no radiogroup, no label, no swatch inside the open sheet. */
async function assertNoPicker(page: Page, tag: string) {
  assert.equal(await page.getByRole("radiogroup", { name: "Card color" }).count(), 0, `${tag}: no radiogroup`);
  assert.equal(await page.locator(".color-pick, .color-opt, .color-swatch, [data-card-color]").count(), 0, `${tag}: no swatches`);
  assert.equal(await page.getByText("Card color").count(), 0, `${tag}: no label`);
}

test("the Plan sheet has no color picker, and a new plan gets the automatic gradient", { timeout: 240_000 }, async () => {
  const { host } = await seed();
  const errors: string[] = [];
  const page = await openAs(host.token, 360, 640);
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await openPlanSheet(page);
    await page.locator("#sheet-note").fill("Pizza night");
    await assertNoPicker(page, "plan sheet");
    await shot(page, "plan-sheet-dark-360");

    const created = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/plans"));
    await page.locator(".sheet-dock").getByRole("button", { name: "Add plan" }).click();
    const response = await created;
    assert.equal("cardColor" in response.request().postDataJSON(), false, "the client sends no cardColor");
    const plan = (await response.json()).plan;
    assert.equal(plan.cardColor, null);
    await planCard(page, plan.id).waitFor();
    await assertCardAndRow(page, plan.id, gradientClass(plan.id), "new plan");
    await shot(page, "new-plan-card-dark-360");
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

test("the Edit sheet has no color picker and saves without a cardColor, so a picked color is kept", { timeout: 240_000 }, async () => {
  const { host, friend } = await seed();
  const plan = (await call("POST", "/api/plans", host.token, { note: "Rooftop drinks", date: tomorrow(), cardColor: 12 })).plan;
  assert.equal(plan.cardColor, 12);
  const page = await openAs(host.token, 320, 568);
  try {
    await planCard(page, plan.id).waitFor();
    await planCard(page, plan.id).getByRole("button", { name: /^More for / }).click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    await page.locator("#admin-note").waitFor();
    await assertNoPicker(page, "edit sheet");
    await shot(page, "edit-sheet-dark-320");

    await page.locator("#admin-note").fill("Rooftop drinks, late");
    const patched = page.waitForResponse((res) => res.request().method() === "PATCH" && res.url().includes(`/api/plans/${plan.id}`));
    await page.locator(".sheet-dock").getByRole("button", { name: "Save" }).click();
    const res = await patched;
    assert.equal(res.status(), 200);
    assert.equal("cardColor" in res.request().postDataJSON(), false, "the edit sends no cardColor");
    await page.locator("form.sheet").waitFor({ state: "detached" });
    assert.equal((await res.json()).plan.cardColor, 12, "the pick survives the edit");
    await assertCardAndRow(page, plan.id, "grad-12", "after edit");
  } finally {
    await page.context().close();
  }
  const other = await openAs(friend.token, 360, 640);
  try {
    await planCard(other, plan.id).waitFor();
    assert.equal(await gradOf(planCard(other, plan.id)), "grad-12", "a friend still sees the pick");
  } finally {
    await other.context().close();
  }
});

test("a plan that already has a picked color keeps that gradient on the card and the compact row", { timeout: 240_000 }, async () => {
  const { host } = await seed();
  const picked = (await call("POST", "/api/plans", host.token, { note: "Board games", date: tomorrow(), cardColor: 9 })).plan;
  const plain = (await call("POST", "/api/plans", host.token, { note: "Long walk", date: tomorrow() })).plan;
  assert.equal(picked.cardColor, 9);
  assert.equal(plain.cardColor, null);
  const page = await openAs(host.token, 360, 640);
  try {
    await planCard(page, picked.id).waitFor();
    await assertCardAndRow(page, picked.id, "grad-9", "picked");
    await assertCardAndRow(page, plain.id, gradientClass(plain.id), "automatic");
    await shot(page, "picked-and-automatic-cards-dark-360");
    await showCompact(page);
    await shot(page, "picked-and-automatic-compact-dark-360");
  } finally {
    await page.context().close();
  }
});
