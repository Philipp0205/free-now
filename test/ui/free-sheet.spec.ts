import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Locator, Page } from "playwright-core";
import { FIELD_REVEAL_MS } from "../../public/js/keyboard.js";
import { skipWhatsNew } from "./whats-new-seen.js";
import { UA as CHROME_UA, openYouSection, testEmail, useHangry, waitForEventChat } from "./harness.js";

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

const FIREFOX_UA = "Mozilla/5.0 (Android 14; Mobile; rv:130.0) Gecko/130.0 Firefox/130.0";
const PLACE = "Near Schlossplatz, Stuttgart-Mitte";

const hangry = useHangry({ tz: "UTC" });

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
      const segment = document.getElementById("when-label")!.parentElement!.getBoundingClientRect();
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

    await page.locator(".segment").getByRole("button", { name: /^(Later today|Tomorrow)$/ }).click();
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
    const choice = page.locator(".segment").getByRole("button", { name: /^(Later today|Tomorrow)$/ });
    await choice.click();
    const value = await page.locator("#later-time").inputValue();
    assert.match(value, /^\d{2}:(00|30|59)$/);
    const tomorrow = (await choice.innerText()).trim() === "Tomorrow";
    assert.equal(await page.getByRole("button", { name: "I'm free later" }).isDisabled(), tomorrow);
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
    const me = await fetch(`${hangry.baseUrl}/api/me`, { headers: { authorization: `Bearer ${token}` } }).then((response) => response.json());
    const friend = await fetch(`${hangry.baseUrl}/api/auth/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Fritz", email: testEmail(), code: me.circle.inviteCode }),
    }).then((response) => response.json());
    await fetch(`${hangry.baseUrl}/api/socials`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ note: "Coffee", place: "Schlossplatz", lat: 48.7784, lng: 9.18 }),
    });
    const viewerContext = await hangry.browser.newContext({
      viewport: { width: 360, height: 640 },
      isMobile: true,
      hasTouch: true,
      userAgent: CHROME_UA,
    });
    await skipWhatsNew(viewerContext);
    await viewerContext.addInitScript(vvMock);
    await viewerContext.addInitScript((value) => localStorage.setItem("fn_token", value), friend.token);
    const viewer = await viewerContext.newPage();
    await viewer.goto(hangry.baseUrl);
    const later = viewer.locator(".sheet button", { hasText: "Not now" });
    if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
    await viewer.getByRole("button", { name: "I'm in" }).click();
    await viewer.getByRole("button", { name: "In ✓" }).waitFor();
    await viewer.getByText("You're in", { exact: true }).waitFor();
    assert.equal(await viewer.getByRole("button", { name: "5 min" }).count(), 0);
    assert.equal(await viewer.getByText("Arriving at").count(), 0);
    await viewer.getByRole("button", { name: /^More for / }).click();
    await viewer.getByRole("menuitem", { name: "Pick arrival time" }).click();
    await viewer.getByRole("dialog", { name: "Pick arrival" }).waitFor();
    await viewer.screenshot({ path: shot("free-arrive-before.png") });
    const field = viewer.locator("#arrival-time");
    await field.waitFor();
    // Five minutes ahead, wrapping past 23:59, so the arrival is never in the past.
    const placed = await field.evaluate((input) => {
      const [hour, minute] = (input as HTMLInputElement).value.split(":").map(Number);
      const total = (hour * 60 + minute + 5) % (24 * 60);
      const value = `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
      (input as HTMLInputElement).value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return {
        min: (input as HTMLInputElement).min,
        max: (input as HTMLInputElement).max,
        step: (input as HTMLInputElement).step,
        height: Math.round((input as HTMLInputElement).getBoundingClientRect().height),
        value,
      };
    });
    assert.equal(placed.min, "");
    assert.equal(placed.max, "");
    assert.equal(placed.step, "60");
    assert.ok(placed.height >= 40, JSON.stringify(placed));
    await viewer.getByRole("button", { name: "Save" }).click();
    await viewer.getByText("You're in", { exact: true }).waitFor();
    await viewer.getByRole("button", { name: /^More for / }).click();
    await viewer.getByRole("menuitem", { name: `Arriving ${placed.value}` }).waitFor();
    await viewer.keyboard.press("Escape");
    assert.equal(await viewer.getByText(`You're in, arriving ${placed.value}`).count(), 0);
    await viewer.screenshot({ path: shot("free-arrive-time.png") });
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

test("later and tomorrow replies keep I'm in on the card and Can't in the menu", { timeout: 90_000 }, async () => {
  const page = await phonePage(CHROME_UA, false);
  try {
    await signIn(page, "Alex");
    const token = await page.evaluate(() => localStorage.getItem("fn_token"));
    const me = await fetch(`${hangry.baseUrl}/api/me`, { headers: { authorization: `Bearer ${token}` } }).then((response) => response.json());
    const friend = await fetch(`${hangry.baseUrl}/api/auth/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Fritz", email: testEmail(), code: me.circle.inviteCode }),
    }).then((response) => response.json());
    const now = new Date();
    const ahead = new Date(now.getTime() + 90 * 60 * 1000);
    const laterClock = ahead.getUTCDate() === now.getUTCDate()
      ? `${String(ahead.getUTCHours()).padStart(2, "0")}:${String(ahead.getUTCMinutes()).padStart(2, "0")}`
      : null;
    if (laterClock) {
      await fetch(`${hangry.baseUrl}/api/socials`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ note: "Dinner", startsAt: laterClock }),
      });
    }
    await fetch(`${hangry.baseUrl}/api/plans`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ note: "Walk" }),
    });
    const viewerContext = await hangry.browser.newContext({
      viewport: { width: 360, height: 640 },
      isMobile: true,
      hasTouch: true,
      userAgent: CHROME_UA,
    });
    await skipWhatsNew(viewerContext);
    await viewerContext.addInitScript(vvMock);
    await viewerContext.addInitScript((value) => localStorage.setItem("fn_token", value), friend.token);
    const viewer = await viewerContext.newPage();
    await viewer.goto(hangry.baseUrl);
    const sheet = viewer.locator(".sheet button", { hasText: "Not now" });
    if (await sheet.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await sheet.click();
    const labels = [...(laterClock ? ["Dinner"] : []), "Walk"];
    for (const width of [320, 360, 412]) {
      await viewer.setViewportSize({ width, height: 700 });
      for (const label of labels) {
        const card = viewer.locator("article", { has: viewer.getByRole("heading", { name: label, exact: true }) });
        await card.scrollIntoViewIfNeeded();
        await card.getByRole("button", { name: "I'm in" }).waitFor();
        await card.getByRole("button", { name: /^More for / }).click();
        const menu = viewer.getByRole("menu");
        await menu.getByRole("menuitem", { name: "Can't make it" }).waitFor();
        await menu.getByRole("menuitem", { name: "Pick arrival time" }).waitFor();
        const clipped = await menu.evaluate((node) => {
          const r = node.getBoundingClientRect();
          return { left: r.left, right: r.right, bottom: r.bottom, vw: window.innerWidth, vh: window.innerHeight };
        });
        assert.ok(clipped.left >= -1 && clipped.right <= clipped.vw + 1 && clipped.bottom <= clipped.vh + 1, JSON.stringify({ width, label, clipped }));
        await viewer.keyboard.press("Escape");
      }
    }
    await viewer.locator("article", { has: viewer.getByRole("heading", { name: labels[0], exact: true }) }).scrollIntoViewIfNeeded();
    await viewer.screenshot({ path: shot("reply-row.png") });
    await viewerContext.close();
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
    await openYouSection(page, "Notifications");
    await page.locator("button.notif-row").click();
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
    await fetch(`${hangry.baseUrl}/api/socials`, {
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
    const me = await fetch(`${hangry.baseUrl}/api/me`, { headers: { authorization: `Bearer ${token}` } }).then((response) => response.json());
    const bea = await fetch(`${hangry.baseUrl}/api/auth/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Bea", email: testEmail(), code: me.circle.inviteCode }),
    }).then((response) => response.json());
    await fetch(`${hangry.baseUrl}/api/socials`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ note: "Coffee", place: "Schlossplatz", lat: 48.7784, lng: 9.18 }),
    });
    await fetch(`${hangry.baseUrl}/api/socials`, {
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
    const plan = await fetch(`${hangry.baseUrl}/api/plans`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ note: "Bouldering", place: "Gym", lat: 48.775, lng: 9.175 }),
    }).then((response) => response.json());
    await page.goto(`${hangry.baseUrl}/?plan=${plan.plan.id}`);
    const later = page.locator(".sheet button", { hasText: "Not now" });
    if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
    await page.locator(".map-card").getByText("Bouldering").waitFor({ timeout: 8000 });
    assert.equal(await page.locator(".screen-title").innerText(), "Events");
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
    await openYouSection(page, "Notifications");
    await page.locator("button.notif-row").click();
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
    await page.getByRole("button", { name: /^More for / }).waitFor({ timeout: 8000 });
    await page.getByRole("button", { name: /^More for / }).click();
    await page.getByRole("menuitem", { name: "End" }).waitFor();
    const token = await page.evaluate(() => localStorage.getItem("fn_token"));
    const listed = await fetch(`${hangry.baseUrl}/api/socials`, { headers: { authorization: `Bearer ${token}` } }).then((response) => response.json());
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
    const me = await fetch(`${hangry.baseUrl}/api/me`, { headers: { authorization: `Bearer ${token}` } }).then((response) => response.json());
    const friend = await fetch(`${hangry.baseUrl}/api/auth/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Fritz", email: testEmail(), code: me.circle.inviteCode }),
    }).then((response) => response.json());
    await fetch(`${hangry.baseUrl}/api/socials`, {
      method: "POST",
      headers: { authorization: `Bearer ${friend.token}`, "content-type": "application/json" },
      body: JSON.stringify({ note: "Coffee" }),
    });
    await page.keyboard.press("Escape");
    await page.reload();
    const later = page.locator(".sheet button", { hasText: "Not now" });
    if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
    await page.getByRole("button", { name: "I'm in" }).waitFor();
    await page.getByRole("button", { name: /^More for / }).click();
    await page.getByRole("menuitem", { name: "Can't make it" }).waitFor();
    await page.keyboard.press("Escape");
    await page.route("**/api/**", (route) => route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "internal error" }),
    }));
    await page.getByText("Something went wrong. Retrying…").waitFor({ timeout: 8000 });
    await page.getByRole("button", { name: /^More for / }).click();
    await page.getByRole("menuitem", { name: "Can't make it" }).click();
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
    await page.goto(`${hangry.baseUrl}/join/NOTREAL`);
    await page.getByText("This invite isn't valid. Ask for a new link.").waitFor();
    await page.getByRole("button", { name: "Start my own circle" }).click();
    await page.locator("#name").fill("Philipp");
    await page.locator("#email").fill(testEmail());
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
    await fetch(`${hangry.baseUrl}/api/socials`, {
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
    // The map card (chat row + In toggle) covers the lower map; drag in the clear strip above it.
    const clear = await page.evaluate(() => {
      const map = document.getElementById("hangry-map")!.getBoundingClientRect();
      const card = document.querySelector(".map-card")!.getBoundingClientRect();
      return Math.max(30, Math.min(200, card.top - map.top - 12));
    });
    // Start beside the pin: the focused pin sits mid-strip, and grabbing it would focus the pin, not the map.
    await page.locator("#hangry-map").dragTo(page.locator("#hangry-map"), {
      sourcePosition: { x: 40, y: clear },
      targetPosition: { x: 200, y: Math.max(4, clear - 120) },
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
    // Back to the Events tab: the pin focus put it on the map for this visit, so the map comes back.
    await page.locator(".tabbar").getByRole("button", { name: "Events", exact: true }).click();
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
    const me = await fetch(`${hangry.baseUrl}/api/me`, { headers: { authorization: `Bearer ${token}` } }).then((response) => response.json());
    const fritz = await fetch(`${hangry.baseUrl}/api/auth/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Fritz", email: testEmail(), code: me.circle.inviteCode }),
    }).then((response) => response.json());
    await fetch(`${hangry.baseUrl}/api/socials`, {
      method: "POST",
      headers: { authorization: `Bearer ${fritz.token}`, "content-type": "application/json" },
      body: JSON.stringify({ note: "Coffee" }),
    });
    await page.reload();
    const later = page.locator(".sheet button", { hasText: "Not now" });
    if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
    await page.getByRole("button", { name: /Alerts/ }).click();
    await page.locator(".alert-card .time").first().waitFor();
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
    await fetch(`${hangry.baseUrl}/api/socials`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ note: "Coffee" }),
    });
    await page.reload();
    const later = page.locator(".sheet button", { hasText: "Not now" });
    if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
    await page.locator("article", { has: page.getByRole("heading", { name: "Coffee", exact: true }) }).getByRole("button", { name: /^More for / }).click();
    await page.getByRole("menuitem", { name: /End/ }).click();
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
    await fetch(`${hangry.baseUrl}/api/socials`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ note: "Coffee" }),
    });
    await page.reload();
    const later = page.locator(".sheet button", { hasText: "Not now" });
    if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
    await page.locator("article", { has: page.getByRole("heading", { name: "Coffee", exact: true }) }).getByRole("button", { name: /^More for / }).click();
    await page.getByRole("menuitem", { name: /End/ }).click();
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
      await fetch(`${hangry.baseUrl}/api/socials`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ note: "Coffee" }),
      });
      await page.reload();
      const later = page.locator(".sheet button", { hasText: "Not now" });
      if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
      await page.locator("article", { has: page.getByRole("heading", { name: "Coffee", exact: true }) }).getByRole("button", { name: /^More for / }).click();
      await page.getByRole("menuitem", { name: /End/ }).click();
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
    const me = await fetch(`${hangry.baseUrl}/api/me`, { headers: { authorization: `Bearer ${token}` } }).then((response) => response.json());
    await fetch(`${hangry.baseUrl}/api/auth/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Fritz", email: testEmail(), code: me.circle.inviteCode }),
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
    const me = await fetch(`${hangry.baseUrl}/api/me`, { headers: { authorization: `Bearer ${token}` } }).then((response) => response.json());
    const fritz = await fetch(`${hangry.baseUrl}/api/auth/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Fritz", email: testEmail(), code: me.circle.inviteCode }),
    }).then((response) => response.json());
    const social = await fetch(`${hangry.baseUrl}/api/socials`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ note: "Coffee" }),
    }).then((response) => response.json());
    await fetch(`${hangry.baseUrl}/api/socials/${social.social.id}/reply`, {
      method: "POST",
      headers: { authorization: `Bearer ${fritz.token}`, "content-type": "application/json" },
      body: JSON.stringify({ reply: "in" }),
    });
    await page.reload();
    const later = page.locator(".sheet button", { hasText: "Not now" });
    if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
    const card = page.locator("article", { has: page.getByRole("heading", { name: "Coffee", exact: true }) });
    const more = card.getByRole("button", { name: /^More for / });
    await more.waitFor();
    assert.ok(await more.evaluate((node) => Math.round(node.getBoundingClientRect().height)) >= 44);
    await card.getByRole("button", { name: "Open details" }).click();
    const details = page.getByRole("dialog", { name: "Details" });
    const remove = details.getByRole("button", { name: "Remove Fritz" });
    await remove.waitFor();
    assert.ok(await remove.evaluate((node) => Math.round(node.getBoundingClientRect().height)) >= 44);
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
    const me = await fetch(`${hangry.baseUrl}/api/me`, { headers: { authorization: `Bearer ${token}` } }).then((response) => response.json());
    const nia = await fetch(`${hangry.baseUrl}/api/auth/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Nia", email: testEmail(), code: me.circle.inviteCode }),
    }).then((response) => response.json());
    const social = await fetch(`${hangry.baseUrl}/api/socials`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ note: "Coffee" }),
    }).then((response) => response.json());
    await fetch(`${hangry.baseUrl}/api/socials/${social.social.id}/reply`, {
      method: "POST",
      headers: { authorization: `Bearer ${nia.token}`, "content-type": "application/json" },
      body: JSON.stringify({ reply: "in" }),
    });
    await fetch(`${hangry.baseUrl}/api/socials/${social.social.id}/people/${nia.user.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    await page.evaluate((value) => localStorage.setItem("fn_token", value), nia.token);
    await page.reload();
    const later = page.locator(".sheet button", { hasText: "Not now" });
    if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
    await page.getByText("Alex removed you from this.").waitFor();
    assert.equal(await page.locator(".in-toggle").count(), 0);
    assert.equal(await page.getByRole("button", { name: "I'm in" }).count(), 0);
    const more = page.getByRole("button", { name: /^More for / });
    if (await more.count()) {
      await more.first().click();
      const menu = page.getByRole("menu");
      await menu.waitFor();
      assert.equal(await menu.getByRole("menuitem", { name: /Can.t/ }).count(), 0);
      assert.equal(await menu.getByRole("menuitem", { name: /Pick arrival|Arriving/ }).count(), 0);
    }
  } finally {
    await page.context().close();
  }
});

test("an admin sees edit, end, and remove on someone else's cards", { timeout: 90_000 }, async () => {
  const page = await phonePage(CHROME_UA, false);
  try {
    await signIn(page, "Alex");
    const token = await page.evaluate(() => localStorage.getItem("fn_token"));
    const me = await fetch(`${hangry.baseUrl}/api/me`, { headers: { authorization: `Bearer ${token}` } }).then((response) => response.json());
    const join = (name: string) => fetch(`${hangry.baseUrl}/api/auth/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, email: testEmail(), code: me.circle.inviteCode }),
    }).then((response) => response.json());
    const fritz = await join("Fritz");
    const sam = await join("Sam");
    const postAs = (tokenValue: string, pathname: string, body: unknown) => fetch(`${hangry.baseUrl}${pathname}`, {
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
    const replyAs = (tokenValue: string, pathname: string) => fetch(`${hangry.baseUrl}${pathname}`, {
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
      const more = card.getByRole("button", { name: /^More for / });
      await more.waitFor();
      assert.ok(await more.evaluate((node) => Math.round(node.getBoundingClientRect().height)) >= 44);
      await more.click();
      const menu = page.getByRole("menu");
      await menu.getByRole("menuitem", { name: "Edit" }).waitFor();
      await menu.getByRole("menuitem", { name: /End/ }).waitFor();
      await page.keyboard.press("Escape");
      await card.getByRole("button", { name: "Open details" }).click();
      const details = page.getByRole("dialog", { name: "Details" });
      await details.getByRole("button", { name: `Remove ${guest}` }).waitFor();
      await page.keyboard.press("Escape");
    }
    const coffeeCard = page.locator("article", { has: page.getByRole("heading", { name: "Coffee", exact: true }) });
    await coffeeCard.getByRole("button", { name: /^More for / }).click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
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
    await fetch(`${hangry.baseUrl}/api/plans`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ note: "Bouldering" }),
    });
    await page.reload();
    const later = page.locator(".sheet button", { hasText: "Not now" });
    if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
    await page.getByRole("button", { name: /^More for / }).click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
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
      await fetch(`${hangry.baseUrl}/api/plans`, {
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
        const tools = card.querySelector(".card-more")!.getBoundingClientRect();
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

test("a failed chat send goes out again when the connection returns", { timeout: 90_000 }, async () => {
  const page = await phonePage(CHROME_UA, false);
  let fail = true;
  await page.route("**/api/**/chat", (route) => {
    if (fail && route.request().method() === "POST") {
      fail = false;
      return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "internal error" }) });
    }
    return route.continue();
  });
  try {
    await signIn(page, "Alex");
    const token = await page.evaluate(() => localStorage.getItem("fn_token"));
    await fetch(`${hangry.baseUrl}/api/socials`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ note: "Coffee" }),
    });
    await page.reload();
    const later = page.locator(".sheet button", { hasText: "Not now" });
    if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
    await page.locator("article .chat-row").click();
    await page.locator("#chat-input").fill("Held");
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByText("Something went wrong. Retrying…").waitFor();
    await page.getByText("Held", { exact: true }).waitFor({ timeout: 8000 });
    assert.equal(await page.getByText("Something went wrong. Retrying…").count(), 0);
  } finally {
    await page.context().close();
  }
});

test("text typed while a chat message retries stays in the composer", { timeout: 90_000 }, async () => {
  const page = await phonePage(CHROME_UA, false);
  let failed = false;
  let releaseRetry = () => {};
  const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve; });
  await page.route("**/api/**/chat", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    if (!failed) {
      failed = true;
      return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "internal error" }) });
    }
    await retryGate;
    return route.continue();
  });
  try {
    await signIn(page, "Alex");
    const token = await page.evaluate(() => localStorage.getItem("fn_token"));
    await fetch(`${hangry.baseUrl}/api/socials`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ note: "Coffee" }),
    });
    await page.reload();
    const later = page.locator(".sheet button", { hasText: "Not now" });
    if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
    await page.locator("article .chat-row").click();
    await page.locator("#chat-input").fill("Want");
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByText("Something went wrong. Retrying…").waitFor();
    await page.locator("#chat-input").fill("Want dinner");
    releaseRetry();
    await page.locator(".chat-msg", { hasText: "Want" }).waitFor({ timeout: 8000 });
    assert.equal(await page.locator("#chat-input").inputValue(), "dinner");
    assert.equal(await page.locator(".chat-msg", { hasText: "Want dinner" }).count(), 0);
  } finally {
    releaseRetry();
    await page.context().close();
  }
});

test("you can edit your name, and an admin can edit the circle name", { timeout: 90_000 }, async () => {
  const page = await phonePage(CHROME_UA, false);
  try {
    await signIn(page, "Alex");
    const later = page.locator(".sheet button", { hasText: "Not now" });
    if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
    await openYouSection(page, "Profile");
    await page.getByText("Your name", { exact: true }).waitFor();
    await page.locator("#rename").fill("Alexis");
    await page.getByRole("button", { name: "Save name" }).click();
    await page.getByText("Alexis").first().waitFor();
    await page.getByRole("button", { name: "Circle", exact: true }).click();
    await page.getByText("Circle name", { exact: true }).waitFor();
    const save = page.getByRole("button", { name: "Save circle name" });
    const height = await save.evaluate((node) => Math.round(node.getBoundingClientRect().height));
    assert.ok(height >= 44, `save circle is ${height}px`);
  } finally {
    await page.context().close();
  }
});

test("each person keeps a distinct chat color", { timeout: 90_000 }, async () => {
  const page = await phonePage(CHROME_UA, false);
  try {
    await signIn(page, "Alex");
    const token = await page.evaluate(() => localStorage.getItem("fn_token"));
    const me = await fetch(`${hangry.baseUrl}/api/me`, { headers: { authorization: `Bearer ${token}` } }).then((response) => response.json());
    const join = (name: string) => fetch(`${hangry.baseUrl}/api/auth/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, email: testEmail(), code: me.circle.inviteCode }),
    }).then((response) => response.json());
    const fritz = await join("Fritz");
    const nia = await join("Nia");
    const post = (who: { token: string }, text: string) => fetch(`${hangry.baseUrl}/api/circles/chat`, {
      method: "POST",
      headers: { authorization: `Bearer ${who.token}`, "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    await post({ token }, "From Alex");
    await post(fritz, "From Fritz");
    const social = await fetch(`${hangry.baseUrl}/api/socials`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ note: "Coffee" }),
    }).then((response) => response.json());
    await fetch(`${hangry.baseUrl}/api/socials/${social.social.id}/reply`, {
      method: "POST",
      headers: { authorization: `Bearer ${fritz.token}`, "content-type": "application/json" },
      body: JSON.stringify({ reply: "in" }),
    });
    await page.evaluate((value) => localStorage.setItem("fn_token", value), nia.token);
    await page.reload();
    const later = page.locator(".sheet button", { hasText: "Not now" });
    if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
    await page.locator(".tabbar").getByRole("button", { name: /^Chat/ }).click();
    await page.getByText("From Fritz").waitFor();
    const read = () => page.evaluate(`(() => {
      const rows = [...document.querySelectorAll(".chat-msg")];
      const screen = getComputedStyle(document.querySelector(".chat-screen")).backgroundColor;
      return rows.map((row) => {
        const name = row.querySelector("strong");
        const bubble = name ? getComputedStyle(name).color : "";
        const parts = (color) => (color.match(/\\d+/g) || ["0", "0", "0"]).slice(0, 3).map(Number);
        const lum = (color) => {
          const rgb = parts(color).map((value) => {
            const channel = value / 255;
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
        };
        const a = bubble ? lum(bubble) : 0;
        const b = lum(screen);
        return {
          text: row.querySelector("p")?.textContent || "",
          color: bubble,
          data: row.getAttribute("data-color"),
          contrast: bubble ? (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) : 0,
        };
      });
    })()`);
    const first = await read();
    const alex = first.find((row) => row.text === "From Alex");
    const fritzMsg = first.find((row) => row.text === "From Fritz");
    assert.ok(alex && fritzMsg);
    assert.ok(alex.data != null && fritzMsg.data != null);
    assert.notEqual(alex.data, fritzMsg.data);
    assert.ok(alex.contrast >= 4.5, JSON.stringify(alex));
    assert.ok(fritzMsg.contrast >= 4.5, JSON.stringify(fritzMsg));
    await page.reload();
    if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
    await page.locator(".tabbar").getByRole("button", { name: /^Chat/ }).click();
    await page.getByText("From Fritz").waitFor();
    const second = await read();
    assert.equal(second.find((row) => row.text === "From Alex")?.color, alex.color);
    assert.equal(second.find((row) => row.text === "From Fritz")?.color, fritzMsg.color);
    await page.locator("#chat-input").fill("From Nia");
    await page.getByRole("button", { name: "Send" }).click();
    await page.locator(".chat-msg.mine").waitFor();
    const niaMe = await fetch(`${hangry.baseUrl}/api/me`, { headers: { authorization: `Bearer ${nia.token}` } }).then((response) => response.json());
    assert.equal(await page.locator(".chat-msg.mine").getAttribute("data-color"), niaMe.user.color);
    await page.getByRole("button", { name: "Back" }).click();
    await page.getByRole("button", { name: "Now", exact: true }).click();
    await page.locator("article .chat-row").click();
    await page.locator(".chat-system").waitFor();
    assert.equal(await page.locator(".chat-system").getAttribute("data-color"), null);
    const accented = await page.locator(".chat-msg[data-color]").count();
    assert.equal(accented, 0);
  } finally {
    await page.context().close();
  }
});

test("a chat thread stays above the keyboard", { timeout: 90_000 }, async () => {
  for (const agent of [CHROME_UA, FIREFOX_UA]) {
    const page = await phonePage(agent, false);
    try {
      await signIn(page, "Alex");
      const token = await page.evaluate(() => localStorage.getItem("fn_token"));
      await fetch(`${hangry.baseUrl}/api/socials`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ note: "Coffee" }),
      });
      await page.reload();
      const later = page.locator(".sheet button", { hasText: "Not now" });
      if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
      const chat = page.getByRole("button", { name: "Chat", exact: true }).first();
      await chat.waitFor();
      const height = await chat.evaluate((node) => Math.round(node.getBoundingClientRect().height));
      assert.ok(height >= 44, `chat is ${height}px`);
      await chat.click();
      await waitForEventChat(page, "Coffee");
      await page.locator("#chat-input").fill("See you there");
      await page.getByRole("button", { name: "Send" }).click();
      await page.getByText("See you there").waitFor();
      if (agent === CHROME_UA) await page.screenshot({ path: shot("chat-thread.png") });
      await page.evaluate(() => {
        window.__setVisualViewport({ height: 360, offsetTop: 0 });
      });
      await page.locator("#chat-input").focus();
      await page.waitForTimeout(500);
      const box = await page.locator(".chat-compose").boundingBox();
      const message = await page.locator(".chat-msg").last().boundingBox();
      assert.ok(box);
      assert.ok(message);
      assert.ok(box.y + box.height <= 364, JSON.stringify(box));
      assert.ok(box.height >= 44, JSON.stringify(box));
      assert.ok(message.y + message.height <= box.y + 1, JSON.stringify({ message, box }));
      await page.getByRole("button", { name: "Back" }).click();
      const circleChat = page.locator(".tabbar").getByRole("button", { name: "Chat", exact: true });
      await circleChat.waitFor();
      const circleHeight = await circleChat.evaluate((node) => Math.round(node.getBoundingClientRect().height));
      assert.ok(circleHeight >= 44, `circle chat is ${circleHeight}px`);
    } finally {
      await page.context().close();
    }
  }
});

test("Past events lists an ended hangout without reply buttons", { timeout: 90_000 }, async () => {
  const page = await phonePage(CHROME_UA, false);
  try {
    await signIn(page, "Alex");
    const token = await page.evaluate(() => localStorage.getItem("fn_token"));
    const me = await fetch(`${hangry.baseUrl}/api/me`, { headers: { authorization: `Bearer ${token}` } }).then((response) => response.json());
    const fritz = await fetch(`${hangry.baseUrl}/api/auth/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Fritz", email: testEmail(), code: me.circle.inviteCode }),
    }).then((response) => response.json());
    const social = await fetch(`${hangry.baseUrl}/api/socials`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ note: "Coffee", place: "Cafe" }),
    }).then((response) => response.json());
    await fetch(`${hangry.baseUrl}/api/socials/${social.social.id}/reply`, {
      method: "POST",
      headers: { authorization: `Bearer ${fritz.token}`, "content-type": "application/json" },
      body: JSON.stringify({ reply: "in" }),
    });
    await page.reload();
    const later = page.locator(".sheet button", { hasText: "Not now" });
    if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
    await page.locator("article", { has: page.getByRole("heading", { name: "Coffee", exact: true }) }).getByRole("button", { name: /^More for / }).click();
    await page.getByRole("menuitem", { name: /End/ }).click();
    await page.getByRole("button", { name: "End", exact: true }).click();
    await page.getByRole("heading", { name: "Coffee" }).waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Past events" }).click();
    await page.getByRole("heading", { name: "Past events" }).waitFor();
    await page.getByRole("heading", { name: "Coffee" }).waitFor();
    await page.getByText(/Alex/).waitFor();
    await page.getByText("Cafe").waitFor();
    await page.getByText("Fritz", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "I'm in" }).count(), 0);
    assert.equal(await page.getByRole("button", { name: /^More for / }).count(), 0);
    await page.locator(".past-card .chat-row").click();
    await page.getByText("This chat is closed.").waitFor();
    assert.equal(await page.locator("#chat-input").count(), 0);
    await page.getByRole("button", { name: "Back" }).click();
    await page.getByRole("heading", { name: "Past events" }).waitFor();
  } finally {
    await page.context().close();
  }
});

test("two circles stay separate when you switch, post, join, and leave", { timeout: 90_000 }, async () => {
  const page = await phonePage(CHROME_UA, false);
  try {
    await signIn(page, "Alex");
    const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
    if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
    await page.getByRole("button", { name: "Circle", exact: true }).click();
    await page.getByRole("button", { name: "New circle", exact: true }).click();
    await page.locator("#new-circle-name").fill("Home");
    await page.getByRole("button", { name: "Create circle" }).click();
    await page.getByRole("button", { name: "Switch circle" }).waitFor();
    const switchHeight = await page.getByRole("button", { name: "Switch circle" }).evaluate((node) => node.getBoundingClientRect().height);
    assert.ok(switchHeight >= 44, `switcher is ${switchHeight}px`);
    await page.getByRole("button", { name: "Now", exact: true }).click();
    await page.getByRole("button", { name: "Let friends know you're free now" }).click();
    await page.getByText("Posting to Home").waitFor();
    await page.locator("#sheet-note").fill("Soup");
    await page.getByRole("button", { name: "I'm free" }).click();
    await page.getByRole("heading", { name: "Soup" }).waitFor();

    await page.getByRole("button", { name: "Switch circle" }).click();
    await page.getByRole("button", { name: "friends", exact: true }).click();
    await page.getByRole("heading", { name: "Soup" }).waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Switch circle" }).click();
    await page.getByRole("button", { name: "Home", exact: true }).click();
    await page.getByRole("heading", { name: "Soup" }).waitFor();

    const token = await page.evaluate(() => localStorage.getItem("fn_token"));
    const me = await fetch(`${hangry.baseUrl}/api/me`, { headers: { authorization: `Bearer ${token}` } }).then((response) => response.json());
    const bea = await fetch(`${hangry.baseUrl}/api/auth/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Bea", email: testEmail(), code: me.circle.inviteCode }),
    }).then((response) => response.json());
    const beaContext = await hangry.browser.newContext({ viewport: { width: 360, height: 640 }, isMobile: true, hasTouch: true, userAgent: CHROME_UA });
    await skipWhatsNew(beaContext);
    await beaContext.addInitScript(vvMock);
    const beaPage = await beaContext.newPage();
    await beaPage.addInitScript((value) => localStorage.setItem("fn_token", value), bea.token);
    await beaPage.goto(hangry.baseUrl);
    const beaLater = beaPage.locator(".sheet button.btn.ghost", { hasText: "Not now" });
    if (await beaLater.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await beaLater.click();
    await beaPage.getByRole("button", { name: "Now", exact: true }).waitFor();
    assert.equal(await beaPage.getByRole("heading", { name: "Soup" }).count(), 0);

    await openYouSection(page, "Account");
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "Leave circle" }).click();
    await page.getByRole("button", { name: "Now", exact: true }).waitFor();
    assert.equal(await page.getByRole("heading", { name: "Soup" }).count(), 0);
    await beaContext.close();
  } finally {
    await page.context().close();
  }
});

async function phonePage(userAgent: string, locate: boolean, extraScript = "") {
  const context = await hangry.browser.newContext({
    viewport: { width: 360, height: 640 },
    isMobile: true,
    hasTouch: true,
    userAgent,
    ...(locate ? { geolocation: { latitude: 48.7784, longitude: 9.18 }, permissions: ["geolocation"] } : {}),
  });
  await skipWhatsNew(context);
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
  await page.goto(hangry.baseUrl);
  await page.locator("#name").fill(name);
  await page.locator("#email").fill(testEmail());
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
