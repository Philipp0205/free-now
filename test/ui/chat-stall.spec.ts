import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "@playwright/test";
import type { Page, Route } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { UA, useHangry } from "./harness.js";

// Fake people and messages only. Screenshots go to test/ui/screenshots (gitignored).
const SHOT_DIR = path.resolve("test/ui/screenshots/chat-stall");

const hangry = useHangry();
const { call } = hangry;

const PLANS_LIST = /\/api\/plans(\?|$)/;
const EVENT_CHAT = /\/api\/(plans|socials)\/[^/]+\/chat(\?|$)/;

async function seed() {
  const finn = await call("POST", "/api/auth/start", undefined, { name: "Finn" });
  const circle = (await call("POST", "/api/circles", finn.token, { name: "Stall test" })).circle;
  const uma = await call("POST", "/api/auth/start", undefined, { name: "Uma", code: circle.inviteCode });
  const plan = (await call("POST", "/api/plans", finn.token, { note: "Pizza night", time: "23:59" })).plan;
  const social = (await call("POST", "/api/socials", finn.token, { note: "Coffee now" })).social;
  await call("POST", `/api/plans/${plan.id}/chat`, finn.token, { text: "Bring plates" });
  await call("POST", `/api/socials/${social.id}/chat`, finn.token, { text: "Table by the window" });
  return { uma, circle };
}

async function openApp(token: string, circleId: string, clock = false, baseUrl = hangry.baseUrl) {
  const context = await hangry.browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: UA,
  });
  await skipWhatsNew(context);
  await context.addInitScript(([value, circle]) => {
    localStorage.setItem("fn_install_later", String(Date.now()));
    localStorage.setItem("fn_token", value);
    localStorage.setItem("fn_circle", circle);
  }, [token, circleId]);
  await context.route("https://*.tile.openstreetmap.org/**", (route) => route.fulfill({ status: 204, body: "" }));
  const page = await context.newPage();
  if (clock) await page.clock.install();
  await page.goto(baseUrl);
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
  await page.locator(".tabbar").waitFor();
  await page.getByRole("heading", { name: "Pizza night" }).waitFor();
  await page.getByRole("heading", { name: "Coffee now" }).waitFor();
  return page;
}

async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}-390x844.png`) });
}

const planRow = (page: Page) => page.locator("article.card-plan .chat-row");
const socialRow = (page: Page) => page.locator("article.card-now .chat-row");
// history.length never shrinks on Back, so read the overlay depth the app stamps on its own entries.
const overlayDepth = (page: Page) => page.evaluate(() => (history.state?.hangryOverlay as number | undefined) ?? 0);

test("a stalled /api/plans GET is not stacked up by the poll", { timeout: 40_000 }, async () => {
  const { uma, circle } = await seed();
  const page = await openApp(uma.token, circle.id);
  try {
    const held: Route[] = [];
    await page.route(PLANS_LIST, (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      held.push(route);
      return undefined;
    });
    // Two poll ticks (3s each) and a bit more. Without single-flight each tick adds another pending GET.
    await page.waitForTimeout(7000);
    assert.ok(held.length >= 1, "the poll asked for plans at least once");
    assert.ok(held.length <= 1, `at most one /api/plans GET is pending, saw ${held.length}`);
    await shot(page, "1-plans-held");
  } finally {
    await page.context().close();
  }
});

test("tapping an event chat row shows the chat at once while its GET is held, and Back returns", { timeout: 40_000 }, async () => {
  const { uma, circle } = await seed();
  const page = await openApp(uma.token, circle.id);
  try {
    await page.route(EVENT_CHAT, (route) => (route.request().method() === "GET" ? undefined : route.fallback()));
    assert.equal(await overlayDepth(page), 0);

    for (const [name, row] of [["plan", planRow(page)], ["social", socialRow(page)]] as const) {
      await row.click();
      await page.locator(".chat-screen .chat-log", { hasText: "Loading…" }).waitFor({ timeout: 1000 });
      assert.equal(await overlayDepth(page), 1, `${name}: opening pushes one history entry`);
      await shot(page, `2-${name}-loading`);

      await page.getByRole("button", { name: "Back" }).click();
      await page.locator(".chat-screen").waitFor({ state: "detached", timeout: 2000 });
      await page.getByRole("heading", { name: "Pizza night" }).waitFor();
      await page.waitForFunction(() => !history.state?.hangryOverlay);

      // The phone's own Back closes it too.
      await row.click();
      await page.locator(".chat-screen .chat-log", { hasText: "Loading…" }).waitFor({ timeout: 1000 });
      await page.goBack();
      await page.locator(".chat-screen").waitFor({ state: "detached", timeout: 2000 });
      await page.getByRole("heading", { name: "Coffee now" }).waitFor();
    }
    await shot(page, "3-back-on-list");
  } finally {
    await page.context().close();
  }
});

test("held chat GETs time out, many open and close cycles work, and a chat opens once they are released", { timeout: 60_000 }, async () => {
  const { uma, circle } = await seed();
  const page = await openApp(uma.token, circle.id, true);
  try {
    const held: Route[] = [];
    const failed: string[] = [];
    page.on("requestfailed", (request) => {
      if (EVENT_CHAT.test(request.url())) failed.push(request.url());
    });
    await page.route(EVENT_CHAT, (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      held.push(route);
      return undefined;
    });

    let cycles = 0;
    for (let round = 0; round < 4; round += 1) {
      for (const row of [planRow(page), socialRow(page)]) {
        await row.click();
        await page.locator(".chat-screen .chat-log", { hasText: "Loading…" }).waitFor({ timeout: 1000 });
        await page.getByRole("button", { name: "Back" }).click();
        await page.locator(".chat-screen").waitFor({ state: "detached", timeout: 2000 });
        cycles += 1;
      }
    }
    assert.ok(cycles >= 8);
    assert.ok(held.length >= 8, `every open asked for its thread, saw ${held.length}`);

    // The 15 second GET timeout, run on the fake clock instead of waiting for it.
    await page.clock.fastForward(16_000);
    await page.waitForFunction(() => true);
    for (let wait = 0; wait < 20 && failed.length < held.length; wait += 1) await page.waitForTimeout(100);
    assert.ok(failed.length >= 1, "held chat GETs were aborted by the app");

    // Network is back: nothing held any more.
    await page.unroute(EVENT_CHAT);
    for (const route of held.splice(0)) await route.abort().catch(() => {});

    await planRow(page).click();
    await page.getByText("Bring plates").waitFor({ timeout: 10_000 });
    await page.locator("#chat-input").waitFor();
    await shot(page, "4-plan-chat-after-release");
    await page.getByRole("button", { name: "Back" }).click();
    await page.locator(".chat-screen").waitFor({ state: "detached" });

    await socialRow(page).click();
    await page.getByText("Table by the window").waitFor({ timeout: 10_000 });
    await page.locator("#chat-input").waitFor();
    await shot(page, "5-social-chat-after-release");
  } finally {
    await page.context().close();
  }
});

test("six API GETs that never answer do not leave event chats stuck", { timeout: 80_000 }, async () => {
  const { uma, circle } = await seed();
  // A real socket in front of the app. Chrome allows 6 connections per host on HTTP/1.1, so six dead GETs fill them all.
  let stallLeft = 0;
  const target = new URL(hangry.baseUrl);
  const proxy = http.createServer((req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/api/") && stallLeft > 0) {
      stallLeft -= 1;
      req.on("error", () => {});
      return;
    }
    const upstream = http.request({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers: req.headers }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    upstream.on("error", () => res.destroy());
    req.pipe(upstream);
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", () => resolve()));
  const page = await openApp(uma.token, circle.id, false, `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`);
  try {
    stallLeft = 6;
    // Poll ticks and tab taps while the network is dead.
    for (const name of ["Events", "Circle", "You", "Now"]) {
      await page.locator(".tabbar").getByRole("button", { name }).click();
      await page.waitForTimeout(1500);
    }
    await planRow(page).click();
    await shot(page, "6-stalled-network");
    // The stalled GETs give up after 15 seconds and the thread arrives once the network answers again.
    await page.getByText("Bring plates").waitFor({ timeout: 45_000 });
    await page.locator("#chat-input").waitFor();
    await shot(page, "7-opened-after-stall");
  } finally {
    await page.context().close();
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
});
