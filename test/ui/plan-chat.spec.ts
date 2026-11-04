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
const HIT = { name: "RATTO Bistrobar", address: "Cottastraße 4", lat: 48.7674, lng: 9.1708, distanceM: 400 };

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

test("plan and edit sheets send a picked place and free text clears the pin", { timeout: 90_000 }, async () => {
  const page = await phone();
  try {
    await page.route("**/api/geocode?**", (route) => {
      const q = new URL(route.request().url()).searchParams.get("q") || "";
      if (!q || /kitchen/i.test(q)) return route.fulfill({ json: { results: [] } });
      return route.fulfill({ json: { results: [HIT] } });
    });
    await signIn(page, "Alex");
    await page.getByRole("button", { name: "Plan tomorrow" }).click();
    await page.locator("#sheet-note").fill("Dinner");
    await page.locator("#plan-time").fill("19:00");
    await page.getByRole("button", { name: "Where" }).click();
    await page.locator("#where-query").fill("Ratto");
    await page.locator(".where-hit").click();
    const created = page.waitForResponse((response) => response.url().includes("/api/plans") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Add plan" }).click();
    const posted = (await created).request().postDataJSON();
    assert.equal(posted.place, "RATTO Bistrobar");
    assert.equal(posted.lat, HIT.lat);
    assert.equal(posted.lng, HIT.lng);
    assert.equal(posted.precise, true);
    assert.equal(posted.time, "19:00");
    await page.getByRole("heading", { name: "Dinner" }).waitFor();

    await page.getByRole("button", { name: "Edit Dinner" }).click();
    await page.getByRole("button", { name: "Where" }).click();
    await page.locator("#where-query").fill("Schloss");
    await page.locator(".where-hit").click();
    const edited = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().includes("/api/plans/"));
    await page.getByRole("button", { name: "Save" }).click();
    const patched = (await edited).request().postDataJSON();
    assert.equal(patched.lat, HIT.lat);
    assert.equal(patched.lng, HIT.lng);
    await page.getByRole("heading", { name: "Dinner" }).waitFor();

    await page.getByRole("button", { name: "Edit Dinner" }).click();
    await page.getByRole("button", { name: "Where" }).click();
    const searched = page.waitForResponse((response) => response.url().includes("/api/geocode") && response.url().includes("Kitchen"));
    await page.locator("#where-query").fill("Kitchen");
    await searched;
    const cleared = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().includes("/api/plans/"));
    await page.getByRole("button", { name: "Save" }).click();
    const textOnly = (await cleared).request().postDataJSON();
    assert.equal(textOnly.place, "Kitchen");
    assert.equal(textOnly.lat, null);
    assert.equal(textOnly.lng, null);
    await page.getByRole("heading", { name: "Dinner" }).waitFor();
    const token = await page.evaluate(() => localStorage.getItem("fn_token"));
    const plans = await fetch(`${baseUrl}/api/plans`, { headers: { authorization: `Bearer ${token}` } }).then((response) => response.json());
    assert.equal(plans.plans[0].place, "Kitchen");
    assert.equal(plans.plans[0].location, null);
    assert.equal(plans.plans[0].time, "19:00");
  } finally {
    await page.context().close();
  }
});

test("an open sheet dims the page and blocks the form behind it", { timeout: 90_000 }, async () => {
  const page = await phone();
  try {
    await signIn(page, "Alex");
    await page.getByRole("button", { name: "Circle", exact: true }).click();
    await page.locator("#circle-rename").waitFor();
    await page.getByRole("button", { name: "New circle", exact: true }).click();
    await page.locator("#new-circle-name").waitFor();
    const blocked = await page.evaluate(() => {
      const scrim = document.querySelector(".scrim");
      const title = document.querySelector(".screen-title");
      const input = document.getElementById("circle-rename");
      if (!(scrim instanceof HTMLElement) || !title || !input) return null;
      const scrimBox = scrim.getBoundingClientRect();
      const titleBox = title.getBoundingClientRect();
      const inputBox = input.getBoundingClientRect();
      const titleHit = document.elementFromPoint(titleBox.left + 8, titleBox.top + 8);
      const inputHit = document.elementFromPoint(inputBox.left + 12, inputBox.top + 12);
      return {
        covers: scrimBox.width > 200 && scrimBox.height > 200,
        titleOnScrim: titleHit === scrim,
        inputBlocked: inputHit !== input && !input.contains(inputHit),
        locked: getComputedStyle(document.documentElement).overflow === "hidden",
      };
    });
    assert.equal(blocked?.covers, true);
    assert.equal(blocked?.titleOnScrim, true);
    assert.equal(blocked?.inputBlocked, true);
    assert.equal(blocked?.locked, true);
    let intercepted = false;
    try {
      await page.locator("#circle-rename").click({ timeout: 1500 });
    } catch (error) {
      intercepted = /intercept/i.test(String(error));
    }
    assert.equal(intercepted, true);
    assert.notEqual(await page.evaluate(() => document.activeElement?.id || ""), "circle-rename");
  } finally {
    await page.context().close();
  }
});

test("chat badge, banner, and per-circle dots follow unread", { timeout: 90_000 }, async () => {
  const page = await phone();
  try {
    await signIn(page, "Alex");
    const token = await page.evaluate(() => localStorage.getItem("fn_token"));
    const me = await fetch(`${baseUrl}/api/me`, { headers: { authorization: `Bearer ${token}` } }).then((response) => response.json());
    const sam = await fetch(`${baseUrl}/api/auth/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Sam", code: me.circle.inviteCode }),
    }).then((response) => response.json());
    await fetch(`${baseUrl}/api/circles/chat?circle=${me.circle.id}`, {
      method: "POST",
      headers: { authorization: `Bearer ${sam.token}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "Hello" }),
    });
    await page.reload();
    await dismiss(page);
    await page.getByRole("button", { name: "Chat, 1 unread" }).waitFor();
    assert.equal(await page.locator(".tabbar .badge").innerText(), "1");
    await page.getByRole("button", { name: "1 new message in friends" }).click();
    await page.getByText("Hello").waitFor();
    await page.getByRole("button", { name: "Back" }).click();
    await page.getByRole("button", { name: "Chat", exact: true }).waitFor();
    assert.equal(await page.locator(".chat-banner").count(), 0);
    assert.equal(await page.locator(".tabbar .badge").count(), 0);

    await page.getByRole("button", { name: "Circle", exact: true }).click();
    await page.getByRole("button", { name: "New circle", exact: true }).click();
    await page.locator("#new-circle-name").fill("Home");
    await page.getByRole("button", { name: "Create circle" }).click();
    await page.getByRole("button", { name: "Switch circle" }).waitFor();
    const posted = await fetch(`${baseUrl}/api/circles/chat?circle=${me.circle.id}`, {
      method: "POST",
      headers: { authorization: `Bearer ${sam.token}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "In friends" }),
    });
    assert.equal(posted.status, 201, await posted.text());
    await page.reload();
    await dismiss(page);
    await page.getByRole("button", { name: "Switch circle" }).click();
    const menu = page.locator(".circle-menu");
    assert.equal(await menu.getByRole("button", { name: "friends" }).locator(".unread-dot").count(), 1);
    assert.equal(await menu.getByRole("button", { name: "Home" }).locator(".unread-dot").count(), 0);
    assert.equal(await page.locator(".circle-switch-btn .unread-dot").count(), 1);
  } finally {
    await page.context().close();
  }
});

test("the last place result is reachable on a 320x568 screen", { timeout: 90_000 }, async () => {
  const page = await phone(320, 568);
  try {
    const hits = [1, 2, 3, 4, 5].map((n) => ({
      name: `Cafe ${n}`,
      address: `Street ${n}`,
      lat: 48.7 + n / 100,
      lng: 9.1,
      distanceM: n * 100,
    }));
    await page.route("**/api/geocode?**", (route) => route.fulfill({ json: { results: hits } }));
    await signIn(page, "Alex");
    await page.getByRole("button", { name: "Plan tomorrow" }).click();
    await page.getByRole("button", { name: "Where" }).click();
    await page.locator("#where-query").fill("Cafe");
    const last = page.locator(".where-hit", { hasText: "Cafe 5" });
    await last.waitFor();
    await last.scrollIntoViewIfNeeded();
    const box = await last.boundingBox();
    assert.ok(box, "last result has no box");
    assert.ok(box.y >= 0 && box.y + box.height <= 568, JSON.stringify(box));
    await last.click();
    await page.locator(".where-v", { hasText: "Cafe 5" }).waitFor();
  } finally {
    await page.context().close();
  }
});

async function phone(width = 390, height = 844) {
  const context = await browser.newContext({
    viewport: { width, height },
    isMobile: true,
    hasTouch: true,
    userAgent: CHROME_UA,
  });
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
