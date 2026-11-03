import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { FIELD_REVEAL_MS } from "../../public/keyboard.js";
import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { openDb } from "../../src/db.js";
import { createNoopPushSender } from "../../src/push.js";

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

test("picking on the map drops a pin and names the place", { timeout: 90_000 }, async () => {
  const page = await phonePage(CHROME_UA, false);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.context().route("**/api/geocode?**", (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("q")) return route.fulfill({ json: { results: [] } });
    return route.fulfill({ json: { place: PLACE } });
  });
  try {
    await openFreeSheet(page, "Philipp");
    await page.locator("button.where-row").click();
    await page.getByRole("button", { name: "Pick on map" }).click();
    await page.locator("#where-map .leaflet-marker-icon").waitFor({ timeout: 8000 });
    await page.locator("#where-map").click({ position: { x: 30, y: 40 } });
    await page.locator(".where-v", { hasText: PLACE }).waitFor({ timeout: 8000 });
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

async function phonePage(userAgent: string, locate: boolean) {
  const context = await browser.newContext({
    viewport: { width: 360, height: 640 },
    isMobile: true,
    hasTouch: true,
    userAgent,
    ...(locate ? { geolocation: { latitude: 48.7784, longitude: 9.18 }, permissions: ["geolocation"] } : {}),
  });
  await context.addInitScript(vvMock);
  if (locate) {
    await context.route("**/api/geocode?**", (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.has("q")) return route.fulfill({ json: { results: [] } });
      return route.fulfill({ json: { place: PLACE } });
    });
  }
  return context.newPage();
}

async function openFreeSheet(page: Page, name: string) {
  await page.goto(baseUrl);
  await page.locator("#name").fill(name);
  await page.getByRole("button", { name: "Continue" }).click();
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
  await page.locator("#circle-name").fill("friends");
  await page.getByRole("button", { name: "Create circle" }).click();
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
  await page.getByRole("button", { name: "Let friends know you're free now" }).click();
  await page.locator("#sheet-note").waitFor();
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
