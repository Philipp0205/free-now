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
const SHOT_DIR = path.resolve("test/ui/screenshots/private-events");
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

/** Hana hosts a circle with Bea and Cam. */
async function seed(label: string) {
  const host = await call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Hana" });
  const { circle } = await call("POST", "/api/circles", host.token, { name: `Private ${label}` });
  const bea = await call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Bea", code: circle.inviteCode });
  const cam = await call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Cam", code: circle.inviteCode });
  hangry.confirmEmails();
  return { host, bea, cam, circle };
}

async function phone(width: number, height: number, token: string, circleId: string, compact = false): Promise<Page> {
  const context = await hangry.browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: UA });
  await skipWhatsNew(context);
  await context.addInitScript(([value, circle, wantCompact]) => {
    localStorage.setItem("fn_install_later", String(Date.now()));
    localStorage.setItem("fn_installed", "1");
    localStorage.setItem("fn_token", value);
    localStorage.setItem("fn_circle", circle);
    if (wantCompact) localStorage.setItem("fn_compact_home", "1");
  }, [token, circleId, compact ? "1" : ""]);
  await context.route(/arcgisonline|tile\.openstreetmap|basemaps\.cartocdn|protomaps|\.pmtiles/, (route) => route.fulfill({ status: 204, body: "" }));
  const page = await context.newPage();
  await page.goto(hangry.baseUrl);
  await page.getByRole("heading", { name: "Now", exact: true, level: 1 }).waitFor();
  await dismissPaymentReminder(page);
  return page;
}

const openFree = (page: Page) => page.getByRole("button", { name: "Let friends know you're free now" }).click();

test("the free sheet offers the picker, and one friend picked makes a private post only they see", { timeout: 180_000 }, async () => {
  const { host, bea, cam, circle } = await seed("free");
  for (const [width, height] of SIZES) {
    const page = await phone(width, height, host.token, circle.id);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await openFree(page);
      const sheet = page.locator("form.sheet");
      const field = sheet.locator(".invite-field");
      await field.scrollIntoViewIfNeeded();
      assert.deepEqual(await field.locator(".chip").allInnerTexts(), ["Everyone", "Bea", "Cam"], "the host is not on the list");
      assert.equal(await field.locator('[data-invite="everyone"]').getAttribute("aria-pressed"), "true", "starts on Everyone");
      await field.getByText("Everyone in the circle can see it.").waitFor();

      await field.getByRole("button", { name: "Bea", exact: true }).click();
      const picker = sheet.locator(".invite-field");
      assert.equal(await picker.getByRole("button", { name: "Bea", exact: true }).getAttribute("aria-pressed"), "true");
      assert.equal(await picker.locator('[data-invite="everyone"]').getAttribute("aria-pressed"), "false");
      await picker.getByText(/only they can see it/).waitFor();
      const box = await picker.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1, `the picker fits ${width}`);
      await shot(page, "free-sheet-picked");

      await sheet.getByRole("button", { name: "I'm free", exact: true }).click();
      const card = page.locator("[data-social]");
      await card.waitFor();
      await card.getByText("Private · with Bea").waitFor();
      await shot(page, "social-card-private");
      assert.deepEqual(errors, []);

      const mine = (await call("GET", "/api/socials", host.token)).socials[0];
      assert.equal(mine.private, true);
      assert.deepEqual(mine.invitees.map((person: { name: string }) => person.name).sort(), ["Bea", "Hana"]);
      assert.equal((await call("GET", "/api/socials", bea.token)).socials.length, 1, "Bea sees it");
      assert.equal((await call("GET", "/api/socials", cam.token)).socials.length, 0, "Cam does not");
      await call("DELETE", `/api/socials/${mine.id}`, host.token);
    } finally {
      await page.context().close();
    }
  }
});

test("a private plan shows its marker on the card, the compact row and the sheet, and Cam never sees it", { timeout: 180_000 }, async () => {
  const { host, cam, circle } = await seed("plan");
  const page = await phone(360, 640, host.token, circle.id);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await openPlanSheet(page);
    const sheet = page.locator("form.sheet");
    await sheet.locator("#sheet-note").fill("Secret ramen");
    await sheet.locator("#plan-date").fill(daysAhead(1));
    await sheet.locator("#plan-time").fill("19:00");
    await sheet.locator(".invite-field").getByRole("button", { name: "Bea", exact: true }).click();
    await shot(page, "plan-sheet-picked");
    await sheet.getByRole("button", { name: "Add plan", exact: true }).click();

    const card = page.locator(".card-plan", { hasText: "Secret ramen" });
    await card.getByText("Private · with Bea").waitFor();
    await shot(page, "plan-card-private");

    await card.getByRole("button", { name: "Open details" }).click();
    const details = page.getByRole("dialog", { name: "Details" });
    await details.locator(".detail-private", { hasText: "Private · with Bea" }).waitFor();
    await shot(page, "plan-sheet-private");
    assert.deepEqual(errors, []);
    assert.equal((await call("GET", "/api/plans", cam.token)).plans.length, 0, "Cam gets no plan");
  } finally {
    await page.context().close();
  }

  const compact = await phone(360, 640, host.token, circle.id, true);
  try {
    const row = compact.locator(".compact-row", { hasText: "Secret ramen" });
    await row.locator(".compact-private", { hasText: "Private" }).waitFor();
    await shot(compact, "compact-row-private");
  } finally {
    await compact.context().close();
  }

  const outsider = await phone(360, 640, cam.token, circle.id);
  try {
    assert.equal(await outsider.getByText("Secret ramen").count(), 0, "Cam's Now list has no trace of it");
    await shot(outsider, "outsider-now");
  } finally {
    await outsider.context().close();
  }
});

test("Edit shows the picker to the host with the picks on, and Everyone makes the plan public again", { timeout: 180_000 }, async () => {
  const { host, cam, circle } = await seed("edit");
  await call("POST", "/api/plans", host.token, { note: "Board games", date: daysAhead(1), time: "20:00" });
  const page = await phone(360, 640, host.token, circle.id);
  try {
    const card = page.locator(".card-plan", { hasText: "Board games" });
    await card.waitFor();
    assert.equal(await card.locator(".private-line").count(), 0, "a public plan has no marker");
    await card.locator(".card-more").click();
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
    const edit = page.getByRole("dialog", { name: "Edit" });
    await edit.getByRole("button", { name: "Cam", exact: true }).click();
    await edit.getByRole("button", { name: "Save", exact: true }).click();
    await edit.waitFor({ state: "detached" });
    await card.getByText("Private · with Cam").waitFor();
    assert.equal((await call("GET", "/api/plans", cam.token)).plans.length, 1, "Cam is the one invited");

    await card.locator(".card-more").click();
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
    assert.equal(await edit.getByRole("button", { name: "Cam", exact: true }).getAttribute("aria-pressed"), "true", "Edit opens on the saved pick");
    await shot(page, "plan-edit-picked");
    await edit.locator('[data-invite="everyone"]').click();
    await edit.getByRole("button", { name: "Save", exact: true }).click();
    await edit.waitFor({ state: "detached" });
    await card.waitFor();
    assert.equal(await card.locator(".private-line").count(), 0, "public again");
    assert.equal((await call("GET", "/api/plans", host.token)).plans[0].private, undefined);
  } finally {
    await page.context().close();
  }
});
