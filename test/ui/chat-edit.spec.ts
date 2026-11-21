import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { UA as CHROME_UA, useHangry } from "./harness.js";
import { testEmail } from "../http.js";
// Fake people and messages only. Screenshots go to test/ui/screenshots (gitignored).
const shotsDir = path.resolve("test/ui/screenshots/chat-edit");
const hangry = useHangry({ tz: "UTC" });
const DESKTOP_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

type Layout = { name: string; width: number; height: number; touch: boolean };
const LAYOUTS: Layout[] = [
  { name: "phone", width: 360, height: 640, touch: true },
  { name: "desktop", width: 1280, height: 800, touch: false },
];

for (const layout of LAYOUTS) {
  test(`edit your own message, cancel leaves it alone, and others cannot edit it on a ${layout.name}`, { timeout: 150_000 }, async () => {
    const alex = await post("/api/auth/start", { email: testEmail(), name: "Alex" });
    const circle = await post("/api/circles", { name: "Testers" }, alex.token);
    const ada = await post("/api/auth/start", { email: testEmail(), name: "Ada", code: circle.circle.inviteCode });
    const first = (await post("/api/circles/chat", { text: "Dinner at 7?" }, ada.token)).chat.messages.at(-1);
    await post("/api/circles/chat", { text: "Sounds good to me" }, alex.token);
    fs.mkdirSync(shotsDir, { recursive: true });

    const page = await openChat(ada.token, layout);
    try {
      const shot = (name: string) => page.screenshot({ path: path.join(shotsDir, `${name}-${layout.name}.png`) });
      // By id, not by text: while editing, the words live in a textarea and are not text content.
      const mine = page.locator(`.chat-msg[data-id="${first.id}"]`);
      const theirs = page.locator(".chat-msg", { hasText: "Sounds good to me" });
      await mine.waitFor();
      assert.equal(await mine.locator(".chat-edited").count(), 0, "no mark before an edit");
      assert.equal(await theirs.getByRole("button", { name: "Edit" }).count(), 0, "no Edit on someone else's message");
      assert.equal(await theirs.getByRole("button", { name: "Delete" }).count(), 0, "Ada is no admin, so no Delete there either");
      await mine.hover();
      await shot("own-message-actions");

      // Cancel leaves the original alone and sends nothing.
      const patches: string[] = [];
      page.on("request", (request) => { if (request.method() === "PATCH") patches.push(request.url()); });
      await mine.getByRole("button", { name: "Edit" }).click();
      const box = mine.locator(".chat-edit-input");
      await box.waitFor();
      assert.equal(await box.inputValue(), "Dinner at 7?");
      await box.fill("Dinner at 9?");
      await shot("editing");
      await mine.getByRole("button", { name: "Cancel" }).click();
      await box.waitFor({ state: "detached" });
      assert.equal(await mine.locator("p").textContent(), "Dinner at 7?");
      assert.equal(await mine.locator(".chat-edited").count(), 0);
      assert.deepEqual(patches, []);

      // An empty box is not sent; Save with new words changes the text and adds the mark.
      await mine.getByRole("button", { name: "Edit" }).click();
      await box.fill("   ");
      await mine.getByRole("button", { name: "Save" }).click();
      assert.ok(await box.isVisible(), "an empty edit stays open");
      assert.deepEqual(patches, []);
      await box.fill("Dinner at 8?");
      const saved = page.waitForResponse((response) => response.request().method() === "PATCH");
      await mine.getByRole("button", { name: "Save" }).click();
      assert.equal((await saved).status(), 200);
      await box.waitFor({ state: "detached" });
      assert.equal(await mine.locator("p").textContent(), "Dinner at 8?");
      const mark = mine.locator(".chat-edited");
      assert.equal((await mark.textContent())?.trim(), "edited");
      assert.ok(await mark.isVisible());
      await page.mouse.move(0, 0);
      await shot("edited-dark");

      // The Escape key cancels too, without leaving the chat.
      await mine.getByRole("button", { name: "Edit" }).click();
      await box.fill("Never sent");
      await page.keyboard.press("Escape");
      await box.waitFor({ state: "detached" });
      assert.equal(await mine.locator("p").textContent(), "Dinner at 8?");
      assert.ok(await page.locator(".chat-screen").isVisible());
      assert.equal(patches.length, 1);
    } finally {
      await page.context().close();
    }

    // Alex can delete Ada's message as the circle admin, but cannot edit it. The edit and its mark show for him too.
    const other = await openChat(alex.token, layout);
    try {
      const row = other.locator(".chat-msg", { hasText: "Dinner at 8?" });
      await row.waitFor();
      assert.equal(await row.getByRole("button", { name: "Edit" }).count(), 0, "an admin cannot edit");
      assert.equal(await row.getByRole("button", { name: "Delete" }).count(), 1, "an admin can still delete");
      assert.equal((await row.locator(".chat-edited").textContent())?.trim(), "edited");
      for (const scheme of ["dark", "light"] as const) {
        await other.emulateMedia({ colorScheme: scheme });
        const mark = row.locator(".chat-edited");
        assert.ok(await mark.isVisible(), `the mark shows in ${scheme}`);
        const colors = await mark.evaluate((node) => {
          const style = getComputedStyle(node);
          return { text: style.color, page: getComputedStyle(document.body).backgroundColor };
        });
        assert.notEqual(colors.text, colors.page, `the mark is readable in ${scheme}`);
        await other.screenshot({ path: path.join(shotsDir, `seen-by-admin-${scheme}-${layout.name}.png`) });
      }
      const refused = await hangry.call("PATCH", `/api/messages/${await row.getAttribute("data-id")}`, alex.token, { text: "nope" }).then(
        () => "allowed",
        (error: Error) => error.message,
      );
      assert.match(refused, /-> 403 /);
    } finally {
      await other.context().close();
    }
  });
}

async function openChat(token: string, layout: Layout): Promise<Page> {
  const context = await hangry.browser.newContext({
    viewport: { width: layout.width, height: layout.height },
    isMobile: layout.touch,
    hasTouch: layout.touch,
    userAgent: layout.touch ? CHROME_UA : DESKTOP_UA,
    colorScheme: "dark",
  });
  await skipWhatsNew(context);
  await context.addInitScript((value) => localStorage.setItem("fn_token", value), token);
  const page = await context.newPage();
  await page.goto(hangry.baseUrl);
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
  await page.locator(".tabbar").waitFor();
  await page.locator(".tabbar").getByRole("button", { name: /^Chat/ }).click();
  return page;
}

async function post(pathname: string, body: unknown, token?: string) {
  return hangry.call("POST", pathname, token, body);
}
