import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Locator, Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { UA as CHROME_UA, openEventsMap, useHangry } from "./harness.js";

const SHOT_DIR = process.env.HANG_SHOT_DIR || "/workspace/hangry-shots/waiting-tap/after";
const SIZES: Array<[number, number]> = [[360, 740], [390, 844]];

const hangry = useHangry({ tz: "UTC" });

function shot(name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  return path.join(SHOT_DIR, name);
}

async function call(method: string, urlPath: string, token?: string, body?: Record<string, unknown>) {
  const res = await fetch(`${hangry.baseUrl}${urlPath}`, {
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

async function phone(width: number, height: number, colorScheme: "light" | "dark" = "light") {
  const context = await hangry.browser.newContext({
    viewport: { width, height },
    isMobile: true,
    hasTouch: true,
    userAgent: CHROME_UA,
    colorScheme,
  });
  await skipWhatsNew(context);
  await context.route("https://*.tile.openstreetmap.org/**", (route) => route.fulfill({ status: 204, body: "" }));
  return context.newPage();
}

async function asUser(page: Page, token: string) {
  await page.goto(`${hangry.baseUrl}/robots.txt`);
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

async function onMap(page: Page) {
  const mapTab = page.locator(".tabbar .tab[aria-label='Events']");
  const current = await mapTab.getAttribute("aria-current");
  return current === "page" || (await page.locator(".map-screen").count()) > 0;
}

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  assert.ok(b, "element has a box");
  return b;
}

/** Taps a 3x3 grid across the who row; every tap opens details and none reaches the map. */
async function tapGrid(page: Page, card: Locator, width: number) {
  const who = card.locator(".who-row");
  const copy = await box(card.locator(".card-copy"));
  const row = await box(who);
  assert.ok(row.height >= 44, `who row is ${row.height}px tall at w${width}`);
  // Full width of the card copy (minus its 16px padding on each side).
  assert.ok(row.width >= copy.width - 32 - 2, `who row is ${row.width}px wide, copy ${copy.width}px at w${width}`);

  const home = page.url();
  const xs = [row.x + 3, row.x + row.width / 2, row.x + row.width - 3];
  const ys = [row.y + 2, row.y + row.height / 2, row.y + row.height - 2];
  let n = 0;
  for (const y of ys) {
    for (const x of xs) {
      if (n++ % 2 === 0) await page.touchscreen.tap(x, y);
      else await page.mouse.click(x, y);
      const details = page.getByRole("dialog", { name: "Details" });
      await details.waitFor({ timeout: 5000 });
      assert.equal(await onMap(page), false, `tap at ${Math.round(x)},${Math.round(y)} opened the map (w${width})`);
      await page.keyboard.press("Escape");
      await details.waitFor({ state: "detached" });
      assert.equal(await onMap(page), false);
      assert.equal(page.url(), home);
    }
  }
}

async function separated(card: Locator, width: number) {
  const row = await box(card.locator(".who-row"));
  const place = await box(card.locator("button.place-line"));
  const gap = place.y >= row.y ? place.y - (row.y + row.height) : row.y - (place.y + place.height);
  assert.ok(gap >= 8, `who row and place line are ${gap}px apart at w${width}`);
  assert.ok(place.height >= 44, `place line is ${place.height}px tall`);
  assert.ok(place.width < row.width - 40, `place line hugs its text (${place.width}px vs row ${row.width}px)`);
}

test("tapping Waiting for friends on an empty plan opens details, never the map", { timeout: 180_000 }, async () => {
  const { host } = await people();
  await call("POST", "/api/plans", host.token, {
    note: "Rooftop drinks",
    time: "19:30",
    place: "Secret Garden Bar",
    lat: 52.5,
    lng: 13.42,
  });

  for (const [width, height] of SIZES) {
    for (const scheme of ["light", "dark"] as const) {
      const page = await phone(width, height, scheme);
      try {
        await asUser(page, host.token);
        await page.goto(hangry.baseUrl);
        await dismiss(page);
        const card = page.locator(".card-plan", { hasText: "Rooftop drinks" });
        await card.locator(".who-row", { hasText: "Waiting for friends" }).waitFor();
        await page.screenshot({ path: shot(`card-${scheme}-w${width}.png`) });
        await separated(card, width);
        if (scheme === "light") {
          await tapGrid(page, card, width);
          await card.locator("button.place-line").click();
          await page.locator(".map-screen").waitFor();
          assert.equal(await onMap(page), true, "place line still opens the map");
        }
      } finally {
        await page.context().close();
      }
    }
  }
});

test("tapping Waiting for friends on an empty free-now opens details, never the map", { timeout: 180_000 }, async () => {
  const { friend } = await people();
  await call("POST", "/api/socials", friend.token, { note: "Coffee", place: "Schlossplatz", lat: 48.7784, lng: 9.18 });

  for (const [width, height] of SIZES) {
    const page = await phone(width, height);
    try {
      await asUser(page, friend.token);
      await page.goto(hangry.baseUrl);
      await dismiss(page);
      const card = page.locator(".card-now", { hasText: "Coffee" });
      await card.locator(".who-row", { hasText: "Waiting for friends" }).waitFor();
      await page.screenshot({ path: shot(`social-light-w${width}.png`) });
      await separated(card, width);
      await tapGrid(page, card, width);
      await card.locator("button.place-line").click();
      await page.locator(".map-screen").waitFor();
      assert.equal(await onMap(page), true, "place line still opens the map");
    } finally {
      await page.context().close();
    }
  }
});

test("with people in, the who row lists them and still opens details", { timeout: 90_000 }, async () => {
  const { host, friend } = await people();
  const { plan } = await call("POST", "/api/plans", host.token, {
    note: "Board games",
    time: "18:00",
    place: "Spielwiese",
    lat: 52.51,
    lng: 13.41,
  });
  await call("POST", `/api/plans/${plan.id}/reply`, friend.token, { reply: "in" });

  const page = await phone(360, 740);
  try {
    await asUser(page, host.token);
    await page.goto(hangry.baseUrl);
    await dismiss(page);
    const card = page.locator(".card-plan", { hasText: "Board games" });
    const who = card.locator(".who-row", { hasText: "Finn is in" });
    await who.waitFor();
    await separated(card, 360);
    await page.screenshot({ path: shot("card-with-people-w360.png") });
    await who.tap();
    const details = page.getByRole("dialog", { name: "Details" });
    await details.waitFor();
    await details.getByRole("button", { name: "Remove Finn" }).waitFor();
    assert.equal(await onMap(page), false);
  } finally {
    await page.context().close();
  }
});

test("map card who row is a 44px row that opens details; cards hold at 320 and 412", { timeout: 120_000 }, async () => {
  const { host, friend } = await people();
  await call("POST", "/api/socials", host.token, { note: "Ramen", place: "Schlossplatz", lat: 48.7784, lng: 9.18 });

  for (const [width, height] of [[320, 568], [412, 915]] as Array<[number, number]>) {
    const page = await phone(width, height);
    try {
      await asUser(page, friend.token);
      await page.goto(hangry.baseUrl);
      await dismiss(page);
      const card = page.locator(".card-now", { hasText: "Ramen" });
      await card.locator(".who-row", { hasText: "Waiting for friends" }).waitFor();
      await card.scrollIntoViewIfNeeded();
      await separated(card, width);
      await page.screenshot({ path: shot(`social-light-w${width}.png`) });

      await openEventsMap(page);
      const pin = page.locator(".leaflet-marker-icon.pin").first();
      await pin.waitFor({ timeout: 10_000 });
      await page.waitForTimeout(400);
      await pin.click();
      const mapCard = page.locator(".map-card");
      const who = mapCard.locator(".who-row", { hasText: "Waiting for friends" });
      await who.waitFor();
      assert.ok((await box(who)).height >= 44, "map card who row is 44px+");
      await page.screenshot({ path: shot(`map-card-w${width}.png`) });
      await who.tap();
      await page.getByRole("dialog", { name: "Details" }).waitFor();
    } finally {
      await page.context().close();
    }
  }
});
