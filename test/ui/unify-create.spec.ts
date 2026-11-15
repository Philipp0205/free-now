import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Page } from "playwright-core";
import { insertSocial } from "../../src/db.js";
import { addDays, dayLabel, isoDate } from "../../src/lib/time.js";
import { skipWhatsNew } from "./whats-new-seen.js";
import { UA as CHROME_UA, useHangry } from "./harness.js";

const TZ = "Europe/Berlin";
const SHOT_DIR = path.resolve(process.env.HANG_SHOT_DIR || "/workspace/hangry-shots/unify-create/");
const ORB = "Let friends know you're free now";

const hangry = useHangry({ tz: TZ });
let seq = 0;

async function call(method: string, pathname: string, token?: string, body?: unknown, circleId?: string) {
  const response = await fetch(`${hangry.baseUrl}${pathname}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(circleId ? { "x-circle": circleId } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${pathname} -> ${response.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

/** Fake auth: a user made over the API, in a fresh circle. */
async function user(name = "Hana") {
  seq += 1;
  const me = await call("POST", "/api/auth/start", undefined, { name: `${name}${seq}` });
  const { circle } = await call("POST", "/api/circles", me.token, { name: `Unify ${seq}` });
  return { token: me.token as string, id: me.user?.id as string, circleId: circle.id as string, code: circle.inviteCode as string };
}

async function phone(who: { token: string; circleId: string }, width = 390, height = 844) {
  const context = await hangry.browser.newContext({
    viewport: { width, height },
    isMobile: true,
    hasTouch: true,
    userAgent: CHROME_UA,
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
  return { page, errors };
}

async function home(page: Page) {
  await page.goto(hangry.baseUrl);
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
  await page.getByRole("button", { name: ORB }).waitFor();
}

async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) });
}

test("Now has no section headings and no Plan button, Past events stays", { timeout: 60_000 }, async () => {
  const who = await user();
  for (const [width, height] of [[320, 568], [360, 640], [412, 915]]) {
    const { page, errors } = await phone(who, width, height);
    try {
      await home(page);
      for (const name of ["Later today", "Today & tomorrow", "Upcoming"]) {
        assert.equal(await page.getByRole("heading", { name, exact: true }).count(), 0, name);
      }
      assert.equal(await page.locator(".text-btn", { hasText: /^Plan$/ }).count(), 0);
      assert.equal(await page.getByRole("button", { name: "Nothing planned yet" }).count(), 0);
      await page.getByRole("button", { name: "Past events" }).waitFor();
      await page.getByRole("button", { name: "Share invite" }).waitFor();
      await shot(page, `now-empty-${width}`);
      assert.deepEqual(errors, []);
    } finally {
      await page.context().close();
    }
  }
});

test("red orb, Plan for another day: defaults to three days out and adds a plan", { timeout: 90_000 }, async () => {
  const who = await user();
  for (const [width, height] of [[320, 568], [360, 640], [412, 915]]) {
    const { page, errors } = await phone(who, width, height);
    try {
      const today = isoDate(Date.now(), TZ);
      const inThree = addDays(today, 3);
      const note = `Bowling ${width}`;
      await home(page);
      await page.getByRole("button", { name: ORB }).click();
      const segment = page.locator("form.sheet .segment");
      await segment.getByRole("button", { name: "Now", exact: true }).waitFor();
      await segment.getByRole("button", { name: /^(Later today|Tomorrow)$/ }).waitFor();
      assert.equal(await page.locator("#plan-date").count(), 0, "free mode has no date");
      const other = page.locator("form.sheet").getByRole("button", { name: "Plan for another day" });
      await other.click();
      const date = page.locator("#plan-date");
      await date.waitFor();
      assert.equal(await other.getAttribute("aria-pressed"), "true");
      assert.equal(await date.inputValue(), inThree);
      assert.equal(await date.getAttribute("min"), today);
      assert.equal(await date.getAttribute("max"), addDays(today, 365));
      assert.equal(await page.locator("#later-time").count(), 0, "no social-only time");
      assert.equal(await page.locator(".sheet-summary").count(), 0);
      await page.locator("#plan-time").waitFor();
      await page.locator(".sheet .where-row").waitFor();
      await page.locator(".sheet .share-toggle").waitFor();
      await page.locator(".sheet").getByRole("heading", { name: dayLabel(inThree, today) }).waitFor();
      await page.locator("#sheet-note").fill(note);
      await page.locator("#plan-time").fill("20:00");
      await shot(page, `orb-pick-date-${width}`);
      const created = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/plans"));
      await page.locator(".sheet-dock").getByRole("button", { name: "Add plan" }).click();
      const response = await created;
      assert.equal(response.status(), 201);
      const posted = response.request().postDataJSON();
      assert.equal(posted.date, inThree);
      assert.equal(posted.time, "20:00");
      await page.locator("form.sheet").waitFor({ state: "detached" });
      await page.locator(".card-plan").getByRole("heading", { name: note }).waitFor();
      await shot(page, `orb-plan-added-${width}`);
      assert.deepEqual(errors, []);
    } finally {
      await page.context().close();
    }
  }
});

test("red orb, Now, I'm free: posts a social", { timeout: 60_000 }, async () => {
  const who = await user();
  const { page, errors } = await phone(who, 360, 740);
  try {
    await home(page);
    await page.getByRole("button", { name: ORB }).click();
    const segment = page.locator("form.sheet .segment");
    // Visit Plan for another day and come back: the free sheet is as it was.
    await page.locator("form.sheet").getByRole("button", { name: "Plan for another day" }).click();
    await page.locator("#plan-date").waitFor();
    await segment.getByRole("button", { name: "Now", exact: true }).click();
    await page.locator("#plan-date").waitFor({ state: "detached" });
    assert.equal(await page.locator("#plan-time").count(), 0);
    assert.equal(await segment.getByRole("button", { name: "Now", exact: true }).getAttribute("aria-pressed"), "true");
    await page.locator(".sheet-summary").waitFor();
    await page.locator("#sheet-note").fill("Coffee");
    let planned = false;
    page.on("request", (request) => { if (request.method() === "POST" && request.url().endsWith("/api/plans")) planned = true; });
    const created = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/socials"));
    await page.locator(".sheet-dock").getByRole("button", { name: "I'm free", exact: true }).click();
    const response = await created;
    assert.ok(response.ok());
    assert.equal(response.request().postDataJSON().startsAt, null);
    await page.locator("form.sheet").waitFor({ state: "detached" });
    await page.locator(".card-now").getByRole("heading", { name: "Coffee" }).waitFor();
    assert.equal(planned, false);
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

test("live social, later social, today plan and a far plan share one feed in order", { timeout: 90_000 }, async () => {
  const host = await user();
  const ben = await call("POST", "/api/auth/start", undefined, { name: "Ben", code: host.code });
  const cleo = await call("POST", "/api/auth/start", undefined, { name: "Cleo", code: host.code });
  const now = Date.now();
  const today = isoDate(now, TZ);
  // Inserted straight in the DB, so the later one works at any hour.
  insertSocial(hangry.db, {
    id: crypto.randomUUID(), circleId: host.circleId, creatorId: ben.user.id, note: "Live coffee",
    createdAt: now - 60_000, expiresAt: now + 2 * 3600_000, lat: null, lng: null, startsAt: null,
  });
  insertSocial(hangry.db, {
    id: crypto.randomUUID(), circleId: host.circleId, creatorId: cleo.user.id, note: "Later beers",
    createdAt: now, expiresAt: now + 4 * 3600_000, lat: null, lng: null, startsAt: now + 2 * 3600_000,
  });
  await call("POST", "/api/plans", host.token, { note: "Far trip", date: addDays(today, 20) }, host.circleId);
  await call("POST", "/api/plans", host.token, { note: "Next week dinner", date: addDays(today, 7), time: "19:00" }, host.circleId);
  await call("POST", "/api/plans", host.token, { note: "Today picnic", date: today }, host.circleId);

  for (const [width, height] of [[320, 568], [360, 640], [412, 915]]) {
    const { page, errors } = await phone(host, width, height);
    try {
      await home(page);
      await page.getByRole("heading", { name: "Far trip" }).waitFor();
      assert.equal(await page.locator(".cards").count(), 1, "one feed");
      const order = await page.locator(".cards > .card h3").allInnerTexts();
      assert.deepEqual(order, ["Live coffee", "Later beers", "Today picnic", "Next week dinner", "Far trip"]);
      for (const name of ["Later today", "Today & tomorrow", "Upcoming"]) {
        assert.equal(await page.getByRole("heading", { name, exact: true }).count(), 0, name);
      }
      await page.getByRole("button", { name: "Past events" }).waitFor();
      const scroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
      assert.ok(scroll, `no sideways scroll at ${width}`);
      await shot(page, `feed-${width}`);
      assert.deepEqual(errors, []);
    } finally {
      await page.context().close();
    }
  }
});
