import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import { chromium, devices, type Browser, type Page } from "playwright-core";
import { FIELD_REVEAL_MS, keyboardOffset } from "../../public/keyboard.js";
import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { openDb } from "../../src/db.js";
import { createNoopPushSender } from "../../src/push.js";

type Measure = {
  kb: number;
  vvHeight: number;
  offsetTop: number;
  innerHeight: number;
  visibleBottom: number;
  sheetBottom: number;
  sheetTop: number;
  sheetMaxHeight: number;
  paddingBottom: number;
  inputTop: number;
  inputBottom: number;
  kbOpen: boolean;
  tabHidden: boolean | null;
  scrolls: { id: string; block?: string }[];
  touchUi: boolean;
  viewportMeta: string;
};

const shotsDir = path.resolve("test/ui/screenshots");
const artifactsDir = "/opt/cursor/artifacts";

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
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatchEvent(event) {
      for (const fn of listeners.get(event.type) ?? []) fn(event);
      return true;
    },
  };
  window.__setVisualViewport = (next) => {
    if (Object.prototype.hasOwnProperty.call(next, "height")) bucket.height = next.height;
    if (Object.prototype.hasOwnProperty.call(next, "offsetTop")) bucket.offsetTop = next.offsetTop;
    fake.dispatchEvent(new Event("resize"));
    fake.dispatchEvent(new Event("scroll"));
  };
  Object.defineProperty(window, "visualViewport", { configurable: true, get: () => fake });
  const original = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function scrollIntoView(arg) {
    const entry = { id: this.id || "", block: arg && arg.block, inline: arg && arg.inline };
    (window.__scrolls = window.__scrolls || []).push(entry);
    return original.apply(this, arguments);
  };
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
  try {
    browser = await chromium.launch({ channel: "chrome", headless: true });
  } catch {
    browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true });
  }
});

test.after(async () => {
  await browser?.close();
  await closeServer();
});

test("mobile sheets stay above a reduced visual viewport", { timeout: 90_000 }, async () => {
  const page = await mobilePage(true);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  try {
    await page.goto(baseUrl);
    await signUp(page, "Alex");
    assert.match(await viewportContent(page), /interactive-widget=resizes-content/);
    await createCircle(page);
    const homeBar = await page.locator(".tabbar").boundingBox();
    assert.ok(homeBar);
    assert.ok(Math.abs(homeBar.y + homeBar.height - page.viewportSize()!.height) < 3);
    await shot(page, "mobile_home_nav");

    await page.getByRole("button", { name: "Let friends know you're free now" }).click();
    await page.locator("#sheet-note").waitFor();
    await page.locator("#sheet-note").focus();
    const closed = await measure(page);
    assert.equal(closed.touchUi, true, "Pixel emulation should be a touch UI");
    assert.equal(closed.kb, 0);
    assert.equal(closed.kbOpen, false);
    assert.equal(closed.tabHidden, false);
    assert.ok(Math.abs(closed.sheetBottom - closed.innerHeight) <= 2, JSON.stringify(closed));

    await page.evaluate(() => { window.__scrolls = []; });
    await setViewport(page, { height: closed.innerHeight - 300, offsetTop: 40 });
    await page.waitForTimeout(FIELD_REVEAL_MS + 250);
    await page.locator("#sheet-note").fill("Rooftop coffee??");
    const lifted = await measure(page);
    assertSheetAboveKeyboard(lifted);
    assert.equal(await page.locator("#sheet-note").inputValue(), "Rooftop coffee??");
    assert.ok(
      lifted.scrolls.some((entry) => entry.id === "sheet-note" && entry.block === "nearest"),
      `expected sheet input to scroll into view, got ${JSON.stringify(lifted.scrolls)}`,
    );

    await setViewport(page, { height: lifted.innerHeight - 340, offsetTop: 0 });
    await page.waitForTimeout(80);
    const framed = await measure(page);
    assertSheetAboveKeyboard(framed);
    await paintKeyboard(page);
    await shot(page, "mobile_free_sheet_keyboard");

    await page.locator(".scrim").click({ position: { x: 16, y: 16 } });
    await page.locator(".sheet").waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Plan tomorrow" }).click();
    await page.locator(".sheet").getByRole("heading", { name: "Tomorrow" }).waitFor();
    await page.waitForTimeout(FIELD_REVEAL_MS + 250);
    const plan = await measure(page);
    assertSheetAboveKeyboard(plan);
    await page.locator("#sheet-note").fill("Walk and dinner");
    await paintKeyboard(page);
    await shot(page, "mobile_plan_sheet_keyboard");

    await setViewport(page, { height: 180, offsetTop: 0 });
    await page.waitForTimeout(FIELD_REVEAL_MS + 250);
    const cramped = await measure(page);
    assertSheetAboveKeyboard(cramped);
    const overflow = await page.evaluate(() => {
      const sheet = document.querySelector(".sheet");
      const scroller = document.querySelector(".sheet-scroll") || sheet;
      const input = document.getElementById("sheet-note");
      if (!sheet || !scroller || !input) return null;
      const sheetRect = sheet.getBoundingClientRect();
      const inputRect = input.getBoundingClientRect();
      return {
        scrolls: scroller.scrollHeight > scroller.clientHeight + 1,
        inputInside: inputRect.top >= sheetRect.top - 1 && inputRect.bottom <= sheetRect.bottom + 1,
      };
    });
    assert.equal(overflow?.scrolls, true);
    assert.equal(overflow?.inputInside, true);

    await setViewport(page, { height: null, offsetTop: 0 });
    await page.waitForTimeout(80);
    const restored = await measure(page);
    assert.equal(restored.kb, 0);
    assert.equal(restored.kbOpen, false);
    assert.equal(restored.tabHidden, false);
    assert.ok(Math.abs(restored.sheetBottom - restored.innerHeight) <= 2, JSON.stringify(restored));
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("join form clears a 280px keyboard on a 360x640 phone", { timeout: 90_000 }, async () => {
  const pixel = devices["Pixel 7"];
  const context = await browser.newContext({
    viewport: { width: 360, height: 640 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    userAgent: pixel.userAgent,
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  try {
    await page.goto(baseUrl);
    await signUp(page, "Jo");
    await page.locator("#invite-code").click();
    // Content-resize: a 280px keyboard shrinks the layout viewport from 640 to 360.
    await page.setViewportSize({ width: 360, height: 360 });
    await page.waitForTimeout(FIELD_REVEAL_MS + 250);
    const placed = await page.evaluate(() => {
      const input = document.getElementById("invite-code")?.getBoundingClientRect();
      const button = [...document.querySelectorAll("button")].find((node) => node.textContent === "Join circle")?.getBoundingClientRect();
      const view = window.visualViewport?.height ?? window.innerHeight;
      return {
        view,
        innerHeight: window.innerHeight,
        inputTop: input?.top ?? null,
        inputBottom: input?.bottom ?? null,
        buttonTop: button?.top ?? null,
        buttonBottom: button?.bottom ?? null,
      };
    });
    assert.ok(placed.view <= 360, JSON.stringify(placed));
    assert.ok(placed.buttonTop != null && placed.buttonBottom != null, JSON.stringify(placed));
    assert.ok(placed.buttonTop >= -1, JSON.stringify(placed));
    assert.ok(placed.buttonBottom <= placed.view + 1, JSON.stringify(placed));
    assert.ok(placed.inputTop != null && placed.inputTop >= -1, JSON.stringify(placed));
    assert.ok(placed.inputBottom != null && placed.inputBottom <= placed.view + 1, JSON.stringify(placed));
    await shot(page, "mobile_join_form_keyboard");
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
    await context.close();
  }
});

test("where search stays above the pinned I'm free bar", { timeout: 90_000 }, async () => {
  const page = await mobilePage(true);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  try {
    await page.goto(baseUrl);
    await signUp(page, "Bea");
    await createCircle(page);
    await page.getByRole("button", { name: "Let friends know you're free now" }).click();
    await page.locator("#sheet-note").waitFor();
    await page.locator("button.where-row").click();
    const query = page.locator("#where-query");
    await query.waitFor();
    await query.focus();
    await setViewport(page, { height: 330, offsetTop: 0 });
    await page.waitForTimeout(FIELD_REVEAL_MS + 300);
    const placed = await page.evaluate(() => {
      const field = document.getElementById("where-query")?.getBoundingClientRect();
      const dock = document.querySelector(".sheet-dock")?.getBoundingClientRect();
      const view = window.visualViewport;
      return {
        fieldTop: field?.top ?? null,
        fieldBottom: field?.bottom ?? null,
        dockTop: dock?.top ?? null,
        viewHeight: view?.height ?? null,
        focused: document.activeElement?.id ?? "",
      };
    });
    assert.equal(placed.focused, "where-query", JSON.stringify(placed));
    assert.equal(placed.viewHeight, 330);
    assert.ok(placed.fieldTop != null && placed.fieldBottom != null && placed.dockTop != null, JSON.stringify(placed));
    assert.ok(placed.fieldTop >= -1, JSON.stringify(placed));
    assert.ok(placed.fieldBottom <= placed.dockTop - 8, JSON.stringify(placed));
    await paintKeyboard(page);
    await shot(page, "mobile_where_above_dock");
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("desktop sheet stays on the bottom edge", { timeout: 90_000 }, async () => {
  const page = await mobilePage(false);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  try {
    await page.goto(baseUrl);
    await signUp(page, "Sam");
    await createCircle(page);
    const bar = await page.locator(".tabbar").boundingBox();
    assert.ok(bar);
    assert.ok(Math.abs(bar.y + bar.height - page.viewportSize()!.height) < 3);
    await page.getByRole("button", { name: "Let friends know you're free now" }).click();
    await page.locator("#sheet-note").waitFor();
    await page.locator("#sheet-note").fill("Desk note");
    await page.waitForTimeout(FIELD_REVEAL_MS + 250);
    const data = await measure(page);
    assert.equal(data.touchUi, false);
    assert.equal(data.kb, 0);
    assert.equal(data.kbOpen, false);
    assert.equal(data.tabHidden, false);
    assert.ok(Math.abs(data.sheetBottom - data.innerHeight) <= 2, JSON.stringify(data));
    assert.ok(data.inputBottom <= data.innerHeight);
    assert.ok(data.paddingBottom >= 20);
    await shot(page, "desktop_free_sheet");
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

async function mobilePage(emulatePhone: boolean) {
  const pixel = devices["Pixel 7"];
  const context = await browser.newContext(emulatePhone
    ? { ...pixel, deviceScaleFactor: 1 }
    : { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, hasTouch: false, isMobile: false });
  if (emulatePhone) await context.addInitScript(vvMock);
  return context.newPage();
}

async function dismissReminders(page: Page) {
  const sheet = page.locator(".sheet");
  for (let i = 0; i < 4; i += 1) {
    const visible = await sheet.waitFor({ state: "visible", timeout: 1500 }).then(() => true).catch(() => false);
    if (!visible) return;
    const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
    if (!(await later.count())) return;
    await later.first().click();
  }
}

async function signUp(page: Page, name: string) {
  await page.locator("#name").waitFor({ timeout: 15_000 });
  await page.locator("#name").fill(name);
  await page.getByRole("button", { name: "Continue" }).click();
  await dismissReminders(page);
  await page.locator("#invite-code").waitFor();
}

async function createCircle(page: Page) {
  await page.locator("#circle-name").fill("friends");
  await page.getByRole("button", { name: "Create circle" }).click();
  await dismissReminders(page);
  await page.getByRole("button", { name: "Let friends know you're free now" }).waitFor();
}

async function viewportContent(page: Page) {
  return page.locator('meta[name="viewport"]').getAttribute("content");
}

async function setViewport(page: Page, next: { height: number | null; offsetTop: number }) {
  await page.evaluate((value) => {
    if (typeof window.__setVisualViewport !== "function") {
      throw new Error("visualViewport mock was not installed");
    }
    window.__setVisualViewport(value);
  }, next);
}

async function measure(page: Page): Promise<Measure> {
  return page.evaluate(() => {
    const sheet = document.querySelector(".sheet");
    const input = document.getElementById("sheet-note");
    const bar = document.querySelector(".tabbar");
    const vv = window.visualViewport;
    if (!sheet || !vv) throw new Error("sheet or visualViewport missing");
    const sheetRect = sheet.getBoundingClientRect();
    const inputRect = input ? input.getBoundingClientRect() : null;
    const style = getComputedStyle(sheet);
    return {
      kb: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--kb-offset")),
      vvHeight: vv.height,
      offsetTop: vv.offsetTop,
      innerHeight: window.innerHeight,
      visibleBottom: vv.offsetTop + vv.height,
      sheetBottom: sheetRect.bottom,
      sheetTop: sheetRect.top,
      sheetMaxHeight: parseFloat(style.maxHeight),
      paddingBottom: parseFloat(style.paddingBottom),
      inputTop: inputRect ? inputRect.top : null,
      inputBottom: inputRect ? inputRect.bottom : null,
      kbOpen: document.documentElement.classList.contains("kb-open"),
      tabHidden: bar ? getComputedStyle(bar).visibility === "hidden" : null,
      scrolls: window.__scrolls || [],
      touchUi: window.matchMedia("(pointer: coarse)").matches
        || (navigator.maxTouchPoints > 0 && window.matchMedia("(hover: none)").matches),
      viewportMeta: document.querySelector('meta[name="viewport"]')?.getAttribute("content") || "",
    };
  });
}

function assertSheetAboveKeyboard(data: Measure) {
  assert.equal(data.kb, keyboardOffset(data.innerHeight, data.vvHeight, data.offsetTop));
  assert.ok(data.kb >= 80, JSON.stringify(data));
  assert.ok(Math.abs(data.sheetBottom - (data.innerHeight - data.kb)) <= 2, JSON.stringify(data));
  assert.ok(data.inputBottom <= data.visibleBottom + 1, JSON.stringify(data));
  assert.ok(data.inputTop >= data.offsetTop - 1, JSON.stringify(data));
  assert.ok(data.inputBottom <= data.sheetBottom + 1, JSON.stringify(data));
  assert.ok(data.sheetMaxHeight <= data.vvHeight - 12 + 1, JSON.stringify(data));
  assert.ok(data.sheetMaxHeight >= data.vvHeight - 12 - 80, JSON.stringify(data));
  assert.ok(data.paddingBottom >= 20, JSON.stringify(data));
  assert.equal(data.kbOpen, true);
  assert.equal(data.tabHidden, true);
}

async function paintKeyboard(page: Page) {
  await page.evaluate(() => {
    document.getElementById("kb-probe")?.remove();
    const band = document.createElement("div");
    band.id = "kb-probe";
    band.style.cssText = [
      "position:fixed",
      "left:0",
      "right:0",
      "bottom:0",
      "height:var(--kb-offset)",
      "background:#2c2c2e",
      "border-top:1px solid #6e6e73",
      "z-index:32",
      "pointer-events:none",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "color:#aeaeb2",
      "font:600 12px/1 sans-serif",
      "letter-spacing:.08em",
      "text-transform:uppercase",
    ].join(";");
    band.textContent = "Simulated keyboard";
    document.body.append(band);
  });
}

async function shot(page: Page, name: string) {
  fs.mkdirSync(shotsDir, { recursive: true });
  const file = path.join(shotsDir, `${name}.png`);
  await page.screenshot({ path: file });
  if (fs.existsSync(artifactsDir)) {
    const dest = path.join(artifactsDir, `${name}.png`);
    if (!fs.existsSync(dest)) fs.copyFileSync(file, dest);
  }
}
