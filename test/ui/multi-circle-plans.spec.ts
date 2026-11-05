import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { openDb } from "../../src/db.js";
import type { PushPayload, PushSender, PushSubscription } from "../../src/push.js";
import { skipWhatsNew } from "./whats-new-seen.js";

const UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36";
const TZ = "Europe/Berlin";
/** Set to a folder to keep screenshots, for example MC_SHOT_DIR=/tmp/shots. */
const SHOT_DIR = process.env.MC_SHOT_DIR ? path.resolve(process.env.MC_SHOT_DIR) : "";
const SIZES = [[320, 568], [360, 740], [412, 915]] as const;

const sent: Array<{ endpoint: string; payload: PushPayload }> = [];
const fakePush: PushSender = {
  async send(subscription: PushSubscription, payload: PushPayload) { sent.push({ endpoint: subscription.endpoint, payload }); },
};

let browser: Browser;
let baseUrl = "";
let closeServer: () => Promise<void> = async () => {};

test.before(async () => {
  const db = openDb(":memory:");
  const config = loadConfig({ PORT: "3000", DB_PATH: ":memory:", APP_TZ: TZ });
  const server = http.createServer(createApp({ db, push: fakePush, config: { ...config, dbPath: ":memory:" }, now: () => Date.now() }));
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

type Person = { token: string; user: { id: string; name: string } };

async function call(method: string, pathname: string, token?: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${pathname} -> ${response.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

/** Ana hosts Friends and Climbing. Ben is only in Friends, Cleo only in Climbing. All three have push on. */
async function seed(tag: string) {
  const ana: Person = await call("POST", "/api/auth/start", undefined, { name: "Ana" });
  const friends = (await call("POST", "/api/circles", ana.token, { name: "Friends" })).circle;
  const climbing = (await call("POST", "/api/circles", ana.token, { name: "Climbing" })).circle;
  const ben: Person = await call("POST", "/api/auth/start", undefined, { name: "Ben", code: friends.inviteCode });
  const cleo: Person = await call("POST", "/api/auth/start", undefined, { name: "Cleo", code: climbing.inviteCode });
  const ends = { ana: `https://push.example/ana-${tag}`, ben: `https://push.example/ben-${tag}`, cleo: `https://push.example/cleo-${tag}` };
  for (const [person, endpoint] of [[ana, ends.ana], [ben, ends.ben], [cleo, ends.cleo]] as const) {
    await call("POST", "/api/push/subscribe", person.token, { endpoint, keys: { p256dh: "p", auth: "a" } });
  }
  return { ana, ben, cleo, friends, climbing, ends };
}

async function phone(width: number, height: number, token: string, circleId?: string) {
  const context = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: UA, timezoneId: TZ });
  await skipWhatsNew(context);
  await context.addInitScript(([value, circle]) => {
    localStorage.setItem("fn_install_later", String(Date.now()));
    localStorage.setItem("fn_token", value);
    if (circle) localStorage.setItem("fn_circle", circle);
  }, [token, circleId ?? ""] as const);
  await context.route("https://*.tile.openstreetmap.org/**", (route) => route.fulfill({ status: 204, body: "" }));
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  return { page, errors };
}

async function open(page: Page) {
  await page.goto(baseUrl);
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
}

async function shot(page: Page, name: string) {
  if (!SHOT_DIR) return;
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const size = page.viewportSize()!;
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}-${size.width}x${size.height}.png`) });
}

async function noSideScroll(page: Page, where: string) {
  const widths = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    view: window.innerWidth,
  }));
  assert.ok(widths.doc <= widths.view && widths.body <= widths.view, `${where}: no horizontal overflow ${JSON.stringify(widths)}`);
}

/** Fully inside the viewport, left to right and top to bottom. */
async function inView(page: Page, locator: Locator, where: string) {
  await locator.scrollIntoViewIfNeeded();
  assert.ok(await locator.isVisible(), `${where}: visible`);
  const box = await locator.boundingBox();
  const size = page.viewportSize()!;
  assert.ok(box, `${where}: has a box`);
  assert.ok(box.x >= 0 && box.x + box.width <= size.width + 0.5, `${where}: inside the width ${JSON.stringify(box)}`);
  assert.ok(box.y >= 0 && box.y + box.height <= size.height + 0.5, `${where}: inside the height ${JSON.stringify(box)}`);
}

const planCard = (page: Page, note: string) => page.locator(".card-plan", { has: page.getByRole("heading", { name: note }) });
async function openEdit(page: Page, note: string) {
  await planCard(page, note).locator(".card-more").click();
  await page.getByRole("menu").getByRole("menuitem", { name: "Edit", exact: true }).click();
}
const newPlanPushes = (from: number, endpoint: string, planId: string) =>
  sent.slice(from).filter((item) => item.endpoint === endpoint && item.payload.tag === `plan:${planId}`);

for (const [width, height] of SIZES) {
  test(`at ${width}x${height}: Ana shares a Friends plan with Climbing, Cleo joins and chats, Ben sees it, unsharing hides it`, { timeout: 150_000 }, async () => {
    const { ana, ben, cleo, friends, climbing, ends } = await seed(`${width}`);
    const note = `Bouldering ${width}`;
    const start = sent.length;

    // Ana makes the plan in Friends, then shares it with Climbing from Edit.
    const anaPhone = await phone(width, height, ana.token, friends.id);
    let planId = "";
    try {
      const page = anaPhone.page;
      await open(page);
      await page.getByRole("button", { name: "Plan", exact: true }).click();
      await page.locator("#sheet-note").fill(note);
      await page.locator("#plan-time").fill("18:30");
      const created = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/plans"));
      await page.locator(".sheet-dock").getByRole("button", { name: "Add plan" }).click();
      planId = (await (await created).json()).plan.id;
      await planCard(page, note).waitFor();
      assert.equal(await planCard(page, note).locator(".plan-circles").count(), 0, "one circle: no circle line");
      assert.equal(newPlanPushes(start, ends.ben, planId).length, 1, "Ben hears about the new Friends plan once");
      assert.equal(newPlanPushes(start, ends.cleo, planId).length, 0, "Cleo is not in Friends");

      await openEdit(page, note);
      const sheet = page.locator(".sheet");
      const label = sheet.getByText("Also share with", { exact: true });
      await label.waitFor();
      const group = sheet.getByRole("group", { name: "Also share with" });
      const chips = group.getByRole("button");
      assert.deepEqual(await chips.allInnerTexts(), ["Climbing"], "only the other circle is offered, not Friends");
      const chip = group.getByRole("button", { name: "Climbing" });
      assert.equal(await chip.getAttribute("aria-pressed"), "false");
      await inView(page, group, "chips row");
      await noSideScroll(page, "edit sheet");
      const sheetOverflow = await sheet.evaluate((node) => node.scrollWidth - node.clientWidth);
      assert.ok(sheetOverflow <= 0, `edit sheet does not scroll sideways (${sheetOverflow})`);
      await chip.click();
      assert.equal(await chip.getAttribute("aria-pressed"), "true");
      await inView(page, chip, "picked chip");
      await shot(page, "edit-also-share");

      const before = sent.length;
      const patched = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().includes(`/api/plans/${planId}`));
      await sheet.getByRole("button", { name: "Save" }).click();
      const body = (await patched).request().postDataJSON();
      assert.deepEqual(body.circleIds, [friends.id, climbing.id]);
      await sheet.waitFor({ state: "detached" });
      await planCard(page, note).locator(".plan-circles", { hasText: "Friends + Climbing" }).waitFor();

      // Sharing pushes Cleo once with the new-plan push, and no one in Friends again.
      assert.equal(newPlanPushes(before, ends.cleo, planId).length, 1, "Cleo gets the new-plan push once");
      assert.equal(newPlanPushes(before, ends.ben, planId).length, 0, "Ben is not told twice");
      assert.equal(sent.slice(before).filter((item) => item.endpoint === ends.ben).length, 0, "no push of any kind to Ben");
      assert.equal(sent.slice(before).filter((item) => item.endpoint === ends.ana).length, 0, "none to the host");
      assert.deepEqual(anaPhone.errors, []);
    } finally {
      await anaPhone.page.context().close();
    }

    // Cleo, only in Climbing, sees the plan with both circle names, says she's in, and writes in the chat.
    const cleoPhone = await phone(width, height, cleo.token);
    try {
      const page = cleoPhone.page;
      await open(page);
      const card = planCard(page, note);
      await card.waitFor();
      assert.equal((await card.locator(".plan-circles").innerText()).trim(), "Friends + Climbing");
      await noSideScroll(page, "Cleo home");
      await shot(page, "cleo-card");
      const replied = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes(`/api/plans/${planId}/`));
      await card.locator(".in-toggle").click();
      assert.ok((await replied).ok(), "Cleo's reply is accepted");
      await card.getByText("You're in").waitFor();
      await card.locator(".in-toggle.on").waitFor();

      await card.getByRole("button", { name: /^Chat/ }).click();
      await page.locator("#chat-input").fill("Count me in, bringing chalk");
      const posted = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes(`/api/plans/${planId}/chat`));
      await page.getByRole("button", { name: "Send" }).click();
      assert.equal((await posted).status(), 201);
      await page.locator(".chat-msg.mine", { hasText: "Count me in, bringing chalk" }).waitFor();
      await noSideScroll(page, "Cleo chat");

      await page.getByRole("button", { name: "Back" }).click();
      await page.getByRole("button", { name: /Alerts/ }).first().click();
      const alert = page.locator(".alert-card", { hasText: note });
      await alert.first().waitFor();
      assert.equal(await alert.count(), 1, "one alert for the shared plan");
      await shot(page, "cleo-alerts");
      assert.deepEqual(cleoPhone.errors, []);
    } finally {
      await cleoPhone.page.context().close();
    }

    // Ben, only in Friends, sees Cleo in the joined list and her message in the same chat.
    const benPhone = await phone(width, height, ben.token);
    try {
      const page = benPhone.page;
      await open(page);
      const card = planCard(page, note);
      await card.waitFor();
      await card.getByText("Cleo is in").waitFor();
      assert.ok((await card.locator(".avatars").innerText()).includes("C"), "Cleo's avatar is on the card");
      await card.getByRole("button", { name: /^Chat/ }).click();
      const message = page.locator(".chat-msg", { hasText: "Count me in, bringing chalk" });
      await message.waitFor();
      assert.equal(await message.locator("strong").innerText(), "Cleo");
      await noSideScroll(page, "Ben chat");
      await shot(page, "ben-chat");
      assert.deepEqual(benPhone.errors, []);
    } finally {
      await benPhone.page.context().close();
    }

    // Across the whole run: one new-plan push each to Ben and Cleo, never a second.
    assert.equal(newPlanPushes(start, ends.cleo, planId).length, 1);
    assert.equal(newPlanPushes(start, ends.ben, planId).length, 1);

    // Ana unchecks Climbing. Quietly: no push to anyone.
    const anaAgain = await phone(width, height, ana.token, friends.id);
    try {
      const page = anaAgain.page;
      await open(page);
      await openEdit(page, note);
      const chip = page.locator(".sheet").getByRole("group", { name: "Also share with" }).getByRole("button", { name: "Climbing" });
      assert.equal(await chip.getAttribute("aria-pressed"), "true", "the sheet shows it as shared");
      await chip.click();
      assert.equal(await chip.getAttribute("aria-pressed"), "false");
      const before = sent.length;
      const patched = page.waitForResponse((response) => response.request().method() === "PATCH");
      await page.locator(".sheet").getByRole("button", { name: "Save" }).click();
      assert.deepEqual((await patched).request().postDataJSON().circleIds, [friends.id]);
      await page.locator(".sheet").waitFor({ state: "detached" });
      await planCard(page, note).waitFor();
      assert.equal(await planCard(page, note).locator(".plan-circles").count(), 0);
      assert.equal(sent.length, before, "unsharing sends nothing");
      assert.deepEqual(anaAgain.errors, []);
    } finally {
      await anaAgain.page.context().close();
    }

    const cleoAfter = await phone(width, height, cleo.token);
    try {
      const page = cleoAfter.page;
      await open(page);
      await page.getByRole("button", { name: "Plan", exact: true }).waitFor();
      await page.waitForLoadState("networkidle");
      assert.equal(await planCard(page, note).count(), 0, "Cleo no longer sees the plan");
      const plans = await call("GET", "/api/plans", cleo.token);
      assert.ok(!plans.plans.some((plan: { id: string }) => plan.id === planId));
    } finally {
      await cleoAfter.page.context().close();
    }
  });
}

test("a host in one circle sees no Also share with", { timeout: 60_000 }, async () => {
  const { ben, ends } = await seed("solo");
  const note = "Ben's walk";
  const made = (await call("POST", "/api/plans", ben.token, { note, time: "19:00" })).plan;
  for (const [width, height] of SIZES) {
    const { page, errors } = await phone(width, height, ben.token);
    try {
      await open(page);
      await openEdit(page, note);
      const sheet = page.locator(".sheet");
      await sheet.getByRole("button", { name: "Save" }).waitFor();
      assert.equal(await sheet.getByText("Also share with").count(), 0);
      assert.equal(await sheet.locator(".also-circles").count(), 0);
      await noSideScroll(page, "solo edit sheet");
      assert.deepEqual(errors, []);
    } finally {
      await page.context().close();
    }
  }
  assert.equal(newPlanPushes(0, ends.cleo, made.id).length, 0);
});
