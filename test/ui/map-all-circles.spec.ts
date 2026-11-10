import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { UA as CHROME_UA, useHangry } from "./harness.js";

/** Set to a folder to keep screenshots, for example MAP_ALL_SHOT_DIR=/workspace/hangry-railway. */
const SHOT_DIR = process.env.MAP_ALL_SHOT_DIR ? path.resolve(process.env.MAP_ALL_SHOT_DIR) : "";
const UNI_PLAN = "Uni rooftop";
const HOME_PLAN = "Home picnic";

const hangry = useHangry({ tz: "UTC" });

async function open(width: number, height: number, token: string, circleId: string, mobile: boolean): Promise<Page> {
  const context = await hangry.browser.newContext({
    viewport: { width, height },
    isMobile: mobile,
    hasTouch: mobile,
    userAgent: mobile ? CHROME_UA : undefined,
  });
  await skipWhatsNew(context);
  await context.route(/arcgisonline|tile\.openstreetmap|basemaps\.cartocdn|protomaps|\.pmtiles/, (route) => route.fulfill({ status: 204, body: "" }));
  const page = await context.newPage();
  await page.goto(`${hangry.baseUrl}/robots.txt`);
  await page.evaluate(({ value, circle }) => {
    localStorage.clear();
    localStorage.setItem("fn_token", value);
    localStorage.setItem("fn_circle", circle);
    localStorage.setItem("fn_installed", "1");
    localStorage.setItem("fn_install_later", String(Date.now()));
  }, { value: token, circle: circleId });
  await page.goto(hangry.baseUrl);
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
  return page;
}

async function goMap(page: Page) {
  // The Events tab (formerly Map) opens on Calendar; the map is one tap on the segment.
  await page.locator(".tabbar").getByRole("button", { name: "Events", exact: true }).click();
  await page.locator(".events-view").getByRole("button", { name: "Map", exact: true }).click();
  await page.locator("#hangry-map, .map-empty").first().waitFor({ timeout: 10_000 });
  await page.waitForTimeout(400);
}

async function planPins(page: Page, count: number) {
  await page.waitForFunction((want) => document.querySelectorAll(".leaflet-marker-icon.pin-plan").length === want, count, { timeout: 10_000 });
}

async function shot(page: Page, name: string) {
  if (!SHOT_DIR) return;
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOT_DIR, name) });
}

test("map: This circle / All circles puts every circle on one map and names the circle on the card", { timeout: 180_000 }, async () => {
  const host = await hangry.call("POST", "/api/auth/start", undefined, { name: "Hana" });
  const uni = (await hangry.call("POST", "/api/circles", host.token, { name: "Uni friends" })).circle;
  const home = (await hangry.call("POST", "/api/circles", host.token, { name: "Home" })).circle;
  await hangry.call("POST", `/api/plans?circle=${uni.id}`, host.token, {
    note: UNI_PLAN, time: "23:30", place: "Schlossplatz", lat: 48.7784, lng: 9.18, precise: true,
  });
  await hangry.call("POST", `/api/plans?circle=${home.id}`, host.token, {
    note: HOME_PLAN, time: "23:00", place: "Rosenstein", lat: 48.8, lng: 9.21, precise: true,
  });

  const sizes: Array<[number, number, boolean, string]> = [[360, 740, true, "mobile"], [1024, 768, false, "desktop"]];
  for (const [width, height, mobile, tag] of sizes) {
    const page = await open(width, height, host.token, uni.id, mobile);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    try {
      await goMap(page);
      const scope = page.locator(".map-scope");
      await scope.waitFor({ timeout: 5000 });
      const thisBtn = scope.getByRole("button", { name: "This circle" });
      const allBtn = scope.getByRole("button", { name: "All circles" });
      assert.equal(await thisBtn.getAttribute("class"), "on", `${tag} default is This circle`);
      assert.notEqual(await allBtn.getAttribute("class"), "on", tag);
      await planPins(page, 1);
      const box = (await scope.boundingBox())!;
      assert.ok(box.width > 0 && box.x + box.width <= width + 0.5, `${tag} toggle fits ${JSON.stringify(box)}`);
      await shot(page, `map-all-circles-toggle-${tag}.png`);

      await allBtn.click();
      await planPins(page, 2);
      assert.equal(await allBtn.getAttribute("class"), "on", tag);
      assert.equal(await page.evaluate(() => localStorage.getItem("hangry-map-all")), "1", tag);
      await shot(page, `map-all-circles-unified-${tag}.png`);

      // The Home plan's card names its circle and still has Close.
      const pins = page.locator(".leaflet-marker-icon.pin-plan");
      let found = false;
      for (let index = 0; index < 2 && !found; index += 1) {
        // Opening a card pans to its pin, so the other pin may sit off screen. Tap it directly.
        await pins.nth(index).dispatchEvent("click");
        const card = page.locator(".map-card");
        await card.waitFor({ timeout: 5000 });
        if (await card.filter({ hasText: HOME_PLAN }).count()) {
          found = true;
          assert.equal((await card.locator(".map-card-circle").textContent())?.trim(), "Home", tag);
          await card.getByRole("button", { name: "Close", exact: true }).waitFor();
          await shot(page, `map-all-circles-card-${tag}.png`);
          await card.getByRole("button", { name: "Close", exact: true }).click();
          await card.waitFor({ state: "detached", timeout: 3000 });
        } else {
          assert.equal((await card.locator(".map-card-circle").textContent())?.trim(), "Uni friends", tag);
          await card.getByRole("button", { name: "Close", exact: true }).click();
          await card.waitFor({ state: "detached", timeout: 3000 });
        }
      }
      assert.ok(found, `${tag} found the Home plan card`);

      // The pick survives a reload.
      await page.reload();
      await goMap(page);
      await page.locator(".map-scope").waitFor();
      assert.equal(await page.locator(".map-scope").getByRole("button", { name: "All circles" }).getAttribute("class"), "on", `${tag} kept All`);
      await planPins(page, 2);

      // Back to This circle shows only the selected circle again.
      await page.locator(".map-scope").getByRole("button", { name: "This circle" }).click();
      await planPins(page, 1);
      assert.equal(await page.evaluate(() => localStorage.getItem("hangry-map-all")), "0", tag);
      assert.deepEqual(errors, [], tag);
    } finally {
      await page.context().close();
    }
  }
});

test("map: one circle shows no scope switch", { timeout: 60_000 }, async () => {
  const solo = await hangry.call("POST", "/api/auth/start", undefined, { name: "Solo" });
  const { circle } = await hangry.call("POST", "/api/circles", solo.token, { name: "Only" });
  await hangry.call("POST", "/api/plans", solo.token, { note: "Solo walk", lat: 48.77, lng: 9.18, precise: true });
  const page = await open(360, 740, solo.token, circle.id, true);
  try {
    await goMap(page);
    await planPins(page, 1);
    assert.equal(await page.locator(".map-scope").count(), 0);
  } finally {
    await page.context().close();
  }
});
