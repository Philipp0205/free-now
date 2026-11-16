import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { UA as CHROME_UA, useHangry } from "./harness.js";
import { testEmail } from "../http.js";
// Fake people and messages only. Screenshots go to test/ui/screenshots (gitignored).
const shotsDir = path.resolve("test/ui/screenshots/chat-mentions-reactions");
const hangry = useHangry({ tz: "UTC" });
const DESKTOP_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

type Layout = { name: string; width: number; height: number; touch: boolean };
const LAYOUTS: Layout[] = [
  { name: "mobile", width: 360, height: 640, touch: true },
  { name: "desktop", width: 1024, height: 768, touch: false },
];

for (const layout of LAYOUTS) {
  test(`@ tags a friend and a quick reaction toggles at ${layout.width}`, { timeout: 120_000 }, async () => {
    const alex = await post("/api/auth/start", { email: testEmail(), name: "Alex" });
    const circle = await post("/api/circles", { name: "Testers" }, alex.token);
    const ada = await post("/api/auth/start", { email: testEmail(), name: "Ada", code: circle.circle.inviteCode });
    await post("/api/auth/start", { email: testEmail(), name: "Alexandra", code: circle.circle.inviteCode });
    await post("/api/auth/start", { email: testEmail(), name: "Bea", code: circle.circle.inviteCode });
    await post("/api/circles/chat", { text: "Anyone up for ramen?" }, ada.token);
    await post("/api/circles/chat", { text: "@Alex you in? Bring @Bea" }, ada.token);

    const page = await openAs(alex.token, layout);
    try {
      fs.mkdirSync(shotsDir, { recursive: true });
      const shot = (name: string) => page.screenshot({ path: path.join(shotsDir, `${name}.png`) });
      await page.locator(".tabbar").getByRole("button", { name: /^Chat/ }).click();
      await page.getByText("Anyone up for ramen?").waitFor();

      // A mention of you stands out; a mention of someone else is in their colour.
      const tagged = page.locator(".chat-msg", { hasText: "you in?" });
      await tagged.locator(".mention.me").waitFor();
      assert.equal(await tagged.locator(".mention.me").textContent(), "@Alex");
      assert.equal(await tagged.locator(".mention:not(.me)").textContent(), "@Bea");

      const input = page.locator("#chat-input");
      await input.click();
      await input.pressSequentially("See you @");
      const list = page.locator(".mention-list");
      await list.waitFor();
      assert.deepEqual(await list.locator(".mention-option").allTextContents(), ["Ada", "Alexandra", "Bea", "👺Goblin"], "everyone but you, then the Goblin");
      await input.pressSequentially("a");
      assert.deepEqual(await list.locator(".mention-option").allTextContents(), ["Ada", "Alexandra"], "filters as you type");
      if (layout.name === "mobile") {
        await shot("chat-mention-autocomplete");
        await page.keyboard.press("Escape");
        await list.waitFor({ state: "detached" });
        assert.ok(await page.locator(".chat-screen").isVisible(), "Escape closes the list, not the chat");
        await input.pressSequentially("d");
        await list.waitFor();
        await list.locator(".mention-option", { hasText: "Ada" }).tap();
      } else {
        await shot("chat-mention-autocomplete-desktop");
        await page.keyboard.press("ArrowDown");
        assert.equal(await list.locator(".mention-option.active").textContent(), "Alexandra");
        await page.keyboard.press("ArrowUp");
        await page.keyboard.press("Enter");
      }
      await list.waitFor({ state: "detached" });
      assert.equal(await input.inputValue(), "See you @Ada ");
      await input.pressSequentially("at 7");
      await page.getByRole("button", { name: "Send" }).click();

      const sent = page.locator(".chat-msg", { hasText: "See you @Ada at 7" });
      await sent.waitFor();
      const mention = sent.locator(".mention");
      assert.equal(await mention.textContent(), "@Ada");
      const adaColor = await page.evaluate(async () => {
        const response = await fetch("/api/circles/chat", { headers: { authorization: `Bearer ${localStorage.getItem("fn_token")}` } });
        const body = await response.json();
        return body.chat.participants.find((person: { name: string }) => person.name === "Ada").color as string;
      });
      assert.equal(await mention.evaluate((node) => getComputedStyle(node).color), hexToRgb(adaColor), "the mention is in Ada's colour");
      await page.locator("#chat-input").blur();
      if (layout.name === "mobile") await shot("chat-mention-highlighted");

      // Open the quick-reaction bar: a long-press on a phone, the smile on desktop.
      const target = page.locator(".chat-msg", { hasText: "Anyone up for ramen?" });
      if (layout.touch) await longPress(page, target.locator("p"));
      else {
        await target.hover();
        const smile = target.getByRole("button", { name: "React" });
        assert.ok(await smile.isVisible());
        await smile.click();
      }
      const bar = target.locator(".react-bar");
      await bar.waitFor();
      assert.equal(await bar.locator(".react-pick").count(), 6);
      await shot(layout.name === "mobile" ? "chat-reaction-bar" : "chat-reaction-bar-desktop");

      const toggled = page.waitForResponse((response) => response.url().includes("/reactions") && response.request().method() === "POST");
      await tapOrClick(page, layout, bar.getByRole("button", { name: "React 👍" }));
      assert.equal((await toggled).status(), 200);
      await bar.waitFor({ state: "detached" });
      const pill = target.locator(".react-pill");
      await pill.waitFor();
      assert.equal(await pill.count(), 1);
      assert.equal(await pill.locator(".react-emoji").textContent(), "👍");
      assert.equal(await pill.locator(".react-count").textContent(), "1");
      assert.equal(await pill.getAttribute("aria-pressed"), "true");
      assert.match((await pill.getAttribute("class")) || "", /\bmine\b/);
      assert.equal(await pill.getAttribute("title"), "Alex");

      // A friend's reaction shows up on the next refresh.
      const message = (await get("/api/circles/chat", ada.token)).chat.messages.find((item: { text: string }) => item.text === "Anyone up for ramen?");
      await post(`/api/messages/${message.id}/reactions`, { emoji: "🔥" }, ada.token);
      await target.locator('.react-pill[data-emoji="🔥"]').waitFor({ timeout: 10_000 });
      assert.equal(await target.locator('.react-pill[data-emoji="🔥"]').getAttribute("aria-pressed"), "false");
      if (layout.name === "mobile") await shot("chat-reaction-pills");

      const untoggled = page.waitForResponse((response) => response.url().includes("/reactions") && response.request().method() === "POST");
      await tapOrClick(page, layout, target.locator('.react-pill[data-emoji="👍"]'));
      assert.equal((await untoggled).status(), 200);
      await target.locator('.react-pill[data-emoji="👍"]').waitFor({ state: "detached" });
      assert.equal(await target.locator(".react-pill").count(), 1, "only the friend's 🔥 is left");

      const box = await page.evaluate(() => ({ scroll: document.querySelector(".chat-log")!.scrollWidth, client: document.querySelector(".chat-log")!.clientWidth }));
      assert.ok(box.scroll <= box.client, "no sideways scroll");
      assert.equal(await page.locator(".chat-system .react-pill, .chat-system .chat-react-btn").count(), 0);
    } finally {
      await page.context().close();
    }
  });
}

async function longPress(page: Page, locator: ReturnType<Page["locator"]>) {
  const box = await locator.boundingBox();
  assert.ok(box, "message is on screen");
  const point = { x: Math.round(box.x + 20), y: Math.round(box.y + box.height / 2) };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
  await page.waitForTimeout(600);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

async function tapOrClick(page: Page, layout: Layout, locator: ReturnType<Page["locator"]>) {
  // A long-press just before eats one tap on purpose; let it lapse.
  await page.waitForTimeout(layout.touch ? 750 : 0);
  if (layout.touch) await locator.tap();
  else await locator.click();
}

function hexToRgb(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

async function openAs(token: string, layout: Layout): Promise<Page> {
  const context = await hangry.browser.newContext({
    viewport: { width: layout.width, height: layout.height },
    isMobile: layout.touch,
    hasTouch: layout.touch,
    userAgent: layout.touch ? CHROME_UA : DESKTOP_UA,
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

async function get(pathname: string, token: string) {
  return hangry.call("GET", pathname, token);
}

async function post(pathname: string, body: unknown, token?: string) {
  return hangry.call("POST", pathname, token, body);
}
