import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { createApp } from "../../src/app.js";
import { flushChatNotices } from "../../src/chat.js";
import { loadConfig } from "../../src/config.js";
import { openDb } from "../../src/db.js";
import { createNoopPushSender } from "../../src/push.js";
import { skipWhatsNew } from "./whats-new-seen.js";

const UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36";
/** Screenshots go here. Override with CDS_SHOT_DIR=/some/folder. */
const SHOT_DIR = path.resolve(process.env.CDS_SHOT_DIR || ".oc/shots/circle-dot-sync");
/** 360 writes before.png / after.png; the other sizes add their size to the name. */
const SIZES = [[360, 640], [320, 568], [412, 915]] as const;

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
    await flushChatNotices(true);
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

async function call(method: string, pathname: string, token?: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${pathname} -> ${response.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function phone(width: number, height: number, token: string, circleId: string) {
  const context = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: UA, ...(process.env.CDS_VIDEO_DIR && width === 360 ? { recordVideo: { dir: process.env.CDS_VIDEO_DIR, size: { width, height } } } : {}) });
  await skipWhatsNew(context);
  await context.addInitScript(([value, circle]) => {
    if (sessionStorage.getItem("cds_seeded")) return;
    sessionStorage.setItem("cds_seeded", "1");
    localStorage.setItem("fn_install_later", String(Date.now()));
    localStorage.setItem("fn_token", value);
    localStorage.setItem("fn_circle", circle);
  }, [token, circleId]);
  await context.route("https://*.tile.openstreetmap.org/**", (route) => route.fulfill({ status: 204, body: "" }));
  return context.newPage();
}

async function dismiss(page: Page) {
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
}

async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const size = page.viewportSize()!;
  const file = size.width === 360 ? `${name}.png` : `${name}-${size.width}x${size.height}.png`;
  await page.screenshot({ path: path.join(SHOT_DIR, file) });
}

function bell(page: Page) {
  return page.locator(".screen-head .icon-btn[aria-label^='Alerts']");
}

function switchDot(page: Page) {
  return page.locator(".circle-switch-btn .unread-dot");
}

function menuDots(page: Page) {
  return page.locator(".circle-menu .unread-dot");
}

async function openMenu(page: Page) {
  if (await page.locator(".circle-menu").count()) return;
  await page.getByRole("button", { name: "Switch circle" }).click();
  await page.locator(".circle-menu").waitFor();
}

async function closeMenu(page: Page) {
  if (await page.locator(".circle-menu").count()) await page.getByRole("button", { name: "Switch circle" }).click();
}

for (const [width, height] of SIZES) {
  test(`at ${width}: reading Alerts clears the circle dot even with unread plan chat`, { timeout: 120_000 }, async () => {
    const home = `Home ${width}`;
    const uni = `Uni ${width}`;
    const finn = await call("POST", "/api/auth/start", undefined, { name: "Finn" });
    const a = (await call("POST", "/api/circles", finn.token, { name: home })).circle;
    const b = (await call("POST", "/api/circles", finn.token, { name: uni })).circle;
    const uma = await call("POST", "/api/auth/start", undefined, { name: "Uma", code: a.inviteCode });
    await call("POST", "/api/circles/join", uma.token, { code: b.inviteCode });
    await call("POST", `/api/notifications/read?circle=${a.id}`, uma.token);
    await call("POST", `/api/notifications/read?circle=${b.id}`, uma.token);

    // Finn makes a plan in Home, Uma is in, then Finn writes in the plan chat.
    const plan = (await call("POST", `/api/plans?circle=${a.id}`, finn.token, { note: "Pizza night", time: "19:30" })).plan;
    await call("POST", `/api/plans/${plan.id}/reply?circle=${a.id}`, uma.token, { reply: "in" });
    await call("POST", `/api/plans/${plan.id}/chat?circle=${a.id}`, finn.token, { text: "Table booked" });
    await flushChatNotices(true);

    const me = await call("GET", `/api/me?circle=${a.id}`, uma.token);
    assert.ok(me.circles.find((c: { id: string }) => c.id === a.id).alertUnread > 0);
    const chats = await call("GET", `/api/chats?circle=${a.id}`, uma.token);
    assert.ok((chats.unreadByCircle[a.id] || 0) > 0, JSON.stringify(chats.unreadByCircle));

    const page = await phone(width, height, uma.token, a.id);
    try {
      await page.goto(baseUrl);
      await dismiss(page);
      await switchDot(page).waitFor({ timeout: 10_000 });
      await bell(page).locator(".badge").waitFor();
      await openMenu(page);
      await page.locator(".circle-menu button", { hasText: home }).locator(".unread-dot").waitFor();
      await shot(page, "before");
      await closeMenu(page);

      // Open the bell: Home's alerts are marked read.
      const read = page.waitForResponse((r) => r.url().includes("/api/notifications/read") && r.request().method() === "POST");
      await bell(page).click();
      await read;
      await page.locator(".alert-card").first().waitFor();
      await bell(page).locator(".badge").waitFor({ state: "detached" });

      // The plan chat is still unread, but the circle dot follows Alerts only.
      await switchDot(page).waitFor({ state: "detached", timeout: 10_000 });
      await openMenu(page);
      assert.equal(await menuDots(page).count(), 0);
      await closeMenu(page);
      const after = await call("GET", `/api/me?circle=${a.id}`, uma.token);
      assert.deepEqual(after.circles.map((c: { alertUnread: number }) => c.alertUnread), [0, 0]);
      const still = await call("GET", `/api/chats?circle=${a.id}`, uma.token);
      assert.ok((still.unreadByCircle[a.id] || 0) > 0, "plan chat should still be unread");

      // A reload keeps it gone.
      await page.reload();
      await dismiss(page);
      await page.getByRole("button", { name: "Switch circle" }).waitFor();
      await bell(page).waitFor();
      // Give the fresh /api/me, /api/notifications and /api/chats a moment to land.
      await page.waitForLoadState("networkidle");
      assert.equal(await switchDot(page).count(), 0);
      assert.equal(await bell(page).locator(".badge").count(), 0);
      await openMenu(page);
      assert.equal(await menuDots(page).count(), 0);
      await shot(page, "after");
    } finally {
      await page.context().close();
    }
  });
}
