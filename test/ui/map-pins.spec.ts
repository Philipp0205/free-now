import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { UA as CHROME_UA, useHangry } from "./harness.js";

/** Screenshots land here. Override with MAP_PINS_SHOT_DIR. */
const SHOT_DIR = path.resolve(process.env.MAP_PINS_SHOT_DIR || "/workspace/hangry-mapbuzz-logs/shots");
const SIZES: Array<[number, number]> = [[320, 568], [360, 640], [412, 915]];
const PLAN_NOTE = "Rooftop dinner";

const hangry = useHangry({ tz: "UTC" });

function tomorrow(): string {
  return new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
}

async function people() {
  const host = await hangry.call("POST", "/api/auth/start", undefined, { name: "Hana" });
  const { circle } = await hangry.call("POST", "/api/circles", host.token, { name: "Friends" });
  const join = (name: string) => hangry.call("POST", "/api/auth/start", undefined, { name, code: circle.inviteCode });
  const going = [await join("Ana"), await join("Ben"), await join("Cyd"), await join("Dee")];
  const maybe = await join("Max");
  return { host, going, maybe };
}

async function phone(width: number, height: number, token: string): Promise<Page> {
  const context = await hangry.browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: CHROME_UA });
  await skipWhatsNew(context);
  await context.route("https://server.arcgisonline.com/**", (route) => route.fulfill({ status: 204, body: "" }));
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

/** Animation names on the buzzer body and its ring, plus the ring's shadow. */
async function buzz(page: Page) {
  return page.locator(".leaflet-marker-icon.pin-now .pin-body").evaluate((node) => ({
    body: getComputedStyle(node).animationName,
    ring: getComputedStyle(node, "::before").animationName,
    ringShadow: getComputedStyle(node, "::before").boxShadow,
  }));
}

test("map pins: tomorrow label, a going crowd with +N, a live buzzer that calms down for reduced motion", { timeout: 180_000 }, async () => {
  const { host, going, maybe } = await people();
  const { plan } = await hangry.call("POST", "/api/plans", host.token, {
    note: PLAN_NOTE, date: tomorrow(), time: "19:00", place: "Schlossplatz", lat: 48.7784, lng: 9.18, precise: true,
  });
  for (const person of going) await hangry.call("POST", `/api/plans/${plan.id}/reply`, person.token, { reply: "in" });
  await hangry.call("POST", `/api/plans/${plan.id}/reply`, maybe.token, { reply: "maybe" });
  await hangry.call("POST", "/api/socials", going[1].token, { note: "Coffee now", place: "Marktplatz", lat: 48.7752, lng: 9.1772, precise: true });

  fs.mkdirSync(SHOT_DIR, { recursive: true });
  for (const [width, height] of SIZES) {
    const page = await phone(width, height, host.token);
    try {
      await page.locator(".tabbar").getByRole("button", { name: /^Map/ }).click();
      const planPin = page.locator(".leaflet-marker-icon.pin-plan");
      const nowPin = page.locator(".leaflet-marker-icon.pin-social");
      await planPin.waitFor({ timeout: 10_000 });
      await nowPin.waitFor({ timeout: 10_000 });
      await page.waitForTimeout(500);

      // The future plan shows its day.
      assert.equal(await planPin.locator(".pin-when").innerText(), "Tomorrow", `${width}: plan label`);
      assert.equal(await nowPin.locator(".pin-when").count(), 0, `${width}: a live buzzer has no date`);

      // Host is the pin; three of the four friends In are faces, the fourth is +1. Maybe stays off.
      const faces = planPin.locator(".pin-crowd .pin-face");
      assert.equal(await faces.count(), 3, `${width}: three faces`);
      assert.equal(await planPin.locator(".pin-crowd .pin-more").innerText(), "+1", `${width}: overflow`);
      const ids = await faces.evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.person));
      assert.ok(!ids.includes(maybe.user.id), `${width}: Maybe is not in the crowd`);
      assert.ok(!ids.includes(host.user.id), `${width}: the host is not repeated`);
      assert.deepEqual(await faces.allInnerTexts(), ["A", "B", "C"], `${width}: initials without photos`);
      assert.equal(await planPin.locator(".pin-crowd").evaluate((node) => getComputedStyle(node).pointerEvents), "none");

      // The live buzzer buzzes; the plan never does.
      assert.ok(await nowPin.evaluate((node) => node.classList.contains("pin-now")), `${width}: buzzer class`);
      assert.equal(await planPin.evaluate((node) => node.classList.contains("pin-now")), false, `${width}: plan is not now`);
      assert.equal(await planPin.locator(".pin-body").evaluate((node) => getComputedStyle(node).animationName), "none");
      const moving = await buzz(page);
      assert.equal(moving.body, "pin-buzz", `${width}: shake`);
      assert.equal(moving.ring, "pin-ring", `${width}: ring pulse`);
      const zNow = await nowPin.evaluate((node) => Number(getComputedStyle(node).zIndex));
      const zPlan = await planPin.evaluate((node) => Number(getComputedStyle(node).zIndex));
      assert.ok(zNow > zPlan, `${width}: buzzer on top (${zNow} > ${zPlan})`);
      await page.screenshot({ path: path.join(SHOT_DIR, `map-pins-w${width}.png`) });

      // Reduced motion: still, but the thicker ring stays.
      await page.emulateMedia({ reducedMotion: "reduce" });
      const still = await buzz(page);
      assert.equal(still.body, "none", `${width}: no shake`);
      assert.equal(still.ring, "none", `${width}: no pulse`);
      assert.match(still.ringShadow, /7px/, `${width}: static ring ${still.ringShadow}`);
      assert.ok(await nowPin.evaluate((node) => node.classList.contains("pin-now")), `${width}: still marked now`);
      await page.screenshot({ path: path.join(SHOT_DIR, `map-pins-reduced-w${width}.png`) });
      await page.emulateMedia({ reducedMotion: "no-preference" });

      // Tapping the plan pin still opens its card.
      await planPin.click();
      await page.locator(".map-card", { hasText: PLAN_NOTE }).waitFor({ timeout: 5000 });
      await page.screenshot({ path: path.join(SHOT_DIR, `map-pins-card-w${width}.png`) });
    } finally {
      await page.context().close();
    }
  }
});
