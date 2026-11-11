import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { Locator, Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { UA as CHROME_UA, useHangry } from "./harness.js";

// Fake people and messages only. Screenshots go to test/ui/screenshots (gitignored).
const shotsDir = path.resolve("test/ui/screenshots/chat-replies");
const hangry = useHangry({ tz: "UTC" });
const DESKTOP_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

type Layout = { name: string; width: number; height: number; touch: boolean };
const LAYOUTS: Layout[] = [
  { name: "mobile", width: 360, height: 640, touch: true },
  { name: "desktop", width: 1024, height: 768, touch: false },
];

for (const layout of LAYOUTS) {
  test(`reply to a message, see the quote, and jump back to the original at ${layout.width}`, { timeout: 120_000 }, async () => {
    const alex = await post("/api/auth/start", { name: "Alex" });
    const circle = await post("/api/circles", { name: "Testers" }, alex.token);
    const ada = await post("/api/auth/start", { name: "Ada", code: circle.circle.inviteCode });
    const original = (await post("/api/circles/chat", { text: "Who wants to try the new ramen place on Friday?" }, ada.token)).chat.messages.at(-1);
    for (let i = 1; i <= 14; i += 1) await post("/api/circles/chat", { text: `Filler message ${i}` }, i % 2 ? alex.token : ada.token);
    const doomed = (await post("/api/circles/chat", { text: "Old idea, ignore this" }, ada.token)).chat.messages.at(-1);
    await post("/api/circles/chat", { text: "Bring a jacket, it gets cold" }, ada.token);

    const page = await openAs(alex.token, layout);
    try {
      fs.mkdirSync(shotsDir, { recursive: true });
      const shot = (name: string) => page.screenshot({ path: path.join(shotsDir, `${name}.png`) });
      await page.locator(".tabbar").getByRole("button", { name: /^Chat/ }).click();
      const last = page.locator(".chat-msg", { hasText: "Bring a jacket" });
      await last.waitFor();
      const input = page.locator("#chat-input");
      const preview = page.locator(".chat-compose .reply-preview");

      // Start a reply: the bar's Reply after a long-press on a phone, the arrow next to the time on desktop.
      if (layout.touch) {
        await longPress(page, last.locator("p"));
        const bar = last.locator(".react-bar");
        await bar.waitFor();
        assert.equal(await bar.locator(".react-pick").count(), 6);
        await shot("chat-reply-bar");
        await page.waitForTimeout(750);
        await bar.getByRole("button", { name: "Reply" }).tap();
        await bar.waitFor({ state: "detached" });
      } else {
        await last.hover();
        const reply = last.getByRole("button", { name: "Reply" });
        assert.ok(await reply.isVisible());
        await shot("chat-reply-hover-desktop");
        await reply.click();
      }
      await preview.waitFor();
      assert.equal(await preview.locator("strong").textContent(), "Ada");
      assert.equal(await preview.locator(".reply-preview-copy span").textContent(), "Bring a jacket, it gets cold");
      assert.ok(await input.evaluate((node) => node === document.activeElement), "the composer has focus");

      // The X drops the reply and keeps what you typed. Its hit area is at least 44px.
      await input.pressSequentially("draft stays");
      const cancel = preview.getByRole("button", { name: "Cancel reply" });
      const box = await cancel.boundingBox();
      assert.ok(box && box.width >= 44 && box.height >= 44, "44px X");
      if (layout.touch) await cancel.tap();
      else await cancel.click();
      await preview.waitFor({ state: "detached" });
      assert.equal(await input.inputValue(), "draft stays");
      await input.fill("");

      // A swipe right starts a reply on a phone; Escape drops it on desktop.
      const target = page.locator(`.chat-msg[data-id="${original.id}"]`);
      if (layout.touch) {
        await last.scrollIntoViewIfNeeded();
        await swipeRight(page, last.locator("p"));
        await preview.waitFor();
        assert.equal(await last.locator(".react-bar").count(), 0, "a swipe never opens the bar");
        // Chrome folds a tap that lands right after a swipe into the same gesture.
        await page.waitForTimeout(750);
        await cancel.tap();
        await preview.waitFor({ state: "detached" });
        await target.scrollIntoViewIfNeeded();
        await swipeRight(page, target.locator("p"));
      } else {
        await last.hover();
        await last.getByRole("button", { name: "Reply" }).click();
        await preview.waitFor();
        await page.keyboard.press("Escape");
        await preview.waitFor({ state: "detached" });
        assert.ok(await page.locator(".chat-screen").isVisible(), "Escape drops the reply, not the chat");
        await target.scrollIntoViewIfNeeded();
        await target.hover();
        await target.getByRole("button", { name: "Reply" }).click();
      }
      await preview.waitFor();
      assert.match((await preview.locator(".reply-preview-copy span").textContent()) || "", /^Who wants to try the new ramen place/);

      // An empty message is still not sent, and the preview stays.
      await page.getByRole("button", { name: "Send" }).click();
      assert.ok(await preview.isVisible());
      await input.pressSequentially("Count me in, 7pm?");
      await shot(layout.touch ? "chat-reply-composer" : "chat-reply-composer-desktop");
      const posted = page.waitForResponse((response) => response.url().endsWith("/api/circles/chat") && response.request().method() === "POST");
      await page.getByRole("button", { name: "Send" }).click();
      const response = await posted;
      assert.equal(response.status(), 201);
      assert.equal(JSON.parse(response.request().postData() || "{}").replyTo, original.id);
      await preview.waitFor({ state: "detached" });
      assert.equal(await input.inputValue(), "");

      const sent = page.locator(".chat-msg", { hasText: "Count me in, 7pm?" });
      await sent.waitFor();
      const quote = sent.locator(".chat-quote");
      assert.equal(await quote.locator("strong").textContent(), "Ada");
      assert.match((await quote.locator("span").textContent()) || "", /^Who wants to try/);
      const quoteBox = await quote.boundingBox();
      assert.ok(quoteBox && quoteBox.height < 48, "one compact quote, not a second bubble");
      await page.locator("#chat-input").blur();
      await shot(layout.touch ? "chat-reply-quote" : "chat-reply-quote-desktop");

      // Tapping the quote brings the original into view and lights it up.
      assert.equal(await inLog(page, target), false, "the original starts off screen");
      // A tap right after a swipe lift is ignored on purpose; let that lapse.
      await page.waitForTimeout(layout.touch ? 400 : 0);
      if (layout.touch) await quote.tap();
      else await quote.click();
      await page.waitForFunction(() => document.querySelector(".chat-msg.flash") !== null);
      assert.match((await target.getAttribute("class")) || "", /\bflash\b/);
      await page.waitForFunction(() => {
        const row = document.querySelector(".chat-msg.flash");
        const log = document.querySelector(".chat-log");
        if (!row || !log) return false;
        const a = row.getBoundingClientRect();
        const b = log.getBoundingClientRect();
        return a.top >= b.top && a.bottom <= b.bottom;
      });
      await page.waitForTimeout(250);
      await shot("chat-reply-highlight" + (layout.touch ? "" : "-desktop"));

      // A reply to a message that is later deleted keeps a quiet fallback and never the old text.
      await post("/api/circles/chat", { text: "Agreed, skip it", replyTo: doomed.id }, alex.token);
      await hangry.call("DELETE", `/api/messages/${doomed.id}`, ada.token);
      const fallback = page.locator(".chat-msg", { hasText: "Agreed, skip it" }).locator(".chat-quote");
      await fallback.waitFor({ timeout: 10_000 });
      await page.waitForFunction(() => document.querySelector(".chat-quote.gone") !== null, null, { timeout: 10_000 });
      assert.equal(await fallback.textContent(), "Original message deleted");
      assert.equal(await page.getByText("Old idea, ignore this").count(), 0);
      await fallback.scrollIntoViewIfNeeded();
      if (layout.touch) await shot("chat-reply-deleted");

      const sizes = await page.evaluate(() => ({ scroll: document.querySelector(".chat-log")!.scrollWidth, client: document.querySelector(".chat-log")!.clientWidth }));
      assert.ok(sizes.scroll <= sizes.client, "no sideways scroll");
    } finally {
      await page.context().close();
    }
  });
}

test("a reduced-motion flash has no animation and still marks the original", { timeout: 60_000 }, async () => {
  const alex = await post("/api/auth/start", { name: "Alex" });
  const circle = await post("/api/circles", { name: "Calm" }, alex.token);
  const ada = await post("/api/auth/start", { name: "Ada", code: circle.circle.inviteCode });
  const first = (await post("/api/circles/chat", { text: "Picnic Sunday?" }, ada.token)).chat.messages.at(-1);
  await post("/api/circles/chat", { text: "Yes please", replyTo: first.id }, alex.token);
  const page = await openAs(alex.token, LAYOUTS[0], true);
  try {
    await page.locator(".tabbar").getByRole("button", { name: /^Chat/ }).click();
    const quote = page.locator(".chat-msg", { hasText: "Yes please" }).locator(".chat-quote");
    await quote.waitFor();
    assert.equal(await quote.locator("strong").textContent(), "Ada");
    await quote.tap();
    const original = page.locator(`.chat-msg[data-id="${first.id}"]`);
    await page.waitForFunction(() => document.querySelector(".chat-msg.flash") !== null);
    assert.equal(await original.evaluate((node) => getComputedStyle(node).animationName), "none");
    assert.notEqual(await original.evaluate((node) => getComputedStyle(node).backgroundColor), "rgba(0, 0, 0, 0)");
    // Closed chats and system lines offer no Reply at all.
    assert.equal(await page.locator(".chat-system .chat-reply-btn, .chat-system .chat-quote").count(), 0);
  } finally {
    await page.context().close();
  }
});

async function inLog(page: Page, row: Locator): Promise<boolean> {
  return row.evaluate((node) => {
    const a = node.getBoundingClientRect();
    const b = document.querySelector(".chat-log")!.getBoundingClientRect();
    return a.bottom > b.top && a.top < b.bottom;
  });
}

async function longPress(page: Page, locator: Locator) {
  const box = await locator.boundingBox();
  assert.ok(box, "message is on screen");
  const point = { x: Math.round(box.x + 20), y: Math.round(box.y + box.height / 2) };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
  await page.waitForTimeout(600);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

/** A quick finger drag to the right, flat, like a real swipe. */
async function swipeRight(page: Page, locator: Locator) {
  const box = await locator.boundingBox();
  assert.ok(box, "message is on screen");
  const x = Math.round(box.x + 20);
  const y = Math.round(box.y + box.height / 2);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let dx = 8; dx <= 80; dx += 8) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + dx, y: y + 1 }] });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

async function openAs(token: string, layout: Layout, reducedMotion = false): Promise<Page> {
  const context = await hangry.browser.newContext({
    viewport: { width: layout.width, height: layout.height },
    isMobile: layout.touch,
    hasTouch: layout.touch,
    userAgent: layout.touch ? CHROME_UA : DESKTOP_UA,
    reducedMotion: reducedMotion ? "reduce" : "no-preference",
  });
  await skipWhatsNew(context);
  await context.addInitScript((value) => localStorage.setItem("fn_token", value), token);
  const page = await context.newPage();
  await page.goto(hangry.baseUrl);
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
  await page.locator(".tabbar").waitFor();
  return page;
}

async function post(pathname: string, body: unknown, token?: string) {
  return hangry.call("POST", pathname, token, body);
}
