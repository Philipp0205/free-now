import assert from "node:assert/strict";
import { test } from "@playwright/test";
import type { Page } from "playwright-core";
import { FIELD_REVEAL_MS } from "../../public/js/keyboard.js";
import { openPlanSheet } from "./plan-sheet.js";
import { UA as CHROME_UA, openEventsMap, useHangry } from "./harness.js";

const LONG = "Meet at the side door, not the front. Bring a jacket because we sit outside until late. "
  + "Menu is at https://example.com/menu and we split the bill. Text me if you run late, I will save you a seat.";

const hangry = useHangry();

const vvMock = `(() => {
  const bucket = { height: null, offsetTop: 0 };
  const listeners = new Map();
  const fake = {
    get width() { return window.innerWidth; },
    get height() { return bucket.height == null ? window.innerHeight : bucket.height; },
    get offsetTop() { return bucket.offsetTop; },
    get offsetLeft() { return 0; },
    get pageTop() { return bucket.offsetTop; },
    get pageLeft() { return 0; },
    get scale() { return 1; },
    addEventListener(type, fn) {
      let set = listeners.get(type);
      if (!set) { set = new Set(); listeners.set(type, set); }
      set.add(fn);
    },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    dispatchEvent(event) {
      for (const fn of listeners.get(event.type) ?? []) fn(event);
      return true;
    },
  };
  window.__setVisualViewport = (next) => {
    if ("height" in next) bucket.height = next.height;
    if ("offsetTop" in next) bucket.offsetTop = next.offsetTop;
    fake.dispatchEvent(new Event("resize"));
    fake.dispatchEvent(new Event("scroll"));
  };
  Object.defineProperty(window, "visualViewport", { configurable: true, get: () => fake });
})();`;

test("host adds a description in Edit, the card clamps it to two lines, and a tap opens it", { timeout: 120_000 }, async () => {
  const page = await phone(412, 915, false);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  try {
    await signIn(page, "Alex");
    await addPlan(page, "Dinner on the roof");
    // Create sheet stays as it was: no description there.
    await openPlanSheet(page);
    await page.locator("#sheet-note").waitFor();
    assert.equal(await page.locator(".sheet textarea").count(), 0);
    await page.locator(".scrim").click({ position: { x: 20, y: 20 } });
    await page.locator("#sheet-note").waitFor({ state: "detached" });

    await page.locator(".card-plan").getByRole("button", { name: /^More for / }).click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    const area = page.locator("#admin-description");
    await area.waitFor();
    assert.equal(await area.getAttribute("maxlength"), "280");
    await area.fill(LONG);
    const saved = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().includes("/api/plans/"));
    await page.locator(".sheet-dock").getByRole("button", { name: "Save" }).click();
    const response = await saved;
    assert.equal(response.status(), 200);
    assert.equal((await response.json()).plan.description, LONG);

    const desc = page.locator(".card-plan .plan-desc");
    await desc.waitFor();
    const lineHeight = await desc.evaluate((node) => parseFloat(getComputedStyle(node).lineHeight));
    const closed = await desc.boundingBox();
    assert.ok(closed && closed.height <= lineHeight * 2 + 2, `clamped height ${closed?.height} vs line ${lineHeight}`);
    assert.equal(await desc.getAttribute("aria-expanded"), "false");
    assert.equal(await desc.locator("a").getAttribute("href"), "https://example.com/menu");

    await desc.click({ position: { x: 10, y: 5 } });
    assert.equal(await desc.getAttribute("aria-expanded"), "true");
    const open = await desc.boundingBox();
    assert.ok(open && open.height > lineHeight * 3, `open height ${open?.height}`);
    await desc.click({ position: { x: 10, y: 5 } });
    assert.equal(await desc.getAttribute("aria-expanded"), "false");

    await openEventsMap(page);
    const pin = page.locator(".leaflet-marker-icon.pin").first();
    await pin.waitFor({ timeout: 10_000 });
    await page.waitForTimeout(500);
    await pin.click();
    const mapDesc = page.locator(".map-card .plan-desc");
    await mapDesc.waitFor();
    assert.match((await mapDesc.textContent()) ?? "", /^Meet at the side door/);
    const mapClosed = await mapDesc.boundingBox();
    const mapLine = await mapDesc.evaluate((node) => parseFloat(getComputedStyle(node).lineHeight));
    assert.ok(mapClosed && mapClosed.height <= mapLine * 2 + 2, `map clamped ${mapClosed?.height}`);
    await mapDesc.click({ position: { x: 10, y: 5 } });
    assert.equal(await mapDesc.getAttribute("aria-expanded"), "true");
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

test("at 320 the Save button stays clear of the keyboard with the description focused", { timeout: 120_000 }, async () => {
  for (const mode of ["visual-viewport", "resizes-content"] as const) {
    const page = await phone(320, 568, mode === "visual-viewport");
    const label = mode;
    try {
      await signIn(page, "Alex");
      await addPlan(page, "Bagels");
      await page.locator(".card-plan").getByRole("button", { name: /^More for / }).click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
      const area = page.locator("#admin-description");
      await area.waitFor();
      await area.focus();
      const kb = Math.round(568 * 0.42);
      if (mode === "visual-viewport") await page.evaluate((h) => (window as unknown as { __setVisualViewport: (next: object) => void }).__setVisualViewport({ height: h, offsetTop: 0 }), 568 - kb);
      else await page.setViewportSize({ width: 320, height: 568 - kb });
      await page.waitForTimeout(FIELD_REVEAL_MS + 300);
      await page.keyboard.type("Side door. ");
      await page.waitForTimeout(200);
      const report = await page.evaluate(() => {
        const problems: string[] = [];
        const vv = window.visualViewport!;
        const viewBottom = vv.offsetTop + vv.height;
        const area = document.getElementById("admin-description")!;
        const dock = document.querySelector(".sheet-dock")!;
        const head = document.querySelector(".sheet-head")!;
        const button = dock.querySelector("button[type=submit]")!;
        const b = button.getBoundingClientRect();
        const a = area.getBoundingClientRect();
        if (b.bottom > viewBottom + 1) problems.push(`Save ${b.top}-${b.bottom} below view ${viewBottom}`);
        const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        if (hit !== button && !button.contains(hit)) problems.push(`Save covered by ${hit?.className}`);
        if (a.bottom > dock.getBoundingClientRect().top + 1) problems.push(`textarea ${a.bottom} under dock ${dock.getBoundingClientRect().top}`);
        if (a.top < head.getBoundingClientRect().bottom - 1) problems.push(`textarea ${a.top} under head`);
        if (document.activeElement !== area) problems.push("textarea lost focus");
        return problems;
      });
      assert.deepEqual(report, [], label);
      await page.locator(".sheet-dock button[type=submit]").click({ trial: true, timeout: 3000 });
      const saved = page.waitForResponse((response) => response.request().method() === "PATCH");
      await page.locator(".sheet-dock button[type=submit]").click();
      assert.equal((await (await saved).json()).plan.description, "Side door.", label);
    } finally {
      await page.context().close();
    }
  }
});

async function phone(width: number, height: number, mockViewport: boolean) {
  const context = await hangry.browser.newContext({
    viewport: { width, height },
    isMobile: true,
    hasTouch: true,
    userAgent: CHROME_UA,
  });
  if (mockViewport) await context.addInitScript(vvMock);
  await context.route("**/api/geocode?**", (route) => route.fulfill({ json: { results: [], place: "", area: "" } }));
  await context.route(/arcgisonline|tile\.openstreetmap|basemaps\.cartocdn/, (route) => route.abort());
  return context.newPage();
}

async function dismiss(page: Page) {
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
}

async function signIn(page: Page, name: string) {
  await page.goto(hangry.baseUrl);
  await page.locator("#name").fill(name);
  await page.getByRole("button", { name: "Continue" }).click();
  await dismiss(page);
  await page.locator("#circle-name").fill("friends");
  await page.getByRole("button", { name: "Create circle" }).click();
  await dismiss(page);
  await page.getByRole("button", { name: "Let friends know you're free now" }).waitFor();
}

async function addPlan(page: Page, note: string) {
  const token = await page.evaluate(() => localStorage.getItem("fn_token"));
  const made = await fetch(`${hangry.baseUrl}/api/plans`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ note, place: "jomi Bagel Deli", lat: 48.7705, lng: 9.1655, precise: true, time: "19:30" }),
  });
  assert.equal(made.status, 201);
  await page.reload();
  await dismiss(page);
  await page.getByRole("heading", { name: note }).waitFor();
}
