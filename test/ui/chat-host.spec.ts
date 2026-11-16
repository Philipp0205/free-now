import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { useHangry } from "./harness.js";
import { testEmail } from "../http.js";
// Fake people and messages only. Screenshots go to test/ui/screenshots (gitignored).
const shotsDir = path.resolve("test/ui/screenshots/chat-host");
const hangry = useHangry({ tz: "UTC" });

test("the chat screen host and the composer survive render() while the same chat is open", { timeout: 120_000 }, async () => {
  const alex = await post("/api/auth/start", { email: testEmail(), name: "Alex" });
  const circle = await post("/api/circles", { name: "Testers" }, alex.token);
  const ada = await post("/api/auth/start", { email: testEmail(), name: "Ada", code: circle.circle.inviteCode });
  await post("/api/circles/chat", { text: "Anyone up for ramen tonight?" }, ada.token);
  fs.mkdirSync(shotsDir, { recursive: true });

  const context = await hangry.browser.newContext({ viewport: { width: 360, height: 640 } });
  await skipWhatsNew(context);
  await context.addInitScript((value) => localStorage.setItem("fn_token", value), alex.token);
  const page = await context.newPage();
  try {
    await page.goto(hangry.baseUrl);
    const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
    if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
    await page.locator(".tabbar").getByRole("button", { name: /^Chat/ }).click();
    await page.getByText("Anyone up for ramen").waitFor();

    // Tag the live nodes. A remount would drop these.
    await page.evaluate(() => {
      (document.querySelector(".chat-screen") as any).__host = true;
      (document.getElementById("chat-input") as any).__input = true;
    });
    const input = page.locator("#chat-input");
    await input.click();
    await input.pressSequentially("pizza maybe");
    await page.evaluate(() => (document.getElementById("chat-input") as HTMLTextAreaElement).setSelectionRange(3, 3));

    // A reaction runs the app's render() (replaceChildren on #app). The host comes back as the same node.
    const row = page.locator(".chat-msg", { hasText: "Anyone up for ramen" });
    await row.hover();
    await row.locator(".chat-react-btn").click();
    await row.locator(".react-pick", { hasText: "🔥" }).click();
    await row.locator(".react-pill").waitFor();
    const afterReact = await probe(page);
    assert.ok(afterReact.host, "the .chat-screen node is the same one after render()");
    assert.ok(afterReact.input, "the composer node is the same one after render()");
    assert.equal(afterReact.value, "pizza maybe", "the draft stays");
    assert.equal(afterReact.sel, 3, "the caret stays");
    await page.screenshot({ path: path.join(shotsDir, "after-render.png") });

    // The 3s poll renders again when a friend writes. The new line shows and the host is still the same.
    await input.blur();
    await post("/api/circles/chat", { text: "Ramen at eight works" }, ada.token);
    await page.getByText("Ramen at eight works").waitFor({ timeout: 10_000 });
    const afterPoll = await probe(page);
    assert.ok(afterPoll.host && afterPoll.input, "host and composer survive a poll render");
    assert.equal(afterPoll.value, "pizza maybe");

    // Back drops the host. Opening the chat again builds a fresh one with an empty draft.
    await page.locator(".chat-back").click();
    await page.locator(".tabbar").waitFor();
    assert.equal(await page.locator(".chat-screen").count(), 0, "leaving chat removes the screen");
    await page.locator(".tabbar").getByRole("button", { name: /^Chat/ }).click();
    await page.getByText("Ramen at eight works").waitFor();
    const reopened = await probe(page);
    assert.ok(!reopened.host && !reopened.input, "a reopened chat is a fresh tree");
    assert.equal(reopened.value, "");
    await page.screenshot({ path: path.join(shotsDir, "reopened.png") });
  } finally {
    await context.close();
  }
});

async function probe(page: Page) {
  return page.evaluate(() => {
    const input = document.getElementById("chat-input") as HTMLTextAreaElement | null;
    return {
      host: Boolean((document.querySelector(".chat-screen") as any)?.__host),
      input: Boolean((input as any)?.__input),
      value: input?.value ?? "",
      sel: input?.selectionStart ?? null,
    };
  });
}

async function post(pathname: string, body: unknown, token?: string) {
  return hangry.call("POST", pathname, token, body);
}
