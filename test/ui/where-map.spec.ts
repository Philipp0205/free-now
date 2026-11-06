import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { UA as CHROME_UA, useHangry } from "./harness.js";

const PLACE = "Near Alexanderplatz, Berlin";
const NOTE = "Coffee nearby";

const hangry = useHangry();

test("current location while the where map is open does not throw", { timeout: 90_000 }, async () => {
  const page = await phonePage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.stack || String(error)));
  try {
    await signIn(page, "Philipp");
    await page.getByRole("button", { name: "Let friends know you're free now" }).click();
    await page.locator("#sheet-note").fill(NOTE);
    await page.locator("button.where-row").click();
    await page.getByRole("button", { name: "Pick on map" }).click();
    await page.locator("#where-map .leaflet-marker-icon").waitFor({ timeout: 8000 });
    await page.getByRole("button", { name: "Use my current location" }).click();
    await page.locator(".where-v", { hasText: PLACE }).waitFor({ timeout: 8000 });
    await page.locator("#where-map .leaflet-marker-icon").waitFor({ timeout: 8000 });
    // invalidateSize is armed for 60ms and can fire twice (geolocation, then reverse geocode).
    await page.waitForTimeout(1000);
    assert.equal(await page.locator("#sheet-note").inputValue(), NOTE);
    assert.equal(await page.locator("#where-map").count(), 1);
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

async function phonePage() {
  const context = await hangry.browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent: CHROME_UA,
    geolocation: { latitude: 52.52, longitude: 13.405 },
    permissions: ["geolocation"],
  });
  await skipWhatsNew(context);
  await context.route("**/api/geocode?**", (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("q")) return route.fulfill({ json: { results: [] } });
    return route.fulfill({ json: { place: PLACE } });
  });
  return context.newPage();
}

async function signIn(page: Page, name: string) {
  await page.goto(hangry.baseUrl);
  await page.locator("#name").fill(name);
  await page.getByRole("button", { name: "Continue" }).click();
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
  await page.locator("#circle-name").fill("friends");
  await page.getByRole("button", { name: "Create circle" }).click();
  const again = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await again.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await again.click();
  await page.getByRole("button", { name: "Let friends know you're free now" }).waitFor();
}
