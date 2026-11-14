import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { Page } from "playwright-core";
import { GOBLIN_LINES } from "../../src/chat/goblin.js";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA, useHangry } from "./harness.js";

// Fake people and gripes only. Screenshots go to test/ui/screenshots (gitignored).
// The Goblin picks its lines at random, so a reply is checked against the whole list for its situation.
const shotsDir = path.resolve("test/ui/screenshots/chat-goblin");
const ADMIN = "a".repeat(32);
const hangry = useHangry({ tz: "UTC", env: { ADMIN_TOKEN: ADMIN } });

const received: readonly string[] = GOBLIN_LINES.received;
const empty: readonly string[] = GOBLIN_LINES.empty;

async function openChatAs(token: string, width: number, height: number): Promise<Page> {
  const context = await hangry.browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: UA });
  await skipWhatsNew(context);
  await context.addInitScript((value) => localStorage.setItem("fn_token", value), token);
  const page = await context.newPage();
  await page.goto(hangry.baseUrl);
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
  await page.locator(".tabbar").getByRole("button", { name: /^Chat/ }).click();
  await page.locator("#chat-input").waitFor();
  return page;
}

/** Types "@gob", checks the picker offers the Goblin, and taps it. */
async function pickGoblin(page: Page, shot: (name: string) => Promise<unknown>) {
  const input = page.locator("#chat-input");
  await input.click();
  await input.pressSequentially("@gob");
  const list = page.locator(".mention-list");
  await list.waitFor();
  // The only member is the sender, who is never offered, so the Goblin is all there is.
  assert.deepEqual(await list.locator(".mention-option").allTextContents(), ["👺Goblin"]);
  assert.equal(await list.locator(".mention-option .goblin-face").textContent(), "👺");
  await shot("picker");
  await list.locator(".mention-option", { hasText: "Goblin" }).tap();
  await list.waitFor({ state: "detached" });
  assert.equal(await input.inputValue(), "@Goblin ");
}

async function feedbackList() {
  return (await hangry.call("GET", "/api/admin/feedback", ADMIN)).feedback as Array<{
    userName: string; circleName: string | null; appVersion: string | null; text: string;
  }>;
}

for (const [width, height] of SIZES) {
  test(`@gob picks the Goblin, a gripe is filed and the Goblin answers at ${width}px`, { timeout: 120_000 }, async () => {
    const alex = await hangry.call("POST", "/api/auth/start", undefined, { name: `Alex${width}` });
    const circle = await hangry.call("POST", "/api/circles", alex.token, { name: `Testers ${width}` });
    const page = await openChatAs(alex.token, width, height);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      fs.mkdirSync(shotsDir, { recursive: true });
      const shot = (name: string) => page.screenshot({ path: path.join(shotsDir, `${name}-${width}.png`) });
      const input = page.locator("#chat-input");

      await pickGoblin(page, shot);
      await input.pressSequentially(`the buttons feel small at ${width}`);
      await page.getByRole("button", { name: "Send" }).click();

      // The asker's own line stays, with the mention in the Goblin's color.
      const own = page.locator(".chat-msg.mine", { hasText: `the buttons feel small at ${width}` });
      await own.waitFor();
      assert.equal(await own.locator(".mention").textContent(), "@Goblin");

      const reply = page.locator(".chat-msg.goblin");
      await reply.waitFor();
      assert.equal(await reply.count(), 1);
      assert.equal(await reply.locator("header strong").textContent(), "👺 Goblin");
      assert.ok(received.includes((await reply.locator("p").textContent()) ?? ""), "a line from the received list");
      assert.equal(await reply.locator(".chat-react-btn, .chat-reply-btn, .text-btn").count(), 0, "nothing to react to, reply to or delete");
      assert.equal(await reply.locator("header strong").evaluate((node) => getComputedStyle(node).color), "rgb(79, 132, 16)");
      assert.ok(!(await reply.evaluate((node) => node.classList.contains("mine"))), "not the sender's row");
      const box = await page.evaluate(() => ({ scroll: document.querySelector(".chat-log")!.scrollWidth, client: document.querySelector(".chat-log")!.clientWidth }));
      assert.ok(box.scroll <= box.client, "no sideways scroll");
      await input.blur();
      await shot("reply");

      // It reached the admin feedback list like a form submission, without the mention.
      const row = (await feedbackList()).find((item) => item.text === `the buttons feel small at ${width}`);
      assert.ok(row, "the gripe is in the admin list");
      assert.equal(row.userName, `Alex${width}`);
      assert.equal(row.circleName, `Testers ${width}`);
      assert.match(row.appVersion ?? "", /^hangry-v\d+$/);
      assert.equal(circle.circle.name, row.circleName);

      // An empty mention stores nothing and the Goblin asks what is wrong.
      const before = (await feedbackList()).length;
      await pickGoblin(page, async () => {});
      await page.getByRole("button", { name: "Send" }).click();
      await page.locator(".chat-msg.goblin", { hasText: /\S/ }).nth(1).waitFor();
      const second = await page.locator(".chat-msg.goblin p").nth(1).textContent();
      assert.ok(empty.includes(second ?? ""), `an empty-mention line, got: ${second}`);
      assert.equal((await feedbackList()).length, before, "nothing stored");
      await input.blur();
      await shot("empty");
      assert.deepEqual(errors, []);
    } finally {
      await page.context().close();
    }
  });
}
