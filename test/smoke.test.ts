import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { chromium } from "playwright-core";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { createNoopPushSender } from "../src/push/push.js";

test("the page loads in Chrome without a page error", { timeout: 60_000 }, async () => {
  const db = openDb(":memory:");
  const config = loadConfig({ PORT: "3000", DB_PATH: ":memory:", APP_TZ: "UTC" });
  const server = http.createServer(createApp({
    db,
    push: createNoopPushSender(),
    config: { ...config, dbPath: ":memory:" },
    now: () => Date.now(),
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  let browser;
  try {
    try {
      browser = await chromium.launch({ channel: "chrome", headless: true });
    } catch {
      browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true });
    }
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    const response = await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
    assert.equal(response?.status(), 200);
    await page.locator("h1", { hasText: "Hangry" }).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});
