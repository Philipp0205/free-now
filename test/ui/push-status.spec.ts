import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { openDb } from "../../src/db.js";
import type { PushPayload, PushSender, PushSubscription } from "../../src/push.js";
import { skipWhatsNew } from "./whats-new-seen.js";

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
    await host.locator(".card-now, .card-plan").filter({ hasText: "Coffee" }).getByRole("button", { name: "Open details" }).click();
    await host.getByRole("dialog", { name: "Details" }).getByRole("button", { name: "Delivered to 1 of 3" }).click();
    const sheet = host.getByRole("dialog", { name: "Push delivery" });
    await sheet.getByText("Delivered", { exact: true }).waitFor();
    await sheet.getByText("Bea", { exact: true }).waitFor();
    await sheet.getByText("Not installed", { exact: true }).waitFor();
    await sheet.getByText("Notifications off", { exact: true }).waitFor();
    await sheet.getByText("Cam", { exact: true }).waitFor();
    await sheet.getByText("Dana", { exact: true }).waitFor();
    await host.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });

    await host.keyboard.press("Escape");
    await host.locator(".card-plan").filter({ hasText: "Dinner" }).getByRole("button", { name: "Open details" }).click();
    await host.getByRole("dialog", { name: "Details" }).getByRole("button", { name: "Delivered to 0 of 3" }).click();
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

/** A host and `count` friends, each with notifications on, plus one social. Returns the delivery row id per friend name. */
async function crowd(count: number, note: string) {
  const host = await post("/api/auth/start", { name: "Host" });
  const circle = await post("/api/circles", { name: "big" }, host.token);
  const code = circle.circle.inviteCode as string;
  const names: string[] = [];
  for (let i = 1; i <= count; i += 1) {
    const name = `Friend ${String(i).padStart(2, "0")}`;
    const friend = await post("/api/auth/start", { name, code });
    await post("/api/push/subscribe", {
      endpoint: `https://push.example/${note}-${i}`,
      keys: { p256dh: "p", auth: "a" },
    }, friend.token);
    names.push(name);
  }
  sent.length = 0;
  await post("/api/socials", { note }, host.token);
  const ids = new Map<string, string>();
  names.forEach((name, index) => {
    const row = sent.find((item) => item.endpoint === `https://push.example/${note}-${index + 1}`);
    if (row?.payload.id) ids.set(name, row.payload.id);
  });
  return { host, names, ids };
}

async function ack(id: string) {
  const response = await fetch(`${baseUrl}/api/push/ack`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  });
  assert.equal(response.status, 204);
}

for (const viewport of [{ width: 320, height: 568 }, { width: 360, height: 640 }, { width: 412, height: 915 }]) {
  test(`the push list scrolls to the last friend at ${viewport.width}x${viewport.height} and the head stays put`, { timeout: 90_000 }, async () => {
    const note = `Crowd${viewport.width}`;
    const { host, names } = await crowd(16, note);
    const page = await openAs(host.token, viewport);
    try {
      await page.getByRole("button", { name: "Open details" }).first().click();
      const line = page.getByRole("dialog", { name: "Details" }).getByRole("button", { name: "Delivered to 0 of 16" });
      const card = page.locator("article", { has: line });
      const lineBox = await line.boundingBox();
      const chipBox = await card.getByRole("button", { name: "Chat" }).boundingBox();
      assert.ok(lineBox && chipBox);
      assert.ok(lineBox.y + lineBox.height <= chipBox.y + 0.5, "the delivery line sits above the Chat chip, not beside it");
      await line.click();
      const sheet = page.getByRole("dialog", { name: "Push delivery" });
      const list = sheet.locator(".sheet-scroll");
      const last = sheet.locator(".row", { hasText: names[names.length - 1] });
      await last.waitFor();
      await page.waitForTimeout(400);
      const head = sheet.locator(".sheet-head");
      const headBefore = await head.boundingBox();
      const sheetBox = await sheet.boundingBox();
      assert.ok(headBefore && sheetBox);
      await sheet.getByText(`${note} · Delivered to 0 of 16`).waitFor();

      const metrics = await list.evaluate((node) => ({ scroll: node.scrollHeight, client: node.clientHeight }));
      assert.ok(metrics.scroll > metrics.client, `list should overflow at ${viewport.width}x${viewport.height}`);

      const box = await list.boundingBox();
      assert.ok(box);
      await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 60));
      for (let i = 0; i < 8; i += 1) {
        await page.mouse.wheel(0, 400);
        await page.waitForTimeout(60);
      }
      await page.waitForFunction(() => {
        const node = document.querySelector(".sheet .sheet-scroll");
        return Boolean(node && node.scrollTop + node.clientHeight >= node.scrollHeight - 1);
      });

      const lastBox = await last.boundingBox();
      const listBox = await list.boundingBox();
      assert.ok(lastBox && listBox);
      assert.ok(lastBox.y >= 0 && lastBox.y + lastBox.height <= viewport.height + 0.5, "last row inside the viewport");
      assert.ok(lastBox.y + lastBox.height <= listBox.y + listBox.height + 0.5, "last row not clipped by the list");
      assert.ok(lastBox.y >= listBox.y - 0.5, "last row below the head");

      const headAfter = await head.boundingBox();
      assert.ok(headAfter);
      assert.ok(Math.abs(headAfter.y - headBefore.y) <= 0.5, "head stays pinned");
      assert.ok(headAfter.y - sheetBox.y <= 12, "head sits at the top of the sheet");
      await head.getByRole("heading", { name: "Push" }).waitFor();
      assert.ok(await head.getByText(`${note} · Delivered to 0 of 16`).isVisible());
      assert.ok(await page.evaluate(() => (document.scrollingElement?.scrollTop ?? 0) === 0));
    } finally {
      await page.context().close();
    }
  });
}

test("an open push sheet updates when a friend acks, without reopening", { timeout: 90_000 }, async () => {
  const { host, names, ids } = await crowd(16, "Live");
  const page = await openAs(host.token, { width: 320, height: 568 });
  try {
    await page.getByRole("button", { name: "Open details" }).first().click();
    await page.getByRole("dialog", { name: "Details" }).getByRole("button", { name: "Delivered to 0 of 16" }).click();
    const sheet = page.getByRole("dialog", { name: "Push delivery" });
    const target = names[names.length - 1];
    const row = sheet.locator(".row", { hasText: target });
    await row.getByText("Sent, not confirmed", { exact: true }).waitFor();
    const list = sheet.locator(".sheet-scroll");
    await list.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    const scrolled = await list.evaluate((node) => node.scrollTop);
    assert.ok(scrolled > 0);

    await ack(ids.get(target) ?? "");
    await sheet.getByText("Live · Delivered to 1 of 16", { exact: true }).waitFor({ timeout: 10_000 });
    await row.getByText("Delivered", { exact: true }).waitFor();
    assert.equal(await sheet.isVisible(), true);
    const after = await list.evaluate((node) => node.scrollTop);
    assert.ok(Math.abs(after - scrolled) <= 1, `scroll kept (${scrolled} -> ${after})`);

    await ack(ids.get(names[0]) ?? "");
    await sheet.getByText("Live · Delivered to 2 of 16", { exact: true }).waitFor({ timeout: 10_000 });
    await page.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Open details" }).first().click();
    await page.getByRole("dialog", { name: "Details" }).getByRole("button", { name: "Delivered to 2 of 16" }).waitFor();
  } finally {
    await page.context().close();
  }
});

test("a friend with notifications on but no push for this event says so", { timeout: 90_000 }, async () => {
  const { host } = await crowd(1, "Early");
  const circle = (await get("/api/me", host.token)).circle;
  const late = await post("/api/auth/start", { name: "Late", code: circle.inviteCode });
  await post("/api/push/subscribe", { endpoint: "https://push.example/late", keys: { p256dh: "p", auth: "a" } }, late.token);
  const page = await openAs(host.token);
  try {
    await page.getByRole("button", { name: "Open details" }).first().click();
    await page.getByRole("dialog", { name: "Details" }).getByRole("button", { name: "Delivered to 0 of 2" }).click();
    const sheet = page.getByRole("dialog", { name: "Push delivery" });
    await sheet.locator(".row", { hasText: "Late" }).getByText("Notifications on · not sent for this event", { exact: true }).waitFor();
    await sheet.locator(".row", { hasText: "Friend 01" }).getByText("Sent, not confirmed", { exact: true }).waitFor();
  } finally {
    await page.context().close();
  }
});

test("a sheet opened from a plan card refreshes live and survives the plan ending", { timeout: 90_000 }, async () => {
  const host = await post("/api/auth/start", { name: "Planner" });
  const circle = await post("/api/circles", { name: "plans" }, host.token);
  const code = circle.circle.inviteCode as string;
  const ids: string[] = [];
  for (const name of ["Pia", "Quinn"]) {
    const friend = await post("/api/auth/start", { name, code });
    await post("/api/push/subscribe", { endpoint: `https://push.example/plan-${name}`, keys: { p256dh: "p", auth: "a" } }, friend.token);
  }
  sent.length = 0;
  const plan = await post("/api/plans", { note: "Picnic" }, host.token);
  for (const name of ["Pia", "Quinn"]) {
    const row = sent.find((item) => item.endpoint === `https://push.example/plan-${name}`);
    ids.push(row?.payload.id ?? "");
  }
  const page = await openAs(host.token);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  try {
    await page.getByRole("button", { name: "Open details" }).first().click();
    await page.getByRole("dialog", { name: "Details" }).getByRole("button", { name: "Delivered to 0 of 2" }).click();
    const sheet = page.getByRole("dialog", { name: "Push delivery" });
    await sheet.getByText("Picnic · Delivered to 0 of 2", { exact: true }).waitFor();
    await ack(ids[0]);
    await sheet.getByText("Picnic · Delivered to 1 of 2", { exact: true }).waitFor({ timeout: 10_000 });
    await sheet.locator(".row", { hasText: "Pia" }).getByText("Delivered", { exact: true }).waitFor();

    const ended = await fetch(`${baseUrl}/api/plans/${plan.plan.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${host.token}` },
    });
    assert.equal(ended.status, 204);
    // Two polls that no longer list the plan, then let the client handle them.
    for (let i = 0; i < 2; i += 1) {
      await page.waitForResponse(async (response) => {
        if (new URL(response.url()).pathname !== "/api/plans") return false;
        const body = await response.json().catch(() => null);
        return Array.isArray(body?.plans) && !body.plans.some((item: { id: string }) => item.id === plan.plan.id);
      }, { timeout: 10_000 });
    }
    await page.waitForTimeout(300);
    assert.equal(await sheet.isVisible(), true);
    await sheet.getByText("Picnic · Delivered to 1 of 2", { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    await page.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
    assert.equal(await page.getByRole("button", { name: /Delivered to/ }).count(), 0);
  } finally {
    await page.context().close();
  }
});

async function get(pathname: string, token: string) {
  const response = await fetch(`${baseUrl}${pathname}`, { headers: { authorization: `Bearer ${token}` } });
  return response.json();
}

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

async function openAs(token: string, viewport = { width: 360, height: 640 }): Promise<Page> {
  const context = await browser.newContext({
    viewport,
    isMobile: true,
    hasTouch: true,
    userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36",
  });
  await skipWhatsNew(context);
  await context.addInitScript((value) => {
    localStorage.setItem("fn_token", value);
    localStorage.setItem("fn_install_later", String(Date.now()));
  }, token);
  const page = await context.newPage();
  await page.goto(baseUrl);
  return page;
}
