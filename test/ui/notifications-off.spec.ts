import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { openDb } from "../../src/db.js";
import type { PushPayload, PushSender, PushSubscription } from "../../src/push.js";
import { skipWhatsNew } from "./whats-new-seen.js";

const UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36";
const SHOT_DIR = path.resolve(process.env.NOTIF_SHOT_DIR || ".oc/shots");
const ENDPOINT = "https://push.example/fake";

let browser: Browser;
let baseUrl = "";
let closeServer: () => Promise<void> = async () => {};
const sent: Array<{ endpoint: string; payload: PushPayload }> = [];

/**
 * Headless Chrome cannot really subscribe to push. This fakes Notification permission and the
 * service worker's pushManager, keeping its state in localStorage so it survives a reload.
 */
const FAKE_PUSH = `(() => {
  const ENDPOINT = ${JSON.stringify(ENDPOINT)};
  const read = (key) => localStorage.getItem(key);
  function FakeNotification() {}
  Object.defineProperty(FakeNotification, "permission", { get: () => read("fake.permission") || "default" });
  FakeNotification.requestPermission = () => {
    localStorage.setItem("fake.permission", "granted");
    return Promise.resolve("granted");
  };
  Object.defineProperty(window, "Notification", { configurable: true, get: () => FakeNotification });
  const bump = (key) => localStorage.setItem(key, String(Number(read(key) || 0) + 1));
  const subscription = () => ({
    endpoint: ENDPOINT,
    toJSON: () => ({ endpoint: ENDPOINT, keys: { p256dh: "p", auth: "a" } }),
    unsubscribe: () => {
      bump("fake.unsubscribed");
      localStorage.removeItem("fake.sub");
      return Promise.resolve(true);
    },
  });
  const pushManager = {
    subscribe: () => {
      bump("fake.subscribed");
      localStorage.setItem("fake.sub", "1");
      return Promise.resolve(subscription());
    },
    getSubscription: () => Promise.resolve(read("fake.sub") === "1" ? subscription() : null),
  };
  const sw = navigator.serviceWorker;
  if (sw) {
    Object.defineProperty(sw, "ready", { configurable: true, get: () => Promise.resolve({ pushManager }) });
    sw.register = () => Promise.resolve({ pushManager });
  }
})();`;

test.before(async () => {
  const db = openDb(":memory:");
  const config = loadConfig({
    PORT: "3000",
    DB_PATH: ":memory:",
    APP_TZ: "UTC",
    VAPID_PUBLIC_KEY: "BFakePublicKeyForTestsOnly_abcdefghijklmnopqrstuvwxyz0123456789",
    VAPID_PRIVATE_KEY: "fake-private-key-for-tests",
  });
  const push: PushSender = {
    async send(subscription: PushSubscription, payload: PushPayload) {
      sent.push({ endpoint: subscription.endpoint, payload });
    },
  };
  const server = http.createServer(createApp({ db, push, config: { ...config, dbPath: ":memory:" }, now: () => Date.now() }));
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

async function post(pathname: string, body: unknown, token?: string) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (response.status >= 400) throw new Error(`${pathname} -> ${response.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function known(token: string) {
  return (await post("/api/push/status", { endpoint: ENDPOINT }, token)).known as boolean;
}

async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) });
}

const fakeCount = (page: Page, key: string) => page.evaluate((k) => Number(localStorage.getItem(k) || 0), key);

test("Settings → Notifications turns push off and back on at 393x852", { timeout: 120_000 }, async () => {
  const alex = await post("/api/auth/start", { name: "Alex" });
  const circle = await post("/api/circles", { name: "friends" }, alex.token);
  const bea = await post("/api/auth/start", { name: "Bea", code: circle.circle.inviteCode });

  const context = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, userAgent: UA });
  await skipWhatsNew(context);
  await context.addInitScript((token) => {
    localStorage.setItem("fn_token", token);
    // Count as installed, so the only possible nag is the push one.
    localStorage.setItem("fn_installed", "1");
    if (!sessionStorage.getItem("booted")) {
      sessionStorage.setItem("booted", "1");
      localStorage.setItem("fn_install_later", String(Date.now()));
    }
  }, bea.token);
  await context.addInitScript(FAKE_PUSH);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const row = page.locator("button.notif-row");
  const sheet = page.getByRole("dialog", { name: "Notifications" });
  try {
    await page.goto(baseUrl);
    await page.locator("nav.tabbar").getByRole("button", { name: "You", exact: true }).click();
    await row.getByText("Off", { exact: true }).waitFor();

    // Turn on.
    await row.click();
    await sheet.getByRole("button", { name: "Turn on notifications" }).click();
    await sheet.getByRole("button", { name: "Turn off notifications" }).waitFor();
    await sheet.getByText("Notifications are on for this phone.").waitFor();
    assert.equal(await known(bea.token), true);
    await page.locator(".toast").waitFor({ state: "detached", timeout: 6000 });
    await shot(page, "notif-sheet-on");
    await page.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
    await row.getByText("On", { exact: true }).waitFor();
    await shot(page, "notif-row-on");

    // Turn off.
    await row.click();
    await sheet.getByRole("button", { name: "Turn off notifications" }).click();
    await sheet.getByRole("button", { name: "Turn on notifications" }).waitFor();
    await page.getByRole("status").getByText("Notifications are off").waitFor();
    assert.equal(await known(bea.token), false);
    assert.equal(await fakeCount(page, "fake.unsubscribed"), 1);
    assert.equal(await page.evaluate(() => localStorage.getItem("hangry.pushOff")), "1");
    await page.locator(".toast").waitFor({ state: "detached", timeout: 6000 });
    await shot(page, "notif-sheet-off");
    await page.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
    await row.getByText("Off", { exact: true }).waitFor();
    await shot(page, "notif-row-off");

    sent.length = 0;
    await post("/api/socials", { note: "Coffee" }, alex.token);
    assert.equal(sent.filter((item) => item.endpoint === ENDPOINT).length, 0);

    // Reminders are due again, but a phone that turned push off is not nagged.
    await page.evaluate(() => localStorage.removeItem("fn_install_later"));
    await page.reload();
    await page.getByText("Coffee", { exact: true }).first().waitFor();
    await page.waitForTimeout(2500);
    assert.equal(await page.locator(".sheet").count(), 0, "no onboarding nag");
    await page.locator("nav.tabbar").getByRole("button", { name: "You", exact: true }).click();
    await row.getByText("Off", { exact: true }).waitFor();

    // Turn back on.
    await row.click();
    await sheet.getByRole("button", { name: "Turn on notifications" }).click();
    await sheet.getByRole("button", { name: "Turn off notifications" }).waitFor();
    assert.equal(await known(bea.token), true);
    assert.equal(await fakeCount(page, "fake.subscribed"), 2);
    assert.equal(await page.evaluate(() => localStorage.getItem("hangry.pushOff")), null);
    await page.keyboard.press("Escape");
    await row.getByText("On", { exact: true }).waitFor();
    sent.length = 0;
    await post("/api/socials", { note: "Walk" }, alex.token).catch(() => null);
    await post("/api/plans", { note: "Dinner" }, alex.token);
    assert.ok(sent.some((item) => item.endpoint === ENDPOINT), "pushes reach the phone again");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});
