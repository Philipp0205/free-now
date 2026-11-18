import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Locator, Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA, useHangry } from "./harness.js";
import { testEmail } from "../http.js";

// Fake people and messages only. Screenshots go to test/ui/screenshots (gitignored).
const shotsDir = path.resolve("test/ui/screenshots/chat-links-copy");
const hangry = useHangry({ tz: "UTC" });

const LINK_TEXT = "Menu is at https://example.com/menu?lang=en, it looks great.";
const PAYLOAD_TEXT = "javascript:alert(1) <img src=x onerror=alert(1)> <script>window.__pwned = 1</script> https://example.com/ok\"><b>bold</b>";

async function post(pathname: string, body: unknown, token?: string) {
  return hangry.call("POST", pathname, token, body);
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

for (const [width, height] of SIZES) {
  test(`event chat links are real links and Copy copies the message at ${width}x${height}`, { timeout: 120_000 }, async () => {
    const alex = await post("/api/auth/start", { email: testEmail(), name: "Alex" });
    const { circle } = await post("/api/circles", { name: "Friends" }, alex.token);
    const bea = await post("/api/auth/start", { email: testEmail(), name: "Bea", code: circle.inviteCode });
    hangry.confirmEmails();
    const social = await post("/api/socials", { note: "Ramen" }, alex.token);
    await post(`/api/socials/${social.social.id}/reply`, { reply: "in" }, bea.token);
    await post(`/api/socials/${social.social.id}/chat`, { text: LINK_TEXT }, bea.token);
    await post(`/api/socials/${social.social.id}/chat`, { text: PAYLOAD_TEXT }, bea.token);
    await post(`/api/socials/${social.social.id}/chat`, { text: "Mine: https://example.org/a_(b) (see https://example.org/c)." }, alex.token);

    const context = await hangry.browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: UA });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: hangry.baseUrl });
    await skipWhatsNew(context);
    await context.addInitScript((value) => {
      localStorage.setItem("fn_token", value);
      localStorage.setItem("fn_install_later", String(Date.now()));
    }, alex.token);
    await context.route("https://example.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>ok</title>" }));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      fs.mkdirSync(shotsDir, { recursive: true });
      const shot = (name: string) => page.screenshot({ path: path.join(shotsDir, `${name}-${width}x${height}.png`) });
      await page.goto(hangry.baseUrl);
      await page.locator(".tabbar").waitFor();
      await page.locator("article", { has: page.locator("h3", { hasText: "Ramen" }) }).locator(".chat-row").click();
      await page.locator(".chat-screen").waitFor();

      // The URL is a real link with safe attributes; the text around it stays text.
      const row = page.locator(".chat-msg", { hasText: "Menu is at" });
      await row.waitFor();
      const link = row.locator("p a");
      assert.equal(await link.count(), 1);
      assert.equal(await link.getAttribute("href"), "https://example.com/menu?lang=en", "the comma is not part of the link");
      assert.equal(await link.getAttribute("target"), "_blank");
      assert.equal(await link.getAttribute("rel"), "noopener noreferrer");
      assert.equal(await link.textContent(), "https://example.com/menu?lang=en");
      assert.equal(await row.locator("p").textContent(), LINK_TEXT);

      // Brackets: a balanced pair stays, a wrapping one goes.
      const mine = page.locator(".chat-msg.mine", { hasText: "Mine:" });
      assert.deepEqual(await mine.locator("p a").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("href"))), ["https://example.org/a_(b)", "https://example.org/c"]);

      // A javascript: or HTML payload stays text.
      const payload = page.locator(".chat-msg", { hasText: "javascript:alert(1)" });
      await payload.waitFor();
      assert.equal(await payload.locator("p").textContent(), PAYLOAD_TEXT, "every character is shown as text");
      assert.equal(await payload.locator("p img, p script, p b").count(), 0, "no injected tags");
      assert.deepEqual(await payload.locator("p a").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("href"))), ["https://example.com/ok"]);
      assert.equal(await page.locator(".chat-log img, .chat-log script, .chat-log b").count(), 0);
      assert.equal(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned), undefined);

      // The link is readable on the dark row and fits at this width.
      const colour = await link.evaluate((node) => getComputedStyle(node).color);
      assert.notEqual(colour, await row.locator("header time").evaluate((node) => getComputedStyle(node).color), "links stand out from the muted time");
      const sizes = await page.evaluate(() => ({ scroll: document.querySelector(".chat-log")!.scrollWidth, client: document.querySelector(".chat-log")!.clientWidth }));
      assert.ok(sizes.scroll <= sizes.client, "no sideways scroll");
      await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => null))));
      await shot("links");

      // A tap on the link opens it in a new tab and does not open the reaction bar.
      const popup = context.waitForEvent("page");
      await link.tap();
      const opened = await popup;
      assert.match(opened.url(), /^https:\/\/example\.com\/menu\?lang=en/);
      await opened.close();
      assert.equal(await row.locator(".react-bar").count(), 0, "a link tap does not open the bar");

      // Long-press someone else's message, tap Copy: toast and the full text on the clipboard.
      await page.evaluate(() => navigator.clipboard.writeText("stale"));
      await longPress(page, row.locator("p"));
      const bar = row.locator(".react-bar");
      await bar.waitFor();
      await page.waitForTimeout(750);
      await shot("bar");
      await bar.getByRole("button", { name: "Copy" }).tap();
      await page.locator(".toast", { hasText: "Copied" }).waitFor();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), LINK_TEXT);
      await bar.waitFor({ state: "detached" });
      await shot("copied");

      // Your own message too, and the payload comes out as the original text, not markup.
      await page.waitForTimeout(750);
      await longPress(page, mine.locator("p"));
      await mine.locator(".react-bar").waitFor();
      await page.waitForTimeout(750);
      await mine.locator(".react-bar").getByRole("button", { name: "Copy" }).tap();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "Mine: https://example.org/a_(b) (see https://example.org/c).");
      await page.waitForTimeout(750);
      await longPress(page, payload.locator("p"));
      await payload.locator(".react-bar").waitFor();
      await page.waitForTimeout(750);
      await payload.locator(".react-bar").getByRole("button", { name: "Copy" }).tap();
      await page.locator(".toast", { hasText: "Copied" }).waitFor();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), PAYLOAD_TEXT);

      assert.deepEqual(errors, [], "no page errors");
    } finally {
      await context.close();
    }
  });
}
