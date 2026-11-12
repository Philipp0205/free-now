import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { Locator, Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA as CHROME_UA, useHangry } from "./harness.js";

// Fake people and messages only. Screenshots go to test/ui/screenshots (gitignored).
const shotsDir = path.resolve("test/ui/screenshots/chat-caret");
const hangry = useHangry({ tz: "UTC" });

type Layout = { name: string; width: number; height: number };

for (const [width, height] of SIZES) {
  const layout: Layout = { name: `${width}x${height}`, width, height };

  test(`tapping in the composer to move the caret keeps focus at ${layout.name}`, { timeout: 120_000 }, async () => {
    const { page, input, ada } = await openChat();
    try {
      fs.mkdirSync(shotsDir, { recursive: true });
      await input.tap();
      await input.pressSequentially("Hello there friends, pizza tonight?");
      const before = await readComposer(page);
      assert.equal(before.active, "chat-input", "composer starts focused");
      assert.equal(before.value, "Hello there friends, pizza tonight?");
      assert.ok((before.sel ?? 0) >= before.value.length - 1, "caret is at the end after typing");

      await tapInsideInput(page, input, 40);
      const after = await readComposer(page);
      assert.equal(after.active, "chat-input", "tapping the text must not blur the composer");
      assert.equal(after.value, before.value, "the draft stays");
      assert.ok(after.sameNode, "the input node is not replaced");
      if (after.sel != null && before.sel != null) {
        assert.ok(after.sel < before.sel, `caret should move toward the tap (was ${before.sel}, now ${after.sel})`);
      }

      const touch = await touchActions(page);
      assert.notEqual(touch.html, "manipulation", "html { touch-action: manipulation } steals caret gestures on a phone");
      assert.equal(touch.input, "auto", "the composer must allow native caret movement");

      if (width === 360) await page.screenshot({ path: path.join(shotsDir, "caret-moved.png") });

      // Mention autocomplete is open: a caret tap must still keep the keyboard.
      await input.fill("");
      await input.tap();
      await input.pressSequentially("See you @");
      await page.locator(".mention-list").waitFor();
      await tapInsideInput(page, input, 40);
      assert.equal((await readComposer(page)).active, "chat-input", "caret tap with the @ list open keeps focus");
      assert.equal(await input.inputValue(), "See you @");
      if (width === 360) await page.screenshot({ path: path.join(shotsDir, "caret-with-mention.png") });

      // Reply preview is showing: same rule.
      await page.locator(".mention-list").waitFor({ state: "detached" }).catch(() => {});
      const last = page.locator(".chat-msg", { hasText: "Anyone up for ramen" });
      await last.scrollIntoViewIfNeeded();
      await longPress(page, last.locator("p"));
      const bar = last.locator(".react-bar");
      await bar.waitFor();
      await page.waitForTimeout(750);
      await bar.getByRole("button", { name: "Reply" }).tap();
      await page.locator(".chat-compose .reply-preview").waitFor();
      await input.fill("I can do Friday");
      await input.tap();
      assert.equal((await readComposer(page)).active, "chat-input");
      await tapInsideInput(page, input, 36);
      const replied = await readComposer(page);
      assert.equal(replied.active, "chat-input", "caret tap with a reply preview keeps focus");
      assert.equal(replied.value, "I can do Friday");
      if (width === 360) await page.screenshot({ path: path.join(shotsDir, "caret-with-reply.png") });

      // A friend's new message lands on the 3s poll. Refresh skips a full repaint while
      // the composer is focused, so the line may not show yet; the caret tap must still keep focus.
      const incoming = `Ada dropping in at ${width}`;
      await post("/api/circles/chat", { text: incoming }, ada.token);
      await page.waitForTimeout(4000);
      const mid = await readComposer(page);
      assert.equal(mid.active, "chat-input", "a poll after a new message must not blur the composer");
      assert.equal(mid.value, "I can do Friday");
      assert.ok(mid.sameNode, "the input node is not replaced while a message arrives");
      await tapInsideInput(page, input, 36);
      const afterIncoming = await readComposer(page);
      assert.equal(afterIncoming.active, "chat-input", "caret tap still works after a new message arrives");
      assert.equal(afterIncoming.value, "I can do Friday");
    } finally {
      await page.context().close();
    }

    async function openChat() {
      const alex = await post("/api/auth/start", { name: "Alex" });
      const circle = await post("/api/circles", { name: "Testers" }, alex.token);
      const ada = await post("/api/auth/start", { name: "Ada", code: circle.circle.inviteCode });
      await post("/api/circles/chat", { text: "Anyone up for ramen tonight at the usual place?" }, ada.token);
      const page = await openAs(alex.token, layout);
      await page.locator(".tabbar").getByRole("button", { name: /^Chat/ }).click();
      await page.getByText("Anyone up for ramen").waitFor();
      return { page, input: page.locator("#chat-input"), ada };
    }
  });
}

async function readComposer(page: Page) {
  return page.evaluate(() => {
    const el = document.getElementById("chat-input") as HTMLTextAreaElement | null;
    return {
      active: document.activeElement?.id || document.activeElement?.tagName || "",
      value: el?.value ?? "",
      sel: el?.selectionStart ?? null,
      sameNode: Boolean(el && el.isConnected),
    };
  });
}

async function touchActions(page: Page) {
  return page.evaluate(() => ({
    html: getComputedStyle(document.documentElement).touchAction,
    input: getComputedStyle(document.getElementById("chat-input")!).touchAction,
  }));
}

/** Tap inside the already-focused composer, toward the start of the text, to move the caret. */
async function tapInsideInput(page: Page, input: Locator, xFromLeft: number) {
  const box = await input.boundingBox();
  assert.ok(box, "composer is on screen");
  const x = Math.round(box.x + Math.min(Math.max(xFromLeft, 8), box.width - 8));
  const y = Math.round(box.y + box.height / 2);
  await page.touchscreen.tap(x, y);
  await page.waitForTimeout(80);
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

async function openAs(token: string, layout: Layout): Promise<Page> {
  const context = await hangry.browser.newContext({
    viewport: { width: layout.width, height: layout.height },
    isMobile: true,
    hasTouch: true,
    userAgent: CHROME_UA,
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
