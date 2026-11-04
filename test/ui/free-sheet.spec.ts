import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import { FIELD_REVEAL_MS } from "../../public/keyboard.js";
import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { openDb } from "../../src/db.js";
import { createNoopPushSender } from "../../src/push.js";

const SHOT_DIR = process.env.HANG_SHOT_DIR || path.join(process.cwd(), "test-results");

function shot(name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  return path.join(SHOT_DIR, name);
}

const DENIED_NOTIFICATIONS = `(() => {
  function HangryNotification() {}
  HangryNotification.permission = "denied";
  HangryNotification.requestPermission = () => Promise.resolve("denied");
  Object.defineProperty(window, "Notification", {
    configurable: true,
    get: () => HangryNotification,
  });
})();`;

const CHROME_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36";
const FIREFOX_UA = "Mozilla/5.0 (Android 14; Mobile; rv:130.0) Gecko/130.0 Firefox/130.0";
const PLACE = "Near Schlossplatz, Stuttgart-Mitte";

let browser: Browser;
let baseUrl = "";
let closeServer: () => Promise<void> = async () => {};

const vvMock = `(() => {
  const bucket = { height: null, offsetTop: 0 };
  const listeners = new Map();
  const fake = {
    get width() { return window.innerWidth; },
    get height() { return bucket.height == null ? window.innerHeight : bucket.height; },
    get offsetTop() { return bucket.offsetTop; },
    get offsetLeft() { return 0; },
    get pageTop() { return bucket.offsetTop; },
    get pageLeft() { return 0; },
    get scale() { return 1; },
    addEventListener(type, fn) {
      let set = listeners.get(type);
      if (!set) { set = new Set(); listeners.set(type, set); }
      set.add(fn);
    },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    dispatchEvent(event) {
      for (const fn of listeners.get(event.type) ?? []) fn(event);
      return true;
    },
  };
  window.__setVisualViewport = (next) => {
    if ("height" in next) bucket.height = next.height;
    if ("offsetTop" in next) bucket.offsetTop = next.offsetTop;
    fake.dispatchEvent(new Event("resize"));
  };
  Object.defineProperty(window, "visualViewport", { configurable: true, get: () => fake });
})();`;

test.before(async () => {
  const db = openDb(":memory:");
  const config = loadConfig({ PORT: "3000", DB_PATH: ":memory:", APP_TZ: "UTC" });
  const server = http.createServer(createApp({
    db,
    push: createNoopPushSender(),
    config: { ...config, dbPath: ":memory:" },
    now: () => Date.now(),
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closeServer = async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  };
  try { browser = await chromium.launch({ channel: "chrome", headless: true }); }
  catch { browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true }); }
});

test.after(async () => {
  await browser?.close();
  await closeServer();
});

test("the free sheet reads as separate fields", { timeout: 90_000 }, async () => {
  const page = await phonePage(CHROME_UA, false);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  try {
    await openFreeSheet(page, "Philipp");
    await page.getByText("Note (optional)", { exact: true }).waitFor();
    await page.getByText("Pick a place", { exact: true }).waitFor();
    assert.equal(await page.getByText("Nowhere").count(), 0);
    assert.match(await page.locator(".sheet-summary").innerText(), /Friends get: Philipp is free now/);
    const rhythm = await page.evaluate(() => {
      const sheet = getComputedStyle(document.querySelector("form.sheet")!);
      const note = document.getElementById("sheet-note")!;
      const noteLabel = [...document.querySelectorAll(".sheet-label")].find((node) => node.textContent === "Note (optional)")!;
      const segment = document.querySelector(".segment")!.getBoundingClientRect();
      const labelBox = noteLabel.getBoundingClientRect();
      const noteBox = note.getBoundingClientRect();
      return {
        sheet: sheet.backgroundColor,
        note: getComputedStyle(note).backgroundColor,
        groupGap: labelBox.top - segment.bottom,
        labelGap: noteBox.top - labelBox.bottom,
      };
    });
    assert.notEqual(rhythm.note, rhythm.sheet, JSON.stringify(rhythm));
    assert.ok(rhythm.groupGap >= 12 && rhythm.groupGap <= 24, JSON.stringify(rhythm));
    assert.ok(rhythm.labelGap >= 4 && rhythm.labelGap <= 12, JSON.stringify(rhythm));

    await page.getByRole("button", { name: "Later today" }).click();
    await page.locator("#later-time").waitFor();
    await page.getByText("Time", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "In 1 hour" }).count(), 0);
    await page.locator("#later-time").focus();
    await page.evaluate(() => window.__setVisualViewport({ height: 330, offsetTop: 0 }));
    await page.waitForTimeout(FIELD_REVEAL_MS + 300);
    const placed = await page.evaluate(() => {
      const field = document.getElementById("later-time")?.getBoundingClientRect();
      const dock = document.querySelector(".sheet-dock")?.getBoundingClientRect();
      return { bottom: field?.bottom ?? null, dock: dock?.top ?? null };
    });
    assert.ok(placed.bottom != null && placed.dock != null && placed.bottom <= placed.dock - 8, JSON.stringify(placed));
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

test("one delete clears an untouched current location in Chrome and Firefox", { timeout: 120_000 }, async () => {
  for (const ua of [CHROME_UA, FIREFOX_UA]) {
    const page = await phonePage(ua, true);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    try {
      await openFreeSheet(page, "Philipp");
      await page.locator(".where-v", { hasText: PLACE }).waitFor({ timeout: 8000 });
      await page.locator("button.where-row").click();
      const query = page.locator("#where-query");
      await query.waitFor();
      assert.equal(await query.inputValue(), PLACE);

      await deleteBackward(page, ua);
      assert.equal(await query.inputValue(), "");
      await page.locator(".where-v", { hasText: "Pick a place" }).waitFor();
      assert.doesNotMatch(await page.locator(".sheet-summary").innerText(), /Schlossplatz/);

      await page.getByRole("button", { name: "Use my current location" }).click();
      await page.locator("#where-query").waitFor();
      await expectValue(page, PLACE);
      await insertText(page, ua, "c");
      assert.equal(await page.locator("#where-query").inputValue(), "c");
      await insertText(page, ua, "a");
      assert.equal(await page.locator("#where-query").inputValue(), "ca");
      await deleteBackward(page, ua);
      assert.equal(await page.locator("#where-query").inputValue(), "c");

      if (ua === FIREFOX_UA) {
        await page.getByRole("button", { name: "Use my current location" }).click();
        await expectValue(page, PLACE);
        await page.evaluate(() => {
          const input = document.getElementById("where-query") as HTMLInputElement;
          input.focus();
          input.value = input.value.slice(0, -1);
          input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
        });
        assert.equal(await page.locator("#where-query").inputValue(), "");
      }
      assert.deepEqual(errors, []);
    } finally {
      await page.context().close();
    }
  }
});

test("back, escape, and a swipe close the sheet without leaving", { timeout: 90_000 }, async () => {
  const page = await phonePage(CHROME_UA, false);
  try {
    await openFreeSheet(page, "Philipp");
    const home = page.url();
    await page.keyboard.press("Escape");
    await page.locator("form.sheet").waitFor({ state: "detached" });
    assert.equal(page.url(), home);

    await page.getByRole("button", { name: "Let friends know you're free now" }).click();
    await page.locator("form.sheet").waitFor();
    await page.evaluate(() => history.back());
    await page.locator("form.sheet").waitFor({ state: "detached" });
    assert.equal(page.url(), home);

    await page.getByRole("button", { name: "Let friends know you're free now" }).click();
    await page.locator(".grabber").waitFor();
    const handle = await page.locator("form.sheet .grabber").boundingBox();
    assert.ok(handle);
    await page.mouse.move(handle.x + handle.width / 2, handle.y + 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + 180, { steps: 10 });
    await page.mouse.up();
    await page.locator("form.sheet").waitFor({ state: "detached" });
    assert.equal(page.url(), home);
  } finally {
    await page.context().close();
  }
});

test("later today defaults to the next half hour", { timeout: 90_000 }, async () => {
  const page = await phonePage(CHROME_UA, false);
  try {
    await openFreeSheet(page, "Philipp");
    await page.getByRole("button", { name: "Later today" }).click();
    const value = await page.locator("#later-time").inputValue();
    assert.match(value, /^\d{2}:(00|30)$/);
    assert.equal(await page.getByRole("button", { name: "I'm free later" }).isDisabled(), false);
    await page.locator("#later-time").evaluate((input) => {
      const field = input as HTMLInputElement;
      field.value = "00:00";
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.getByText("Pick a time later today").waitFor();
    const summary = await page.locator(".sheet-summary").boundingBox();
    const toast = await page.locator(".toast").count();
    assert.equal(toast, 0);
    assert.ok(summary);
  } finally {
    await page.context().close();
  }
});

test("pick time keeps a one-tap I'm in and can set an arrival clock", { timeout: 90_000 }, async () => {
  const page = await phonePage(CHROME_UA, false);
  try {
    await openFreeSheet(page, "Alex");
    const token = await page.evaluate(() => localStorage.getItem("fn_token"));
    const me = await fetch(`${baseUrl}/api/me`, { headers: { authorization: `Bearer ${token}` } }).then((response) => response.json());
    const friend = await fetch(`${baseUrl}/api/auth/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Fritz", code: me.circle.inviteCode }),
    }).then((response) => response.json());
    await fetch(`${baseUrl}/api/socials`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ note: "Coffee", place: "Schlossplatz", lat: 48.7784, lng: 9.18 }),
    });
    const viewerContext = await browser.newContext({
      viewport: { width: 360, height: 640 },
      isMobile: true,
      hasTouch: true,
      userAgent: CHROME_UA,
    });
    await viewerContext.addInitScript(vvMock);
    await viewerContext.addInitScript((value) => localStorage.setItem("fn_token", value), friend.token);
    const viewer = await viewerContext.newPage();
    await viewer.goto(baseUrl);
    const later = viewer.locator(".sheet button", { hasText: "Not now" });
    if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
    await viewer.getByRole("button", { name: "I'm in" }).click();
    await viewer.getByText("You're in", { exact: true }).waitFor();
    assert.equal(await viewer.getByRole("button", { name: "5 min" }).count(), 1);
    assert.equal(await viewer.getByRole("button", { name: "Pick time" }).count(), 1);
    await viewer.screenshot({ path: shot("fix-arrive-before.png") });
    await viewer.getByRole("button", { name: "Pick time" }).click();
    await viewer.getByText(/You're in, arriving /).waitFor();
    const field = viewer.locator(".arrive-field input");
    await field.waitFor();
    const placed = await field.evaluate((input) => {
      const box = input.getBoundingClientRect();
      const tab = document.querySelector(".tabbar")?.getBoundingClientRect().top ?? window.innerHeight;
      const style = getComputedStyle(input);
      return {
        bottom: box.bottom,
        tab,
        background: style.backgroundColor,
        min: (input as HTMLInputElement).min,
        max: (input as HTMLInputElement).max,
        value: (input as HTMLInputElement).value,
      };
    });
    assert.ok(placed.bottom <= placed.tab - 8, JSON.stringify(placed));
    assert.equal(placed.background, "rgb(44, 44, 46)");
    assert.match(placed.min, /^\d{2}:\d{2}$/);
    assert.match(placed.max, /^\d{2}:\d{2}$/);
    assert.ok(placed.value >= placed.min && placed.value <= placed.max, JSON.stringify(placed));
    await viewer.screenshot({ path: shot("fix-arrive-time.png") });
    await viewerContext.close();
    await page.reload();
    const hostLater = page.locator(".sheet button", { hasText: "Not now" });
    if (await hostLater.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await hostLater.click();
    await page.getByText(/Fritz is in, arriving /).waitFor();
    await page.screenshot({ path: shot("fix-arrive-host.png") });
  } finally {
    await page.context().close();
  }
});

test("a saved session stays in the app when the network drops", { timeout: 90_000 }, async () => {
  const page = await phonePage(CHROME_UA, false);
  try {
    await signIn(page, "Philipp");
    await page.waitForFunction(() => (localStorage.getItem("fn_state") || "").includes("circle"));
    await page.route("**/api/**", (route) => route.abort("internetdisconnected"));
    await page.reload();
    await page.getByText("You're offline. Retrying…").waitFor();
    assert.equal(await page.locator("#name").count(), 0);
    await page.getByRole("button", { name: "Let friends know you're free now" }).waitFor();
    await page.screenshot({ path: shot("polish-offline.png") });
  } finally {
    await page.context().close();
  }
});

test("denied notifications explain how to allow them again", { timeout: 90_000 }, async () => {
  const page = await phonePage(CHROME_UA, false, DENIED_NOTIFICATIONS);
  try {
    await signIn(page, "Philipp");
    await page.getByRole("heading", { name: "Notifications are blocked" }).waitFor();
    await page.getByText("Settings → Site settings → Notifications").waitFor();
    assert.equal(await page.getByRole("button", { name: "Turn on notifications" }).count(), 0);
    await page.screenshot({ path: shot("polish-notifications-denied.png") });
    await page.locator(".sheet button.btn.ghost", { hasText: "Not now" }).click();
    await page.getByRole("button", { name: "You", exact: true }).click();
    await page.getByRole("button", { name: "Notifications" }).click();
    await page.locator(".guide").waitFor();
    await page.getByText("Settings → Site settings → Notifications").waitFor();
    assert.equal(await page.locator(".guide").getByRole("button", { name: "Turn on notifications" }).count(), 0);
  } finally {
    await page.context().close();
  }
});

test("a place line opens that pin and Back returns", { timeout: 90_000 }, async () => {
  const page = await phonePage(CHROME_UA, false);
  try {
    await openFreeSheet(page, "Alex");
    const token = await page.evaluate(() => localStorage.getItem("fn_token"));
    await fetch(`${baseUrl}/api/socials`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ note: "Coffee", place: "Schlossplatz", lat: 48.7784, lng: 9.18 }),
    });
    await page.reload();
    const later = page.locator(".sheet button", { hasText: "Not now" });
    if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
    await page.getByRole("button", { name: "Show Schlossplatz on the map" }).click();
    await page.locator(".map-card").waitFor({ timeout: 8000 });
    await page.getByText("Coffee").waitFor();
    await page.screenshot({ path: shot("polish-map-pin.png") });
    await page.evaluate(() => history.back());
    await page.getByRole("button", { name: "Let friends know you're free now" }).waitFor();
    assert.equal(await page.locator(".map-card").count(), 0);
  } finally {
    await page.context().close();
  }
});

test("each place tap recentres on that pin", { timeout: 90_000 }, async () => {
  const page = await phonePage(CHROME_UA, false);
  try {
    await signIn(page, "Alex");
    const token = await page.evaluate(() => localStorage.getItem("fn_token"));
    const me = await fetch(`${baseUrl}/api/me`, { headers: { authorization: `Bearer ${token}` } }).then((response) => response.json());
    const bea = await fetch(`${baseUrl}/api/auth/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Bea", code: me.circle.inviteCode }),
    }).then((response) => response.json());
    await fetch(`${baseUrl}/api/socials`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ note: "Coffee", place: "Schlossplatz", lat: 48.7784, lng: 9.18 }),
    });
    await fetch(`${baseUrl}/api/socials`, {
      method: "POST",
      headers: { authorization: `Bearer ${bea.token}`, "content-type": "application/json" },
      body: JSON.stringify({ note: "Dinner", place: "Rathaus", lat: 48.78, lng: 9.19 }),
    });
    await page.reload();
    const later = page.locator(".sheet button", { hasText: "Not now" });
    if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
    await page.getByRole("button", { name: "Show Schlossplatz on the map" }).click();
    await page.locator(".map-card").getByText("Coffee").waitFor({ timeout: 8000 });
    const placed = await page.evaluate(() => {
      const pin = document.querySelector(".leaflet-marker-icon")?.getBoundingClientRect();
      const card = document.querySelector(".map-card")?.getBoundingClientRect();
      return { pin: pin?.bottom ?? null, card: card?.top ?? null };
    });
    assert.ok(placed.pin != null && placed.card != null && placed.pin <= placed.card + 4, JSON.stringify(placed));
    await page.getByRole("button", { name: "Now", exact: true }).click();
    await page.getByRole("button", { name: "Show Rathaus on the map" }).click();
    await page.locator(".map-card").getByText("Dinner").waitFor({ timeout: 8000 });
    assert.equal(await page.locator(".map-card").getByText("Coffee").count(), 0);
  } finally {
    await page.context().close();
  }
});

test("a plan link opens the map on that plan", { timeout: 90_000 }, async () => {
  const page = await phonePage(CHROME_UA, false);
  try {
    await signIn(page, "Alex");
    const token = await page.evaluate(() => localStorage.getItem("fn_token"));
    const plan = await fetch(`${baseUrl}/api/plans`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ note: "Bouldering", place: "Gym", lat: 48.775, lng: 9.175 }),
    }).then((response) => response.json());
    await page.goto(`${baseUrl}/?plan=${plan.plan.id}`);
    const later = page.locator(".sheet button", { hasText: "Not now" });
    if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
    await page.locator(".map-card").getByText("Bouldering").waitFor({ timeout: 8000 });
    assert.equal(await page.locator(".screen-title").innerText(), "Map");
    assert.equal(new URL(page.url()).search, "");
    await page.evaluate(() => history.back());
    await page.getByRole("button", { name: "Let friends know you're free now" }).waitFor();
    assert.equal(new URL(page.url()).search, "");
    await page.reload();
    const laterAgain = page.locator(".sheet button", { hasText: "Not now" });
    if (await laterAgain.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await laterAgain.click();
    await page.getByRole("button", { name: "Let friends know you're free now" }).waitFor();
    assert.equal(await page.locator(".map-card").count(), 0);
  } finally {
    await page.context().close();
  }
});

test("panning the place map does not close the sheet", { timeout: 90_000 }, async () => {
  const page = await phonePage(CHROME_UA, false);
  try {
    await page.setViewportSize({ width: 412, height: 915 });
    await openFreeSheet(page, "Philipp");
    await page.locator("button.where-row").click();
    await page.getByRole("button", { name: "Pick on map" }).click();
    await page.locator("#where-map .leaflet-marker-icon").waitFor({ timeout: 8000 });
    await page.locator(".sheet-scroll").evaluate((node) => { node.scrollTop = 0; });
    await dragDown(page, page.locator("#where-map"));
    assert.equal(await page.locator("form.sheet").count(), 1);
    await dragDown(page, page.locator("#where-map .leaflet-marker-icon"));
    assert.equal(await page.locator("form.sheet").count(), 1);
  } finally {
    await page.context().close();
  }
});

test("a scrolled install guide drags closed only from the top", { timeout: 90_000 }, async () => {
  const page = await phonePage(CHROME_UA, false, DENIED_NOTIFICATIONS);
  try {
    await signIn(page, "Philipp");
    const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
    if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
    await page.getByRole("button", { name: "You", exact: true }).click();
    await page.getByRole("button", { name: "Notifications" }).click();
    await page.locator(".guide").waitFor();
    await page.locator(".guide-scrim").evaluate((node) => {
      const filler = document.createElement("div");
      filler.style.height = "900px";
      node.querySelector(".guide")?.append(filler);
      node.scrollTop = 240;
    });
    const spot = await page.evaluate(() => {
      const scrim = document.querySelector(".guide-scrim");
      if (!scrim) return null;
      const rect = scrim.getBoundingClientRect();
      for (let y = rect.top + 24; y < rect.bottom - 24; y += 16) {
        const hit = document.elementFromPoint(rect.left + 36, y);
        if (!hit || !scrim.contains(hit) || hit.closest("button, a, input")) continue;
        return { x: rect.left + 36, y };
      }
      return null;
    });
    assert.ok(spot, "no guide text to drag");
    await page.mouse.move(spot.x, spot.y);
    await page.mouse.down();
    await page.mouse.move(spot.x, spot.y + 180, { steps: 12 });
    await page.mouse.up();
    assert.equal(await page.locator(".guide").count(), 1);
    const scrolled = await page.locator(".guide-scrim").evaluate((node) => node.scrollTop);
    assert.ok(scrolled > 0, `expected the guide to stay scrolled, top=${scrolled}`);
    await page.locator(".guide-scrim").evaluate((node) => { node.scrollTop = 0; });
    await dragDown(page, page.locator(".guide .lede"));
    await page.locator(".guide").waitFor({ state: "detached" });
  } finally {
    await page.context().close();
  }
});

test("a failed address lookup still names the pin", { timeout: 90_000 }, async () => {
  const page = await phonePage(CHROME_UA, false);
  await page.route("**/api/geocode?**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("q")) return route.fulfill({ json: { results: [] } });
    if (url.searchParams.get("lat") === "1") {
      return route.fulfill({ json: { place: "", area: "Mitte" } });
    }
    return new Promise(() => {});
  });
  try {
    await openFreeSheet(page, "Philipp");
    await page.locator("button.where-row").click();
    await page.getByRole("button", { name: "Pick on map" }).click();
    await page.locator("#where-map .leaflet-marker-icon").waitFor({ timeout: 8000 });
    await page.locator("#where-map").click({ position: { x: 40, y: 40 } });
    await page.waitForFunction(() => {
      const text = document.querySelector(".where-v")?.textContent || "";
      return text.startsWith("Pinned spot (") || text.startsWith("Dropped pin near ");
    }, null, { timeout: 8000 });
    const named = await page.locator(".where-v").innerText();
    assert.notEqual(named, "Finding address…");
    await page.getByRole("button", { name: "I'm free" }).click();
    await page.getByRole("button", { name: "End" }).waitFor({ timeout: 8000 });
    const token = await page.evaluate(() => localStorage.getItem("fn_token"));
    const listed = await fetch(`${baseUrl}/api/socials`, { headers: { authorization: `Bearer ${token}` } }).then((response) => response.json());
    assert.ok(listed.socials[0].place.length > 0, JSON.stringify(listed.socials[0]));
    assert.notEqual(listed.socials[0].place, "Finding address…");
  } finally {
    await page.context().close();
  }
});

test("a 5xx while the app is open shows the retry banner and a toast", { timeout: 90_000 }, async () => {
  const page = await phonePage(CHROME_UA, false);
  try {
    await openFreeSheet(page, "Alex");
    const token = await page.evaluate(() => localStorage.getItem("fn_token"));
    const me = await fetch(`${baseUrl}/api/me`, { headers: { authorization: `Bearer ${token}` } }).then((response) => response.json());
    const friend = await fetch(`${baseUrl}/api/auth/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Fritz", code: me.circle.inviteCode }),
    }).then((response) => response.json());
    await fetch(`${baseUrl}/api/socials`, {
      method: "POST",
      headers: { authorization: `Bearer ${friend.token}`, "content-type": "application/json" },
      body: JSON.stringify({ note: "Coffee" }),
    });
    await page.keyboard.press("Escape");
    await page.reload();
    const later = page.locator(".sheet button", { hasText: "Not now" });
    if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
    await page.getByRole("button", { name: "Can't" }).waitFor();
    await page.route("**/api/**", (route) => route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "internal error" }),
    }));
    await page.getByText("Something went wrong. Retrying…").waitFor({ timeout: 8000 });
    await page.getByRole("button", { name: "Can't" }).click();
    await page.getByText("Something went wrong. Try again.").waitFor();
    const stacked = await page.evaluate(() => {
      const banner = document.querySelector(".status-banner")?.getBoundingClientRect();
      const title = document.querySelector(".screen-title")?.getBoundingClientRect();
      const toast = document.querySelector(".toast")?.getBoundingClientRect();
      return {
        banner: banner?.bottom ?? null,
        title: title?.top ?? null,
        toast: toast?.top ?? null,
        tab: document.querySelector(".tabbar")?.getBoundingClientRect().top ?? null,
      };
    });
    assert.ok(stacked.banner != null && stacked.title != null && stacked.banner <= stacked.title + 1, JSON.stringify(stacked));
    assert.ok(stacked.toast != null && stacked.tab != null && stacked.toast >= stacked.title, JSON.stringify(stacked));
  } finally {
    await page.context().close();
  }
});

test("a fresh circle is named after you and drops a bad invite code", { timeout: 90_000 }, async () => {
  const page = await phonePage(CHROME_UA, false);
  try {
    await page.goto(`${baseUrl}/join/NOTREAL`);
    await page.getByText("This invite isn't valid. Ask for a new link.").waitFor();
    await page.getByRole("button", { name: "Start my own circle" }).click();
    await page.locator("#name").fill("Philipp");
    await page.getByRole("button", { name: "Continue" }).click();
    assert.equal(await page.locator("#circle-name").inputValue(), "Philipp's circle");
    assert.equal(await page.locator("#invite-code").inputValue(), "");
  } finally {
    await page.context().close();
  }
});

test("a server error retries without saying you're offline", { timeout: 90_000 }, async () => {
  const page = await phonePage(CHROME_UA, false);
  try {
    await signIn(page, "Alex");
    await page.waitForFunction(() => (localStorage.getItem("fn_state") || "").includes("circle"));
    await page.route("**/api/**", (route) => route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "internal error" }),
    }));
    await page.reload();
    await page.getByText("Something went wrong. Retrying…").waitFor();
    assert.equal(await page.getByText("You're offline. Retrying…").count(), 0);
    const stacked = await page.evaluate(() => {
      const banner = document.querySelector(".status-banner")?.getBoundingClientRect();
      const title = document.querySelector(".screen-title")?.getBoundingClientRect();
      return { banner: banner?.bottom ?? null, title: title?.top ?? null };
    });
    assert.ok(stacked.banner != null && stacked.title != null && stacked.banner <= stacked.title + 1, JSON.stringify(stacked));
  } finally {
    await page.context().close();
  }
});

test("leaving the map removes it and closing the picker returns focus", { timeout: 90_000 }, async () => {
  const page = await phonePage(CHROME_UA, false);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  try {
    await signIn(page, "Alex");
    const token = await page.evaluate(() => localStorage.getItem("fn_token"));
    await fetch(`${baseUrl}/api/socials`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ note: "Coffee", place: "Schlossplatz", lat: 48.7784, lng: 9.18 }),
    });
    await page.reload();
    const later = page.locator(".sheet button", { hasText: "Not now" });
    if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
    await page.getByRole("button", { name: "Show Schlossplatz on the map" }).click();
    await page.locator(".map-card").getByText("Coffee").waitFor({ timeout: 8000 });
    await page.locator(".leaflet-control-attribution").waitFor();
    assert.match(await page.locator(".leaflet-control-attribution").innerText(), /Esri/);
    const zoom = await page.locator(".leaflet-control-zoom-in").evaluate((node) => node.getAttribute("aria-label") || node.getAttribute("title") || "");
    assert.equal(zoom, "Zoom in");
    const before = await page.evaluate(() => {
      const pin = document.querySelector("#hangry-map .leaflet-marker-icon")?.getBoundingClientRect();
      return { top: pin?.top ?? null, left: pin?.left ?? null };
    });
    await page.locator("#hangry-map").dragTo(page.locator("#hangry-map"), {
      sourcePosition: { x: 180, y: 200 },
      targetPosition: { x: 40, y: 80 },
    });
    const panned = await page.evaluate(() => {
      const pin = document.querySelector("#hangry-map .leaflet-marker-icon")?.getBoundingClientRect();
      return {
        top: pin?.top ?? null,
        left: pin?.left ?? null,
        focus: document.activeElement?.id ?? "",
        tabIndex: document.getElementById("hangry-map")?.getAttribute("tabindex"),
      };
    });
    assert.ok(before.top != null && panned.top != null && Math.abs(panned.top - before.top) > 20, JSON.stringify({ before, panned }));
    assert.equal(panned.focus, "hangry-map");
    assert.equal(panned.tabIndex, "0");
    assert.deepEqual(errors, [], "after pan");
    await page.getByRole("button", { name: "Now", exact: true }).click();
    await page.getByRole("button", { name: "Let friends know you're free now" }).waitFor();
    const left = await page.evaluate(() => ({
      containers: document.querySelectorAll(".leaflet-container").length,
      hangry: Boolean(document.getElementById("hangry-map")),
      cards: document.querySelectorAll(".map-card").length,
      focus: document.activeElement?.tagName ?? "",
      inLeaflet: Boolean(document.activeElement?.closest(".leaflet-container")),
    }));
    assert.deepEqual(left, { containers: 0, hangry: false, cards: 0, focus: "BODY", inLeaflet: false });
    assert.deepEqual(errors, [], "after leave");
    await page.getByRole("button", { name: "Map", exact: true }).click();
    await page.locator(".map-card").getByText("Coffee").waitFor({ timeout: 8000 });
    const returned = await page.evaluate(() => {
      const pin = document.querySelector("#hangry-map .leaflet-marker-icon")?.getBoundingClientRect();
      return {
        top: pin?.top ?? null,
        left: pin?.left ?? null,
        attr: document.querySelector(".leaflet-control-attribution")?.textContent ?? "",
      };
    });
    assert.ok(returned.top != null && Math.abs(returned.top - (panned.top ?? 0)) <= 2, JSON.stringify({ panned, returned }));
    assert.ok(returned.left != null && Math.abs(returned.left - (panned.left ?? 0)) <= 2, JSON.stringify({ panned, returned }));
    assert.match(returned.attr, /Esri/);
    assert.deepEqual(errors, [], "after return");

    await page.getByRole("button", { name: "Now", exact: true }).click();
    await page.getByRole("button", { name: "Let friends know you're free now" }).click();
    await page.locator("#sheet-note").waitFor();
    await page.locator("button.where-row").click();
    await page.getByRole("button", { name: "Pick on map" }).click();
    await page.locator("#where-map .leaflet-marker-icon").waitFor({ timeout: 8000 });
    await page.waitForTimeout(150);
    await page.locator("#where-map").click({ position: { x: 40, y: 40 } });
    await page.waitForFunction(() => document.activeElement?.id === "where-map");
    await page.keyboard.press("Escape");
    await page.locator("form.sheet").waitFor({ state: "detached" });
    const closed = await page.evaluate(() => ({
      containers: document.querySelectorAll(".leaflet-container").length,
      where: Boolean(document.getElementById("where-map")),
      focus: document.activeElement?.tagName ?? "",
      inLeaflet: Boolean(document.activeElement?.closest(".leaflet-container")),
    }));
    assert.deepEqual(closed, { containers: 0, where: false, focus: "BODY", inLeaflet: false });
    assert.deepEqual(errors, [], "after close");
    await page.getByRole("button", { name: "Let friends know you're free now" }).click();
    await page.locator("button.where-row").click();
    await page.getByRole("button", { name: "Pick on map" }).click();
    await page.locator("#where-map .leaflet-marker-icon").waitFor({ timeout: 8000 });
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

test("picking on the map drops a pin and names the place", { timeout: 90_000 }, async () => {
  const page = await phonePage(CHROME_UA, false);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  let releaseGeocode = () => {};
  const geocode = new Promise<void>((resolve) => { releaseGeocode = resolve; });
  await page.context().route("**/api/geocode?**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("q")) return route.fulfill({ json: { results: [] } });
    await geocode;
    return route.fulfill({ json: { place: PLACE } });
  });
  try {
    await openFreeSheet(page, "Philipp");
    await page.locator("button.where-row").click();
    await page.getByRole("button", { name: "Pick on map" }).click();
    await page.locator("#where-map .leaflet-marker-icon").waitFor({ timeout: 8000 });
    const scroller = page.locator(".sheet-scroll");
    await scroller.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    const before = await scroller.evaluate((node) => node.scrollTop);
    assert.ok(before > 20, `sheet did not scroll, top=${before}`);
    await page.locator("#where-map").click({ position: { x: 30, y: 40 } });
    await page.waitForFunction(() => document.querySelector(".where-v")?.textContent === "Finding address…");
    assert.equal(await page.getByText("Dropped pin").count(), 0);
    const during = await scroller.evaluate((node) => ({ top: node.scrollTop, map: Boolean(document.getElementById("where-map")) }));
    assert.ok(during.map);
    assert.ok(during.top > 20, JSON.stringify({ before, during }));
    releaseGeocode();
    await page.waitForFunction((place) => document.querySelector(".where-v")?.textContent === place, PLACE, { timeout: 8000 });
    const after = await scroller.evaluate((node) => node.scrollTop);
    assert.ok(after > 20, JSON.stringify({ before, after }));
    assert.equal(await page.locator("#where-map").count(), 1);
    assert.deepEqual(errors, []);
  } finally {
    releaseGeocode();
    await page.context().close();
  }
});

test("alert times sit on the right of the card", { timeout: 90_000 }, async () => {
  const page = await phonePage(CHROME_UA, false);
  try {
    await signIn(page, "Alex");
    const token = await page.evaluate(() => localStorage.getItem("fn_token"));
    const me = await fetch(`${baseUrl}/api/me`, { headers: { authorization: `Bearer ${token}` } }).then((response) => response.json());
    const fritz = await fetch(`${baseUrl}/api/auth/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Fritz", code: me.circle.inviteCode }),
    }).then((response) => response.json());
    await fetch(`${baseUrl}/api/socials`, {
      method: "POST",
      headers: { authorization: `Bearer ${fritz.token}`, "content-type": "application/json" },
      body: JSON.stringify({ note: "Coffee" }),
    });
    await page.reload();
    const later = page.locator(".sheet button", { hasText: "Not now" });
    if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
    await page.getByRole("button", { name: /Alerts/ }).click();
    await page.locator(".alert-card .time").waitFor();
    const aligned = await page.evaluate(() => {
      const card = document.querySelector(".alert-card") as HTMLElement;
      const time = card.querySelector(".time") as HTMLElement;
      const style = getComputedStyle(card);
      const cardBox = card.getBoundingClientRect();
      const timeBox = time.getBoundingClientRect();
      const pad = parseFloat(style.paddingRight);
      return { timeRight: timeBox.right, edge: cardBox.right - pad, textAlign: getComputedStyle(time).textAlign };
    });
    assert.equal(aligned.textAlign, "right");
    assert.ok(Math.abs(aligned.timeRight - aligned.edge) <= 2, JSON.stringify(aligned));
  } finally {
    await page.context().close();
  }
});

test("a sheet error toast paints above the sheet", { timeout: 90_000 }, async () => {
  const page = await phonePage(CHROME_UA, false);
  try {
    await openFreeSheet(page, "Alex");
    await page.route("**/api/socials", (route) => {
      if (route.request().method() === "POST") {
        return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "internal error" }) });
      }
      return route.continue();
    });
    await page.getByRole("button", { name: "I'm free" }).click();
    await page.getByText("Something went wrong. Try again.").waitFor();
    const layers = await page.evaluate(() => {
      const toast = document.querySelector(".toast") as HTMLElement;
      const sheet = document.querySelector("form.sheet") as HTMLElement;
      const box = toast.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + 8);
      return {
        toastZ: Number(getComputedStyle(toast).zIndex),
        sheetZ: Number(getComputedStyle(sheet).zIndex),
        hitToast: Boolean(hit && (hit === toast || toast.contains(hit))),
      };
    });
    assert.ok(layers.toastZ > layers.sheetZ, JSON.stringify(layers));
    assert.equal(layers.hitToast, true);
  } finally {
    await page.context().close();
  }
});

test("a confirm sheet closes when its content is dragged at 412", { timeout: 90_000 }, async () => {
  const page = await phonePage(CHROME_UA, false);
  try {
    await page.setViewportSize({ width: 412, height: 700 });
    await signIn(page, "Alex");
    const token = await page.evaluate(() => localStorage.getItem("fn_token"));
    await fetch(`${baseUrl}/api/socials`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ note: "Coffee" }),
    });
    await page.reload();
    const later = page.locator(".sheet button", { hasText: "Not now" });
    if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
    await page.getByRole("button", { name: "End Coffee" }).click();
    await page.locator(".sheet-confirm .sheet-body").waitFor();
    await dragDown(page, page.locator(".sheet-confirm .sheet-body"));
    await page.locator(".sheet-confirm").waitFor({ state: "detached" });
  } finally {
    await page.context().close();
  }
});

test("the When label sits clear of the free sheet intro", { timeout: 90_000 }, async () => {
  const page = await phonePage(CHROME_UA, false);
  try {
    await openFreeSheet(page, "Alex");
    const gap = await page.evaluate(() => {
      const help = document.querySelector("form.sheet .sheet-intro .help");
      const label = document.getElementById("when-label");
      if (!help || !label) return null;
      return label.getBoundingClientRect().top - help.getBoundingClientRect().bottom;
    });
    assert.ok(gap != null && gap >= 12, `When label gap is ${gap}px`);
  } finally {
    await page.context().close();
  }
});

test("the note label stays clear of the help text with the keyboard up", { timeout: 90_000 }, async () => {
  const page = await phonePage(CHROME_UA, false);
  try {
    await openFreeSheet(page, "Alex");
    await page.locator("#sheet-note").focus();
    for (const viewport of [
      { height: 340, offsetTop: 0 },
      { height: 280, offsetTop: 40 },
    ]) {
      await page.evaluate(`window.__setVisualViewport(${JSON.stringify(viewport)})`);
      await page.waitForTimeout(FIELD_REVEAL_MS + 300);
      const placed = await page.evaluate(() => {
        const help = document.querySelector("form.sheet .sheet-intro .help");
        const label = [...document.querySelectorAll(".sheet-label")].find((node) => node.textContent === "Note (optional)");
        if (!help || !label) return null;
        const helpBox = help.getBoundingClientRect();
        const labelBox = label.getBoundingClientRect();
        const x = labelBox.left + labelBox.width / 2;
        const y = labelBox.top + labelBox.height / 2;
        const hit = document.elementFromPoint(x, y);
        return {
          gap: labelBox.top - helpBox.bottom,
          hitLabel: Boolean(hit && (hit === label || label.contains(hit))),
        };
      });
      assert.ok(placed && placed.gap >= 8, JSON.stringify({ viewport, placed }));
      assert.equal(placed.hitLabel, true, JSON.stringify({ viewport, placed }));
    }
  } finally {
    await page.context().close();
  }
});

test("a sheet error toast stays above the action button", { timeout: 90_000 }, async () => {
  const cases: Array<[string, { width: number; height: number }]> = [
    [CHROME_UA, { width: 412, height: 700 }],
    [FIREFOX_UA, { width: 412, height: 700 }],
    [FIREFOX_UA, { width: 360, height: 640 }],
  ];
  for (const [agent, size] of cases) {
    const page = await phonePage(agent, false);
    try {
      await page.setViewportSize(size);
      await openFreeSheet(page, "Alex");
      await page.route("**/api/socials", (route) => {
        if (route.request().method() === "POST") {
          return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "internal error" }) });
        }
        return route.continue();
      });
      await page.getByRole("button", { name: "I'm free" }).click();
      await page.getByText("Something went wrong. Try again.").waitFor();
      const boxes = await page.evaluate(() => {
        const toast = document.querySelector(".toast")?.getBoundingClientRect();
        const button = document.querySelector(".sheet-dock .btn")?.getBoundingClientRect();
        return { toastBottom: toast?.bottom ?? null, buttonTop: button?.top ?? null };
      });
      assert.ok(boxes.toastBottom != null && boxes.buttonTop != null && boxes.toastBottom <= boxes.buttonTop + 0.5, JSON.stringify({ size, boxes }));
    } finally {
      await page.context().close();
    }
  }
});

test("a confirm sheet closes when the gap between its buttons is dragged", { timeout: 90_000 }, async () => {
  const page = await phonePage(CHROME_UA, false);
  try {
    await page.setViewportSize({ width: 412, height: 700 });
    await signIn(page, "Alex");
    const token = await page.evaluate(() => localStorage.getItem("fn_token"));
    await fetch(`${baseUrl}/api/socials`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ note: "Coffee" }),
    });
    await page.reload();
    const later = page.locator(".sheet button", { hasText: "Not now" });
    if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
    await page.getByRole("button", { name: "End Coffee" }).click();
    await page.locator(".sheet-confirm").waitFor();
    const point = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll(".sheet-confirm button")];
      const end = buttons.find((node) => node.textContent === "End");
      const cancel = buttons.find((node) => node.textContent === "Cancel");
      if (!end || !cancel) return null;
      const above = end.getBoundingClientRect();
      const below = cancel.getBoundingClientRect();
      const x = above.left + above.width / 2;
      const y = (above.bottom + below.top) / 2;
      const hit = document.elementFromPoint(x, y);
      return {
        x,
        y,
        inSheet: Boolean(hit?.closest(".sheet-confirm")),
        button: Boolean(hit?.closest("button")),
      };
    });
    assert.ok(point);
    assert.equal(point.button, false);
    assert.equal(point.inSheet, true);
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x, point.y + 180, { steps: 12 });
    await page.mouse.up();
    await page.locator(".sheet-confirm").waitFor({ state: "detached" });
  } finally {
    await page.context().close();
  }
});

test("a confirm sheet closes when the gap is touch-dragged in Chromium", { timeout: 90_000 }, async () => {
  for (const size of [{ width: 360, height: 640 }, { width: 412, height: 700 }]) {
    const page = await phonePage(CHROME_UA, false);
    try {
      await page.setViewportSize(size);
      await signIn(page, "Alex");
      const token = await page.evaluate(() => localStorage.getItem("fn_token"));
      await fetch(`${baseUrl}/api/socials`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ note: "Coffee" }),
      });
      await page.reload();
      const later = page.locator(".sheet button", { hasText: "Not now" });
      if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
      await page.getByRole("button", { name: /^End/ }).click();
      await page.locator(".sheet-gap").waitFor();
      const touch = await page.locator(".sheet-gap").evaluate((node) => getComputedStyle(node).touchAction);
      assert.equal(touch, "none", JSON.stringify(size));
      const point = await page.locator(".sheet-gap").evaluate((node) => {
        const box = node.getBoundingClientRect();
        return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      });
      const session = await page.context().newCDPSession(page);
      const finger = (y: number) => [{ x: point.x, y, id: 1, radiusX: 1, radiusY: 1, force: 1 }];
      await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: finger(point.y) });
      for (let step = 1; step <= 8; step += 1) {
        await session.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: finger(point.y + step * 24),
        });
      }
      await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await session.detach();
      await page.locator(".sheet-confirm").waitFor({ state: "detached" });
    } finally {
      await page.context().close();
    }
  }
});

test("a swipe on the header or the top of the sheet closes it", { timeout: 90_000 }, async () => {
  const page = await phonePage(CHROME_UA, false);
  try {
    await openFreeSheet(page, "Philipp");
    const touch = await page.locator(".sheet-head").evaluate((node) => getComputedStyle(node).touchAction);
    assert.equal(touch, "none");
    await dragDown(page, page.locator("form.sheet h2"));
    await page.locator("form.sheet").waitFor({ state: "detached" });

    await page.getByRole("button", { name: "Let friends know you're free now" }).click();
    await page.locator("form.sheet").waitFor();
    const scroller = page.locator(".sheet-scroll");
    await scroller.evaluate((node) => {
      const filler = document.createElement("div");
      filler.style.height = "480px";
      node.append(filler);
      node.scrollTop = 200;
    });
    await dragSheetContent(page);
    assert.equal(await page.locator("form.sheet").count(), 1);

    await scroller.evaluate((node) => { node.scrollTop = 0; });
    await dragSheetContent(page);
    await page.locator("form.sheet").waitFor({ state: "detached" });

    const guide = page.getByRole("button", { name: "How to turn on notifications" });
    if (await guide.count()) {
      await page.getByRole("button", { name: "You", exact: true }).click();
      await guide.click();
      await page.locator(".guide .grabber").waitFor();
      const guideTouch = await page.locator(".guide-head").evaluate((node) => getComputedStyle(node).touchAction);
      assert.equal(guideTouch, "none");
      await dragDown(page, page.locator(".guide h2"));
      await page.locator(".guide").waitFor({ state: "detached" });
    }
  } finally {
    await page.context().close();
  }
});

test("an admin manages members from the circle list", { timeout: 90_000 }, async () => {
  const page = await phonePage(CHROME_UA, false);
  try {
    await signIn(page, "Alex");
    const token = await page.evaluate(() => localStorage.getItem("fn_token"));
    const me = await fetch(`${baseUrl}/api/me`, { headers: { authorization: `Bearer ${token}` } }).then((response) => response.json());
    await fetch(`${baseUrl}/api/auth/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Fritz", code: me.circle.inviteCode }),
    });
    await page.reload();
    const later = page.locator(".sheet button", { hasText: "Not now" });
    if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
    await page.getByRole("button", { name: "Circle", exact: true }).click();
    await page.getByRole("heading", { name: "Members" }).waitFor();
    await page.locator(".admin-badge", { hasText: "Admin" }).waitFor();
    const manage = page.getByRole("button", { name: "Manage Fritz" });
    await manage.waitFor();
    const height = await manage.evaluate((node) => node.getBoundingClientRect().height);
    assert.ok(height >= 44, `manage button is ${height}px`);
    await manage.click();
    await page.getByRole("button", { name: "Make admin" }).waitFor();
    const remove = page.getByRole("button", { name: "Remove from circle" });
    await remove.waitFor();
    const removeHeight = await remove.evaluate((node) => node.getBoundingClientRect().height);
    assert.ok(removeHeight >= 44, `remove button is ${removeHeight}px`);
    await remove.click();
    await page.getByRole("button", { name: "Remove", exact: true }).waitFor();
    await page.getByText("They lose access right away.").waitFor();
  } finally {
    await page.context().close();
  }
});

test("the host can remove someone who is in", { timeout: 90_000 }, async () => {
  const page = await phonePage(CHROME_UA, false);
  try {
    await signIn(page, "Alex");
    const token = await page.evaluate(() => localStorage.getItem("fn_token"));
    const me = await fetch(`${baseUrl}/api/me`, { headers: { authorization: `Bearer ${token}` } }).then((response) => response.json());
    const fritz = await fetch(`${baseUrl}/api/auth/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Fritz", code: me.circle.inviteCode }),
    }).then((response) => response.json());
    const social = await fetch(`${baseUrl}/api/socials`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ note: "Coffee" }),
    }).then((response) => response.json());
    await fetch(`${baseUrl}/api/socials/${social.social.id}/reply`, {
      method: "POST",
      headers: { authorization: `Bearer ${fritz.token}`, "content-type": "application/json" },
      body: JSON.stringify({ reply: "in" }),
    });
    await page.reload();
    const later = page.locator(".sheet button", { hasText: "Not now" });
    if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
    const remove = page.getByRole("button", { name: "Remove Fritz" });
    await remove.waitFor();
    const end = page.getByRole("button", { name: "End Coffee" });
    await end.waitFor();
    const height = await remove.evaluate((node) => Math.round(node.getBoundingClientRect().height));
    const endHeight = await end.evaluate((node) => Math.round(node.getBoundingClientRect().height));
    assert.ok(height >= 44, `remove is ${height}px`);
    assert.ok(endHeight >= 44, `end is ${endHeight}px`);
    await remove.click();
    await page.getByText("They can't join Coffee again.").waitFor();
  } finally {
    await page.context().close();
  }
});

test("a removed guest sees a note instead of reply buttons", { timeout: 90_000 }, async () => {
  const page = await phonePage(CHROME_UA, false);
  try {
    await signIn(page, "Alex");
    const token = await page.evaluate(() => localStorage.getItem("fn_token"));
    const me = await fetch(`${baseUrl}/api/me`, { headers: { authorization: `Bearer ${token}` } }).then((response) => response.json());
    const nia = await fetch(`${baseUrl}/api/auth/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Nia", code: me.circle.inviteCode }),
    }).then((response) => response.json());
    const social = await fetch(`${baseUrl}/api/socials`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ note: "Coffee" }),
    }).then((response) => response.json());
    await fetch(`${baseUrl}/api/socials/${social.social.id}/reply`, {
      method: "POST",
      headers: { authorization: `Bearer ${nia.token}`, "content-type": "application/json" },
      body: JSON.stringify({ reply: "in" }),
    });
    await fetch(`${baseUrl}/api/socials/${social.social.id}/people/${nia.user.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    await page.evaluate((value) => localStorage.setItem("fn_token", value), nia.token);
    await page.reload();
    const later = page.locator(".sheet button", { hasText: "Not now" });
    if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
    await page.getByText("Alex removed you from this.").waitFor();
    assert.equal(await page.getByRole("button", { name: "I'm in" }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Can't" }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Pick time" }).count(), 0);
  } finally {
    await page.context().close();
  }
});

test("an admin sees edit, end, and remove on someone else's cards", { timeout: 90_000 }, async () => {
  const page = await phonePage(CHROME_UA, false);
  try {
    await signIn(page, "Alex");
    const token = await page.evaluate(() => localStorage.getItem("fn_token"));
    const me = await fetch(`${baseUrl}/api/me`, { headers: { authorization: `Bearer ${token}` } }).then((response) => response.json());
    const join = (name: string) => fetch(`${baseUrl}/api/auth/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, code: me.circle.inviteCode }),
    }).then((response) => response.json());
    const fritz = await join("Fritz");
    const sam = await join("Sam");
    const postAs = (tokenValue: string, pathname: string, body: unknown) => fetch(`${baseUrl}${pathname}`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokenValue}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((response) => response.json());
    const coffee = await postAs(fritz.token, "/api/socials", { note: "Coffee" });
    const dinner = await postAs(fritz.token, "/api/plans", { note: "Dinner" });
    const now = new Date();
    const ahead = new Date(now.getTime() + 90 * 60 * 1000);
    const sameDay = ahead.getUTCDate() === now.getUTCDate();
    const laterClock = sameDay
      ? `${String(ahead.getUTCHours()).padStart(2, "0")}:${String(ahead.getUTCMinutes()).padStart(2, "0")}`
      : null;
    const walk = laterClock
      ? await postAs(sam.token, "/api/socials", { note: "Walk", startsAt: laterClock })
      : null;
    const replyAs = (tokenValue: string, pathname: string) => fetch(`${baseUrl}${pathname}`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokenValue}`, "content-type": "application/json" },
      body: JSON.stringify({ reply: "in" }),
    });
    await replyAs(sam.token, `/api/socials/${coffee.social.id}/reply`);
    await replyAs(sam.token, `/api/plans/${dinner.plan.id}/reply`);
    if (walk?.social?.id) await replyAs(fritz.token, `/api/socials/${walk.social.id}/reply`);
    await page.reload();
    const later = page.locator(".sheet button", { hasText: "Not now" });
    if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
    const cards: Array<[string, string]> = [["Coffee", "Sam"], ["Dinner", "Sam"]];
    if (walk?.social?.id) cards.splice(1, 0, ["Walk", "Fritz"]);
    for (const [label, guest] of cards) {
      const card = page.locator("article", { has: page.getByRole("heading", { name: label, exact: true }) });
      await card.scrollIntoViewIfNeeded();
      const edit = card.getByRole("button", { name: `Edit ${label}` });
      const end = card.getByRole("button", { name: `End ${label}` });
      const remove = card.getByRole("button", { name: `Remove ${guest}` });
      await edit.waitFor();
      await end.waitFor();
      await remove.waitFor();
      const heights = await Promise.all([edit, end, remove].map((button) => button.evaluate((node) => Math.round(node.getBoundingClientRect().height))));
      assert.ok(heights.every((height) => height >= 44), `${label} tools are ${heights.join(", ")}px`);
    }
    const coffeeCard = page.locator("article", { has: page.getByRole("heading", { name: "Coffee", exact: true }) });
    await coffeeCard.getByRole("button", { name: "Edit Coffee" }).click();
    await page.getByRole("dialog", { name: "Edit" }).waitFor();
    await page.getByText("Time (empty means now)").waitFor();
    await page.screenshot({ path: shot("admin-event-tools.png") });
  } finally {
    await page.context().close();
  }
});

test("editing a plan that has ended says so", { timeout: 90_000 }, async () => {
  const page = await phonePage(CHROME_UA, false);
  await page.route("**/api/plans/**", (route) => {
    if (route.request().method() === "PATCH") {
      return route.fulfill({
        status: 410,
        contentType: "application/json",
        body: JSON.stringify({ error: "That plan has ended." }),
      });
    }
    return route.continue();
  });
  try {
    await signIn(page, "Alex");
    const token = await page.evaluate(() => localStorage.getItem("fn_token"));
    await fetch(`${baseUrl}/api/plans`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ note: "Bouldering" }),
    });
    await page.reload();
    const later = page.locator(".sheet button", { hasText: "Not now" });
    if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
    await page.getByRole("button", { name: "Edit Bouldering" }).click();
    await page.getByRole("button", { name: "Save" }).click();
    await page.getByText("That plan has ended.").waitFor();
    assert.equal(await page.getByText("This invite has expired. Ask for a new link.").count(), 0);
  } finally {
    await page.context().close();
  }
});

test("plan tools do not cover the avatar", { timeout: 90_000 }, async () => {
  const cases: Array<[string, { width: number; height: number }]> = [
    [CHROME_UA, { width: 360, height: 640 }],
    [CHROME_UA, { width: 412, height: 700 }],
    [FIREFOX_UA, { width: 360, height: 640 }],
    [FIREFOX_UA, { width: 412, height: 700 }],
  ];
  for (const [agent, size] of cases) {
    const page = await phonePage(agent, false);
    try {
      await page.setViewportSize(size);
      await signIn(page, "Alex");
      const token = await page.evaluate(() => localStorage.getItem("fn_token"));
      await fetch(`${baseUrl}/api/plans`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ note: "Bouldering", place: "Gym" }),
      });
      await page.reload();
      const later = page.locator(".sheet button", { hasText: "Not now" });
      if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
      await page.locator(".card-plan .avatar").waitFor();
      const boxes = await page.evaluate(() => {
        const card = document.querySelector(".card-plan") as HTMLElement;
        const tools = card.querySelector(".card-tools")!.getBoundingClientRect();
        const avatar = card.querySelector(".avatar")!.getBoundingClientRect();
        const separated = tools.bottom <= avatar.top + 0.5 || tools.right <= avatar.left + 0.5
          || avatar.right <= tools.left + 0.5 || avatar.bottom <= tools.top + 0.5;
        return {
          separated,
          tools: { top: tools.top, bottom: tools.bottom, left: tools.left, right: tools.right },
          avatar: { top: avatar.top, bottom: avatar.bottom, left: avatar.left, right: avatar.right },
        };
      });
      assert.equal(boxes.separated, true, JSON.stringify({ size, boxes }));
    } finally {
      await page.context().close();
    }
  }
});

async function phonePage(userAgent: string, locate: boolean, extraScript = "") {
  const context = await browser.newContext({
    viewport: { width: 360, height: 640 },
    isMobile: true,
    hasTouch: true,
    userAgent,
    ...(locate ? { geolocation: { latitude: 48.7784, longitude: 9.18 }, permissions: ["geolocation"] } : {}),
  });
  await context.addInitScript(vvMock);
  if (extraScript) await context.addInitScript(extraScript);
  if (locate) {
    await context.route("**/api/geocode?**", (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.has("q")) return route.fulfill({ json: { results: [] } });
      return route.fulfill({ json: { place: PLACE } });
    });
  }
  return context.newPage();
}

async function signIn(page: Page, name: string) {
  await page.goto(baseUrl);
  await page.locator("#name").fill(name);
  await page.getByRole("button", { name: "Continue" }).click();
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
  await page.locator("#circle-name").fill("friends");
  await page.getByRole("button", { name: "Create circle" }).click();
  await page.getByRole("button", { name: "Let friends know you're free now" }).waitFor();
}

async function openFreeSheet(page: Page, name: string) {
  await signIn(page, name);
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
  await page.getByRole("button", { name: "Let friends know you're free now" }).click();
  await page.locator("#sheet-note").waitFor();
}

async function dragSheetContent(page: Page) {
  const point = await page.evaluate(() => {
    const scroll = document.querySelector(".sheet-scroll");
    if (!scroll) return null;
    const rect = scroll.getBoundingClientRect();
    for (let y = rect.top + 18; y < rect.bottom - 8; y += 14) {
      const hit = document.elementFromPoint(rect.left + 28, y);
      if (!hit || !scroll.contains(hit)) continue;
      if (hit.closest("input, textarea, button, a, select")) continue;
      return { x: rect.left + 28, y };
    }
    return null;
  });
  assert.ok(point, "no empty spot in the sheet to drag");
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x, point.y + 180, { steps: 12 });
  await page.mouse.up();
}

async function dragDown(page: Page, target: Locator) {
  const box = await target.boundingBox();
  assert.ok(box);
  const x = box.x + Math.min(20, box.width / 2);
  const y = box.y + Math.min(10, box.height / 2);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 180, { steps: 12 });
  await page.mouse.up();
}

async function deleteBackward(page: Page, ua: string) {
  const input = page.locator("#where-query");
  await input.focus();
  if (ua === CHROME_UA) {
    await page.keyboard.press("Backspace");
    return;
  }
  await page.evaluate(() => {
    const field = document.getElementById("where-query") as HTMLInputElement;
    field.focus();
    const before = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "deleteContentBackward",
    });
    const prevented = !field.dispatchEvent(before);
    if (prevented) return;
    const end = field.selectionEnd ?? field.value.length;
    const start = field.selectionStart ?? end;
    const from = start === end ? Math.max(0, end - 1) : start;
    field.value = field.value.slice(0, from) + field.value.slice(end);
    field.setSelectionRange(from, from);
    field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
  });
}

async function insertText(page: Page, ua: string, text: string) {
  const input = page.locator("#where-query");
  await input.focus();
  if (ua === CHROME_UA) {
    await page.keyboard.type(text);
    return;
  }
  await page.evaluate((value) => {
    const field = document.getElementById("where-query") as HTMLInputElement;
    field.focus();
    const before = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "insertText",
      data: value,
    });
    const prevented = !field.dispatchEvent(before);
    if (!prevented) {
      field.value += value;
      field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    }
  }, text);
}

async function expectValue(page: Page, value: string) {
  await page.waitForFunction((expected) => {
    const input = document.getElementById("where-query") as HTMLInputElement | null;
    return input?.value === expected;
  }, value, { timeout: 8000 });
}
