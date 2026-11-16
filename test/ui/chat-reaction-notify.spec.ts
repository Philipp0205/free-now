import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import { flushChatNotices } from "../../src/chat/chat.js";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA, useHangry } from "./harness.js";
import { testEmail } from "../http.js";
// Fake people and messages only. Screenshots go to test/ui/screenshots (gitignored).
const shotsDir = path.resolve("test/ui/screenshots/chat-reaction-notify");
const hangry = useHangry({ tz: "UTC", beforeClose: () => flushChatNotices(true) });

for (const [width, height] of SIZES) {
  test(`@ a friend's reaction shows up in Alerts at ${width}x${height}`, { timeout: 120_000 }, async () => {
    const alex = await hangry.call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Alex" });
    const circle = await hangry.call("POST", "/api/circles", alex.token, { name: "Testers" });
    const sam = await hangry.call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Sam", code: circle.circle.inviteCode });
    const posted = await hangry.call("POST", "/api/circles/chat", alex.token, { text: "Ramen at 7?\nBring cash" });
    const id = posted.chat.messages.at(-1).id;
    await flushChatNotices(true);
    await hangry.call("POST", `/api/messages/${id}/reactions`, sam.token, { emoji: "❤️" });
    // Switching emoji or taking it back and re-adding does not add a second alert.
    await hangry.call("POST", `/api/messages/${id}/reactions`, sam.token, { emoji: "🔥" });
    await hangry.call("POST", `/api/messages/${id}/reactions`, sam.token, { emoji: "🔥" });
    await hangry.call("POST", `/api/messages/${id}/reactions`, sam.token, { emoji: "🔥" });

    const context = await hangry.browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: UA });
    await skipWhatsNew(context);
    await context.addInitScript((value) => localStorage.setItem("fn_token", value), alex.token);
    const page = await context.newPage();
    try {
      await page.goto(hangry.baseUrl);
      const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
      if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
      await page.locator(".tabbar").waitFor();

      const bell = page.locator(".screen-head .icon-btn[aria-label^='Alerts']");
      await bell.click();
      const card = page.locator(".alert-card", { hasText: "reacted" });
      await card.first().waitFor();
      assert.equal(await card.count(), 1, "one alert for Sam on that message");
      const text = (await card.textContent()) ?? "";
      assert.ok(text.includes("Sam reacted ❤️ to: \u201cRamen at 7? Bring cash\u201d"), text);
      assert.ok(!text.includes("\u2014"), text);

      fs.mkdirSync(shotsDir, { recursive: true });
      await page.screenshot({ path: path.join(shotsDir, `alerts-${width}x${height}.png`) });
    } finally {
      await context.close();
    }
  });
}
