import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA as CHROME_UA, useHangry } from "./harness.js";

// Fake people and messages only. Screenshots go to test/ui/screenshots (gitignored).
const shotsDir = path.resolve("test/ui/screenshots/chat-wrap");
const hangry = useHangry({ tz: "UTC" });

const LONG_TEXT = "We could all meet near the market after work and then walk over to the new noodle place together, ".repeat(2) + "see you there!";
const LONG_URL = `https://example.com/${"very-long-path-segment-".repeat(8)}end`;

for (const [width, height] of SIZES) {
  test(`composer wraps, grows and sends at ${width}x${height}`, { timeout: 120_000 }, async () => {
    assert.ok(LONG_TEXT.length > 200 && LONG_URL.length > 150);
    const alex = await post("/api/auth/start", { name: "Alex" });
    const circle = await post("/api/circles", { name: "Testers" }, alex.token);
    const ada = await post("/api/auth/start", { name: "Ada", code: circle.circle.inviteCode });
    await post("/api/circles/chat", { text: "Anyone around tonight?" }, ada.token);
    const page = await openAs(alex.token, width, height);
    try {
      fs.mkdirSync(shotsDir, { recursive: true });
      const shot = (name: string) => page.screenshot({ path: path.join(shotsDir, `${name}-${width}.png`) });
      await page.locator(".tabbar").getByRole("button", { name: /^Chat/ }).click();
      await page.getByText("Anyone around tonight").waitFor();
      const input = page.locator("#chat-input");
      const one = await readComposer(page);
      assert.equal(one.tag, "TEXTAREA");
      assert.equal(one.height, 48, "single line stays 48px");
      assert.ok(one.fontSize >= 16, "no iOS zoom");

      for (const [label, text] of [["text", LONG_TEXT], ["url", LONG_URL]] as const) {
        await input.fill(text);
        const grown = await readComposer(page);
        assert.ok(grown.scrollWidth <= grown.clientWidth, `${label}: no sideways scroll in the composer`);
        assert.ok(grown.height > one.height, `${label}: composer grows (${grown.height})`);
        assert.ok(grown.height <= 140, `${label}: composer stops growing (${grown.height})`);
        assert.ok(grown.pageScrollWidth <= grown.pageClientWidth, `${label}: page does not scroll sideways`);
        const send = await page.locator(".chat-send").boundingBox();
        const box = await input.boundingBox();
        assert.ok(send && box);
        assert.ok(Math.abs(send.y + send.height - (box.y + box.height)) <= 1, `${label}: Send sits on the bottom row`);
        await shot(`composer-${label}`);

        await input.press("Enter");
        await page.locator(".chat-msg p", { hasText: text.slice(0, 40) }).waitFor();
        await page.waitForFunction(() => (document.getElementById("chat-input") as HTMLTextAreaElement).value === "");
        const after = await readComposer(page);
        assert.equal(after.height, one.height, `${label}: composer shrinks back after sending`);
        assert.equal(after.value, "");
        await shot(`sent-${label}`);
      }

      const bubbles = await page.evaluate(() => [...document.querySelectorAll(".chat-msg p")].map((p) => ({
        text: p.textContent || "",
        scrollWidth: p.scrollWidth,
        clientWidth: p.clientWidth,
      })));
      for (const bubble of bubbles) assert.ok(bubble.scrollWidth <= bubble.clientWidth, `bubble fits: ${bubble.text.slice(0, 30)}`);
      assert.ok(bubbles.some((b) => b.text === LONG_TEXT) && bubbles.some((b) => b.text === LONG_URL));
      const page2 = await readComposer(page);
      assert.ok(page2.pageScrollWidth <= page2.pageClientWidth, "no horizontal page scroll after sending");

      // Shift+Enter breaks the line and does not send.
      const count = await page.locator(".chat-msg").count();
      await input.fill("");
      await input.pressSequentially("first");
      await input.press("Shift+Enter");
      await input.pressSequentially("second");
      assert.equal(await input.inputValue(), "first\nsecond");
      await page.waitForTimeout(300);
      assert.equal(await page.locator(".chat-msg").count(), count, "Shift+Enter does not send");
      assert.ok((await readComposer(page)).height > one.height, "second line grows the composer");
      await shot("shift-enter");
      await input.press("Enter");
      await page.locator(".chat-msg p", { hasText: "second" }).waitFor();
      assert.equal(await page.locator(".chat-msg").count(), count + 1);
    } finally {
      await page.context().close();
    }
  });
}

async function readComposer(page: Page) {
  return page.evaluate(() => {
    const el = document.getElementById("chat-input") as HTMLTextAreaElement;
    const root = document.documentElement;
    return {
      tag: el.tagName,
      value: el.value,
      height: Math.round(el.getBoundingClientRect().height),
      fontSize: parseFloat(getComputedStyle(el).fontSize),
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      pageScrollWidth: root.scrollWidth,
      pageClientWidth: root.clientWidth,
    };
  });
}

async function openAs(token: string, width: number, height: number): Promise<Page> {
  const context = await hangry.browser.newContext({
    viewport: { width, height },
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
