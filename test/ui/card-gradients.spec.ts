import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { openDb } from "../../src/db.js";
import { createNoopPushSender } from "../../src/push.js";
import { gradientClass } from "../../public/card-grad.js";
import { skipWhatsNew } from "./whats-new-seen.js";

const CHROME_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36";
const NOTES = ["Sushi night", "Board games", "Morning run", "Rooftop drinks", "Museum trip"];

let browser: Browser;
let baseUrl = "";
let closeServer: () => Promise<void> = async () => {};

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
  return text ? JSON.parse(text) : {};
}

function tomorrow(): string {
  return new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
}

async function phone(width: number, height: number, token: string): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width, height },
    isMobile: true,
    hasTouch: true,
    userAgent: CHROME_UA,
  });
  await skipWhatsNew(context);
  await context.addInitScript((value) => {
    localStorage.setItem("fn_token", value);
    localStorage.setItem("fn_install_later", String(Date.now()));
  }, token);
  await context.route("https://*.tile.openstreetmap.org/**", (route) => route.fulfill({ status: 204, body: "" }));
  return context.newPage();
}

async function dismiss(page: Page) {
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
}

/** plan id -> painted background of its card. */
async function backgrounds(page: Page): Promise<Record<string, { cls: string; image: string }>> {
  return page.evaluate(() => {
    const out: Record<string, { cls: string; image: string }> = {};
    for (const card of document.querySelectorAll<HTMLElement>(".card-plan[data-plan]")) {
      const bg = card.querySelector(".card-bg") as HTMLElement;
      out[card.dataset.plan || ""] = {
        cls: [...card.classList].find((name) => /^grad-\d+$/.test(name)) || "",
        image: getComputedStyle(bg).backgroundImage,
      };
    }
    return out;
  });
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

test("each plan card has its own gradient, kept after reload, on the map and in details", { timeout: 120_000 }, async () => {
  const host = await call("POST", "/api/auth/start", undefined, { name: "Hana" });
  const { circle } = await call("POST", "/api/circles", host.token, { name: "Friends" });
  const friend = await call("POST", "/api/auth/start", undefined, { name: "Finn", code: circle.inviteCode });
  const ids: string[] = [];
  for (const [n, note] of NOTES.entries()) {
    const body: Record<string, unknown> = { note, date: tomorrow(), time: `1${n}:30` };
    if (n === 0) Object.assign(body, { place: "Tempelhofer Feld", lat: 52.47, lng: 13.4, precise: true });
    ids.push((await call("POST", "/api/plans", host.token, body)).plan.id);
  }

  const page = await phone(360, 640, friend.token);
  try {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto(baseUrl);
    await dismiss(page);
    await page.locator(".card-plan").nth(NOTES.length - 1).waitFor();

    const first = await backgrounds(page);
    assert.deepEqual(Object.keys(first).sort(), [...ids].sort());
    for (const id of ids) {
      assert.equal(first[id].cls, gradientClass(id), `card ${id} uses its id's gradient`);
      assert.match(first[id].image, /linear-gradient/, `card ${id} paints a gradient`);
    }
    const distinct = new Set(Object.values(first).map((row) => row.image));
    assert.ok(distinct.size >= 3, `only ${distinct.size} distinct backgrounds for ${ids.length} plans`);

    // Text stays white on the card.
    const title = page.locator(".card-plan h3").first();
    assert.equal(await title.evaluate((node) => getComputedStyle(node).color), "rgb(255, 255, 255)");

    await page.reload();
    await dismiss(page);
    await page.locator(".card-plan").nth(NOTES.length - 1).waitFor();
    assert.deepEqual(await backgrounds(page), first, "same plan, same gradient after reload");

    // Light mode swaps to the lighter stops but keeps the same slot.
    await page.emulateMedia({ colorScheme: "light" });
    const light = await backgrounds(page);
    for (const id of ids) {
      assert.equal(light[id].cls, first[id].cls);
      assert.notEqual(light[id].image, first[id].image, `light stops differ for ${id}`);
    }
    await page.emulateMedia({ colorScheme: "dark" });

    // Details header uses the same gradient.
    await page.locator(`.card-plan[data-plan="${ids[1]}"] .card-body`).click();
    const head = page.locator(".sheet .sheet-head");
    await head.waitFor();
    assert.ok(await head.evaluate((node, cls) => node.classList.contains(cls), gradientClass(ids[1])));
    assert.equal(
      await head.evaluate((node) => getComputedStyle(node).backgroundImage),
      first[ids[1]].image,
    );
    await page.locator(".scrim").click({ position: { x: 10, y: 10 } });
    await head.waitFor({ state: "detached" });

    // Map card for the plan with a place.
    await page.locator(".tabbar").getByRole("button", { name: /^Map/ }).click();
    const pin = page.locator(".leaflet-marker-icon.pin").first();
    await pin.waitFor({ timeout: 10_000 });
    await page.waitForTimeout(400);
    await pin.click();
    const card = page.locator(".map-card");
    await card.waitFor();
    assert.ok(await card.evaluate((node, cls) => node.classList.contains(cls), gradientClass(ids[0])));
    assert.equal(await card.evaluate((node) => getComputedStyle(node).backgroundImage), first[ids[0]].image);
  } finally {
    await page.context().close();
  }
});
