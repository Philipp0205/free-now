import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { BrowserContext, Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA, dismissPaymentReminder, openEventsMap, useHangry } from "./harness.js";
import { testEmail } from "../http.js";

// Fake people only. Screenshots go to test/ui/screenshots (gitignored).
const SHOT_DIR = path.resolve("test/ui/screenshots/live-location");
const PIN = { latitude: 52.52, longitude: 13.405 };
const FAR = { latitude: 52.55, longitude: 13.45 };
const hangry = useHangry();
const { call } = hangry;

async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}-w${page.viewportSize()!.width}.png`) });
}

/** Hana hosts a plan with a pin. Bea is in the same circle and has not answered yet. */
async function seed(label: string) {
  const host = await call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Hana" });
  const { circle } = await call("POST", "/api/circles", host.token, { name: `Live ${label}` });
  const bea = await call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Bea", code: circle.inviteCode });
  const { plan } = await call("POST", "/api/plans", host.token, {
    note: "Park picnic", place: "Mauerpark", lat: PIN.latitude, lng: PIN.longitude, precise: true,
  });
  hangry.confirmEmails();
  return { host, bea, circle, plan };
}

/** Counts watchPosition and clearWatch, and lets a test hide the page the way a phone does. */
const SPY = `(() => {
  window.__geo = { watch: 0, clear: 0 };
  window.__hidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => window.__hidden });
  const geo = navigator.geolocation;
  const watch = geo.watchPosition.bind(geo);
  const clear = geo.clearWatch.bind(geo);
  geo.watchPosition = (...args) => { window.__geo.watch += 1; return watch(...args); };
  geo.clearWatch = (id) => { window.__geo.clear += 1; return clear(id); };
})();`;

async function phone(width: number, height: number, token: string, circleId: string, at = PIN): Promise<Page> {
  const context: BrowserContext = await hangry.browser.newContext({
    viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: UA,
    geolocation: at, permissions: ["geolocation"],
  });
  await skipWhatsNew(context);
  await context.addInitScript(SPY);
  await context.addInitScript(([value, circle]) => {
    localStorage.setItem("fn_install_later", String(Date.now()));
    localStorage.setItem("fn_installed", "1");
    localStorage.setItem("fn_token", value);
    localStorage.setItem("fn_circle", circle);
  }, [token, circleId]);
  await context.route(/arcgisonline|tile\.openstreetmap|basemaps\.cartocdn|protomaps|\.pmtiles/, (route) => route.fulfill({ status: 204, body: "" }));
  const page = await context.newPage();
  await page.goto(hangry.baseUrl);
  await page.getByRole("heading", { name: "Now", exact: true, level: 1 }).waitFor();
  await dismissPaymentReminder(page);
  return page;
}

async function openPlanCard(page: Page) {
  await openEventsMap(page);
  await page.locator(".leaflet-marker-icon.pin-plan").first().click();
  await page.locator(".map-card").waitFor();
}

/** The toggle lives in the event details sheet, opened from the map card title. */
async function openDetails(page: Page) {
  await page.locator(".map-card .map-card-head strong").click();
  await page.locator(".sheet[aria-label='Details']").waitFor();
}

test("Bea says she is in, shares live, Hana sees her pin and last seen, and arriving stops it", { timeout: 120_000 }, async () => {
  const { host, bea, circle, plan } = await seed("flow");
  const [width, height] = SIZES[2];
  const beaPage = await phone(width, height, bea.token, circle.id, FAR);
  const hanaPage = await phone(width, height, host.token, circle.id);
  try {
    await openPlanCard(beaPage);
    await openDetails(beaPage);
    assert.equal(await beaPage.locator(".live-share").count(), 0, "no toggle before she says she is in");
    await beaPage.locator(".sheet").getByRole("button", { name: "I'm in" }).click();
    const toggle = beaPage.locator(".sheet .live-share");
    await toggle.waitFor({ timeout: 8000 });
    assert.match((await toggle.innerText()).replace(/\s+/g, " "), /Share my live location.*Only works while Spontaco is open/i);
    assert.equal(await beaPage.evaluate(() => (window as any).__geo.watch), 0, "no location request before the toggle");
    await shot(beaPage, "toggle-off");

    await toggle.getByRole("checkbox").check();
    await beaPage.locator(".sheet .live-share[data-live='on']").waitFor();
    assert.equal(await beaPage.evaluate(() => (window as any).__geo.watch), 1);
    await shot(beaPage, "toggle-on");

    await openPlanCard(hanaPage);
    await hanaPage.locator(".leaflet-marker-icon.pin-live").waitFor({ timeout: 10_000 });
    assert.match(await hanaPage.locator(".leaflet-marker-icon.pin-live").innerText(), /just now/i);
    await hanaPage.locator(".leaflet-marker-icon.pin-live").click();
    const card = hanaPage.locator(".live-card");
    await card.waitFor();
    const text = (await card.innerText()).replace(/\s+/g, " ");
    assert.match(text, /Bea/);
    assert.match(text, /just now|last seen/i);
    assert.match(text, /Live only while their Spontaco is open/);
    assert.doesNotMatch(text, /52\.5|13\.4/, "no raw coordinates on the card");
    await shot(hanaPage, "friend-pin-card");

    assert.equal(await beaPage.locator(".leaflet-marker-icon.pin-live").count(), 0, "her own point is not a pin for her");

    // Hiding the page clears the watch; showing it again starts one.
    await beaPage.evaluate(() => { (window as any).__hidden = true; document.dispatchEvent(new Event("visibilitychange")); });
    assert.equal(await beaPage.evaluate(() => (window as any).__geo.clear), 1);
    await beaPage.evaluate(() => { (window as any).__hidden = false; document.dispatchEvent(new Event("visibilitychange")); });
    assert.equal(await beaPage.evaluate(() => (window as any).__geo.watch), 2);

    // Moving to the pin ends the share. The post rate is limited, so give it a moment.
    await beaPage.context().setGeolocation(PIN);
    await beaPage.waitForFunction(() => document.querySelector(".sheet .live-share[data-live='off']") !== null, null, { timeout: 30_000 });
    assert.equal(await beaPage.locator(".sheet .live-share input").isChecked(), false);
    await shot(beaPage, "arrived");
    const after = await call("GET", `/api/plans/${plan.id}/live`, host.token);
    assert.deepEqual(after.live, [], "her point is gone on the server");
  } finally {
    await beaPage.context().close();
    await hanaPage.context().close();
  }
});

test("the toggle and its open-app note fit every phone size without sideways scroll", { timeout: 120_000 }, async () => {
  const { bea, circle, plan } = await seed("sizes");
  await call("POST", `/api/plans/${plan.id}/reply`, bea.token, { reply: "in" });
  for (const [width, height] of SIZES) {
    const page = await phone(width, height, bea.token, circle.id, FAR);
    try {
      await openPlanCard(page);
      await openDetails(page);
      const toggle = page.locator(".sheet .live-share");
      await toggle.waitFor();
      const box = await toggle.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= width, `${width}: the toggle stays on screen`);
      assert.ok(box!.height >= 44, `${width}: a 44px tap target`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${width}: no sideways scroll`);
      await shot(page, "toggle-size");
    } finally {
      await page.context().close();
    }
  }
});
