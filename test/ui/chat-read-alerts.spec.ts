import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { Page } from "playwright-core";
import { flushChatNotices } from "../../src/chat/chat.js";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA, useHangry } from "./harness.js";

// Fake people and messages only. Screenshots go to test/ui/screenshots (gitignored).
const SHOT_DIR = path.resolve("test/ui/screenshots/chat-read-alerts");

const hangry = useHangry({ beforeClose: () => flushChatNotices(true) });
const { call } = hangry;

async function phone(width: number, height: number, token: string, circleId: string) {
  const context = await hangry.browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: UA });
  await skipWhatsNew(context);
  await context.addInitScript(([value, circle]) => {
    // Seed once per tab, so a reload keeps whatever the app saved itself.
    if (sessionStorage.getItem("cra_seeded")) return;
    sessionStorage.setItem("cra_seeded", "1");
    localStorage.setItem("fn_install_later", String(Date.now()));
    localStorage.setItem("fn_token", value);
    localStorage.setItem("fn_circle", circle);
  }, [token, circleId]);
  await context.route("https://*.tile.openstreetmap.org/**", (route) => route.fulfill({ status: 204, body: "" }));
  return context.newPage();
}

async function dismiss(page: Page) {
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
}

async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const size = page.viewportSize()!;
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}-${size.width}x${size.height}.png`) });
}

const bell = (page: Page) => page.locator(".screen-head .icon-btn[aria-label^='Alerts']");
const switchDot = (page: Page) => page.locator(".circle-switch-btn .unread-dot");
const menuDot = (page: Page, name: string) => page.locator(".circle-menu button", { hasText: name }).locator(".unread-dot");

async function openMenu(page: Page) {
  if (await page.locator(".circle-menu").count()) return;
  await page.getByRole("button", { name: "Switch circle" }).click();
  await page.locator(".circle-menu").waitFor();
}

async function closeMenu(page: Page) {
  if (await page.locator(".circle-menu").count()) await page.getByRole("button", { name: "Switch circle" }).click();
}

/** Reload and wait until the app has asked the server for alerts again, so "still cleared" is server truth. */
async function reloadAndSync(page: Page) {
  const synced = page.waitForResponse((r) => r.url().includes("/api/notifications") && r.request().method() === "GET");
  await page.reload();
  await dismiss(page);
  await page.locator(".tabbar").waitFor();
  await synced;
  await page.getByRole("button", { name: "Switch circle" }).waitFor();
}

async function signUpPair(width: number) {
  const finn = await call("POST", "/api/auth/start", undefined, { name: "Finn" });
  const home = (await call("POST", "/api/circles", finn.token, { name: `Home ${width}` })).circle;
  const uni = (await call("POST", "/api/circles", finn.token, { name: `Uni ${width}` })).circle;
  const uma = await call("POST", "/api/auth/start", undefined, { name: "Uma", code: home.inviteCode });
  await call("POST", "/api/circles/join", uma.token, { code: uni.inviteCode });
  // Joining told Finn and not Uma, but start both clean.
  for (const circle of [home, uni]) {
    await call("POST", `/api/notifications/read?circle=${circle.id}`, uma.token);
    await call("POST", `/api/notifications/read?circle=${circle.id}`, finn.token);
  }
  return { finn, uma, home, uni };
}

for (const [width, height] of SIZES) {
  test(`at ${width}: opening the circle chat clears its alerts, not the other circle's, and a reload agrees`, { timeout: 120_000 }, async () => {
    const { finn, uma, home, uni } = await signUpPair(width);
    const page = await phone(width, height, uma.token, home.id);
    try {
      await page.goto(hangry.baseUrl);
      await dismiss(page);
      await page.getByRole("button", { name: "Switch circle" }).waitFor();
      assert.equal(await bell(page).locator(".badge").count(), 0);
      assert.equal(await switchDot(page).count(), 0);

      // Finn mentions Uma in both circles' chats (both alerts carry the ref "circle").
      await call("POST", `/api/circles/chat?circle=${home.id}`, finn.token, { text: "@Uma dinner at Home?" });
      await call("POST", `/api/circles/chat?circle=${uni.id}`, finn.token, { text: "@Uma library at Uni?" });

      await bell(page).locator(".badge").waitFor({ timeout: 10_000 });
      assert.equal(await bell(page).getAttribute("aria-label"), "Alerts, 1 unread");
      await switchDot(page).waitFor();
      await openMenu(page);
      await menuDot(page, `Home ${width}`).waitFor();
      await menuDot(page, `Uni ${width}`).waitFor();
      await shot(page, "1-circle-before");
      await closeMenu(page);

      // Chat tab, never the Alerts tab.
      await page.locator(".tabbar button[aria-label^='Chat']").click();
      await page.getByText("dinner at Home?").last().waitFor();
      await page.getByRole("button", { name: "Back" }).click();
      await bell(page).locator(".badge").waitFor({ state: "detached", timeout: 10_000 });
      assert.equal(await bell(page).getAttribute("aria-label"), "Alerts");
      await openMenu(page);
      assert.equal(await menuDot(page, `Home ${width}`).count(), 0);
      await menuDot(page, `Uni ${width}`).waitFor();
      await switchDot(page).waitFor();
      await shot(page, "2-circle-after-home-chat");

      // The server agrees, and a reload shows the same.
      const me = await call("GET", `/api/me?circle=${home.id}`, uma.token);
      assert.deepEqual(
        Object.fromEntries(me.circles.map((c: { id: string; alertUnread: number }) => [c.id, c.alertUnread])),
        { [home.id]: 0, [uni.id]: 1 },
      );
      await reloadAndSync(page);
      assert.equal(await bell(page).locator(".badge").count(), 0);
      await openMenu(page);
      assert.equal(await menuDot(page, `Home ${width}`).count(), 0);
      await menuDot(page, `Uni ${width}`).waitFor();
      await shot(page, "3-circle-after-reload");
    } finally {
      await page.context().close();
    }
  });

  test(`at ${width}: opening a plan chat clears its mention and reaction alerts, and they stay cleared after a reload`, { timeout: 120_000 }, async () => {
    const { finn, uma, home } = await signUpPair(width);
    const plan = (await call("POST", `/api/plans?circle=${home.id}`, finn.token, { note: "Pizza night", time: "19:30" })).plan;
    // Uma has seen the new-plan alert; only chat alerts are left to arrive.
    await call("POST", `/api/notifications/read?circle=${home.id}`, uma.token);
    const mine = await call("POST", `/api/plans/${plan.id}/chat?circle=${home.id}`, uma.token, { text: "Who brings drinks?" });
    const mineId = mine.chat.messages.find((m: { mine: boolean }) => m.mine).id as string;
    await flushChatNotices(true);

    const page = await phone(width, height, uma.token, home.id);
    try {
      await page.goto(hangry.baseUrl);
      await dismiss(page);
      await page.getByRole("button", { name: "Switch circle" }).waitFor();
      await page.getByRole("heading", { name: "Pizza night" }).waitFor();
      assert.equal(await bell(page).locator(".badge").count(), 0);
      assert.equal(await switchDot(page).count(), 0);

      await call("POST", `/api/plans/${plan.id}/chat?circle=${home.id}`, finn.token, { text: "@Uma I do" });
      await call("POST", `/api/messages/${mineId}/reactions`, finn.token, { emoji: "👍" });

      await bell(page).locator(".badge").waitFor({ timeout: 10_000 });
      assert.equal(await bell(page).getAttribute("aria-label"), "Alerts, 2 unread");
      await switchDot(page).waitFor();
      await shot(page, "4-plan-before");

      // The event's Chat button, never the Alerts tab.
      await page.locator(".chat-row").first().click();
      await page.getByText("I do").last().waitFor();
      await shot(page, "5-plan-chat-open");
      await page.getByRole("button", { name: "Back" }).click();
      await page.getByRole("heading", { name: "Pizza night" }).waitFor();
      await bell(page).locator(".badge").waitFor({ state: "detached", timeout: 10_000 });
      assert.equal(await bell(page).getAttribute("aria-label"), "Alerts");
      await switchDot(page).waitFor({ state: "detached", timeout: 10_000 });
      await shot(page, "6-plan-after");

      const me = await call("GET", `/api/me?circle=${home.id}`, uma.token);
      assert.ok(me.circles.every((c: { alertUnread: number }) => c.alertUnread === 0));
      await reloadAndSync(page);
      assert.equal(await bell(page).locator(".badge").count(), 0);
      assert.equal(await switchDot(page).count(), 0);
      await shot(page, "7-plan-after-reload");

      // The alert rows themselves show as read (this is the first time Alerts opens).
      const listed = await call("GET", `/api/notifications?circle=${home.id}`, uma.token);
      const chats = listed.notifications.filter((n: { kind: string }) => n.kind === "chat");
      assert.equal(chats.length, 2);
      assert.ok(chats.every((n: { readAt: number | null }) => n.readAt != null));
    } finally {
      await page.context().close();
    }
  });
}
