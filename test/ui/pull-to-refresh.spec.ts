import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Page, Route } from "playwright-core";
import { UA, openEventsMap, useHangry, testEmail } from "./harness.js";
import { skipWhatsNew } from "./whats-new-seen.js";

// Fake people and plans only. Screenshots go to test/ui/screenshots (gitignored).
const SHOT_DIR = path.resolve("test/ui/screenshots/pull-to-refresh");
const SIZES = [[320, 568], [360, 640], [390, 844], [412, 915]] as const;

const hangry = useHangry({ tz: "UTC" });

function tomorrow(): string {
  return new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
}

async function seed() {
  const host = await hangry.call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Hana" });
  const circle = (await hangry.call("POST", "/api/circles", host.token, { name: "Pull crew" })).circle;
  for (const name of ["Finn", "Uma", "Ben"]) {
    await hangry.call("POST", "/api/auth/start", undefined, { email: testEmail(), name, code: circle.inviteCode });
  }
  for (const [index, note] of ["Sushi night", "Board games", "Morning run", "Rooftop drinks", "Museum trip", "Picnic"].entries()) {
    await hangry.call("POST", "/api/plans", host.token, { note, date: tomorrow(), time: `1${index}:30` });
  }
  return host;
}

/** A phone with the 3s poll switched off in the page (test only), so every /api/socials GET is a refresh we caused. */
async function phone(token: string, width: number, height: number, { reducedMotion = false } = {}) {
  const context = await hangry.browser.newContext({
    viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: UA, colorScheme: "dark",
    ...(reducedMotion ? { reducedMotion: "reduce" as const } : {}),
  });
  await skipWhatsNew(context);
  await context.addInitScript((value) => {
    localStorage.setItem("fn_token", value);
    localStorage.setItem("fn_installed", "1");
    localStorage.setItem("fn_install_later", String(Date.now()));
    const original = window.setInterval.bind(window);
    window.setInterval = ((handler: TimerHandler, ms?: number, ...args: unknown[]) => (
      ms === 3000 ? 0 : original(handler, ms, ...args)
    )) as typeof window.setInterval;
  }, token);
  await context.route("https://*.tile.openstreetmap.org/**", (route) => route.fulfill({ status: 204, body: "" }));
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const calls = { socials: 0 };
  page.on("request", (request) => {
    if (request.method() === "GET" && new URL(request.url()).pathname === "/api/socials") calls.socials += 1;
  });
  await page.goto(hangry.baseUrl);
  await page.locator("nav.tabbar").waitFor();
  await page.locator(".card-plan").first().waitFor();
  await quiet(page);
  return { page, calls, errors };
}

/** The boot refresh and the loads after a tab switch are done. */
async function quiet(page: Page) {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(300);
}

const tab = (page: Page, name: string) => page.locator("nav.tabbar").getByRole("button", { name, exact: true });

async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const size = page.viewportSize()!;
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}-${size.width}x${size.height}.png`) });
}

/** A one finger drag straight down, with real touch events. Resolves with a function that lifts the finger. */
async function pullDown(page: Page, { distance = 160, fromY = 140 } = {}) {
  const cdp = await page.context().newCDPSession(page);
  const x = Math.round(page.viewportSize()!.width / 2);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: fromY }] });
  const steps = 8;
  for (let step = 1; step <= steps; step += 1) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: fromY + Math.round((distance * step) / steps) }] });
  }
  return async () => {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await cdp.detach();
  };
}

/** Hold every request to a path until release() is called. */
function hold(page: Page, pattern: string) {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ready = page.route(pattern, async (route: Route) => {
    await gate;
    await route.continue();
  });
  return { ready, release: () => release() };
}

const indicator = (page: Page) => page.locator(".ak-ptr");
const overscroll = (page: Page) => page.evaluate(() => getComputedStyle(document.documentElement).overscrollBehaviorY);
const indicatorOpacity = (page: Page) => indicator(page).evaluate((node) => Number(getComputedStyle(node).opacity));

async function indicatorHidden(page: Page) {
  await page.waitForFunction(() => {
    const node = document.querySelector(".ak-ptr");
    return !node || (!node.classList.contains("ak-ptr-loading") && !node.classList.contains("ak-ptr-pulling") && Number(getComputedStyle(node).opacity) === 0);
  });
}

/** Pull a page and let go: exactly one refresh, the indicator shows and then hides. */
async function pullAndRefresh(page: Page, calls: { socials: number }, what: string) {
  const before = calls.socials;
  const lift = await pullDown(page);
  await indicator(page).waitFor();
  assert.ok(await indicator(page).evaluate((node) => node.classList.contains("ak-ptr-pulling")), `${what}: indicator follows the finger`);
  await lift();
  await indicatorHidden(page);
  await page.waitForTimeout(700);
  assert.equal(calls.socials - before, 1, `${what}: exactly one refresh`);
}

/** The minimum the spinner stays up, read from the source (the page code cannot be imported into node). */
const PTR_MIN_MS = Number(/export const PTR_MIN_MS = (\d+);/.exec(fs.readFileSync(path.resolve("public/js/native.js"), "utf8"))?.[1]);

/**
 * Watch the indicator's class in the page, so timing is not skewed by test round trips. Records when the loading
 * state starts and ends, and the opacity in the same turn the loading state ends and 90ms later.
 */
async function watchIndicator(page: Page) {
  await page.evaluate(() => {
    const node = document.querySelector(".ak-ptr")!;
    const log: { start?: number; end?: number; opacityAtEnd?: number; opacityLater?: number } = {};
    (window as unknown as { __ptr: typeof log }).__ptr = log;
    new MutationObserver(() => {
      const loading = node.classList.contains("ak-ptr-loading");
      if (loading && log.start === undefined) log.start = performance.now();
      if (!loading && log.start !== undefined && log.end === undefined) {
        log.end = performance.now();
        log.opacityAtEnd = Number(getComputedStyle(node).opacity);
        setTimeout(() => { log.opacityLater = Number(getComputedStyle(node).opacity); }, 90);
      }
    }).observe(node, { attributes: true, attributeFilter: ["class"] });
  });
}

const watched = (page: Page) => page.evaluate(() => (window as unknown as { __ptr: { start?: number; end?: number; opacityAtEnd?: number; opacityLater?: number } }).__ptr);

for (const [width, height] of SIZES) {
  test(`a fast refresh keeps the spinner up for the minimum, then fades it out, ${width}x${height}`, { timeout: 120_000 }, async () => {
    assert.ok(PTR_MIN_MS >= 600 && PTR_MIN_MS <= 800, "the minimum is read from native.js");
    const host = await seed();
    const { page, calls, errors } = await phone(host.token, width, height);
    try {
      const before = calls.socials;
      const lift = await pullDown(page);
      await indicator(page).waitFor();
      await watchIndicator(page);
      await lift();
      await page.waitForFunction(() => document.querySelector(".ak-ptr")?.classList.contains("ak-ptr-loading"));
      // The network is not held: the refresh itself is far quicker than the minimum.
      await page.waitForFunction(() => (window as unknown as { __ptr: { end?: number } }).__ptr.end !== undefined);
      const log = await watched(page);
      assert.equal(calls.socials - before, 1, "one refresh");
      const shownFor = log.end! - log.start!;
      assert.ok(shownFor >= PTR_MIN_MS - 60, `the spinner stayed up ${Math.round(shownFor)}ms, at least about ${PTR_MIN_MS}ms`);
      assert.ok(shownFor < PTR_MIN_MS + 1500, `and not much longer (${Math.round(shownFor)}ms)`);
      // The hide is a fade: not already gone in the turn loading ends, partway a moment later.
      assert.ok(log.opacityAtEnd! > 0.5, `not hidden in the same turn (opacity ${log.opacityAtEnd})`);
      await page.waitForFunction(() => (window as unknown as { __ptr: { opacityLater?: number } }).__ptr.opacityLater !== undefined);
      const later = (await watched(page)).opacityLater!;
      assert.ok(later > 0 && later < 1, `fading partway after 90ms (opacity ${later})`);
      await indicatorHidden(page);
      assert.equal(await indicatorOpacity(page), 0, "gone once the fade is over");
      assert.deepEqual(errors, []);
    } finally {
      await page.context().close();
    }
  });
}

test("with reduced motion the spinner still ends and hides without a fade", { timeout: 120_000 }, async () => {
  const host = await seed();
  const { page, calls, errors } = await phone(host.token, 390, 844, { reducedMotion: true });
  try {
    assert.equal(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches), true);
    const before = calls.socials;
    const lift = await pullDown(page);
    await indicator(page).waitFor();
    await watchIndicator(page);
    await lift();
    await page.waitForFunction(() => document.querySelector(".ak-ptr")?.classList.contains("ak-ptr-loading"));
    await indicatorHidden(page);
    const log = await watched(page);
    assert.equal(log.opacityAtEnd, 0, "no fade flourish with reduced motion");
    assert.equal(await indicator(page).evaluate((node) => node.classList.contains("ak-ptr-loading")), false, "no stuck spinner");
    assert.equal(calls.socials - before, 1, "one refresh");
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

for (const [width, height] of SIZES) {
  test(`pull to refresh on Now: one refresh, indicator shows then hides, ${width}x${height}`, { timeout: 120_000 }, async () => {
    const host = await seed();
    const { page, calls, errors } = await phone(host.token, width, height);
    try {
      assert.equal(await page.evaluate(() => document.documentElement.classList.contains("ak-no-bounce")), true, "ak-no-bounce stays");
      assert.equal(await overscroll(page), "contain", "the kit binding sets contain on the scroller");
      assert.equal(await indicator(page).count(), 0, "no indicator before a pull");
      assert.equal(await page.evaluate(() => document.scrollingElement!.scrollTop), 0);

      // A pull past the threshold, with the plans request held so the loading state can be seen.
      const plans = hold(page, "**/api/plans");
      await plans.ready;
      const before = calls.socials;
      const lift = await pullDown(page);
      await indicator(page).waitFor();
      await page.waitForFunction(() => document.querySelector(".ak-ptr")?.classList.contains("ak-ptr-pulling"));
      assert.ok(await indicatorOpacity(page) > 0.9, "the indicator is fully visible past the threshold");
      await shot(page, "now-mid-pull");
      await lift();
      await page.waitForFunction(() => document.querySelector(".ak-ptr")?.classList.contains("ak-ptr-loading"));
      assert.equal(await indicator(page).evaluate((node) => node.classList.contains("ak-ptr-pulling")), false);
      assert.ok(await indicatorOpacity(page) > 0.9, "the indicator rests visible while loading");
      await shot(page, "now-loading");
      assert.equal(calls.socials - before, 1, "one refresh started");
      plans.release();
      await indicatorHidden(page);
      await page.waitForTimeout(700);
      assert.equal(calls.socials - before, 1, "still one refresh once it settled");
      await page.unroute("**/api/plans");
      await shot(page, "now-after");

      // A short pull under the threshold shows the indicator but does not refresh.
      const short = calls.socials;
      const liftShort = await pullDown(page, { distance: 40 });
      await liftShort();
      await indicatorHidden(page);
      await page.waitForTimeout(500);
      assert.equal(calls.socials, short, "a pull under the threshold does not refresh");

      // The binding survives redraws and tab switches: the same indicator element stays in the page.
      await indicator(page).evaluate((node) => node.setAttribute("data-keep", "1"));
      await tab(page, "Now").tap();
      await tab(page, "Circle").tap();
      await page.getByRole("heading", { name: "Members" }).waitFor();
      await tab(page, "You").tap();
      await page.getByRole("heading", { name: "You", exact: true, level: 1 }).waitFor();
      await tab(page, "Now").tap();
      await page.locator(".card-plan").first().waitFor();
      assert.equal(await page.locator(".ak-ptr[data-keep='1']").count(), 1, "the binding was not destroyed and recreated");
      assert.deepEqual(errors, [], "no page errors");
    } finally {
      await page.context().close();
    }
  });

  test(`a pull while scrolled down does not refresh, ${width}x${height}`, { timeout: 120_000 }, async () => {
    const host = await seed();
    const { page, calls, errors } = await phone(host.token, width, height);
    try {
      await page.addStyleTag({ content: ".page { min-height: 2600px !important; }" });
      await page.evaluate(() => window.scrollTo(0, 1500));
      await page.waitForFunction(() => window.scrollY > 1000);
      const before = calls.socials;
      const lift = await pullDown(page);
      assert.equal(await indicator(page).count(), 0, "no indicator while scrolled down");
      await shot(page, "scrolled-pull-no-indicator");
      await lift();
      await page.waitForTimeout(700);
      assert.equal(await indicator(page).count(), 0, "still no indicator");
      assert.equal(calls.socials, before, "no refresh");
      assert.ok(await page.evaluate(() => window.scrollY) > 0, "the page scrolled up a little instead");
      assert.deepEqual(errors, []);
    } finally {
      await page.context().close();
    }
  });

  test(`a pull on an open sheet does not refresh, ${width}x${height}`, { timeout: 120_000 }, async () => {
    const host = await seed();
    const { page, calls, errors } = await phone(host.token, width, height);
    try {
      await page.getByRole("button", { name: "Let friends know you're free now" }).tap();
      await page.locator(".sheet").waitFor();
      assert.equal(await overscroll(page), "none", "no binding while a sheet is open");
      const before = calls.socials;
      // Start on the scrim above the sheet, so the sheet's own swipe to close does not take the gesture.
      const lift = await pullDown(page, { fromY: 4, distance: 120 });
      assert.equal(await indicator(page).count(), 0, "no indicator over a sheet");
      await shot(page, "sheet-pull-no-indicator");
      await lift();
      await page.waitForTimeout(700);
      assert.equal(await indicator(page).count(), 0);
      assert.equal(calls.socials, before, "no refresh");

      // Closing the sheet binds again, and a pull works.
      await page.locator(".scrim").tap({ position: { x: 5, y: 5 } });
      await page.locator(".sheet").waitFor({ state: "detached" });
      assert.equal(await overscroll(page), "contain");
      await pullAndRefresh(page, calls, "Now after a sheet");
      assert.deepEqual(errors, []);
    } finally {
      await page.context().close();
    }
  });

  test(`Events (calendar), Circle and You refresh on a pull; chat and the Events map do not, ${width}x${height}`, { timeout: 180_000 }, async () => {
    const host = await seed();
    const { page, calls, errors } = await phone(host.token, width, height);
    try {
      await tab(page, "Events").tap();
      await page.getByRole("heading", { name: "Events", exact: true, level: 1 }).waitFor();
      await page.locator(".events-view").waitFor();
      await quiet(page);
      assert.equal(await overscroll(page), "contain", "Events calendar is bound");
      await pullAndRefresh(page, calls, "Events calendar");
      await shot(page, "events-after-pull");

      await tab(page, "Circle").tap();
      await page.getByRole("heading", { name: "Members" }).waitFor();
      await quiet(page);
      assert.equal(await overscroll(page), "contain", "Circle is bound");
      await pullAndRefresh(page, calls, "Circle");

      await tab(page, "You").tap();
      await page.getByRole("heading", { name: "You", exact: true, level: 1 }).waitFor();
      await quiet(page);
      assert.equal(await overscroll(page), "contain", "You is bound");
      await pullAndRefresh(page, calls, "You");
      await shot(page, "you-after-pull");

      // The Events map view is not bound.
      await openEventsMap(page);
      await page.locator(".events-view").waitFor();
      await quiet(page);
      assert.equal(await overscroll(page), "none", "the Events map is not bound");
      let before = calls.socials;
      let lift = await pullDown(page, { fromY: 100 });
      assert.equal(await indicator(page).count(), 0, "no indicator on the Events map");
      await lift();
      await page.waitForTimeout(700);
      assert.equal(await indicator(page).count(), 0);
      assert.equal(calls.socials, before, "no refresh on the Events map");

      // Event chat is not bound.
      await tab(page, "Chat").tap();
      await page.locator(".chat-screen").waitFor();
      await quiet(page);
      assert.equal(await overscroll(page), "none", "chat is not bound");
      before = calls.socials;
      lift = await pullDown(page, { fromY: 60 });
      assert.equal(await indicator(page).count(), 0, "no indicator in chat");
      await shot(page, "chat-pull-no-indicator");
      await lift();
      await page.waitForTimeout(700);
      assert.equal(await indicator(page).count(), 0);
      assert.equal(calls.socials, before, "no refresh in chat");
      assert.deepEqual(errors, []);
    } finally {
      await page.context().close();
    }
  });
}
