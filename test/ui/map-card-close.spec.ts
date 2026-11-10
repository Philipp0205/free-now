import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA as CHROME_UA, openEventsMap, useHangry } from "./harness.js";

/** Set to a folder to keep screenshots, for example MAP_CLOSE_SHOT_DIR=.oc/shots/map-card-close. */
const SHOT_DIR = process.env.MAP_CLOSE_SHOT_DIR ? path.resolve(process.env.MAP_CLOSE_SHOT_DIR) : "";
const PLAN_NOTE = "Rooftop dinner";

const hangry = useHangry({ tz: "UTC" });

async function phone(width: number, height: number, token: string): Promise<Page> {
  const context = await hangry.browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: CHROME_UA });
  await skipWhatsNew(context);
  await context.route(/arcgisonline|tile\.openstreetmap|basemaps\.cartocdn/, (route) => route.fulfill({ status: 204, body: "" }));
  const page = await context.newPage();
  await page.goto(`${hangry.baseUrl}/robots.txt`);
  await page.evaluate((value) => {
    localStorage.clear();
    localStorage.setItem("fn_token", value);
    localStorage.setItem("fn_installed", "1");
    localStorage.setItem("fn_install_later", String(Date.now()));
  }, token);
  await page.goto(hangry.baseUrl);
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
  return page;
}

async function openCard(page: Page) {
  const pin = page.locator(".leaflet-marker-icon.pin-plan").first();
  await pin.waitFor({ timeout: 10_000 });
  await pin.click();
  await page.locator(".map-card", { hasText: PLAN_NOTE }).waitFor({ timeout: 5000 });
}

async function cardGone(page: Page, label: string) {
  await page.locator(".map-card").waitFor({ state: "detached", timeout: 3000 });
  assert.equal(await page.locator("#map-card-host").evaluate((node) => node.childElementCount), 0, label);
}

/** A spot on the map well away from the pin, the card and the zoom buttons. */
async function emptySpot(page: Page) {
  const box = (await page.locator("#hangry-map").boundingBox())!;
  return { x: box.x + 28, y: box.y + 28 };
}

async function shot(page: Page, name: string) {
  if (!SHOT_DIR) return;
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOT_DIR, name) });
}

test("map card: a quiet Close in the corner, Escape and a tap on the map put it away, and the map still moves", { timeout: 180_000 }, async () => {
  const host = await hangry.call("POST", "/api/auth/start", undefined, { name: "Hana" });
  const { circle } = await hangry.call("POST", "/api/circles", host.token, { name: "Friends" });
  const friend = await hangry.call("POST", "/api/auth/start", undefined, { name: "Ana", code: circle.inviteCode });
  await hangry.call("POST", "/api/plans", host.token, {
    note: PLAN_NOTE, time: "23:30", place: "Schlossplatz", lat: 48.7784, lng: 9.18, precise: true,
  });

  // The full flow at 360; the button's look and size at every phone width.
  for (const [width, height] of SIZES) {
    const page = await phone(width, height, friend.token);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    const label = `${width}`;
    try {
      await openEventsMap(page);
      await page.waitForTimeout(400);
      await openCard(page);

      const card = page.locator(".map-card");
      const close = card.getByRole("button", { name: "Close", exact: true });
      await close.waitFor();
      assert.equal(await close.getAttribute("aria-label"), "Close", label);
      assert.equal(await close.getAttribute("type"), "button", label);
      const boxes = await page.evaluate(() => {
        const [card, close, more] = [".map-card", ".map-card-close", ".map-card .card-more"]
          .map((sel) => document.querySelector(sel)!.getBoundingClientRect().toJSON());
        return { card, close, more };
      });
      const info = JSON.stringify({ width, boxes });
      assert.ok(boxes.close.width >= 44 - 0.5 && boxes.close.height >= 44 - 0.5, `44px target ${info}`);
      // Top-right corner of the card, right of the ⋯, inside the card.
      assert.ok(boxes.close.right <= boxes.card.right + 0.5, info);
      assert.ok(boxes.card.right - boxes.close.right <= 16, info);
      assert.ok(boxes.close.top - boxes.card.top <= 16, info);
      assert.ok(boxes.close.left >= boxes.more.right - 0.5, `Close sits right of ⋯ ${info}`);
      const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest(".map-card-close") != null, {
        x: boxes.close.left + boxes.close.width / 2, y: boxes.close.top + boxes.close.height / 2,
      });
      assert.ok(hit, `Close is not covered ${info}`);
      await shot(page, `map-card-close-w${width}.png`);
      if (width !== 360) continue;

      // 1. Close button.
      const pin = page.locator(".leaflet-marker-icon.pin-plan").first();
      const cardCenter = { x: boxes.card.left + boxes.card.width / 2, y: boxes.card.top + boxes.card.height / 2 };
      await close.click();
      await cardGone(page, "Close button");
      assert.equal(
        await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest(".leaflet-container") != null, cardCenter),
        true,
        "the map is back where the card was",
      );
      await shot(page, "map-card-closed-w360.png");

      // The map still pans after the card is gone.
      const before = (await pin.boundingBox())!;
      const start = await emptySpot(page);
      await page.mouse.move(start.x + 40, start.y + 80);
      await page.mouse.down();
      await page.mouse.move(start.x + 80, start.y + 140, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(300);
      const after = (await pin.boundingBox())!;
      assert.ok(Math.abs(after.x - before.x) > 20 || Math.abs(after.y - before.y) > 20, `pan moved the pin ${JSON.stringify({ before, after })}`);
      assert.equal(await card.count(), 0, "a drag does not bring the card back");

      // 2. Escape, while the card is the top layer. The Events tab stays on the map.
      await openCard(page);
      await page.keyboard.press("Escape");
      await cardGone(page, "Escape");
      assert.ok(await page.locator("#hangry-map").isVisible(), "Escape left the map open");

      // Escape belongs to a sheet opened from the card, not to the card under it.
      await openCard(page);
      await card.locator(".map-card-head strong").click();
      await page.locator(".sheet").first().waitFor();
      await page.keyboard.press("Escape");
      await page.locator(".sheet").first().waitFor({ state: "detached", timeout: 3000 });
      await card.waitFor({ timeout: 3000 });
      // And an open ⋯ menu: Escape shuts the menu only.
      await card.getByRole("button", { name: /^More for / }).click();
      await page.getByRole("menu").waitFor();
      await page.keyboard.press("Escape");
      await page.getByRole("menu").waitFor({ state: "detached", timeout: 3000 });
      assert.equal(await card.count(), 1, "Escape closed the menu, not the card");
      await page.keyboard.press("Escape");
      await cardGone(page, "Escape after the menu");

      // 3. A tap on empty map closes it. Taps on the card and its buttons do not.
      await openCard(page);
      await card.getByRole("button", { name: /^More for / }).click();
      await page.getByRole("menu").waitFor();
      await card.getByRole("button", { name: /^More for / }).click();
      await page.getByRole("menu").waitFor({ state: "detached", timeout: 3000 });
      const time = (await card.locator(".map-card-time").boundingBox())!;
      // The card's own padding, right of the time line.
      await page.mouse.click(boxes.card.right - 6, time.y + time.height / 2);
      await page.waitForTimeout(300);
      assert.equal(await card.count(), 1, "a tap on the card keeps it");
      // With a ⋯ menu open, the first map tap only shuts the menu.
      await card.getByRole("button", { name: /^More for / }).click();
      await page.getByRole("menu").waitFor();
      const spot = await emptySpot(page);
      await page.mouse.click(spot.x, spot.y);
      await page.getByRole("menu").waitFor({ state: "detached", timeout: 3000 });
      await page.waitForTimeout(300);
      assert.equal(await card.count(), 1, "the tap that shut the menu keeps the card");
      await page.mouse.click(spot.x, spot.y);
      await cardGone(page, "map tap");
      assert.deepEqual(errors, [], label);
    } finally {
      await page.context().close();
    }
  }
});
