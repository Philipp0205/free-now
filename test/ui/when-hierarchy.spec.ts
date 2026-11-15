import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Page } from "playwright-core";
import { addDays, dayLabel, isoDate } from "../../src/lib/time.js";
import { skipWhatsNew } from "./whats-new-seen.js";
import { UA as CHROME_UA, useHangry } from "./harness.js";

const TZ = "Europe/Berlin";
const SHOT_DIR = path.resolve(process.env.WH_SHOT_DIR || "test/ui/screenshots/when-hierarchy");
const ORB = "Let friends know you're free now";
const LINK = "Plan for another day";
const VIEWPORTS = [
  { width: 320, height: 568, mobile: true },
  { width: 360, height: 640, mobile: true },
  { width: 412, height: 915, mobile: true },
  { width: 1280, height: 800, mobile: false },
] as const;

const hangry = useHangry({ tz: TZ });
const { call } = hangry;
let seq = 0;

/** Fake user over the API, in a fresh circle, so counts start at zero. */
async function user() {
  seq += 1;
  const me = await call("POST", "/api/auth/start", undefined, { name: `Wen${seq}` });
  const { circle } = await call("POST", "/api/circles", me.token, { name: `When ${seq}` });
  return { token: me.token as string, circleId: circle.id as string };
}

async function open(who: { token: string; circleId: string }, width = 360, height = 640, mobile = true) {
  const context = await hangry.browser.newContext({
    viewport: { width, height },
    isMobile: mobile,
    hasTouch: mobile,
    ...(mobile ? { userAgent: CHROME_UA } : {}),
    timezoneId: TZ,
  });
  await skipWhatsNew(context);
  await context.addInitScript(([value, circle]) => {
    localStorage.setItem("fn_install_later", String(Date.now()));
    localStorage.setItem("fn_token", value);
    localStorage.setItem("fn_circle", circle);
  }, [who.token, who.circleId]);
  await context.route("**/api/geocode?**", (route) => route.fulfill({ json: { results: [], place: "", area: "" } }));
  await context.route(/arcgisonline|tile\.openstreetmap|basemaps\.cartocdn/, (route) => route.abort());
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(hangry.baseUrl);
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
  await page.getByRole("button", { name: ORB }).click();
  await page.locator("form.sheet .segment").waitFor();
  return { page, errors };
}

const segment = (page: Page) => page.locator("form.sheet .segment");
const link = (page: Page) => page.locator("form.sheet").getByRole("button", { name: LINK });

async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) });
}

/** The link sits inside the sheet's visible scroll area with the sheet scrolled to the top. */
async function linkPlacement(page: Page) {
  return page.evaluate((name) => {
    const sheet = document.querySelector("form.sheet")!;
    const scroll = sheet.querySelector(".sheet-scroll") as HTMLElement;
    const button = [...sheet.querySelectorAll("button")].find((node) => node.textContent === name)!;
    const box = button.getBoundingClientRect();
    const view = scroll.getBoundingClientRect();
    const dock = sheet.querySelector(".sheet-dock")!.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return {
      scrollTop: scroll.scrollTop,
      width: box.width,
      height: box.height,
      inView: box.top >= view.top - 0.5 && box.bottom <= Math.min(view.bottom, dock.top) + 0.5
        && box.left >= 0 && box.right <= window.innerWidth && box.bottom <= window.innerHeight,
      hit: Boolean(hit && (hit === button || button.contains(hit))),
    };
  }, LINK);
}

test("two equal choices, then a visible Plan for another day link at every size", { timeout: 120_000 }, async () => {
  const who = await user();
  for (const { width, height, mobile } of VIEWPORTS) {
    const { page, errors } = await open(who, width, height, mobile);
    try {
      const buttons = segment(page).getByRole("button");
      assert.equal(await buttons.count(), 2, `two segments at ${width}`);
      assert.equal(await buttons.nth(0).innerText(), "Now");
      assert.match(await buttons.nth(1).innerText(), /^(Later today|Tomorrow)$/);
      assert.equal(await buttons.nth(0).getAttribute("aria-pressed"), "true");
      assert.equal(await segment(page).getByRole("button", { name: "Pick a date" }).count(), 0);
      const widths = await buttons.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().width));
      assert.ok(Math.abs(widths[0] - widths[1]) <= 1, `equal widths ${widths}`);

      assert.equal(await link(page).getAttribute("type"), "button");
      assert.equal(await link(page).getAttribute("aria-pressed"), "false");
      const placed = await linkPlacement(page);
      assert.equal(placed.scrollTop, 0, JSON.stringify(placed));
      assert.ok(placed.inView && placed.hit, `link visible without scrolling at ${width}x${height}: ${JSON.stringify(placed)}`);
      assert.ok(placed.height >= 44 && placed.width >= 44, `tap target ${placed.width}x${placed.height}`);
      await shot(page, `default-${width}x${height}`);

      await link(page).click();
      await page.locator("#plan-date").waitFor();
      assert.equal(await link(page).getAttribute("aria-pressed"), "true");
      for (const name of ["Now", /^(Later today|Tomorrow)$/]) {
        assert.equal(await segment(page).getByRole("button", { name, exact: true }).getAttribute("aria-pressed"), "false");
      }
      const today = isoDate(Date.now(), TZ);
      await page.locator(".sheet").getByRole("heading", { name: dayLabel(addDays(today, 3), today) }).waitFor();
      const after = await linkPlacement(page);
      assert.ok(after.inView && after.hit && after.height >= 44, `date path link at ${width}: ${JSON.stringify(after)}`);
      await shot(page, `date-path-${width}x${height}`);
      assert.deepEqual(errors, []);
    } finally {
      await page.context().close();
    }
  }
});

test("Now posts a free post right away", { timeout: 60_000 }, async () => {
  const who = await user();
  const { page, errors } = await open(who);
  try {
    let planned = false;
    page.on("request", (request) => { if (request.method() === "POST" && request.url().endsWith("/api/plans")) planned = true; });
    await page.locator("#sheet-note").fill("Coffee now");
    const created = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/socials"));
    await page.locator(".sheet-dock").getByRole("button", { name: "I'm free", exact: true }).click();
    const response = await created;
    assert.ok(response.ok());
    assert.equal(response.request().postDataJSON().startsAt, null);
    await page.locator("form.sheet").waitFor({ state: "detached" });
    await page.locator(".card-now").getByRole("heading", { name: "Coffee now" }).waitFor();
    assert.equal(planned, false);
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

test("Later today works as before", { timeout: 60_000 }, async () => {
  const who = await user();
  const { page, errors } = await open(who);
  try {
    const later = segment(page).getByRole("button", { name: /^(Later today|Tomorrow)$/ });
    await later.click();
    assert.equal(await later.getAttribute("aria-pressed"), "true");
    assert.equal(await link(page).getAttribute("aria-pressed"), "false");
    await page.locator("#later-time").waitFor();
    assert.equal(await page.locator("#plan-date").count(), 0);
    const submit = page.locator(".sheet-dock").getByRole("button", { name: "I'm free later" });
    if ((await later.innerText()).trim() === "Tomorrow") {
      // Late at night the later slot is tomorrow and the button waits, as before.
      assert.equal(await submit.isDisabled(), true);
      return;
    }
    await page.locator("#sheet-note").fill("Beers later");
    const created = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/socials"));
    await submit.click();
    const response = await created;
    assert.ok(response.ok());
    const posted = response.request().postDataJSON();
    assert.equal(posted.later, true);
    assert.match(String(posted.startsAt), /^\d{2}:\d{2}$/);
    await page.locator("form.sheet").waitFor({ state: "detached" });
    await page.getByRole("heading", { name: "Beers later" }).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

test("Plan for another day adds a plan on the picked date and time", { timeout: 60_000 }, async () => {
  const who = await user();
  const { page, errors } = await open(who);
  try {
    const today = isoDate(Date.now(), TZ);
    const target = addDays(today, 9);
    await link(page).click();
    const date = page.locator("#plan-date");
    await date.waitFor();
    assert.equal(await date.getAttribute("min"), today);
    assert.equal(await date.getAttribute("max"), addDays(today, 365));
    await date.fill(target);
    await page.locator(".sheet").getByRole("heading", { name: dayLabel(target, today) }).waitFor();
    await page.locator("#sheet-note").fill("Lake day");
    await page.locator("#plan-time").fill("11:15");
    const created = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/plans"));
    await page.locator(".sheet-dock").getByRole("button", { name: "Add plan" }).click();
    const response = await created;
    assert.equal(response.status(), 201);
    const posted = response.request().postDataJSON();
    assert.equal(posted.date, target);
    assert.equal(posted.time, "11:15");
    await page.locator("form.sheet").waitFor({ state: "detached" });
    await page.locator(".card-plan").getByRole("heading", { name: "Lake day" }).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

test("the picked date is kept after Now and back through the link", { timeout: 60_000 }, async () => {
  const who = await user();
  const { page, errors } = await open(who);
  try {
    const target = addDays(isoDate(Date.now(), TZ), 12);
    await link(page).click();
    await page.locator("#plan-date").fill(target);
    await segment(page).getByRole("button", { name: "Now", exact: true }).click();
    await page.locator("#plan-date").waitFor({ state: "detached" });
    assert.equal(await segment(page).getByRole("button", { name: "Now", exact: true }).getAttribute("aria-pressed"), "true");
    assert.equal(await link(page).getAttribute("aria-pressed"), "false");
    await link(page).click();
    assert.equal(await page.locator("#plan-date").inputValue(), target);

    await segment(page).getByRole("button", { name: /^(Later today|Tomorrow)$/ }).click();
    await page.locator("#later-time").waitFor();
    await link(page).click();
    assert.equal(await page.locator("#plan-date").inputValue(), target);
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

test("keyboard: Tab reaches the link with a visible focus ring, Enter and Space open the date path", { timeout: 60_000 }, async () => {
  const who = await user();
  const { page, errors } = await open(who, 1280, 800, false);
  try {
    await segment(page).getByRole("button", { name: /^(Later today|Tomorrow)$/ }).focus();
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => {
      const node = document.activeElement as HTMLElement;
      const style = getComputedStyle(node);
      return { id: node.id, text: node.textContent, outline: style.outlineStyle, width: style.outlineWidth };
    });
    assert.equal(focused.text, LINK, JSON.stringify(focused));
    assert.notEqual(focused.outline, "none", JSON.stringify(focused));
    await shot(page, "keyboard-focus-1280x800");
    await page.keyboard.press("Enter");
    await page.locator("#plan-date").waitFor();
    assert.equal(await link(page).getAttribute("aria-pressed"), "true");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "plan-another-day", "focus stays on the link");

    await segment(page).getByRole("button", { name: "Now", exact: true }).click();
    await page.locator("#plan-date").waitFor({ state: "detached" });
    await link(page).focus();
    await page.keyboard.press("Space");
    await page.locator("#plan-date").waitFor();
    assert.equal(await link(page).getAttribute("aria-pressed"), "true");
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

test("Enter in the place search on the date path does not add the plan", { timeout: 60_000 }, async () => {
  const who = await user();
  const { page, errors } = await open(who);
  try {
    const sent: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && /\/api\/(plans|socials)$/.test(request.url())) sent.push(request.url());
    });
    await link(page).click();
    await page.locator("#plan-date").waitFor();
    await page.locator("#sheet-note").fill("Picnic");
    await page.locator(".sheet button.where-row").click();
    await page.locator("#where-query").fill("park");
    await page.locator("#where-query").press("Enter");
    await page.waitForTimeout(500);
    await page.locator("form.sheet").waitFor({ state: "visible" });
    assert.deepEqual(sent, []);
    const { plans } = await call("GET", "/api/plans", who.token);
    assert.equal(plans.length, 0);
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});
