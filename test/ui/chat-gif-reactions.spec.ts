import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Locator, Page } from "playwright-core";
import type { GiphyFetch } from "../../src/chat/giphy.js";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA, useHangry } from "./harness.js";
import { testEmail } from "../http.js";
import { FIELD_REVEAL_MS } from "../../public/js/keyboard.js";

// Fake people, a fake key and a fake Giphy. The server gets a stub fetch and the browser gets mocked images, so
// nothing here reaches giphy.com. Screenshots go to test/ui/screenshots (gitignored).
const shotsDir = path.resolve("test/ui/screenshots/gif-reactions");
const KEY = "test-giphy-key";

const asked: string[] = [];
const giphyFetch: GiphyFetch = async (url) => {
  asked.push(url);
  const q = new URL(url).searchParams.get("q");
  const names = q ? [`${q} one`, `${q} two`] : ["Trending one", "Trending two", "Trending three"];
  const data = names.map((title, index) => {
    const id = `${q ? `s${q}` : "t"}${index}`;
    const image = (file: string, width: number, height: number) => ({ url: `https://media${index}.giphy.com/media/${id}/${file}?cid=x`, width: String(width), height: String(height) });
    return { id, title, images: { fixed_width: image("200w.gif", 200, 150), fixed_width_small: image("100w.gif", 100, 75) } };
  });
  return { ok: true, status: 200, json: async () => ({ data }) };
};

const on = useHangry({ tz: "UTC", env: { GIPHY_API_KEY: KEY }, giphyFetch });
const off = useHangry({ tz: "UTC" });

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="150" viewBox="0 0 200 150"><rect width="200" height="150" fill="#ff4d8d"/><circle cx="100" cy="75" r="40" fill="#fff"/></svg>';

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

const chatPost = (page: Page) => page.waitForResponse((response) => /\/chat$/.test(response.url()) && response.request().method() === "POST");

async function loaded(image: Locator) {
  await image.waitFor();
  await image.evaluate((node) => (node as HTMLImageElement).decode());
  assert.ok(await image.evaluate((node) => (node as HTMLImageElement).naturalWidth > 0), "the GIF image loaded");
}

async function phone(hangry: typeof on, token: string, width: number, height: number) {
  const context = await hangry.browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: UA, serviceWorkers: "block" });
  await skipWhatsNew(context);
  await context.addInitScript((value) => {
    localStorage.setItem("fn_token", value);
    localStorage.setItem("fn_install_later", String(Date.now()));
  }, token);
  const outside: string[] = [];
  await context.route(/^https:\/\/(media\d*|i)\.giphy\.com\//, (route) => route.fulfill({ status: 200, contentType: "image/svg+xml", body: SVG }));
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const url = request.url();
    if (!url.startsWith(hangry.baseUrl) && !/^https:\/\/(media\d*|i)\.giphy\.com\//.test(url)) outside.push(url);
  });
  return { context, page, errors, outside };
}

async function seed(hangry: typeof on) {
  const post = (pathname: string, body: unknown, token?: string) => hangry.call("POST", pathname, token, body);
  const alex = await post("/api/auth/start", { email: testEmail(), name: "Alex" });
  const { circle } = await post("/api/circles", { name: "Friends" }, alex.token);
  const bea = await post("/api/auth/start", { email: testEmail(), name: "Bea", code: circle.inviteCode });
  hangry.confirmEmails();
  const social = await post("/api/socials", { note: "Ramen" }, alex.token);
  await post(`/api/socials/${social.social.id}/reply`, { reply: "in" }, bea.token);
  await post(`/api/socials/${social.social.id}/chat`, { text: "Who is bringing the party hats?" }, bea.token);
  return { alex, bea };
}

async function openChat(page: Page, hangry: typeof on) {
  await page.goto(hangry.baseUrl);
  await page.locator(".tabbar").waitFor();
  await page.locator("article", { has: page.locator("h3", { hasText: "Ramen" }) }).locator(".chat-row").click();
  await page.locator(".chat-screen").waitFor();
  await page.locator(".chat-msg", { hasText: "party hats" }).waitFor();
  // The chat slides in and scrolls to its end: press only once the row has stopped moving.
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => null))));
  await page.waitForTimeout(500);
}

for (const [width, height] of SIZES) {
  test(`pick a GIF, search, send it, and answer a message with one at ${width}x${height}`, { timeout: 150_000 }, async () => {
    const { alex } = await seed(on);
    const { context, page, errors, outside } = await phone(on, alex.token, width, height);
    try {
      fs.mkdirSync(shotsDir, { recursive: true });
      const shot = async (name: string) => {
        await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().endTime !== Infinity).map((a) => a.finished.catch(() => null))));
        await page.screenshot({ path: path.join(shotsDir, `${name}-${width}x${height}.png`) });
      };
      await openChat(page, on);
      const compose = page.locator(".chat-compose");
      const button = compose.getByRole("button", { name: /GIF/ });
      await button.waitFor();
      assert.equal(await button.textContent(), "GIF");
      assert.equal(await button.getAttribute("aria-label"), "Choose a GIF");
      // The composer still fits its row: the field, the GIF button and Send inside the screen.
      for (const item of [button, compose.getByRole("button", { name: "Send" }), compose.locator("textarea")]) {
        const box = (await item.boundingBox())!;
        assert.ok(box.x >= 0 && box.x + box.width <= width + 0.5, `composer control fits: ${JSON.stringify(box)}`);
      }
      await shot("composer");

      // The sheet opens on trending, without the keyboard, and says whose it is.
      const requestsBefore = asked.length;
      await button.tap();
      const sheet = page.getByRole("dialog", { name: "GIFs" });
      await sheet.waitFor();
      await sheet.getByRole("heading", { name: "GIFs" }).waitFor();
      const search = sheet.getByRole("searchbox", { name: "Search GIFs" });
      await search.waitFor();
      assert.equal(await search.getAttribute("enterkeyhint"), "search");
      const trending = sheet.getByRole("button", { name: /^Send GIF: Trending/ });
      await trending.first().waitFor();
      assert.equal(await trending.count(), 3);
      assert.equal(asked.length, requestsBefore + 1, "one trending lookup");
      assert.match(asked[asked.length - 1], /\/gifs\/trending\?/);
      assert.equal(new URL(asked[asked.length - 1]).searchParams.get("rating"), "pg-13");
      await sheet.getByText("Powered by GIPHY").waitFor();
      assert.equal(await page.evaluate(() => document.activeElement?.id === "gif-query"), true, "the search box is focused on open, on a phone too");
      const box = (await sheet.boundingBox())!;
      assert.ok(box.x >= 0 && box.x + box.width <= width + 0.5 && box.y >= 0 && box.y + box.height <= height + 0.5, `the sheet fits the screen: ${JSON.stringify(box)}`);
      await loaded(sheet.locator(".gif-pick img").first());
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, "no sideways scroll");
      await shot("sheet-trending");

      // Searching shows the matches, and clearing the box brings trending back.
      await search.tap();
      await search.pressSequentially("cat");
      await sheet.getByRole("button", { name: "Send GIF: cat one" }).waitFor();
      assert.equal(await sheet.getByRole("button", { name: /^Send GIF:/ }).count(), 2);
      assert.ok(asked.some((url) => new URL(url).pathname.endsWith("/search") && new URL(url).searchParams.get("q") === "cat"));
      await shot("sheet-search");
      await search.fill("");
      await trending.first().waitFor();
      assert.equal(await trending.count(), 3, "empty search is trending again");

      // Picking a GIF sends it, closes the sheet and shows the animated image from Giphy.
      await search.fill("cat");
      const pick = sheet.getByRole("button", { name: "Send GIF: cat two" });
      await pick.waitFor();
      const sent = chatPost(page);
      await pick.tap();
      const response = await sent;
      assert.equal(response.status(), 201);
      const body = response.request().postDataJSON();
      assert.deepEqual(Object.keys(body.gif).sort(), ["height", "id", "title", "url", "width"]);
      assert.equal(body.gif.id, "scat1");
      assert.equal(body.gif.url, "https://media1.giphy.com/media/scat1/200w.gif");
      assert.equal(body.replyTo, undefined, "from the composer it is not a reply");
      await sheet.waitFor({ state: "detached" });
      const mine = page.locator(".chat-msg .chat-gif img");
      await loaded(mine);
      assert.equal(await mine.getAttribute("alt"), "GIF: cat two");
      assert.equal(await mine.getAttribute("src"), "https://media1.giphy.com/media/scat1/200w.gif");
      assert.equal(await page.locator(".chat-screen").count(), 1, "the chat is still open");
      await shot("sent");

      // From a message's reaction bar a GIF is an answer to that message.
      const row = page.locator(".chat-msg", { hasText: "party hats" });
      await page.waitForTimeout(750);
      await longPress(page, row.locator("p"));
      const bar = row.locator(".react-bar");
      await bar.waitFor();
      await page.waitForTimeout(750);
      const buttons = bar.locator(".react-row > button");
      assert.deepEqual(await buttons.evaluateAll((nodes) => nodes.map((node) => node.textContent)), ["👍", "❤️", "😂", "😮", "😢", "🔥", "+", "GIF"]);
      const barBox = (await bar.boundingBox())!;
      assert.ok(barBox.x >= 0 && barBox.x + barBox.width <= width + 0.5, `the bar fits the screen: ${JSON.stringify(barBox)}`);
      for (const item of await buttons.all()) {
        const itemBox = (await item.boundingBox())!;
        assert.ok(itemBox.x >= barBox.x - 0.5 && itemBox.x + itemBox.width <= barBox.x + barBox.width + 0.5, `a bar button fits the bar: ${JSON.stringify(itemBox)}`);
        assert.ok(itemBox.width >= 30 && itemBox.height >= 30, "and stays easy to hit");
      }
      assert.equal(await bar.locator(".react-pick").count(), 6, "emoji reactions are unchanged");
      await shot("bar");
      await bar.getByRole("button", { name: "React with a GIF" }).tap();
      await sheet.waitFor();
      await sheet.getByText("Replying to Bea").waitFor();
      await trending.first().waitFor();
      await shot("sheet-reply");
      const replied = chatPost(page);
      await sheet.getByRole("button", { name: "Send GIF: Trending two" }).tap();
      const reply = await replied;
      assert.equal(reply.status(), 201);
      const replyBody = reply.request().postDataJSON();
      assert.equal(replyBody.gif.id, "t1");
      assert.ok(typeof replyBody.replyTo === "string" && replyBody.replyTo.length > 0, "sent as a reply");
      await sheet.waitFor({ state: "detached" });
      await bar.waitFor({ state: "detached" });
      const answer = page.locator(".chat-msg", { has: page.locator('img[alt="GIF: Trending two"]') });
      await loaded(answer.locator(".chat-gif img"));
      await answer.locator(".chat-quote").getByText("party hats").waitFor();
      assert.equal(await page.locator(".chat-gif img").count(), 2);
      assert.equal(await page.locator(".react-pill").count(), 0, "a GIF reply adds no emoji reaction");
      await shot("reply");

      // Close without picking: the button, and nothing is sent.
      const sentBefore = await page.locator(".chat-msg").count();
      await button.tap();
      await sheet.waitFor();
      await sheet.getByRole("button", { name: "Close", exact: true }).tap();
      await sheet.waitFor({ state: "detached" });
      assert.equal(await page.locator(".chat-msg").count(), sentBefore);

      // The key and the rating stay on the server.
      const html = await page.content();
      assert.ok(!html.includes(KEY), "the page never has the key");
      assert.ok(asked.every((url) => new URL(url).searchParams.get("api_key") === KEY), "the server added the key");
      assert.deepEqual(outside, [], "no request leaves the app but the GIF images");
      assert.deepEqual(errors, [], "no page errors");
    } finally {
      await context.close();
    }
  });
}

for (const [width, height] of SIZES) {
  test(`the GIF search is focused on open, types without a tap, and the sheet fits with the keyboard up at ${width}x${height}`, { timeout: 120_000 }, async () => {
    const { alex } = await seed(on);
    const { context, page, errors, outside } = await phone(on, alex.token, width, height);
    // Record every scrollIntoView, to prove the GIF field never asks the page to scroll.
    await context.addInitScript(() => {
      const original = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function scrollIntoView(this: Element, ...args: []) {
        (window as unknown as { __scrolled: string[] }).__scrolled = [...((window as unknown as { __scrolled?: string[] }).__scrolled || []), this.id || this.tagName];
        return original.apply(this, args);
      };
    });
    try {
      fs.mkdirSync(shotsDir, { recursive: true });
      await openChat(page, on);
      const logTop = () => page.evaluate(() => document.querySelector(".chat-log")!.scrollTop);
      const pageScroll = () => page.evaluate(() => ({ x: window.scrollX, y: window.scrollY, doc: document.scrollingElement!.scrollTop }));
      const logBefore = await logTop();

      await page.locator(".chat-compose").getByRole("button", { name: /GIF/ }).tap();
      const sheet = page.getByRole("dialog", { name: "GIFs" });
      const search = sheet.getByRole("searchbox", { name: "Search GIFs" });
      await search.waitFor();
      // Focused straight away, with no tap on the field, and the page and chat log have not moved.
      assert.equal(await page.evaluate(() => document.activeElement?.id), "gif-query", "the search box is focused on open");
      assert.deepEqual(await pageScroll(), { x: 0, y: 0, doc: 0 }, "focusing does not scroll the page");
      assert.equal(await logTop(), logBefore, "focusing does not move the chat log");

      // Typing works at once and shows results from the fake Giphy.
      await page.keyboard.type("dog");
      assert.equal(await search.inputValue(), "dog");
      await sheet.getByRole("button", { name: "Send GIF: dog one" }).waitFor();
      assert.equal(await sheet.getByRole("button", { name: /^Send GIF:/ }).count(), 2);
      assert.ok(asked.some((url) => new URL(url).pathname.endsWith("/search") && new URL(url).searchParams.get("q") === "dog"));

      // The keyboard comes up: the layout viewport shrinks by 280px, as on a phone that resizes its content.
      const shrunk = Math.max(260, height - 280);
      await page.setViewportSize({ width, height: shrunk });
      await page.waitForTimeout(FIELD_REVEAL_MS + 300);
      const placed = await page.evaluate(() => {
        const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
        const view = window.visualViewport!;
        const log = document.querySelector(".chat-log")!;
        const scroll = rect(".gif-scroll");
        return {
          viewTop: view.offsetTop,
          viewBottom: view.offsetTop + view.height,
          viewWidth: view.width,
          sheet: rect(".gif-sheet"),
          head: rect(".gif-sheet .sheet-head"),
          field: rect("#gif-query"),
          scroll,
          dock: rect(".gif-credit"),
          focused: document.activeElement?.id,
          sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          logGap: log.scrollHeight - log.scrollTop - log.clientHeight,
          scrolled: (window as unknown as { __scrolled?: string[] }).__scrolled || [],
          page: { x: window.scrollX, y: window.scrollY, doc: document.scrollingElement!.scrollTop },
        };
      });
      const note = JSON.stringify(placed);
      assert.equal(placed.focused, "gif-query", "the field keeps focus with the keyboard up");
      assert.ok(placed.sheet.top >= placed.viewTop - 1 && placed.sheet.bottom <= placed.viewBottom + 1, `the sheet is inside the visible viewport: ${note}`);
      assert.ok(placed.sheet.left >= -1 && placed.sheet.right <= placed.viewWidth + 1, `the sheet fits sideways: ${note}`);
      assert.ok(placed.head.top >= placed.viewTop - 1, `the sheet head is visible: ${note}`);
      assert.ok(placed.field.top >= placed.head.top - 1 && placed.field.bottom <= placed.sheet.bottom + 1, `the search field is in the sheet: ${note}`);
      assert.ok(placed.field.bottom <= placed.viewBottom, `the search field is above the keyboard: ${note}`);
      assert.ok(placed.scroll.top >= placed.field.bottom - 1, `the results sit under the field: ${note}`);
      assert.ok(placed.scroll.height > 40, `the results keep some room: ${note}`);
      assert.ok(placed.dock.top >= placed.scroll.bottom - 1 && placed.dock.top >= placed.field.bottom, `the credit does not cover the field: ${note}`);
      assert.ok(placed.dock.bottom <= placed.viewBottom + 1, `the credit is above the keyboard: ${note}`);
      assert.equal(placed.sideways, false, `no sideways scroll: ${note}`);
      assert.deepEqual(placed.page, { x: 0, y: 0, doc: 0 }, `the page did not jump: ${note}`);
      assert.ok(placed.logGap < 48, `the chat log is still at its end: ${note}`);
      assert.ok(!placed.scrolled.includes("gif-query"), `the field did not scroll the page: ${note}`);
      await page.screenshot({ path: path.join(shotsDir, `focus-keyboard-${width}x${height}.png`) });

      // The sheet still works with the keyboard up, and gives the room back when it goes.
      await sheet.getByRole("button", { name: "Send GIF: dog two" }).waitFor();
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(300);
      const restored = (await sheet.boundingBox())!;
      assert.ok(restored.y >= 0 && restored.y + restored.height <= height + 0.5, `the sheet fits after the keyboard goes: ${JSON.stringify(restored)}`);
      assert.deepEqual(outside, [], "no request leaves the app but the GIF images");
      assert.deepEqual(errors, [], "no page errors");
    } finally {
      await context.close();
    }
  });
}

test("with no Giphy key there is no GIF button and no GIF control, and no error shows", { timeout: 90_000 }, async () => {
  const { alex } = await seed(off);
  const { context, page, errors, outside } = await phone(off, alex.token, 360, 640);
  try {
    fs.mkdirSync(shotsDir, { recursive: true });
    await openChat(page, off);
    const compose = page.locator(".chat-compose");
    await compose.getByRole("button", { name: "Send" }).waitFor();
    assert.equal(await page.getByRole("button", { name: /GIF/ }).count(), 0, "no GIF button in the composer");
    await page.screenshot({ path: path.join(shotsDir, "no-key-composer-360x640.png") });
    const row = page.locator(".chat-msg", { hasText: "party hats" });
    await longPress(page, row.locator("p"));
    const bar = row.locator(".react-bar");
    await bar.waitFor();
    await page.waitForTimeout(750);
    assert.deepEqual(await bar.locator(".react-row > button").evaluateAll((nodes) => nodes.map((node) => node.textContent)), ["👍", "❤️", "😂", "😮", "😢", "🔥", "+"]);
    assert.equal(await bar.getByRole("button", { name: "React with a GIF" }).count(), 0);
    await page.screenshot({ path: path.join(shotsDir, "no-key-bar-360x640.png") });
    const status = await page.evaluate(async (token) => (await fetch("/api/giphy/trending", { headers: { authorization: `Bearer ${token}` } })).status, alex.token);
    assert.equal(status, 404);
    assert.equal(await page.locator(".status-banner, .toast, [role=alert]").count(), 0, "no error is shown");
    assert.deepEqual(outside, []);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});
