import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { openDb } from "../../src/db.js";
import { createNoopPushSender } from "../../src/push.js";

const CHROME_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36";
const PLACE = "Near Alexanderplatz, Berlin";
const NOTE = "Coffee nearby";

let browser: Browser;
let baseUrl = "";
let closeServer: () => Promise<void> = async () => {};

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

test("current location while the where map is open does not throw", { timeout: 90_000 }, async () => {
  const page = await phonePage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.stack || String(error)));
  try {
    await signIn(page, "Philipp");
    await page.getByRole("button", { name: "Let friends know you're free now" }).click();
    await page.locator("#sheet-note").fill(NOTE);
    await page.locator("button.where-row").click();
    await page.getByRole("button", { name: "Pick on map" }).click();
    await page.locator("#where-map .leaflet-marker-icon").waitFor({ timeout: 8000 });
    await page.getByRole("button", { name: "Use my current location" }).click();
    await page.locator(".where-v", { hasText: PLACE }).waitFor({ timeout: 8000 });
    await page.locator("#where-map .leaflet-marker-icon").waitFor({ timeout: 8000 });
    // invalidateSize is armed for 60ms and can fire twice (geolocation, then reverse geocode).
    await page.waitForTimeout(1000);
    assert.equal(await page.locator("#sheet-note").inputValue(), NOTE);
    assert.equal(await page.locator("#where-map").count(), 1);
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

async function phonePage() {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent: CHROME_UA,
    geolocation: { latitude: 52.52, longitude: 13.405 },
    permissions: ["geolocation"],
  });
  await context.route("**/api/geocode?**", (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("q")) return route.fulfill({ json: { results: [] } });
    return route.fulfill({ json: { place: PLACE } });
  });
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
  const again = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await again.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await again.click();
  await page.getByRole("button", { name: "Let friends know you're free now" }).waitFor();
}
