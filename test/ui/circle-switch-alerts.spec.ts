import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { Page, Request, Route, APIResponse } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { UA, useHangry } from "./harness.js";

/** Screenshots go here (gitignored). Override with CSA_SHOT_DIR=/some/folder. */
const SHOT_DIR = path.resolve(process.env.CSA_SHOT_DIR || "test/ui/screenshots/circle-switch-alerts");
/** Two phones and a desktop window. The banner and list are the same component at each. */
const VIEWS = [[360, 640], [412, 915], [1280, 800]] as const;

const hangry = useHangry();
const { call } = hangry;

type Note = { id: string; title: string; body: string };

/**
 * Holds back one GET /api/notifications answer, the way a slow phone network does.
 * The server answers at request time (so the data is what it was then); the page only sees it on release().
 */
async function slowNetwork(page: Page) {
  let armed = false;
  let held: { request: Request; release: () => void } | null = null;
  let onHeld: (() => void) | null = null;
  await page.route("**/api/notifications", async (route: Route) => {
    if (route.request().method() !== "GET" || !armed || held) {
      await route.continue();
      return;
    }
    armed = false;
    let response: APIResponse;
    try {
      response = await route.fetch();
    } catch {
      return;
    }
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    held = { request: route.request(), release };
    onHeld?.();
    await gate;
    await route.fulfill({ response }).catch(() => {});
  });
  return {
    /** Holds the next poll that goes out, and resolves once it is held. */
    async holdNextPoll() {
      held = null;
      armed = true;
      await new Promise<void>((resolve) => { onHeld = resolve; });
      onHeld = null;
    },
    /** Lets the held answer reach the page, and waits until the app has had it. */
    async release() {
      const current = held;
      assert.ok(current, "nothing held");
      const landed = page.waitForResponse((r) => r.request() === current.request);
      current.release();
      await landed;
      await page.waitForTimeout(400);
    },
  };
}

/** Logs every banner the page shows, once per appearance. render() rebuilds the DOM, so a banner that stays up is one entry. */
async function recordBanners(page: Page) {
  await page.addInitScript(() => {
    const log: string[] = [];
    (window as unknown as { __banners: string[] }).__banners = log;
    let last: string | null = null;
    new MutationObserver(() => {
      const text = document.querySelector(".banner")?.textContent ?? null;
      if (text !== last && text) log.push(text);
      last = text;
    }).observe(document, { childList: true, subtree: true });
  });
}

function banners(page: Page): Promise<string[]> {
  return page.evaluate(() => [...(window as unknown as { __banners: string[] }).__banners]);
}

async function openAs(width: number, height: number, token: string, circleId: string) {
  const mobile = width < 600;
  const context = await hangry.browser.newContext({
    viewport: { width, height },
    // page.route sees every API call. The app's worker never answers /api/ anyway.
    serviceWorkers: "block",
    ...(mobile ? { isMobile: true, hasTouch: true, userAgent: UA } : {}),
  });
  await skipWhatsNew(context);
  await context.addInitScript(([value, circle]) => {
    if (sessionStorage.getItem("csa_seeded")) return;
    sessionStorage.setItem("csa_seeded", "1");
    localStorage.setItem("fn_install_later", String(Date.now()));
    localStorage.setItem("fn_token", value);
    localStorage.setItem("fn_circle", circle);
  }, [token, circleId]);
  await context.route("https://*.tile.openstreetmap.org/**", (route) => route.fulfill({ status: 204, body: "" }));
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await recordBanners(page);
  return { page, errors };
}

async function dismiss(page: Page) {
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
}

async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const size = page.viewportSize()!;
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}-${size.width}.png`) });
}

function circleName(page: Page) {
  return page.locator(".circle-switch-btn > span").first();
}

async function switchTo(page: Page, name: string, circleId: string) {
  await page.getByRole("button", { name: "Switch circle" }).click();
  await page.locator(".circle-menu").waitFor();
  const answered = page.waitForResponse((r) => r.url().endsWith("/api/notifications") && r.request().method() === "GET"
    && r.request().headers()["x-circle"] === circleId);
  await page.locator(".circle-menu button", { hasText: name }).click();
  await answered;
  await page.locator(".circle-menu").waitFor({ state: "detached" });
  await assert.doesNotReject(circleName(page).filter({ hasText: name }).waitFor({ timeout: 5000 }));
}

/** The Alerts list shows this circle's alerts, each exactly once. */
async function assertListIs(page: Page, notes: Note[], label: string) {
  const cards = await page.locator(".alert-card").allInnerTexts();
  assert.equal(cards.length, notes.length, `${label}: ${cards.join(" | ")}`);
  for (const note of notes) {
    const hits = cards.filter((text) => text.includes(note.body));
    assert.equal(hits.length, 1, `${label}: "${note.body}" in ${cards.join(" | ")}`);
  }
}

for (const [width, height] of VIEWS) {
  test(`at ${width}: switching circles never repeats an alert, and one new alert shows once`, { timeout: 150_000 }, async () => {
    const home = `Home ${width}`;
    const uni = `Uni ${width}`;
    const bea = await call("POST", "/api/auth/start", undefined, { name: "Bea" });
    const a = (await call("POST", "/api/circles", bea.token, { name: home })).circle;
    const b = (await call("POST", "/api/circles", bea.token, { name: uni })).circle;
    const alex = await call("POST", "/api/auth/start", undefined, { name: "Alex", code: a.inviteCode });
    await call("POST", "/api/circles/join", alex.token, { code: b.inviteCode });
    // One alert Alex already has in each circle.
    await call("POST", `/api/plans?circle=${a.id}`, bea.token, { note: "Pizza night", time: "19:30" });
    await call("POST", `/api/plans?circle=${b.id}`, bea.token, { note: "Study group", time: "18:00" });
    const listFor = async (circleId: string): Promise<Note[]> =>
      (await call("GET", `/api/notifications?circle=${circleId}`, alex.token)).notifications;
    const homeNotes = await listFor(a.id);
    const uniNotes = await listFor(b.id);
    assert.equal(homeNotes.length, 1);
    assert.equal(uniNotes.length, 1);

    const { page, errors } = await openAs(width, height, alex.token, a.id);
    const net = await slowNetwork(page);
    try {
      await page.goto(hangry.baseUrl);
      await dismiss(page);
      await circleName(page).filter({ hasText: home }).waitFor();
      await page.locator(".screen-head .icon-btn[aria-label^='Alerts']").click();
      await page.locator(".alert-card").first().waitFor();
      await assertListIs(page, homeNotes, "Home at start");

      // Four switches. Each one happens while a 3s refresh for the circle being left is still on its way.
      const trips = [[uni, b.id, uniNotes], [home, a.id, homeNotes], [uni, b.id, uniNotes], [home, a.id, homeNotes]] as const;
      for (const [index, [name, id, notes]] of trips.entries()) {
        await net.holdNextPoll();
        await switchTo(page, name, id);
        await assertListIs(page, [...notes], `switch ${index + 1} to ${name}`);
        await net.release();
        // The late answer was for the other circle: it must not repaint this one or banner its alerts.
        assert.equal(await circleName(page).innerText(), name, `switch ${index + 1}: still on ${name}`);
        await assertListIs(page, [...notes], `switch ${index + 1} to ${name}, after the late answer`);
        assert.deepEqual(await banners(page), [], `switch ${index + 1}: old alerts are not news`);
      }

      // One new alert in Home, while an older refresh (sent before it existed) is still on its way.
      await net.holdNextPoll();
      await call("POST", `/api/socials?circle=${a.id}`, bea.token, { note: "Coffee" });
      const fresh = await listFor(a.id);
      assert.equal(fresh.length, 2);
      const coffee = fresh[0];
      assert.match(coffee.body, /Coffee/);
      const shown = page.locator(".banner", { hasText: "Coffee" });
      await shown.waitFor({ timeout: 10_000 });
      await shot(page, "banner-once");
      await net.release();
      // Give two more 3s refreshes time to land after the late one.
      await page.waitForTimeout(7000);
      const log = await banners(page);
      assert.equal(log.filter((text) => text.includes("Coffee")).length, 1, `banners: ${log.join(" | ")}`);
      assert.equal(log.length, 1, `only the new alert bannered: ${log.join(" | ")}`);
      assert.equal(await circleName(page).innerText(), home);
      await assertListIs(page, fresh, "Home after the new alert");
      await shot(page, "alerts-once");
      assert.deepEqual(errors, []);
    } finally {
      await page.context().close();
    }
  });
}
