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
import { skipWhatsNew } from "./whats-new-seen.js";

const CHROME_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36";
const HITS = [
  { name: "jomi Bagel Deli", address: "Hasenbergsteige 5, Stuttgart", lat: 48.7705, lng: 9.1655, distanceM: 1100 },
  { name: "jomi Bagel Deli West", address: "Rotebühlstraße 120, 70197 Stuttgart-West, Baden-Württemberg, Deutschland", lat: 48.7712, lng: 9.159, distanceM: 1500 },
  { name: "Bagel Brothers", address: "Königstraße 1, Stuttgart", lat: 48.778, lng: 9.18, distanceM: 2100 },
];
const SIZES: Array<[number, number]> = [[320, 568], [412, 915]];
const MODES = ["visual-viewport", "resizes-content"] as const;
type Mode = typeof MODES[number];

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
    fake.dispatchEvent(new Event("scroll"));
  };
  Object.defineProperty(window, "visualViewport", { configurable: true, get: () => fake });
})();`;

test.before(async () => {
  const db = openDb(":memory:");
  const config = loadConfig({ PORT: "3000", DB_PATH: ":memory:", APP_TZ: "Europe/Berlin" });
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

test("map card Edit and End sit clear of the host name and title", { timeout: 120_000 }, async () => {
  for (const [width, height] of [[320, 568], [360, 640], [412, 915]] as Array<[number, number]>) {
    const page = await phone(width, height, false);
    try {
      await signIn(page, `Alex${width}`);
      await page.getByRole("button", { name: "Plan", exact: true }).click();
      await page.locator("#sheet-note").fill("Bagels for lunch with everyone??");
      await page.locator("#plan-time").fill("12:45");
      await page.getByRole("button", { name: "Where" }).click();
      await page.locator("#where-query").fill("jomi");
      await page.locator(".where-hit").first().click();
      await page.getByRole("button", { name: "Add plan" }).click();
      await page.getByRole("heading", { name: "Bagels for lunch with everyone??" }).waitFor();
      await openMapCard(page);
      const boxes = await page.evaluate(() => {
        const card = document.querySelector(".map-card")!;
        const nodes = [card, card.querySelector("strong")!, ...card.querySelectorAll(":scope > p"), ...card.querySelectorAll("button")];
        const all = nodes.map((node) => {
          const r = node.getBoundingClientRect();
          return { text: node.textContent || "", tag: node.tagName, top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height };
        });
        return {
          card: all[0],
          texts: all.filter((item) => item.tag === "STRONG" || item.tag === "P"),
          buttons: all.filter((item) => item.tag === "BUTTON" && /^(Edit|End)$/.test(item.text)),
        };
      });
      const size = { width, height };
      assert.equal(boxes.buttons.length, 2, JSON.stringify({ size, boxes }));
      assert.ok(boxes.texts.length >= 3, JSON.stringify({ size, boxes }));
      for (const button of boxes.buttons) {
        assert.ok(button.height >= 44 - 0.5, JSON.stringify({ size, button }));
        assert.ok(
          button.top >= boxes.card.top - 0.5 && button.bottom <= boxes.card.bottom + 0.5
            && button.left >= boxes.card.left - 0.5 && button.right <= boxes.card.right + 0.5,
          JSON.stringify({ size, button, card: boxes.card }),
        );
        for (const text of boxes.texts) {
          assert.equal(intersects(button, text), false, JSON.stringify({ size, button, text }));
        }
      }
    } finally {
      await page.context().close();
    }
  }
});

test("the edit sheet from the map card scrolls every field clear of the keyboard", { timeout: 180_000 }, async () => {
  for (const [width, height] of SIZES) {
    for (const mode of MODES) {
      const page = await phone(width, height, mode === "visual-viewport");
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      const label = JSON.stringify({ width, height, mode });
      try {
        await signIn(page, "Alex");
        const token = await page.evaluate(() => localStorage.getItem("fn_token"));
        await fetch(`${baseUrl}/api/plans`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ note: "Bagels for lunch??", place: "jomi Bagel Deli", lat: 48.7705, lng: 9.1655, precise: true, time: "12:45" }),
        });
        await page.reload();
        await dismiss(page);
        await openMapCard(page);
        await page.locator(".map-card").getByRole("button", { name: /^Edit/ }).click();
        await page.locator("#admin-note").waitFor();
        await page.locator("#admin-note").focus();
        await openKeyboard(page, mode, width, height);
        await page.locator(".sheet button.where-row").click();
        await page.locator("#where-query").fill("jomi");
        await page.locator(".where-hit").nth(HITS.length - 1).waitFor();
        await page.waitForTimeout(FIELD_REVEAL_MS + 300);
        await assertSheetReachable(page, label, ["#admin-note", "#admin-time", ".sheet button.where-row", "#where-query", ".where-hit"]);
        await assertSheetCoversMap(page, label);
        const saved = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().includes("/api/plans/"));
        await page.locator(".sheet-dock").getByRole("button", { name: "Save" }).click();
        assert.equal((await saved).status(), 200, label);
        assert.deepEqual(errors, [], label);
      } finally {
        await page.context().close();
      }
    }
  }
});

test("the create plan sheet scrolls every field clear of the keyboard", { timeout: 180_000 }, async () => {
  for (const [width, height] of SIZES) {
    for (const mode of MODES) {
      const page = await phone(width, height, mode === "visual-viewport");
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      const label = JSON.stringify({ width, height, mode });
      try {
        await signIn(page, "Alex");
        await page.getByRole("button", { name: "Plan", exact: true }).click();
        await page.locator("#sheet-note").fill("Dinner");
        await page.locator("#sheet-note").focus();
        await openKeyboard(page, mode, width, height);
        await page.locator(".sheet button.where-row").click();
        await page.locator("#where-query").fill("jomi");
        await page.locator(".where-hit").nth(HITS.length - 1).waitFor();
        await page.waitForTimeout(FIELD_REVEAL_MS + 300);
        await assertSheetReachable(page, label, ["#sheet-note", "#plan-time", ".sheet button.where-row", "#where-query", ".where-hit"]);
        const created = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/plans"));
        await page.locator(".sheet-dock").getByRole("button", { name: "Add plan" }).click();
        assert.equal((await created).status(), 201, label);
        assert.deepEqual(errors, [], label);
      } finally {
        await page.context().close();
      }
    }
  }
});

test("a pasted URL that is not a Maps link is never sent as search text", { timeout: 90_000 }, async () => {
  const page = await phone(412, 915, false);
  const searched: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/geocode")) searched.push(new URL(request.url()).searchParams.get("q") || "");
  });
  try {
    await signIn(page, "Alex");
    await page.getByRole("button", { name: "Plan", exact: true }).click();
    await page.getByRole("button", { name: "Where" }).click();
    const query = page.locator("#where-query");
    await query.focus();
    for (const pasted of ["https://example.com/some/cafe-page", "http://example.com/x", "https://www.google.com/search?q=cafe"]) {
      await query.fill("");
      await page.keyboard.insertText(pasted);
      await page.locator(".where-hint", { hasText: "Paste a Google Maps link or type a place" }).waitFor();
      await page.waitForTimeout(900);
      assert.deepEqual(searched, [], pasted);
      assert.equal(await page.locator(".where-hit").count(), 0, pasted);
    }

    const maps = "https://google.com/maps/place/jomi+Bagel+Deli/@48.7705,9.1655,17z";
    const sent = page.waitForRequest((request) => request.url().includes("/api/geocode"));
    await query.fill("");
    await page.keyboard.insertText(maps);
    await sent;
    assert.deepEqual(searched, [maps]);
    assert.equal(await page.locator(".where-hint", { hasText: "Paste a Google Maps link" }).count(), 0);
    await page.locator(".where-hit").first().waitFor();
  } finally {
    await page.context().close();
  }
});

async function phone(width: number, height: number, mockViewport: boolean) {
  const context = await browser.newContext({
    viewport: { width, height },
    isMobile: true,
    hasTouch: true,
    userAgent: CHROME_UA,
  });
  await skipWhatsNew(context);
  if (mockViewport) await context.addInitScript(vvMock);
  await context.route("**/api/geocode?**", (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("q")) return route.fulfill({ json: { results: HITS } });
    return route.fulfill({ json: { place: "", area: "" } });
  });
  // Map tiles are not needed for layout. Keep the test off the network.
  await context.route(/arcgisonline|tile\.openstreetmap|basemaps\.cartocdn/, (route) => route.abort());
  return context.newPage();
}

async function dismiss(page: Page) {
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
}

async function signIn(page: Page, name: string) {
  await page.goto(baseUrl);
  await page.locator("#name").fill(name);
  await page.getByRole("button", { name: "Continue" }).click();
  await dismiss(page);
  await page.locator("#circle-name").fill("friends");
  await page.getByRole("button", { name: "Create circle" }).click();
  await dismiss(page);
  await page.getByRole("button", { name: "Let friends know you're free now" }).waitFor();
}

async function openMapCard(page: Page) {
  await page.locator(".tabbar").getByRole("button", { name: /^Map/ }).click();
  const pin = page.locator(".leaflet-marker-icon.pin").first();
  await pin.waitFor({ timeout: 10_000 });
  await page.waitForTimeout(500);
  await pin.click();
  await page.locator(".map-card").waitFor();
}

/** (a) the visual viewport shrinks over a full-height layout, or (b) Android resizes the layout itself. */
async function openKeyboard(page: Page, mode: Mode, width: number, height: number) {
  const kb = Math.round(height * 0.42);
  if (mode === "visual-viewport") {
    await page.evaluate((next) => window.__setVisualViewport(next), { height: height - kb, offsetTop: 0 });
  } else {
    await page.setViewportSize({ width, height: height - kb });
  }
  await page.waitForTimeout(FIELD_REVEAL_MS + 300);
}

function intersects(a: { top: number; bottom: number; left: number; right: number }, b: { top: number; bottom: number; left: number; right: number }) {
  return a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
}

async function assertSheetReachable(page: Page, label: string, selectors: string[]) {
  const report = await page.evaluate((targets) => {
    const problems: string[] = [];
    const sheet = document.querySelector(".sheet")!;
    const head = sheet.querySelector(".sheet-head")!;
    const dock = sheet.querySelector(".sheet-dock")!;
    const vv = window.visualViewport!;
    const viewTop = vv.offsetTop;
    const viewBottom = vv.offsetTop + vv.height;
    const sheetBox = sheet.getBoundingClientRect();
    if (sheetBox.bottom > viewBottom + 1) problems.push(`sheet bottom ${sheetBox.bottom} below view ${viewBottom}`);
    if (sheetBox.top < viewTop - 1) problems.push(`sheet top ${sheetBox.top} above view ${viewTop}`);
    const dockBox = dock.getBoundingClientRect();
    if (dockBox.height < 1) problems.push("dock is hidden");

    for (const selector of targets) {
      const nodes = [...sheet.querySelectorAll(selector)];
      if (!nodes.length) problems.push(`${selector} missing`);
      nodes.forEach((node, index) => {
        node.scrollIntoView({ block: "nearest", inline: "nearest" });
        const box = node.getBoundingClientRect();
        const top = head.getBoundingClientRect().bottom;
        const bottom = Math.min(dock.getBoundingClientRect().top, viewBottom);
        const name = `${selector}[${index}]`;
        if (box.top < top - 1 || box.bottom > bottom + 1) problems.push(`${name} ${box.top}-${box.bottom} outside ${top}-${bottom}`);
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        if (!hit || (hit !== node && !node.contains(hit))) problems.push(`${name} centre is covered by ${hit?.className || hit?.tagName}`);
        if (node.classList.contains("where-hit") && node.scrollHeight > node.clientHeight + 1) {
          problems.push(`${name} squeezed ${node.scrollHeight} > ${node.clientHeight}`);
        }
      });
    }

    const scroll = sheet.querySelector(".sheet-scroll")!;
    const fields = [...scroll.querySelectorAll(".sheet-label, .sheet-control, .where-field, .where-results, .where-action, .share-toggle")];
    for (let i = 1; i < fields.length; i += 1) {
      const prev = fields[i - 1].getBoundingClientRect();
      const next = fields[i].getBoundingClientRect();
      if (prev.bottom > next.top + 0.5) problems.push(`${fields[i - 1].className} overlaps ${fields[i].className} (${prev.bottom} > ${next.top})`);
    }
    for (const control of scroll.querySelectorAll(".sheet-control, .where-field")) {
      const h = control.getBoundingClientRect().height;
      if (h < 51.5) problems.push(`${control.id || control.className} shrank to ${h}`);
    }
    const hits = [...scroll.querySelectorAll(".where-hit")];
    for (let i = 1; i < hits.length; i += 1) {
      if (hits[i - 1].getBoundingClientRect().bottom > hits[i].getBoundingClientRect().top + 0.5) problems.push(`where-hit ${i - 1} overlaps ${i}`);
    }

    const button = dock.querySelector("button[type=submit]")!;
    const buttonBox = button.getBoundingClientRect();
    if (buttonBox.top < viewTop - 1 || buttonBox.bottom > viewBottom + 1) problems.push(`submit ${buttonBox.top}-${buttonBox.bottom} outside view`);
    const buttonHit = document.elementFromPoint(buttonBox.left + buttonBox.width / 2, buttonBox.top + buttonBox.height / 2);
    if (buttonHit !== button && !button.contains(buttonHit)) problems.push(`submit covered by ${buttonHit?.className}`);
    return problems;
  }, selectors);
  assert.deepEqual(report, [], label);
  await page.locator(".sheet-dock button[type=submit]").click({ trial: true, timeout: 3000 });
}

async function assertSheetCoversMap(page: Page, label: string) {
  const covered = await page.evaluate(() => {
    const sheet = document.querySelector(".sheet")!;
    const box = sheet.getBoundingClientRect();
    const misses: string[] = [];
    for (const y of [box.top + 12, box.top + box.height / 2, box.bottom - 12]) {
      for (const x of [box.left + 8, box.left + box.width / 2, box.right - 8]) {
        const hit = document.elementFromPoint(x, y);
        if (!hit || !sheet.contains(hit) || hit.closest(".leaflet-container, .map-card")) {
          misses.push(`${Math.round(x)},${Math.round(y)} -> ${hit?.className || hit?.tagName}`);
        }
      }
    }
    const scrim = document.querySelector(".scrim")!.getBoundingClientRect();
    const map = document.querySelector(".map-card")?.getBoundingClientRect();
    if (map && map.top < box.top - 1) {
      const above = document.elementFromPoint(map.left + map.width / 2, Math.max(scrim.top + 2, map.top + 2));
      if (above && above.closest(".leaflet-container, .map-card")) misses.push(`map card above the sheet paints over the scrim`);
    }
    return misses;
  });
  assert.deepEqual(covered, [], label);
}
