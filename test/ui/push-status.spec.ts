import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { openDb } from "../../src/db.js";
import type { PushPayload, PushSender, PushSubscription } from "../../src/push.js";

let browser: Browser;
let baseUrl = "";
let closeServer: () => Promise<void> = async () => {};
const sent: Array<{ endpoint: string; payload: PushPayload }> = [];

test.before(async () => {
  const db = openDb(":memory:");
  const config = loadConfig({ PORT: "3000", DB_PATH: ":memory:", APP_TZ: "UTC" });
  const push: PushSender = {
    async send(subscription: PushSubscription, payload: PushPayload) {
      sent.push({ endpoint: subscription.endpoint, payload });
    },
  };
  const server = http.createServer(createApp({
    db,
    push,
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

test("the host opens a delivery sheet and a friend does not see it", { timeout: 90_000 }, async () => {
  const alex = await post("/api/auth/start", { name: "Alex" });
  const circle = await post("/api/circles", { name: "friends" }, alex.token);
  const code = circle.circle.inviteCode as string;
  const bea = await post("/api/auth/start", { name: "Bea", code });
  const cam = await post("/api/auth/start", { name: "Cam", code });
  const dana = await post("/api/auth/start", { name: "Dana", code });
  await post("/api/push/subscribe", {
    endpoint: "https://push.example/bea",
    keys: { p256dh: "p", auth: "a" },
  }, bea.token);
  await post("/api/me/display", { standalone: false }, cam.token);
  await post("/api/me/display", { standalone: false }, alex.token);
  sent.length = 0;
  await post("/api/socials", { note: "Coffee" }, alex.token);
  await post("/api/plans", { note: "Dinner" }, alex.token);
  const social = sent.find((item) => item.payload.tag.startsWith("social:"));
  assert.ok(social?.payload.id);
  const acked = await fetch(`${baseUrl}/api/push/ack`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: social?.payload.id }),
  });
  assert.equal(acked.status, 204);

  const host = await openAs(alex.token);
  const errors: string[] = [];
  host.on("pageerror", (error) => errors.push(String(error)));
  try {
    await host.getByRole("button", { name: "Delivered to 1 of 3" }).click();
    const sheet = host.getByRole("dialog", { name: "Push delivery" });
    await sheet.getByText("Delivered", { exact: true }).waitFor();
    await sheet.getByText("Bea", { exact: true }).waitFor();
    await sheet.getByText("Not installed", { exact: true }).waitFor();
    await sheet.getByText("Notifications off", { exact: true }).waitFor();
    await sheet.getByText("Cam", { exact: true }).waitFor();
    await sheet.getByText("Dana", { exact: true }).waitFor();
    await host.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });

    await host.getByRole("button", { name: "Delivered to 0 of 3" }).click();
    const plan = host.getByRole("dialog", { name: "Push delivery" });
    await plan.getByText("Sent, not confirmed", { exact: true }).waitFor();
    await plan.getByText("Bea", { exact: true }).waitFor();
    await host.keyboard.press("Escape");

    await host.getByRole("button", { name: "Circle", exact: true }).click();
    await host.locator(".member-row", { hasText: "Bea" }).getByText("Notifications on").waitFor();
    await host.locator(".member-row", { hasText: "Cam" }).getByText("Not installed").waitFor();
    await host.locator(".member-row", { hasText: "Dana" }).getByText("Notifications off").waitFor();
    await host.locator(".member-row", { hasText: "Alex" }).getByText("Not installed").waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await host.context().close();
  }

  const friend = await openAs(bea.token);
  try {
    await friend.getByText("Coffee", { exact: true }).waitFor();
    assert.equal(await friend.getByRole("button", { name: /Delivered to/ }).count(), 0);
    await friend.getByRole("button", { name: "Circle", exact: true }).click();
    await friend.locator(".member-row", { hasText: "Cam" }).getByText("Not installed").waitFor();
  } finally {
    await friend.context().close();
  }
});

async function post(pathname: string, body: unknown, token?: string) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (response.status >= 400) throw new Error(`${pathname} -> ${response.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function openAs(token: string): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: 360, height: 640 },
    isMobile: true,
    hasTouch: true,
    userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36",
  });
  await context.addInitScript((value) => {
    localStorage.setItem("fn_token", value);
    localStorage.setItem("fn_install_later", String(Date.now()));
  }, token);
  const page = await context.newPage();
  await page.goto(baseUrl);
  return page;
}
