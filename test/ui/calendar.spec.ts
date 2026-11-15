import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA, openYouSection, useHangry } from "./harness.js";

const TZ = "Europe/Berlin";
/** Screenshots land here. Override with CAL_SHOT_DIR. */
const SHOT_DIR = path.resolve(process.env.CAL_SHOT_DIR || "/workspace/hangry-calendar-artifacts");
const SAVED = "Saved to your calendar file. It will not update if the plan changes.";

const hangry = useHangry({ tz: TZ });
const { call } = hangry;

async function phone(width: number, height: number, token: string) {
  const context = await hangry.browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: UA, acceptDownloads: true });
  await skipWhatsNew(context);
  await context.addInitScript((value) => {
    localStorage.setItem("fn_install_later", String(Date.now()));
    localStorage.setItem("fn_token", value);
  }, token);
  await context.route("https://*.tile.openstreetmap.org/**", (route) => route.fulfill({ status: 204, body: "" }));
  const page = await context.newPage();
  await page.goto(hangry.baseUrl);
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
  return page;
}

/** The feed link is a secret: it is masked in every screenshot. */
async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const size = page.viewportSize()!;
  const file = path.join(SHOT_DIR, `${name}-${size.width}x${size.height}.png`);
  await page.screenshot({ path: file, mask: [page.locator(".feed-url")], maskColor: "#3a3a3c" });
  return file;
}

async function fitsWidth(page: Page, selector: string) {
  const width = page.viewportSize()!.width;
  const box = await page.locator(selector).first().boundingBox();
  assert.ok(box && box.x >= -0.5 && box.x + box.width <= width + 0.5, `${selector} fits at ${width}: ${JSON.stringify(box)}`);
}

/**
 * The feed link is a secret. Node's test reporter prints actual and expected values
 * on a failed assertion, so a link is only ever checked as a boolean.
 */
function check(ok: boolean, label: string): void {
  assert.ok(ok, label);
}

async function noSideScroll(page: Page) {
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(wide <= 1, `page scrolls sideways by ${wide}px`);
}

async function people(width: number) {
  const host = await call("POST", "/api/auth/start", undefined, { name: "Hana" });
  const { circle } = await call("POST", "/api/circles", host.token, { name: `Cal ${width}` });
  const friend = await call("POST", "/api/auth/start", undefined, { name: "Finn", code: circle.inviteCode });
  return { host, friend };
}

for (const [width, height] of SIZES) {
  test(`at ${width}: Add to calendar sits in the plan menu and saves a named .ics with the right toast`, { timeout: 120_000 }, async () => {
    const { host, friend } = await people(width);
    const { plan } = await call("POST", "/api/plans", host.token, { note: `Sushi night ${width}`, time: "19:00", place: "Sushi Bar" });
    await call("POST", `/api/plans/${plan.id}/reply`, friend.token, { reply: "maybe" });

    const page = await phone(width, height, friend.token);
    try {
      const card = page.locator(`.card-plan[data-plan="${plan.id}"]`);
      await card.locator(".who-row", { hasText: "You're maybe" }).waitFor();
      await card.locator(".card-more").click();
      const texts = await page.locator(".card-menu [role=menuitem]").evaluateAll((nodes) => nodes.map((node) => (node.textContent || "").trim()));
      assert.ok(texts.includes("Remind friends"), texts.join(", "));
      assert.ok(texts.includes("Maybe"), texts.join(", "));
      assert.equal(texts.indexOf("Add to calendar"), texts.indexOf("Remind friends") + 1, `right after Remind friends: ${texts}`);
      await fitsWidth(page, ".card-menu");
      await shot(page, "calendar-menu");

      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.getByRole("menuitem", { name: "Add to calendar" }).click(),
      ]);
      assert.equal(download.suggestedFilename(), `sushi-night-${width}.ics`);
      const saved = await download.path();
      const text = fs.readFileSync(saved!, "utf8");
      assert.match(text, /^BEGIN:VCALENDAR\r\n/);
      assert.ok(text.includes(`UID:${plan.id}@hangry\r\n`));
      assert.ok(text.includes("STATUS:TENTATIVE\r\n"));
      assert.ok(text.replace(/\r\n /g, "").includes("Hangry plans have no end time\\, so this shows 2 hours."), "the 2 hour note");
      await page.locator(".toast", { hasText: SAVED }).waitFor();
      await fitsWidth(page, ".toast");
      await shot(page, "calendar-toast");
    } finally {
      await page.context().close();
    }
  });

  test(`at ${width}: the You tab turns the feed on, shows the link once, resets, and turns off`, { timeout: 120_000 }, async () => {
    const { host } = await people(width);
    await call("POST", "/api/plans", host.token, { note: `Board games ${width}`, time: "18:00" });
    const page = await phone(width, height, host.token);
    try {
      await openYouSection(page, "Availability & calendar");
      const panel = page.getByRole("region", { name: "Calendar feed" });
      await panel.getByRole("button", { name: "Turn on calendar feed" }).waitFor();
      await panel.getByText("Your calendar app decides how often it checks for changes, which can take hours.", { exact: false }).waitFor();
      await panel.scrollIntoViewIfNeeded();
      await fitsWidth(page, ".calendar-feed");
      await shot(page, "calendar-feed-off");

      await panel.getByRole("button", { name: "Turn on calendar feed" }).click();
      const url = await panel.locator(".feed-url").innerText();
      check(/^http:\/\/127\.0\.0\.1:\d+\/cal\/[A-Za-z0-9_-]{43}\.ics$/.test(url), "the feed link is shown");
      // Android has no webcal:// handler, so the panel must not offer one (see calendar-android.spec.ts).
      assert.equal(await panel.locator('a[href^="webcal:"]').count(), 0, "no webcal link on Android");
      await panel.getByRole("button", { name: "Copy link" }).waitFor();
      await noSideScroll(page);
      await fitsWidth(page, ".feed-url");
      await panel.scrollIntoViewIfNeeded();
      await shot(page, "calendar-feed-on");

      const feed = await fetch(url);
      assert.equal(feed.status, 200);
      assert.ok((await feed.text()).includes(`Board games ${width}`));

      // Leaving the tab hides the link for good: only the date shows after that.
      await page.locator(".tabbar").getByRole("button", { name: "Now", exact: true }).click();
      await openYouSection(page, "Availability & calendar");
      await panel.getByText(/On since/).waitFor();
      assert.equal(await panel.locator(".feed-url").count(), 0);

      await panel.getByRole("button", { name: "Reset link" }).click();
      const resetSheet = page.getByRole("dialog", { name: "Reset calendar link?" });
      await resetSheet.getByText("The old link stops working.", { exact: false }).waitFor();
      await shot(page, "calendar-reset-confirm");
      await resetSheet.getByRole("button", { name: "Reset link" }).click();
      const fresh = await panel.locator(".feed-url").innerText();
      check(fresh !== url, "reset shows a new link");
      assert.equal((await fetch(url)).status, 404);
      assert.equal((await fetch(fresh)).status, 200);

      await panel.getByRole("button", { name: "Turn off" }).click();
      const offSheet = page.getByRole("dialog", { name: "Turn off calendar feed?" });
      await offSheet.waitFor();
      await shot(page, "calendar-off-confirm");
      await offSheet.getByRole("button", { name: "Turn off" }).click();
      await panel.getByRole("button", { name: "Turn on calendar feed" }).waitFor();
      assert.equal((await fetch(fresh)).status, 404);
    } finally {
      await page.context().close();
    }
  });
}
