import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { BrowserContext, Locator, Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { openYou, useHangry } from "./harness.js";
import { testEmail } from "../http.js";

// Desktop smoke test, run by the desktop-chrome, desktop-firefox and desktop-webkit projects
// (playwright.config.ts): 1440x900, mouse and keyboard only, prefers-color-scheme: light.
// Hangry must still render its dark look and every screen must be usable with a mouse.
// Fake people and messages only. useHangry launches the browser that matches the project.
const browserName = () => test.info().project.name.replace(/^desktop-/, "");
const shotsDir = () => path.resolve("test/ui/screenshots/desktop-smoke", browserName());
const hangry = useHangry({ tz: "UTC" });

type Rgba = [number, number, number, number];
type Pair = { fg: string; bg: string; bgImage: boolean; opacity: number };

async function post(pathname: string, body: unknown, token?: string) {
  return hangry.call("POST", pathname, token, body);
}

async function desktop(token?: string): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const context = await hangry.browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    colorScheme: "light",
  });
  await skipWhatsNew(context);
  await context.addInitScript((value) => {
    if (value) localStorage.setItem("fn_token", value);
    localStorage.setItem("fn_install_later", String(Date.now()));
  }, token ?? "");
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return { context, page, errors };
}

function parse(css: string): Rgba {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/.exec(css);
  assert.ok(m, `unreadable colour ${css}`);
  const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  return [Number(m[1]), Number(m[2]), Number(m[3]), a];
}

function over(top: Rgba, under: Rgba): Rgba {
  const a = top[3] + under[3] * (1 - top[3]);
  if (a === 0) return [0, 0, 0, 0];
  const mix = (i: number) => (top[i] * top[3] + under[i] * under[3] * (1 - top[3])) / a;
  return [mix(0), mix(1), mix(2), a];
}

function luminance([r, g, b]: Rgba): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function ratio(a: Rgba, b: Rgba): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Waits for the tab and screen fade-ins, so colours and screenshots are not taken mid-animation. */
async function settle(page: Page) {
  await page.evaluate(() => Promise.all(
    document.getAnimations()
      .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
      .map((animation) => animation.finished.catch(() => null)),
  ).then(() => undefined));
}

/** The text colour of a node and the opaque colour behind it, flattened up the ancestor chain. */
async function colours(page: Page, selector: string): Promise<{ fg: Rgba; bg: Rgba; bgImage: boolean }> {
  await settle(page);
  const found = await page.locator(selector).first().evaluate((node): Pair => {
    const layers: string[] = [];
    let bgImage = false;
    let opacity = 1;
    for (let at: Element | null = node; at; at = at.parentElement) {
      const style = getComputedStyle(at);
      if (at !== node && style.backgroundImage !== "none") bgImage = true;
      opacity *= Number(style.opacity);
      layers.push(style.backgroundColor);
    }
    return { fg: getComputedStyle(node).color, bg: JSON.stringify(layers), bgImage, opacity };
  });
  assert.equal(found.opacity, 1, `${selector} is fully opaque once settled, got ${found.opacity}`);
  // Paint from the page colour (opaque black canvas is what a dark scheme gets) up to the node.
  let bg: Rgba = [0, 0, 0, 1];
  for (const layer of (JSON.parse(found.bg) as string[]).reverse()) bg = over(parse(layer), bg);
  return { fg: over(parse(found.fg), bg), bg, bgImage: found.bgImage };
}

async function assertContrast(page: Page, selector: string, what: string) {
  const { fg, bg, bgImage } = await colours(page, selector);
  assert.equal(bgImage, false, `${what}: sits on a gradient, measure it another way`);
  const value = ratio(fg, bg);
  assert.ok(value >= 4.5, `${what}: contrast ${value.toFixed(2)} (text ${fg.map(Math.round)}, behind ${bg.map(Math.round)})`);
}

/**
 * Text over a gradient or image: hides the text, screenshots its box and returns the brightest pixel
 * behind it. That is the worst case for light text, in any browser, whatever the card paints.
 */
async function assertContrastOverPaint(page: Page, node: Locator, what: string) {
  await node.scrollIntoViewIfNeeded();
  await settle(page);
  const fg = parse(await node.evaluate((el) => getComputedStyle(el).color));
  const opacity = await node.evaluate((el) => {
    let value = 1;
    for (let at: Element | null = el; at; at = at.parentElement) value *= Number(getComputedStyle(at).opacity);
    return value;
  });
  assert.equal(opacity, 1, `${what}: fully opaque once settled`);
  const box = await node.boundingBox();
  assert.ok(box && box.width > 0 && box.height > 0, `${what}: has a box`);
  const previous = await node.evaluate((el) => {
    const old = el.getAttribute("style");
    (el as HTMLElement).style.setProperty("color", "transparent", "important");
    (el as HTMLElement).style.setProperty("text-shadow", "none", "important");
    return old;
  });
  const png = await page.screenshot({ clip: box });
  await node.evaluate((el, old) => { if (old === null) el.removeAttribute("style"); else el.setAttribute("style", old); }, previous);
  const brightest = await page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(image, 0, 0);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let best = [0, 0, 0];
    let bestSum = -1;
    for (let i = 0; i < data.length; i += 4) {
      const sum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      if (sum > bestSum) { bestSum = sum; best = [data[i], data[i + 1], data[i + 2]]; }
    }
    return best;
  }, png.toString("base64"));
  const bg: Rgba = [brightest[0], brightest[1], brightest[2], 1];
  const value = ratio(over(fg, bg), bg);
  assert.ok(value >= 4.5, `${what}: contrast ${value.toFixed(2)} (text ${fg.map(Math.round)}, brightest behind ${brightest})`);
}

async function shot(page: Page, name: string) {
  fs.mkdirSync(shotsDir(), { recursive: true });
  await settle(page);
  await page.screenshot({ path: path.join(shotsDir(), `${name}.png`) });
}

test("a light OS still gets the readable, mouse-friendly dark Hangry on desktop", { timeout: 150_000 }, async () => {
  const viewportHeight = 900;
  const alex = await post("/api/auth/start", { email: testEmail(), name: "Alex" });
  const { circle } = await post("/api/circles", { name: "Friends" }, alex.token);
  const bea = await post("/api/auth/start", { email: testEmail(), name: "Bea", code: circle.inviteCode });
  hangry.confirmEmails();
  const social = await post("/api/socials", { note: "Ramen" }, alex.token);
  await post(`/api/socials/${social.social.id}/reply`, { reply: "in" }, bea.token);
  await post(`/api/socials/${social.social.id}/chat`, { text: "Running 5 min late" }, bea.token);
  await post(`/api/socials/${social.social.id}/chat`, { text: "Menu is at https://example.com/menu and it looks great" }, bea.token);
  await post(`/api/socials/${social.social.id}/chat`, { text: "@Goblin the buttons feel small on my laptop" }, alex.token);
  // A plan with a long description, so its details are taller than a half-height sheet.
  const description = "Bring a jacket, the terrace gets windy after sunset. We split the bill evenly and nobody counts coffee. "
    .repeat(8).trim();
  const climbing = await post("/api/plans", { note: "Climbing", time: "19:30" }, alex.token);
  await hangry.call("PATCH", `/api/plans/${climbing.plan.id}`, alex.token, { description });

  // The sign-in screen: the Continue button has a visible fill.
  const out = await desktop();
  try {
    await out.page.goto(hangry.baseUrl);
    const button = out.page.getByRole("button", { name: "Continue" });
    await button.waitFor();
    assert.equal(await out.page.locator("html").getAttribute("data-ak-scheme"), "dark");
    const body = parse(await out.page.evaluate(() => getComputedStyle(document.body).backgroundColor));
    const fill = parse(await button.evaluate((node) => getComputedStyle(node).backgroundColor));
    assert.ok(fill[3] > 0.9, `Continue has a solid fill, got alpha ${fill[3]}`);
    assert.ok(ratio(fill, body) >= 3, `Continue stands out from the page: ${ratio(fill, body).toFixed(2)}`);
    await assertContrast(out.page, ".gate .btn, form .btn[type=submit]", "Continue label");
    await shot(out.page, "sign-in");
    assert.deepEqual(out.errors, [], "no page errors on the sign-in screen");
  } finally {
    await out.context.close();
  }

  const { context, page, errors } = await desktop(alex.token);
  try {
    await page.goto(hangry.baseUrl);
    await page.locator(".tabbar").waitFor();
    assert.equal(await page.locator("html").getAttribute("data-ak-scheme"), "dark");
    const body = parse(await page.evaluate(() => getComputedStyle(document.body).backgroundColor));
    assert.ok(luminance(body) < 0.05, `body is dark, got ${body}`);
    assert.equal(await page.evaluate(() => matchMedia("(prefers-color-scheme: light)").matches), true, "the OS really is light");
    const themeColors = await page.evaluate(() => [...document.querySelectorAll('meta[name="theme-color"]')].map((meta) => meta.getAttribute("content")));
    assert.ok(themeColors.length > 0 && themeColors.every((value) => value === "#000000"), `dark theme colour, got ${themeColors}`);
    assert.equal(await page.evaluate(() => matchMedia("(hover: hover) and (pointer: fine)").matches), true, "a mouse, so the desktop rules apply");

    const tabs = page.locator(".tabbar");

    // Now: every card title is readable on its card, and the tab bar is dark.
    await page.locator("article h3", { hasText: "Ramen" }).waitFor();
    await page.locator("article h3", { hasText: "Climbing" }).waitFor();
    const titles = page.locator("article.card h3");
    const titleCount = await titles.count();
    assert.ok(titleCount >= 2, `the Now tab lists both events, got ${titleCount}`);
    for (let n = 0; n < titleCount; n += 1) {
      await assertContrastOverPaint(page, titles.nth(n), `Now card title ${n}`);
    }
    const navbar = parse(await page.locator(".tabbar").evaluate((node) => getComputedStyle(node).backgroundColor));
    assert.ok(luminance(over(navbar, [255, 255, 255, 1])) < 0.2, `the tab bar is dark even over a light page, got ${navbar}`);
    await shot(page, "now");

    // The kit's pull to refresh is touch only: a mouse drag down from the top of Now starts nothing and leaves no spinner.
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains("ak-no-bounce")), true, "html keeps ak-no-bounce");
    assert.equal(await page.evaluate(() => document.scrollingElement!.scrollTop), 0);
    await page.mouse.move(720, 120);
    await page.mouse.down();
    await page.mouse.move(720, 200, { steps: 4 });
    await page.mouse.move(720, 340, { steps: 6 });
    assert.equal(await page.locator(".ak-ptr.ak-ptr-pulling, .ak-ptr.ak-ptr-loading").count(), 0, "a mouse drag does not pull");
    await page.mouse.up();
    await page.waitForTimeout(500);
    assert.equal(await page.locator(".ak-ptr-loading").count(), 0, "no stuck refresh spinner after a mouse drag");
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains("ak-no-bounce")), true);
    await page.mouse.move(5, 5);

    // Event details open at full height with a mouse: not stuck at the half stop.
    await page.locator("article h3", { hasText: "Climbing" }).click();
    const details = page.getByRole("dialog", { name: "Details" });
    await details.waitFor();
    await settle(page);
    const detailBox = (await details.boundingBox())!;
    await shot(page, "event-sheet");
    assert.ok(detailBox.y >= 0 && detailBox.y + detailBox.height <= viewportHeight + 1, `the details sheet is inside the window: ${JSON.stringify(detailBox)}`);
    assert.equal(await details.evaluate((node) => (node as HTMLElement).style.maxHeight), "", "the details sheet is not held at a half stop");
    const detailClipped = await details.evaluate((node) => [node, ...node.querySelectorAll("*")]
      .filter((el) => /(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1)
      .map((el) => `${el.className}: ${el.scrollHeight} > ${el.clientHeight}`));
    assert.deepEqual(detailClipped, [], "the details sheet shows all of its content");
    await assertContrastOverPaint(page, details.locator("h2"), "Event sheet title");
    await page.locator(".scrim").click({ position: { x: 10, y: 10 } });
    await details.waitFor({ state: "detached" });

    // Events
    await tabs.getByRole("button", { name: "Events", exact: true }).click();
    await page.locator(".events-view").waitFor();
    await shot(page, "events");

    // Circle, then the member sheet.
    await tabs.getByRole("button", { name: "Circle", exact: true }).click();
    await page.locator(".member-row").first().waitFor();
    await assertContrast(page, ".panel h3", "Circle card heading");
    await assertContrast(page, ".code-block", "Circle invite code");
    await shot(page, "circle");
    await page.getByRole("button", { name: "Details for Bea" }).click();
    const sheet = page.getByRole("dialog", { name: "Bea" });
    await sheet.waitFor();
    await settle(page);
    const memberBox = (await sheet.boundingBox())!;
    assert.ok(memberBox.y >= 0 && memberBox.y + memberBox.height <= viewportHeight + 1, `the member sheet is inside the window: ${JSON.stringify(memberBox)}`);
    const clipped = await sheet.evaluate((node) => [node, ...node.querySelectorAll("*")]
      .filter((el) => /(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1)
      .map((el) => `${el.className}: ${el.scrollHeight} > ${el.clientHeight}`));
    assert.deepEqual(clipped, [], "the member sheet shows all of its content, nothing is hidden below the fold");
    await assertContrast(page, ".sheet h2", "Member sheet name");
    await shot(page, "member-sheet");
    await page.locator(".scrim").click({ position: { x: 10, y: 10 } });
    await sheet.waitFor({ state: "detached" });

    // You
    await openYou(page);
    const headings = page.locator(".page h3");
    const count = await headings.count();
    assert.ok(count >= 5, `the You tab lists its sections, got ${count}`);
    for (let n = 0; n < count; n += 1) {
      const selector = `.page .nav-row >> nth=${n} >> h3`;
      await assertContrast(page, selector, `You tab section heading ${n}`);
    }
    await assertContrast(page, ".page h1", "You tab title");
    await shot(page, "you");

    // Back to Now, open the event chat and send messages with the keyboard.
    await tabs.getByRole("button", { name: "Now", exact: true }).click();
    await page.locator("article", { has: page.locator("h3", { hasText: "Ramen" }) }).locator(".chat-row").click();
    const screen = page.locator(".chat-screen");
    await screen.waitFor();
    await page.locator(".chat-msg", { hasText: "Running 5 min late" }).waitFor();
    await page.locator(".chat-msg.goblin").waitFor();
    await assertContrast(page, ".chat-head h1", "Chat title");
    await assertContrast(page, ".chat-head h1 .chat-title", "Chat title button");

    // The title is a button: a click opens the event details at full height on top of the chat, and closing returns to it.
    const titleButton = page.getByRole("button", { name: "Event details" });
    assert.equal((await titleButton.textContent())?.trim(), "Ramen", "the title button still shows the event name");
    assert.equal(await titleButton.evaluate((node) => getComputedStyle(node).cursor), "pointer", "the title has a pointer cursor");
    await page.locator("#chat-log").evaluate((node) => { node.scrollTop = 0; });
    const chatScroll = await page.locator("#chat-log").evaluate((node) => node.scrollTop);
    await titleButton.click();
    const chatDetails = page.getByRole("dialog", { name: "Details" });
    await chatDetails.waitFor();
    await settle(page);
    await shot(page, "chat-event-details");
    const chatDetailBox = (await chatDetails.boundingBox())!;
    assert.ok(chatDetailBox.y >= 0 && chatDetailBox.y + chatDetailBox.height <= viewportHeight + 1, `the chat details sheet is inside the window: ${JSON.stringify(chatDetailBox)}`);
    assert.equal(await chatDetails.evaluate((node) => (node as HTMLElement).style.maxHeight), "", "the chat details sheet is not held at a half stop");
    assert.match((await chatDetails.getAttribute("data-snap")) || "", /^event-detail:social:/);
    assert.equal((await chatDetails.locator("h2").textContent())?.trim(), "Ramen");
    await chatDetails.getByText("Who's in").waitFor();
    assert.equal(await page.locator(".chat-screen").count(), 1, "the chat stays under the sheet");
    await page.locator(".scrim").click({ position: { x: 10, y: 10 } });
    await chatDetails.waitFor({ state: "detached" });
    await screen.waitFor();
    assert.equal(await page.locator("#chat-log").evaluate((node) => node.scrollTop), chatScroll, "the log keeps its place");
    // Keyboard: the title button takes focus, and Enter opens the sheet; Escape closes it and leaves the chat open.
    await titleButton.focus();
    await page.keyboard.press("Enter");
    await chatDetails.waitFor();
    await page.keyboard.press("Escape");
    await chatDetails.waitFor({ state: "detached" });
    await screen.waitFor();
    await page.locator(".chat-msg", { hasText: "Running 5 min late" }).waitFor();
    const input = page.locator("#chat-input");
    await input.click();
    await page.keyboard.type("On my way, save me a seat");
    await page.keyboard.press("Enter");
    const sent = page.locator(".chat-msg", { hasText: "On my way, save me a seat" });
    await sent.waitFor();
    assert.equal(await input.inputValue(), "", "the composer clears after Enter");

    // Every message body is readable: plain, link, the Goblin's, mine.
    const bodies = page.locator(".chat-msg p");
    const bodyCount = await bodies.count();
    assert.ok(bodyCount >= 5, `all messages are listed, got ${bodyCount}`);
    for (let n = 0; n < bodyCount; n += 1) await assertContrast(page, `.chat-msg >> nth=${n} >> p`, `Chat message body ${n}`);
    await assertContrast(page, ".chat-msg.goblin p", "Goblin message body");
    await assertContrast(page, ".chat-msg.mine header strong", "Own message name");
    const chatBg = parse(await screen.evaluate((node) => getComputedStyle(node).backgroundColor));
    assert.ok(luminance(chatBg) < 0.05, `the chat screen is dark, got ${chatBg}`);

    // Delete shows only while the mouse is over the row, or the button has keyboard focus.
    const mine = page.locator(".chat-msg.mine", { hasText: "On my way, save me a seat" });
    const remove = mine.locator(".chat-delete");
    await page.mouse.move(5, 5);
    await settle(page);
    assert.equal(await remove.evaluate((node) => Number(getComputedStyle(node).opacity)), 0, "Delete is hidden until the row is hovered");
    await mine.hover();
    await settle(page);
    assert.equal(await remove.evaluate((node) => Number(getComputedStyle(node).opacity)), 1, "Delete shows while the row is hovered");
    await shot(page, "chat-hover");
    await page.mouse.move(5, 5);
    await remove.focus();
    await settle(page);
    assert.equal(await remove.evaluate((node) => Number(getComputedStyle(node).opacity)), 1, "Delete shows when it has keyboard focus");
    await remove.evaluate((node) => (node as HTMLElement).blur());

    // A click-and-hold on a row does not paint a selection.
    const row = page.locator(".chat-msg", { hasText: "Running 5 min late" });
    const box = (await row.boundingBox())!;
    await page.mouse.move(box.x + 40, box.y + 10);
    await page.mouse.down();
    await page.waitForTimeout(700);
    assert.equal(await page.evaluate(() => window.getSelection()?.toString() ?? ""), "", "holding the mouse on a row selects nothing");
    await page.mouse.up();
    assert.equal(await page.evaluate(() => window.getSelection()?.toString() ?? ""), "", "a click on a row selects nothing");
    await shot(page, "chat");

    // The URL is a real link, and a mouse click on it is a link click, not a row action.
    const MENU_TEXT = "Menu is at https://example.com/menu and it looks great";
    const menuRow = page.locator(".chat-msg", { hasText: "Menu is at" });
    const link = menuRow.locator("p a");
    assert.equal(await link.count(), 1);
    assert.equal(await link.getAttribute("href"), "https://example.com/menu");
    assert.equal(await link.getAttribute("target"), "_blank");
    assert.equal(await link.getAttribute("rel"), "noopener noreferrer");
    assert.equal(await link.textContent(), "https://example.com/menu");
    assert.equal(await menuRow.locator("p").textContent(), MENU_TEXT);
    await assertContrast(page, ".chat-msg p a", "Chat link");
    // Stop the navigation itself (no network from a test) and record what the click hit.
    await page.evaluate(() => {
      const hits: string[] = [];
      (window as unknown as { __linkClicks: string[] }).__linkClicks = hits;
      window.addEventListener("click", (event) => {
        const anchor = (event.target as Element).closest?.("a");
        if (anchor) { hits.push(anchor.href); event.preventDefault(); }
      }, true);
    });
    await link.click();
    assert.deepEqual(await page.evaluate(() => (window as unknown as { __linkClicks: string[] }).__linkClicks), ["https://example.com/menu"]);
    assert.equal(await menuRow.locator(".react-bar").count(), 0, "a link click does not open the action menu");
    assert.equal(await page.evaluate(() => window.getSelection()?.toString() ?? ""), "", "a link click selects nothing");

    // Open the action menu with the React button (mouse), click Copy, and the full text is copied.
    await page.evaluate(() => {
      const copied: string[] = [];
      (window as unknown as { __copied: string[] }).__copied = copied;
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { copied.push(text); } } });
    });
    await menuRow.hover();
    await menuRow.getByRole("button", { name: "React" }).click();
    const bar = menuRow.locator(".react-bar");
    await bar.waitFor();
    await settle(page);
    await shot(page, "chat-menu");
    await bar.getByRole("button", { name: "Copy" }).click();
    await page.locator(".toast", { hasText: "Copied" }).waitFor();
    assert.deepEqual(await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied), [MENU_TEXT]);
    await bar.waitFor({ state: "detached" });
    await shot(page, "chat-copied");
    assert.equal(await page.evaluate(() => window.getSelection()?.toString() ?? ""), "", "Copy leaves no selection");

    // Any emoji with a mouse: React button, +, search in the picker, click a non-quick emoji, and a pill appears.
    const partyRow = page.locator(".chat-msg", { hasText: "Running 5 min late" });
    await partyRow.hover();
    await partyRow.getByRole("button", { name: "React" }).click();
    const reactBar = partyRow.locator(".react-bar");
    await reactBar.waitFor();
    assert.deepEqual(
      await reactBar.locator(".react-row > button").evaluateAll((nodes) => nodes.map((node) => node.textContent)),
      ["👍", "❤️", "😂", "😮", "😢", "🔥", "+"],
    );
    await reactBar.getByRole("button", { name: "More emoji" }).click();
    const emojiPicker = partyRow.locator("emoji-picker");
    const emojiSearch = emojiPicker.locator("input.search");
    await emojiSearch.waitFor();
    await emojiPicker.locator('button.emoji[role="menuitem"]').first().waitFor({ timeout: 30_000 });
    assert.ok((await emojiPicker.locator('button[role="tab"]').count()) >= 8, "the picker has category tabs");
    assert.equal(
      await emojiPicker.evaluate((node) => getComputedStyle(node.shadowRoot!.querySelector(".picker")!).backgroundColor),
      "rgb(28, 28, 30)",
      "the picker is dark on a light OS",
    );
    await shot(page, "chat-picker");
    await emojiSearch.fill("party popper");
    const partyPopper = emojiPicker.locator('button.emoji[aria-label*="party popper"]').first();
    await partyPopper.waitFor({ timeout: 15_000 });
    await shot(page, "chat-picker-search");
    const reacted = page.waitForResponse((response) => response.url().includes("/reactions") && response.request().method() === "POST");
    await partyPopper.click();
    assert.equal((await reacted).status(), 200);
    await reactBar.waitFor({ state: "detached" });
    const popperPill = partyRow.locator('.react-pill[data-emoji="🎉"]');
    await popperPill.waitFor();
    assert.equal(await popperPill.locator(".react-count").textContent(), "1");
    assert.equal(await popperPill.getAttribute("aria-pressed"), "true", "the pill is mine");
    assert.equal(await page.evaluate(() => window.getSelection()?.toString() ?? ""), "", "the picker leaves no selection");
    await shot(page, "chat-picker-pill");
    // Taking it back with a click on the pill.
    const takenBack = page.waitForResponse((response) => response.url().includes("/reactions") && response.request().method() === "POST");
    await popperPill.click();
    assert.equal((await takenBack).status(), 200);
    await popperPill.waitFor({ state: "detached" });

    assert.deepEqual(errors, [], "no page errors");
  } finally {
    await context.close();
  }
});
