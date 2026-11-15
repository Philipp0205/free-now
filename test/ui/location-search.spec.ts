import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Page, Route } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { openPlanSheet } from "./plan-sheet.js";
import { UA as CHROME_UA, useHangry } from "./harness.js";

const SHOT_DIR = path.resolve(process.env.HANG_SHOT_DIR || "/workspace/hangry-shots/location-search/");
const WIDTHS = [[360, 740], [390, 844]] as const;
const HITS = [
  { name: "jomi Bagel Deli", address: "Hasenbergsteige 5, Stuttgart", lat: 48.7705, lng: 9.1655, distanceM: 1100 },
  { name: "Bagel Brothers", address: "Königstraße 1, Stuttgart", lat: 48.778, lng: 9.18, distanceM: 2100 },
];
const OTHER_HITS = [
  { name: "Old answer Café", address: "Somewhere", lat: 48.7, lng: 9.1, distanceM: 9000 },
];

type Geocode = (route: Route, query: string) => Promise<void> | void;

const hangry = useHangry();
const { call } = hangry;
let seq = 0;

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

/** A fresh user in a fresh circle, so plan/social counts start at zero. */
async function user() {
  seq += 1;
  const me = await call("POST", "/api/auth/start", undefined, { name: `Lena${seq}` });
  const { circle } = await call("POST", "/api/circles", me.token, { name: `Search ${seq}` });
  return { token: me.token as string, circleId: circle.id as string };
}

async function phone(
  width: number,
  height: number,
  who: { token: string; circleId: string },
  geocode: Geocode,
  options: { video?: boolean } = {},
) {
  const context = await hangry.browser.newContext({
    viewport: { width, height },
    isMobile: true,
    hasTouch: true,
    userAgent: CHROME_UA,
    ...(options.video ? { recordVideo: { dir: path.join(SHOT_DIR, "video-tmp"), size: { width, height } } } : {}),
  });
  await skipWhatsNew(context);
  await context.addInitScript(([value, circle]) => {
    localStorage.setItem("fn_install_later", String(Date.now()));
    localStorage.setItem("fn_token", value);
    localStorage.setItem("fn_circle", circle);
  }, [who.token, who.circleId]);
  // Never hit the real geocoder.
  await context.route("**/api/geocode?**", (route) => {
    const url = new URL(route.request().url());
    const q = url.searchParams.get("q");
    if (q == null) return route.fulfill({ json: { place: "", area: "" } });
    return geocode(route, q);
  });
  await context.route(/arcgisonline|tile\.openstreetmap|basemaps\.cartocdn/, (route) => route.abort());
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  return { page, errors };
}

async function dismiss(page: Page) {
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
}

async function home(page: Page) {
  await page.goto(hangry.baseUrl);
  await dismiss(page);
  await page.getByRole("button", { name: "Let friends know you're free now" }).waitFor();
}

async function openPlanWhere(page: Page) {
  await openPlanSheet(page);
  await page.locator("form.sheet #sheet-note").waitFor();
  await page.locator(".sheet button.where-row").click();
  await page.locator("#where-query").waitFor();
}

async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.waitForTimeout(120);
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}-w${page.viewportSize()!.width}.png`) });
}

function geocodeRequests(page: Page) {
  const seen: Array<{ q: string; at: number }> = [];
  page.on("request", (request) => {
    if (!request.url().includes("/api/geocode")) return;
    const q = new URL(request.url()).searchParams.get("q");
    if (q != null) seen.push({ q, at: Date.now() });
  });
  return seen;
}

function writes(page: Page) {
  const seen: string[] = [];
  page.on("request", (request) => {
    const method = request.method();
    const url = new URL(request.url());
    if (method === "GET" || !url.pathname.startsWith("/api/")) return;
    if (/^\/api\/(plans|socials)(\/|$)/.test(url.pathname)) seen.push(`${method} ${url.pathname}`);
  });
  return seen;
}

async function statusBox(page: Page) {
  return page.locator(".where-picker .where-status").evaluate((node) => node.getBoundingClientRect().height);
}

for (const [width, height] of WIDTHS) {
  test(`at ${width}: Searching… shows during the debounce and a slow geocoder, then hits`, { timeout: 90_000 }, async () => {
    const hold = deferred();
    const who = await user();
    const { page, errors } = await phone(width, height, who, async (route) => {
      await hold.promise;
      await route.fulfill({ json: { results: HITS } });
    }, { video: width === 360 });
    const requests = geocodeRequests(page);
    try {
      await home(page);
      await openPlanWhere(page);
      const status = page.locator(".where-picker .where-status");
      const idleHeight = await statusBox(page);
      const actionTop = await page.locator(".where-action").first().evaluate((node) => node.getBoundingClientRect().top);
      assert.equal(await status.textContent(), "", "idle status line is empty");

      await page.locator("#where-query").fill("jomi");
      // Right away, inside the 400 ms debounce, before any request.
      const early = await page.evaluate(() => {
        const row = document.querySelector(".where-picker .where-status");
        return { text: row?.textContent || "", spinner: Boolean(row?.querySelector(".where-spinner")) };
      });
      assert.equal(early.text, "Searching…");
      assert.ok(early.spinner, "spinner is shown during the debounce");
      assert.equal(requests.length, 0, "no request fired yet");
      await page.locator(".where-picker .where-status .where-spinner").waitFor({ state: "visible" });

      // The request is held. Searching… stays.
      await page.waitForRequest((request) => request.url().includes("/api/geocode?q="));
      await page.waitForTimeout(250);
      await status.getByText("Searching…").waitFor({ state: "visible" });
      assert.ok(await page.locator(".where-spinner").isVisible());
      assert.equal(await page.locator(".where-hit").count(), 0);
      assert.equal(await status.getAttribute("role"), "status");
      assert.ok(Math.abs((await statusBox(page)) - idleHeight) < 0.5, "status line keeps its height");
      const searchingActionTop = await page.locator(".where-action").first().evaluate((node) => node.getBoundingClientRect().top);
      assert.ok(Math.abs(searchingActionTop - actionTop) < 0.5, "Searching… does not push the picker down");
      await shot(page, "searching");

      hold.release();
      await page.locator(".where-hit").nth(HITS.length - 1).waitFor();
      assert.equal(await status.textContent(), "");
      assert.equal(await page.locator(".where-spinner").count(), 0);
      assert.ok(Math.abs((await statusBox(page)) - idleHeight) < 0.5);
      assert.equal(requests.length, 1);
      await shot(page, "results");

      // Below two characters: no Searching…, no "No places found", no hits.
      await page.locator("#where-query").fill("j");
      await page.waitForTimeout(600);
      assert.equal(await status.textContent(), "");
      assert.equal(await page.locator(".where-hit").count(), 0);
      assert.equal(requests.length, 1);
      assert.deepEqual(errors, []);
    } finally {
      const video = page.video();
      await page.context().close();
      if (video) {
        await video.saveAs(path.join(SHOT_DIR, `searching-w${width}.webm`));
        await video.delete();
        fs.rmSync(path.join(SHOT_DIR, "video-tmp"), { recursive: true, force: true });
      }
    }
  });

  test(`at ${width}: no hits says No places found, a failed search says so`, { timeout: 90_000 }, async () => {
    let mode: "empty" | "error" = "empty";
    const who = await user();
    const { page, errors } = await phone(width, height, who, (route) => {
      if (mode === "error") return route.fulfill({ status: 500, json: { error: "geocoder down" } });
      return route.fulfill({ json: { results: [] } });
    });
    try {
      await home(page);
      await openPlanWhere(page);
      const status = page.locator(".where-picker .where-status");
      const idleHeight = await statusBox(page);
      await page.locator("#where-query").fill("zzqx nowhere");
      await status.getByText("No places found").waitFor();
      assert.equal(await page.locator(".where-hit").count(), 0);
      assert.ok(Math.abs((await statusBox(page)) - idleHeight) < 0.5);
      await shot(page, "no-results");

      mode = "error";
      await page.locator("#where-query").fill("zzqx elsewhere");
      await status.getByText("Couldn't search. Try again.").waitFor();
      assert.equal(await page.locator(".where-hit").count(), 0);
      await shot(page, "search-error");

      // Clearing the text clears the message without flashing the empty state.
      await page.locator("#where-query").fill("");
      await page.waitForTimeout(500);
      assert.equal(await status.textContent(), "");
      assert.deepEqual(errors, []);
    } finally {
      await page.context().close();
    }
  });
}

test("an older answer never replaces a newer one", { timeout: 60_000 }, async () => {
  const slow = deferred();
  const who = await user();
  const { page, errors } = await phone(390, 844, who, async (route, q) => {
    if (q === "old") {
      await slow.promise;
      return route.fulfill({ json: { results: OTHER_HITS } });
    }
    return route.fulfill({ json: { results: HITS } });
  });
  try {
    await home(page);
    await openPlanWhere(page);
    const query = page.locator("#where-query");
    await query.fill("old");
    await page.waitForRequest((request) => request.url().includes("q=old"));
    await query.fill("jomi");
    await page.locator(".where-hit").nth(HITS.length - 1).waitFor();
    slow.release();
    await page.waitForTimeout(400);
    const names = await page.locator(".where-hit-name").allTextContents();
    assert.deepEqual(names, HITS.map((hit) => hit.name));
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

test("Enter in the place field searches at once and does not create the plan", { timeout: 60_000 }, async () => {
  const who = await user();
  const { page, errors } = await phone(390, 844, who, (route) => route.fulfill({ json: { results: HITS } }));
  const requests = geocodeRequests(page);
  const sent = writes(page);
  try {
    await home(page);
    await openPlanWhere(page);
    await page.locator("#sheet-note").fill("Bagels");
    await page.locator(".sheet button.where-row").isVisible();
    const query = page.locator("#where-query");
    await query.focus();
    await page.keyboard.insertText("jo");
    const typedAt = Date.now();
    await page.keyboard.press("Enter");
    await page.locator(".where-hit").first().waitFor({ timeout: 2000 });
    assert.ok(requests.length >= 1, "Enter fired a search");
    assert.ok(requests[0].at - typedAt < 350, `search fired before the debounce (${requests[0].at - typedAt} ms)`);
    await page.waitForTimeout(700);
    assert.equal(requests.length, 1, "the debounce did not fire a second search");

    // Sheet stays, nothing was picked, nothing was saved.
    await page.locator("form.sheet").waitFor({ state: "visible" });
    assert.equal(await page.locator("#where-query").inputValue(), "jo");
    assert.equal(await page.locator(".where-v").textContent(), "jo");
    assert.deepEqual(sent, []);
    const { plans } = await call("GET", "/api/plans", who.token);
    assert.equal(plans.length, 0);

    // A second Enter (Android's Search key again) still does not save.
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    await page.locator("form.sheet").waitFor({ state: "visible" });
    assert.deepEqual(sent, []);

    // The real button still saves.
    await page.locator(".where-hit").first().click();
    const created = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/plans"));
    await page.locator(".sheet-dock").getByRole("button", { name: "Add plan" }).click();
    assert.equal((await created).status(), 201);
    await page.locator("form.sheet").waitFor({ state: "detached" });
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

test("Enter in the plan title or a time field does not create the plan", { timeout: 60_000 }, async () => {
  const who = await user();
  const { page, errors } = await phone(360, 740, who, (route) => route.fulfill({ json: { results: HITS } }));
  const sent = writes(page);
  try {
    await home(page);
    await openPlanSheet(page);
    const note = page.locator("#sheet-note");
    await note.fill("Walk and din");
    await note.press("Enter");
    await page.locator("#plan-time").press("Enter");
    await page.waitForTimeout(500);
    await page.locator("form.sheet").waitFor({ state: "visible" });
    assert.equal(await note.inputValue(), "Walk and din");
    assert.deepEqual(sent, []);
    const { plans } = await call("GET", "/api/plans", who.token);
    assert.equal(plans.length, 0);
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

test("Enter in the free-now note or place field does not post", { timeout: 60_000 }, async () => {
  const who = await user();
  const { page, errors } = await phone(360, 740, who, (route) => route.fulfill({ json: { results: HITS } }));
  const sent = writes(page);
  try {
    await home(page);
    await page.getByRole("button", { name: "Let friends know you're free now" }).click();
    await page.locator("form.sheet #sheet-note").fill("Coffee?");
    await page.locator("#sheet-note").press("Enter");
    await page.locator(".sheet button.where-row").click();
    await page.locator("#where-query").fill("jo");
    await page.locator("#where-query").press("Enter");
    await page.locator(".where-hit").first().waitFor();
    await page.waitForTimeout(400);
    await page.locator("form.sheet").waitFor({ state: "visible" });
    assert.deepEqual(sent, []);
    const { socials } = await call("GET", "/api/socials", who.token);
    assert.equal(socials.length, 0);
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

test("Enter in the edit sheet does not save", { timeout: 60_000 }, async () => {
  const who = await user();
  await call("POST", "/api/plans", who.token, { note: "Bagels for lunch", time: "12:45" });
  const { page, errors } = await phone(390, 844, who, (route) => route.fulfill({ json: { results: HITS } }));
  const sent = writes(page);
  try {
    await home(page);
    await page.getByRole("button", { name: /^More for / }).first().click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    await page.locator("#admin-note").fill("Bagels for dinner");
    await page.locator("#admin-note").press("Enter");
    await page.locator(".sheet button.where-row").click();
    await page.locator("#where-query").fill("jomi");
    await page.locator("#where-query").press("Enter");
    await page.locator(".where-hit").first().waitFor();
    await page.waitForTimeout(400);
    await page.locator("form.sheet").waitFor({ state: "visible" });
    assert.deepEqual(sent, []);

    const saved = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().includes("/api/plans/"));
    await page.locator(".sheet-dock").getByRole("button", { name: "Save" }).click();
    assert.equal((await saved).status(), 200);
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});
