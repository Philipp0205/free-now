import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA, useHangry } from "./harness.js";
import { testEmail } from "../http.js";

// Fake people only. Screenshots go to test/ui/screenshots (gitignored).
const SHOT_DIR = path.resolve("test/ui/screenshots/event-payments");
const hangry = useHangry({ tz: "UTC" });
const call = hangry.call;

const ALEX_PAYPAL = "https://paypal.me/HangryAlex";
const ALEX_WERO = "alex.wero@example.com";

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

async function seed(kind: "plan" | "social", note: string) {
  const alex = await call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Alex" });
  const circle = (await call("POST", "/api/circles", alex.token, { name: "Friends" })).circle;
  const join = (name: string) => call("POST", "/api/auth/start", undefined, { email: testEmail(), name, code: circle.inviteCode });
  const bea = await join("Bea");
  const sam = await join("Sam");
  hangry.confirmEmails();
  await call("PATCH", "/api/me", alex.token, { paymentUrl: ALEX_PAYPAL, weroEmail: ALEX_WERO });
  const made = kind === "plan"
    ? (await call("POST", "/api/plans", alex.token, { note, date: tomorrow() })).plan
    : (await call("POST", "/api/socials", alex.token, { note })).social;
  const route = kind === "plan" ? "plans" : "socials";
  for (const person of [bea, sam]) await call("POST", `/api/${route}/${made.id}/reply`, person.token, { reply: "in" });
  return { alex, bea, sam, id: made.id as string, route };
}

async function openAs(token: string, width: number, height: number, note: string): Promise<Page> {
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
  await page.locator("article h3", { hasText: note }).first().waitFor();
  return page;
}

const card = (page: Page, note: string) => page.locator("article", { has: page.locator("h3", { hasText: note }) });

async function openDetails(page: Page, note: string) {
  await card(page, note).locator("h3").first().click();
  const dialog = page.getByRole("dialog", { name: "Details" });
  await dialog.waitFor();
  return dialog;
}

async function closeDetails(page: Page) {
  await page.locator(".scrim").click({ position: { x: 10, y: 10 } });
  await page.getByRole("dialog", { name: "Details" }).waitFor({ state: "detached" });
}

async function setPrice(page: Page, note: string, price: string, collector?: string) {
  await card(page, note).getByRole("button", { name: `More for ${note}` }).click();
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit" });
  await dialog.waitFor();
  await dialog.getByLabel("Price per person").fill(price);
  if (collector) await dialog.getByLabel("Who collects").selectOption({ label: collector });
  // Bring the field the shot is about clear of the Save dock.
  await dialog.locator(".sheet-scroll").evaluate((node) => { node.scrollTop = node.scrollHeight; });
  return dialog;
}

for (const kind of ["plan", "social"] as const) {
  const note = kind === "plan" ? "Pizza night" : "Ramen now";

  test(`${kind}: the organizer sets a price, friends see pay options, and the paid list works`, { timeout: 300_000 }, async () => {
    const { alex, bea, sam, id, route } = await seed(kind, note);
    const errors: string[] = [];

    // 1. Alex sets the price in the edit sheet.
    const organizer = await openAs(alex.token, 360, 640, note);
    organizer.on("pageerror", (error) => errors.push(error.message));
    try {
      const dialog = await setPrice(organizer, note, "12,50");
      assert.equal(await dialog.getByLabel("Who collects").count(), 0, "no collector choice until someone has paid");
      await shot(organizer, `${kind}-edit-price`, 360, 640);
      await dialog.getByRole("button", { name: "Save" }).click();
      await dialog.waitFor({ state: "detached" });
      await card(organizer, note).getByText("€12.50 per person").waitFor();
      await shot(organizer, `${kind}-card-price`, 360, 640);

      // 2. Details: the organizer has no pay buttons, and ticks Bea.
      const details = await openDetails(organizer, note);
      await details.getByText(/€12\.50 per person/).first().waitFor();
      assert.equal(await details.getByRole("link", { name: /with PayPal/ }).count(), 0, "the collector is not asked to pay");
      const group = details.getByRole("group", { name: "Who paid" });
      await group.waitFor();
      await group.getByRole("checkbox", { name: "Mark Bea paid" }).check();
      await group.getByText("Paid · by Alex").waitFor();
      await shot(organizer, `${kind}-organizer-paid`, 360, 640);
      await closeDetails(organizer);
    } finally {
      await organizer.context().close();
    }
    const after = await call("GET", `/api/${route}`, alex.token);
    const stored = after[route].find((row: { id: string }) => row.id === id);
    assert.equal(stored.payment.priceCents, 1250);
    assert.equal(stored.payment.members.find((m: { name: string }) => m.name === "Bea").paid, true);

    // 3. Sam sees the PayPal link and the Wero email at every phone size, and ticks himself.
    for (const [width, height] of SIZES) {
      const page = await openAs(sam.token, width, height, note);
      page.on("pageerror", (error) => errors.push(error.message));
      try {
        const tag = `${kind} ${width}x${height}`;
        await card(page, note).getByText("€12.50 per person").waitFor();
        const details = await openDetails(page, note);
        const paypal = details.getByRole("link", { name: "Pay €12.50 with PayPal" });
        await paypal.waitFor();
        const href = (await paypal.getAttribute("href")) ?? "";
        assert.equal(href, "https://www.paypal.me/HangryAlex/12.50EUR", tag);
        assert.equal(await paypal.getAttribute("target"), "_blank", tag);
        assert.match((await paypal.getAttribute("rel")) ?? "", /noopener/, tag);
        const wero = details.locator(".pay-wero");
        await wero.getByText(ALEX_WERO).waitFor();
        await wero.getByRole("button", { name: /Copy Wero email/ }).waitFor();
        await wero.getByText(/Send €12\.50 to Alex with Wero/).waitFor();
        const group = details.getByRole("group", { name: "Who paid" });
        await group.waitFor();
        assert.equal(await group.getByRole("checkbox", { name: "Mark Bea paid" }).isChecked(), true, tag);
        assert.equal(await group.getByRole("checkbox", { name: "Mark Bea paid" }).isDisabled(), true, `${tag}: not Bea's row to tick`);
        // Nothing runs off the sheet sideways.
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
        assert.equal(overflow, false, tag);
        await details.locator(".pay-section").evaluate((node) => node.scrollIntoView({ block: "start" }));
        await details.locator(".pay-wero").evaluate((node) => node.scrollIntoView({ block: "end" }));
        const emailBox = (await wero.locator(".wero-email").boundingBox())!;
        assert.ok(emailBox.height < 30, `${tag}: the Wero email stays on one line, got height ${emailBox.height}`);
        assert.equal(await wero.locator(".wero-email").evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true, `${tag}: the email is not cut off`);
        await shot(page, `${kind}-friend-pay`, width, height);
        if (width === 360) {
          const mine = group.getByRole("checkbox", { name: "Mark Sam paid" });
          await mine.check();
          await group.getByText("Paid · by Sam").waitFor();
          await shot(page, `${kind}-friend-ticked`, width, height);
          await mine.uncheck();
          await group.getByText("Owes €12.50").first().waitFor();
        }
      } finally {
        await page.context().close();
      }
    }

    // 4. Bea (already paid, no links) becomes the collector. Sam sees the hint and who collects.
    const again = await openAs(alex.token, 360, 640, note);
    again.on("pageerror", (error) => errors.push(error.message));
    try {
      const dialog = await setPrice(again, note, "12.50", "Bea");
      await shot(again, `${kind}-edit-collector`, 360, 640);
      await dialog.getByRole("button", { name: "Save" }).click();
      await dialog.waitFor({ state: "detached" });
      const details = await openDetails(again, note);
      await details.getByText("€12.50 per person · Bea collects").waitFor();
      await closeDetails(again);
    } finally {
      await again.context().close();
    }
    const hint = await openAs(sam.token, 360, 640, note);
    hint.on("pageerror", (error) => errors.push(error.message));
    try {
      const details = await openDetails(hint, note);
      await details.getByText(/Bea has not added PayPal or Wero yet/).waitFor();
      assert.equal(await details.getByRole("link", { name: /with PayPal/ }).count(), 0);
      await details.locator(".pay-section").evaluate((node) => node.scrollIntoView({ block: "start" }));
      await shot(hint, `${kind}-friend-hint`, 360, 640);
      // A circle member who did not join sees the paid list but no pay controls.
    } finally {
      await hint.context().close();
    }
    assert.deepEqual(errors, []);
  });
}
