import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Locator, Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA, dismissPaymentReminder, openEventsMap, useHangry } from "./harness.js";
import { testEmail } from "../http.js";

// Fake people only. Screenshots go to test/ui/screenshots (gitignored).
const SHOT_DIR = path.resolve("test/ui/screenshots/now-card");
const hangry = useHangry({ tz: "UTC" });
const call = hangry.call;

const LONG_NAME = "Annual neighbourhood board game marathon with snacks and too many house rules";

function shot(page: Page, name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  return page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) });
}

function daysAhead(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

/** A "later today" social needs a start that is still today in UTC. Near midnight it is skipped and the plan is the contrast. */
function laterTodayPossible(): boolean {
  const now = new Date();
  const left = 24 * 60 - (now.getUTCHours() * 60 + now.getUTCMinutes());
  return left > 45;
}

/**
 * Hana (the viewer, owes nothing) has a live Coffee run with a pin, Bea has a live social with a very long
 * name and no pin, Alex has a social that starts later today with a pin, and Hana has a plan tomorrow with a pin.
 */
async function seed() {
  const start = (name: string, code?: string) => call("POST", "/api/auth/start", undefined, { email: testEmail(), name, ...(code ? { code } : {}) });
  const host = await start("Hana");
  const { circle } = await call("POST", "/api/circles", host.token, { name: "Test crew" });
  const bea = await start("Bea", circle.inviteCode);
  const alex = await start("Alex", circle.inviteCode);
  hangry.confirmEmails();
  const coffee = (await call("POST", "/api/socials", host.token, { note: "Coffee run", place: "Marktplatz", lat: 48.7752, lng: 9.1772, precise: true })).social;
  const long = (await call("POST", "/api/socials", bea.token, { note: LONG_NAME })).social;
  let later = null;
  if (laterTodayPossible()) {
    later = (await call("POST", "/api/socials", alex.token, {
      note: "Beers later", place: "Schlossplatz", lat: 48.7784, lng: 9.18, precise: true, startsInMin: 30,
    })).social;
  }
  const plan = (await call("POST", "/api/plans", host.token, {
    note: "Rooftop dinner", date: daysAhead(1), time: "19:00", place: "Max-Eyth-See", lat: 48.7835, lng: 9.1725, precise: true,
  })).plan;
  return { host, coffee, long, later, plan };
}

async function openAs(token: string, width: number, height: number, opts: { scheme?: "dark" | "light"; reduced?: boolean } = {}): Promise<Page> {
  const context = await hangry.browser.newContext({
    viewport: { width, height },
    colorScheme: opts.scheme ?? "dark",
    reducedMotion: opts.reduced ? "reduce" : "no-preference",
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: UA,
  });
  await skipWhatsNew(context);
  await context.route("https://server.arcgisonline.com/**", (route) => route.fulfill({ status: 204, body: "" }));
  await context.addInitScript((value) => {
    localStorage.setItem("fn_token", value);
    localStorage.setItem("fn_installed", "1");
    localStorage.setItem("fn_install_later", String(Date.now()));
  }, token);
  const page = await context.newPage();
  await page.goto(hangry.baseUrl);
  await page.locator(".tabbar").waitFor();
  const notNow = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await notNow.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await notNow.click();
  await dismissPaymentReminder(page);
  return page;
}

const toggle = (page: Page) => page.getByRole("group", { name: "Event list" });

/** The ring colour and animation a card or row shows right now, with the dot of a compact row. */
async function look(node: Locator) {
  return node.evaluate((el) => {
    const style = getComputedStyle(el);
    const dot = getComputedStyle(el, "::before");
    return {
      shadow: style.boxShadow,
      animation: style.animationName,
      dotAnimation: dot.animationName,
      dotContent: dot.content,
      running: el.getAnimations().filter((a) => (a as CSSAnimation).animationName).length,
    };
  });
}

async function checkCards(page: Page, tag: string, ids: Awaited<ReturnType<typeof seed>>) {
  const live = page.locator(`article.card-now[data-social="${ids.coffee.id}"]`);
  const long = page.locator(`article.card-now[data-social="${ids.long.id}"]`);
  await live.waitFor();
  // The social skin is untouched: the live ones are still plain .card-now, never marked .later.
  assert.equal(await live.evaluate((el) => el.classList.contains("later")), false, `${tag}: live is not later`);
  for (const card of [live, long]) {
    assert.equal(await card.getAttribute("data-happening-now"), "1", `${tag}: live card marker`);
    assert.equal(await card.evaluate((el) => el.classList.contains("happening-now")), true);
    assert.match((await look(card)).shadow, /255, 45, 120/, `${tag}: pink ring on the live card`);
  }
  const quiet: Locator[] = [page.locator(`.card-plan[data-plan="${ids.plan.id}"]`)];
  if (ids.later) {
    const later = page.locator(`article.card-now.later[data-social="${ids.later.id}"]`);
    await later.waitFor();
    quiet.push(later);
  }
  for (const card of quiet) {
    assert.equal(await card.getAttribute("data-happening-now"), null, `${tag}: upcoming card has no marker`);
    assert.equal(await card.evaluate((el) => el.classList.contains("happening-now")), false);
    assert.doesNotMatch((await look(card)).shadow, /255, 45, 120/, `${tag}: no pink ring on an upcoming card`);
  }
  assert.equal(await page.locator("[data-happening-now]").count(), 2, `${tag}: exactly the two live socials`);
  assert.equal(await page.locator(".card-now").count(), ids.later ? 3 : 2, `${tag}: .card-now still means every social card`);
}

async function checkCompact(page: Page, tag: string, ids: Awaited<ReturnType<typeof seed>>) {
  const live = page.locator(`.compact-row[data-social="${ids.coffee.id}"]`);
  const long = page.locator(`.compact-row[data-social="${ids.long.id}"]`);
  await live.waitFor();
  for (const row of [live, long]) {
    assert.equal(await row.getAttribute("data-happening-now"), "1", `${tag}: live row marker`);
    const seen = await look(row);
    assert.match(seen.shadow, /255, 45, 120/, `${tag}: pink edge on the live row`);
    assert.notEqual(seen.dotContent, "none", `${tag}: the live dot`);
  }
  const quiet: Locator[] = [page.locator(`.compact-row[data-plan="${ids.plan.id}"]`)];
  if (ids.later) quiet.push(page.locator(`.compact-row[data-social="${ids.later.id}"]`));
  for (const row of quiet) {
    assert.equal(await row.getAttribute("data-happening-now"), null, `${tag}: upcoming row has no marker`);
    const seen = await look(row);
    assert.doesNotMatch(seen.shadow, /255, 45, 120/, `${tag}: no pink on an upcoming row`);
    assert.equal(seen.dotContent === "none" || seen.dotContent === "normal", true, `${tag}: no dot on an upcoming row`);
  }
  // The long name still takes the ellipsis, and the row stays on one line inside the screen.
  const title = long.locator(".compact-title");
  assert.equal(await title.innerText(), LONG_NAME);
  const clipped = await title.evaluate((node) => ({
    over: node.scrollWidth > node.clientWidth,
    ellipsis: getComputedStyle(node).textOverflow === "ellipsis" && getComputedStyle(node).whiteSpace === "nowrap",
  }));
  assert.equal(clipped.over, true, `${tag}: the long name is cut, not wrapped`);
  assert.equal(clipped.ellipsis, true, `${tag}: with an ellipsis`);
  const box = await long.boundingBox();
  const viewport = await page.evaluate(() => document.documentElement.clientWidth);
  assert.ok(box && box.height <= 56 && box.x >= -1 && box.x + box.width <= viewport + 1, `${tag}: the live row stays one line on screen`);
  assert.equal(await long.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true, `${tag}: no sideways overflow`);
}

async function checkMap(page: Page, tag: string, ids: Awaited<ReturnType<typeof seed>>) {
  await openEventsMap(page);
  const livePin = page.locator(".leaflet-marker-icon.pin-social.pin-now");
  await livePin.waitFor({ timeout: 10_000 });
  await page.locator(".leaflet-marker-icon.pin-plan").waitFor({ timeout: 10_000 });
  assert.equal(await livePin.count(), 1, `${tag}: one live pin (the one with a place)`);
  assert.equal(await page.locator(".leaflet-marker-icon.pin-plan.pin-now").count(), 0, `${tag}: plans are never now`);
  if (ids.later) {
    const laterPin = page.locator(".leaflet-marker-icon.pin-social:not(.pin-now)");
    await laterPin.waitFor({ timeout: 10_000 });
    assert.equal(await laterPin.count(), 1, `${tag}: the later social pin is not now`);
  }
  await page.waitForTimeout(500);
}

test("a live social is ringed on the cards and in the compact list, an upcoming event is not, and the map pin is unchanged", { timeout: 300_000 }, async () => {
  const ids = await seed();
  const errors: string[] = [];
  for (const [width, height] of SIZES) {
    const tag = `${width}x${height}`;
    const page = await openAs(ids.host.token, width, height);
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.locator(".card-plan").first().waitFor();
      await checkCards(page, tag, ids);
      const moving = await look(page.locator(`article.card-now[data-social="${ids.coffee.id}"]`));
      assert.equal(moving.animation, "now-card-ring", `${tag}: the ring pulses by default`);
      await shot(page, `cards-dark-${tag}`);

      await toggle(page).getByRole("button", { name: "Compact" }).click();
      await page.locator(".compact-row").first().waitFor();
      assert.equal(await page.locator(".card").count(), 0, `${tag}: compact has no cards`);
      await checkCompact(page, tag, ids);
      await shot(page, `compact-dark-${tag}`);

      // A tap on the live row still opens the event.
      await page.locator(`.compact-row[data-social="${ids.coffee.id}"]`).click();
      const details = page.getByRole("dialog", { name: "Details" });
      await details.waitFor();
      await details.getByText("Coffee run").first().waitFor();
      await page.keyboard.press("Escape");
      await details.waitFor({ state: "detached" });

      await checkMap(page, tag, ids);
      await shot(page, `map-dark-${tag}`);
    } finally {
      await page.context().close();
    }
  }
  assert.deepEqual(errors, []);
});

test("the highlight reads in the light scheme", { timeout: 180_000 }, async () => {
  const ids = await seed();
  const errors: string[] = [];
  const page = await openAs(ids.host.token, 360, 640, { scheme: "light" });
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.locator(".card-plan").first().waitFor();
    await checkCards(page, "light", ids);
    await shot(page, "cards-light-360x640");
    await toggle(page).getByRole("button", { name: "Compact" }).click();
    await page.locator(".compact-row").first().waitFor();
    await checkCompact(page, "light", ids);
    await shot(page, "compact-light-360x640");
    await checkMap(page, "light", ids);
    await shot(page, "map-light-360x640");
  } finally {
    await page.context().close();
  }
  assert.deepEqual(errors, []);
});

test("under reduced motion the ring stays on the card and the row, but nothing pulses, and the map pin stays ringed", { timeout: 180_000 }, async () => {
  const ids = await seed();
  const errors: string[] = [];
  const page = await openAs(ids.host.token, 360, 640, { reduced: true });
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    assert.equal(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches), true);
    await page.locator(".card-plan").first().waitFor();
    await checkCards(page, "reduced", ids);
    const card = await look(page.locator(`article.card-now[data-social="${ids.coffee.id}"]`));
    assert.equal(card.animation, "none", "the card ring does not pulse");
    assert.equal(card.running, 0, "no running animation on the card");
    assert.match(card.shadow, /rgb\(255, 45, 120\) 0px 0px 0px 3px/, `a static pink ring stays: ${card.shadow}`);
    await shot(page, "cards-reduced-360x640");

    await toggle(page).getByRole("button", { name: "Compact" }).click();
    await page.locator(".compact-row").first().waitFor();
    await checkCompact(page, "reduced", ids);
    const row = await look(page.locator(`.compact-row[data-social="${ids.coffee.id}"]`));
    assert.equal(row.dotAnimation, "none", "the dot does not pulse");
    assert.match(row.shadow, /255, 45, 120/, "the pink edge stays");
    await shot(page, "compact-reduced-360x640");

    await checkMap(page, "reduced", ids);
    const pin = await page.locator(".leaflet-marker-icon.pin-now .pin-body").evaluate((node) => ({
      body: getComputedStyle(node).animationName,
      ring: getComputedStyle(node, "::before").animationName,
      shadow: getComputedStyle(node, "::before").boxShadow,
    }));
    assert.equal(pin.body, "none");
    assert.equal(pin.ring, "none");
    assert.match(pin.shadow, /7px/, "the pin keeps its static ring");
    await shot(page, "map-reduced-360x640");
  } finally {
    await page.context().close();
  }
  assert.deepEqual(errors, []);
});
