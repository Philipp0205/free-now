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
import { createNoopPushSender } from "../../src/push.js";
import { skipWhatsNew } from "./whats-new-seen.js";

const SHOT_DIR = process.env.HANG_SHOT_DIR || "/workspace/hangry-shots/card-a";
const SIZES: Array<[number, number]> = [[320, 568], [360, 640], [412, 915]];
const CHROME_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36";

let browser: Browser;
let baseUrl = "";
let closeServer: () => Promise<void> = async () => {};

function shot(name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  return path.join(SHOT_DIR, name);
}

async function call(method: string, urlPath: string, token?: string, body?: Record<string, unknown>) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  assert.ok(res.ok, `${method} ${urlPath} -> ${res.status} ${text}`);
  if (res.status === 204 || !text) return {};
  return JSON.parse(text);
}

async function people() {
  const host = await call("POST", "/api/auth/start", undefined, { name: "Hana" });
  const { circle } = await call("POST", "/api/circles", host.token, { name: "Friends" });
  const friend = await call("POST", "/api/auth/start", undefined, { name: "Finn", code: circle.inviteCode });
  return { host, friend, circle };
}

async function phone(width: number, height: number) {
  const context = await browser.newContext({
    viewport: { width, height },
    isMobile: true,
    hasTouch: true,
    userAgent: CHROME_UA,
  });
  await skipWhatsNew(context);
  await context.route("https://*.tile.openstreetmap.org/**", (route) => route.fulfill({ status: 204, body: "" }));
  return context.newPage();
}

async function asUser(page: Page, token: string) {
  await page.goto(`${baseUrl}/robots.txt`);
  await page.evaluate((value) => {
    localStorage.clear();
    localStorage.setItem("fn_token", value);
    localStorage.setItem("fn_install_later", String(Date.now()));
  }, token);
}

async function dismiss(page: Page) {
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
}

async function noOverlap(page: Page, root: string) {
  return page.evaluate((sel) => {
    const card = document.querySelector(sel) as HTMLElement | null;
    if (!card) return ["missing card"];
    const box = card.getBoundingClientRect();
    const nodes = [...card.querySelectorAll(".in-toggle, .chat-row, .card-more, .card-menu")];
    const out: string[] = [];
    for (const node of nodes) {
      const r = node.getBoundingClientRect();
      if (r.left < box.left - 1 || r.right > box.right + 1) out.push(`outside:${node.className}`);
      if (r.height < 43.5 && !node.className.includes("card-menu")) out.push(`short:${node.className}:${r.height}`);
    }
    const menu = card.querySelector(".card-menu");
    if (menu) {
      const r = menu.getBoundingClientRect();
      if (r.left < -1 || r.right > window.innerWidth + 1 || r.bottom > window.innerHeight + 1) {
        out.push(`menu-clipped:${r.left},${r.right},${r.bottom}/${window.innerWidth}x${window.innerHeight}`);
      }
    }
    return out;
  }, root);
}

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

test("friend toggles I'm in and undoes; host stays In ✓; overflow actions work", { timeout: 180_000 }, async () => {
  const { host, friend } = await people();
  await call("POST", "/api/plans", host.token, {
    note: "Rooftop drinks",
    time: "19:30",
    place: "Secret Garden Bar",
    lat: 52.5,
    lng: 13.42,
    description: "Meet at the side door.",
  });

  // Full interaction once at 360, then layout checks at every size.
  {
    const page = await phone(360, 640);
    try {
      await asUser(page, friend.token);
      await page.goto(baseUrl);
      await dismiss(page);
      const card = page.locator(".card-plan", { hasText: "Rooftop drinks" });
      await card.locator(".in-toggle").waitFor();
      assert.match(await card.locator(".in-toggle").innerText(), /I'm in/);
      await card.locator(".in-toggle").click();
      await card.locator(".in-toggle.on").waitFor();
      assert.match(await card.locator(".in-toggle").innerText(), /In ✓/);
      await page.screenshot({ path: shot("friend-in-w360.png") });
      await card.locator(".in-toggle.on").click();
      await card.locator(".in-toggle:not(.on)").waitFor();
      await card.locator(".in-toggle").click();
      await card.locator(".in-toggle.on").waitFor();

      await card.locator(".card-more").click();
      const menu = page.getByRole("menu");
      await menu.getByRole("menuitem", { name: "Share link" }).waitFor();
      await menu.getByRole("menuitem", { name: "Pick arrival time" }).waitFor();
      await menu.getByRole("menuitem", { name: "Can't make it" }).waitFor();
      await menu.getByRole("menuitem", { name: "Open in Maps" }).waitFor();
      assert.equal(await menu.getByRole("menuitem", { name: "Edit" }).count(), 0);
      assert.equal(await menu.getByRole("menuitem", { name: "End plan" }).count(), 0);
      await page.screenshot({ path: shot("friend-menu-w360.png") });
      assert.deepEqual(await noOverlap(page, ".card-plan"), []);
      await menu.getByRole("menuitem", { name: "Can't make it" }).click();
      await card.locator(".in-toggle:not(.on)").waitFor();

      await card.locator(".card-more").click();
      await menu.getByRole("menuitem", { name: "Pick arrival time" }).click();
      await page.getByRole("dialog", { name: "Pick arrival" }).waitFor();
      await page.locator("#arrival-time").fill("20:15");
      await page.getByRole("button", { name: "Save" }).click();
      await card.locator(".in-toggle.on").waitFor();
      await page.getByText(/arriving 20:15/i).waitFor();

      await card.locator(".card-more").click();
      await menu.getByRole("menuitem", { name: "Share link" }).click();
    } finally {
      await page.context().close();
    }
  }

  for (const [width, height] of SIZES) {
    const page = await phone(width, height);
    try {
      await asUser(page, friend.token);
      await page.goto(baseUrl);
      await dismiss(page);
      const card = page.locator(".card-plan", { hasText: "Rooftop drinks" });
      await card.locator(".in-toggle.on").waitFor();
      await card.locator(".card-more").click();
      await page.getByRole("menu").waitFor();
      await page.screenshot({ path: shot(`friend-layout-w${width}.png`) });
      assert.deepEqual(await noOverlap(page, ".card-plan"), []);
    } finally {
      await page.context().close();
    }
  }

  const hostPage = await phone(360, 640);
  try {
    await asUser(hostPage, host.token);
    await hostPage.goto(baseUrl);
    await dismiss(hostPage);
    const card = hostPage.locator(".card-plan", { hasText: "Rooftop drinks" });
    await card.locator(".in-toggle.on").waitFor();
    assert.equal(await card.locator(".in-toggle.on").isDisabled(), true);
    await hostPage.screenshot({ path: shot("host-in-w360.png") });
    await card.locator(".card-more").click();
    const menu = hostPage.getByRole("menu");
    await menu.getByRole("menuitem", { name: "Share link" }).waitFor();
    await menu.getByRole("menuitem", { name: "Edit" }).waitFor();
    await menu.getByRole("menuitem", { name: "End plan" }).waitFor();
    assert.equal(await menu.getByRole("menuitem", { name: "Can't make it" }).count(), 0);
    await hostPage.screenshot({ path: shot("host-menu-w360.png") });
    await menu.getByRole("menuitem", { name: "Edit" }).click();
    await hostPage.getByRole("dialog", { name: "Edit" }).waitFor();
    await hostPage.keyboard.press("Escape");
    await card.locator(".card-more").click();
    await hostPage.getByRole("menuitem", { name: "End plan" }).click();
    await hostPage.locator(".sheet-confirm").waitFor();
    await hostPage.locator(".sheet-confirm").getByRole("button", { name: "Cancel" }).click();
  } finally {
    await hostPage.context().close();
  }
});

test("chat row opens chat with badge; card body opens details with Remove and Delivered", { timeout: 120_000 }, async () => {
  const { host, friend } = await people();
  const plan = (await call("POST", "/api/plans", host.token, { note: "Board games", time: "18:00" })).plan;
  await call("POST", `/api/plans/${plan.id}/reply`, friend.token, { reply: "in" });
  await call("POST", `/api/plans/${plan.id}/chat`, friend.token, { text: "Bring speakers?" });

  const chats = await call("GET", "/api/chats", host.token);
  const event = (chats.events || []).find((row: any) => row.id === plan.id);
  assert.ok(event && event.unread > 0, `expected unread chat summary, got ${JSON.stringify(chats)}`);

  for (const [width, height] of SIZES) {
    // Opening the chat at the previous width marks it read; give each width fresh unread.
    if (width !== SIZES[0][0]) await call("POST", `/api/plans/${plan.id}/chat`, friend.token, { text: "Bring speakers?" });
    const page = await phone(width, height);
    try {
      await asUser(page, host.token);
      await page.goto(baseUrl);
      await dismiss(page);
      const card = page.locator(".card-plan", { hasText: "Board games" });
      await card.locator(".chat-row .badge").waitFor({ timeout: 10_000 });
      await page.screenshot({ path: shot(`chat-row-w${width}.png`) });
      await card.locator(".chat-row").click();
      await page.getByRole("heading", { name: "Board games" }).waitFor();
      await page.getByText("Bring speakers?").first().waitFor();
      await page.getByRole("button", { name: "Back" }).click();

      await card.getByRole("button", { name: "Open details" }).click();
      const details = page.getByRole("dialog", { name: "Details" });
      await details.waitFor();
      await details.getByText("Who's in").waitFor();
      await details.getByRole("button", { name: "Remove Finn" }).waitFor();
      if (await details.getByRole("button", { name: /Delivered to/ }).count()) {
        await details.getByRole("button", { name: /Delivered to/ }).click();
        await page.getByRole("dialog", { name: "Push delivery" }).waitFor();
        await page.keyboard.press("Escape");
      }
      await page.screenshot({ path: shot(`details-w${width}.png`) });
      await page.keyboard.press("Escape");
      assert.deepEqual(await noOverlap(page, `.card-plan[data-plan="${plan.id}"]`), []);
    } finally {
      await page.context().close();
    }
  }
});

test("map card has the In toggle and ⋯ menu, and the menu stays on screen", { timeout: 120_000 }, async () => {
  const { host, friend } = await people();
  await call("POST", "/api/plans", host.token, {
    note: "Picnic",
    time: "17:00",
    place: "Tempelhofer Feld",
    lat: 52.47,
    lng: 13.4,
    precise: true,
  });

  for (const [width, height] of SIZES) {
    const page = await phone(width, height);
    try {
      await asUser(page, friend.token);
      await page.goto(baseUrl);
      await dismiss(page);
      await page.locator(".tabbar").getByRole("button", { name: /^Map/ }).click();
      const pin = page.locator(".leaflet-marker-icon.pin").first();
      await pin.waitFor({ timeout: 10_000 });
      await page.waitForTimeout(400);
      await pin.click();
      const card = page.locator(".map-card");
      await card.waitFor();
      const toggle = card.locator(".in-toggle");
      if (width === SIZES[0][0]) {
        await toggle.click();
        await card.locator(".in-toggle.on").waitFor();
      }
      await card.locator(".in-toggle.on").waitFor();
      await page.screenshot({ path: shot(`map-card-w${width}.png`) });
      await card.locator(".card-more").click();
      const menu = page.getByRole("menu");
      await menu.getByRole("menuitem", { name: "Can't make it" }).waitFor();
      assert.equal(await menu.getByRole("menuitem", { name: "Edit", exact: true }).count(), 0);
      assert.equal(await menu.getByRole("menuitem", { name: "Open in Maps" }).count(), 0, "map ⋯ has no duplicate Open in Maps");
      assert.equal(await card.getByRole("link", { name: "Open in Maps" }).count(), 1, "quiet Open in Maps stays on the map card");
      await page.screenshot({ path: shot(width === 360 ? "map-menu-after-w360.png" : `map-menu-w${width}.png`) });
      assert.deepEqual(await noOverlap(page, ".map-card"), []);
    } finally {
      await page.context().close();
    }
  }
});

test("a plan shared with two circles shows Friends + Climbing on the redesigned card", { timeout: 90_000 }, async () => {
  const { host, circle } = await people();
  const climbing = (await call("POST", "/api/circles", host.token, { name: "Climbing" })).circle;
  const plan = (await call("POST", `/api/plans?circle=${circle.id}`, host.token, { note: "Crag day", time: "10:00" })).plan;
  await call("PATCH", `/api/plans/${plan.id}?circle=${circle.id}`, host.token, { circleIds: [circle.id, climbing.id] });

  for (const [width, height] of SIZES) {
    const page = await phone(width, height);
    try {
      await asUser(page, host.token);
      await page.evaluate((id) => localStorage.setItem("fn_circle", id), circle.id);
      await page.goto(baseUrl);
      await dismiss(page);
      const card = page.locator(".card-plan", { hasText: "Crag day" });
      await card.locator(".card-body .plan-circles").waitFor();
      assert.equal((await card.locator(".plan-circles").innerText()).trim(), "Friends + Climbing");
      await card.locator(".in-toggle.on").waitFor();
      if (width === 360) await page.screenshot({ path: shot("multi-circle-w360.png") });
      assert.deepEqual(await noOverlap(page, ".card-plan"), []);
    } finally {
      await page.context().close();
    }
  }
});

test("Android Back closes the ⋯ menu and the Details sheet, and stays on home", { timeout: 90_000 }, async () => {
  const { host, friend } = await people();
  await call("POST", "/api/plans", host.token, { note: "Back test", time: "20:00" });
  const page = await phone(360, 640);
  try {
    await asUser(page, friend.token);
    await page.goto(baseUrl);
    await dismiss(page);
    const card = page.locator(".card-plan", { hasText: "Back test" });
    await card.locator(".in-toggle").waitFor();
    const home = page.url();

    await card.locator(".card-more").click();
    await page.getByRole("menu").waitFor();
    await page.evaluate(() => history.back());
    await page.getByRole("menu").waitFor({ state: "detached" });
    await card.locator(".in-toggle").waitFor();
    assert.equal(page.url(), home);
    assert.equal(await page.locator(".tabbar").isVisible(), true);

    await card.getByRole("button", { name: "Open details" }).click();
    const details = page.getByRole("dialog", { name: "Details" });
    await details.waitFor();
    await page.evaluate(() => history.back());
    await details.waitFor({ state: "detached" });
    await card.locator(".in-toggle").waitFor();
    assert.equal(page.url(), home);
  } finally {
    await page.context().close();
  }
});
