import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA, useHangry } from "./harness.js";
import { testEmail } from "../http.js";

// Fake people and messages only. Screenshots go to test/ui/screenshots (gitignored).
const SHOT_DIR = path.resolve("test/ui/screenshots/chat-event-details");
const hangry = useHangry({ tz: "UTC" });
const call = hangry.call;

const DESCRIPTION = "Bring a jacket, the terrace gets windy after sunset. We split the bill evenly and nobody counts coffee. "
  .repeat(6).trim();

async function shot(page: Page, name: string, width: number, height: number) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}-${width}x${height}.png`) });
}

async function seed() {
  const alex = await call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Alex" });
  const circle = (await call("POST", "/api/circles", alex.token, { name: "Friends" })).circle;
  const bea = await call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Bea", code: circle.inviteCode });
  hangry.confirmEmails();
  const social = (await call("POST", "/api/socials", alex.token, { note: "Ramen" })).social;
  const plan = (await call("POST", "/api/plans", alex.token, { note: "Climbing", time: "23:59" })).plan;
  await call("PATCH", `/api/plans/${plan.id}`, alex.token, { description: DESCRIPTION });
  for (const [route, id] of [["socials", social.id], ["plans", plan.id]]) {
    await call("POST", `/api/${route}/${id}/reply`, bea.token, { reply: "in" });
    // Enough messages that the log scrolls at every size.
    for (let n = 1; n <= 24; n += 1) {
      await call("POST", `/api/${route}/${id}/chat`, n % 2 ? alex.token : bea.token, { text: `Message number ${n} about the plan` });
    }
  }
  await call("POST", "/api/circles/chat", alex.token, { text: "Hello circle" });
  return { alex, bea };
}

async function openAs(token: string, width: number, height: number): Promise<Page> {
  const context = await hangry.browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: UA,
  });
  await skipWhatsNew(context);
  await context.addInitScript((value) => {
    localStorage.setItem("fn_token", value);
    localStorage.setItem("fn_install_later", String(Date.now()));
  }, token);
  const page = await context.newPage();
  await page.goto(hangry.baseUrl);
  await page.locator(".tabbar").waitFor();
  await page.locator("article h3", { hasText: "Ramen" }).waitFor();
  await page.locator("article h3", { hasText: "Climbing" }).waitFor();
  return page;
}

async function closeByScrim(page: Page) {
  await page.locator(".scrim").click({ position: { x: 10, y: 10 } });
  await page.getByRole("dialog", { name: "Details" }).waitFor({ state: "detached" });
}

test("tapping an event chat title opens its details sheet on top of the chat, and closing keeps the scroll spot", { timeout: 240_000 }, async () => {
  const { bea } = await seed();
  for (const [width, height] of SIZES) {
    const page = await openAs(bea.token, width, height);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      for (const [kind, title, card] of [["social", "Ramen", "article.card-now"], ["plan", "Climbing", "article.card-plan"]] as const) {
        const tag = `${kind} ${width}x${height}`;
        const dialog = page.getByRole("dialog", { name: "Details" });

        // The card opens the details: the reference for the snap stops.
        await page.locator(card).locator("h3", { hasText: title }).click();
        await dialog.waitFor();
        await page.waitForTimeout(400);
        const fromCard = {
          snap: await dialog.getAttribute("data-snap"),
          maxHeight: await dialog.evaluate((node) => (node as HTMLElement).style.maxHeight),
        };
        assert.match(fromCard.snap || "", new RegExp(`^event-detail:${kind}:`), tag);
        await closeByScrim(page);

        // Into that event's chat.
        await page.locator(card).locator(".chat-row").click();
        await page.locator(".chat-screen").waitFor();
        await page.locator(".chat-msg", { hasText: "Message number 24" }).waitFor();

        // The title is a button named Event details and still shows the event name.
        const heading = page.locator(".chat-head h1");
        const button = page.getByRole("button", { name: "Event details" });
        assert.equal(await button.count(), 1, `${tag}: one Event details button`);
        assert.equal((await button.textContent())?.trim(), title, `${tag}: it shows the event title`);
        assert.equal(await heading.locator("button").count(), 1, `${tag}: the heading holds the button`);
        assert.equal(await button.evaluate((node) => node.tagName), "BUTTON");
        assert.equal(await button.evaluate((node) => getComputedStyle(node).cursor), "pointer", `${tag}: pointer cursor`);
        const box = (await button.boundingBox())!;
        assert.ok(box.height >= 44, `${tag}: a 44px tap target, got ${box.height}`);
        await page.getByRole("button", { name: "Back" }).waitFor();
        await page.getByRole("button", { name: /^(Mute|Unmute)$/ }).waitFor();

        // Scroll the log up and remember where it is.
        await page.locator("#chat-log").evaluate((node) => { node.scrollTop = 140; });
        await page.waitForFunction(() => document.querySelector("#chat-log")!.scrollTop === 140);
        // Let the slide-in finish so the shot shows the settled chat.
        await page.waitForTimeout(600);
        const before = await page.locator("#chat-log").evaluate((node) => node.scrollTop);
        assert.equal(before, 140, `${tag}: the log is scrolled up`);
        await shot(page, `${kind}-chat`, width, height);

        // Tap the title: the same Details sheet, on top of the chat.
        await button.click();
        await dialog.waitFor();
        await page.waitForTimeout(400);
        assert.equal(await dialog.getAttribute("data-snap"), fromCard.snap, `${tag}: same sheet as the card`);
        assert.equal(
          await dialog.evaluate((node) => (node as HTMLElement).style.maxHeight),
          fromCard.maxHeight,
          `${tag}: same snap stop as the card`,
        );
        assert.equal((await dialog.locator("h2").textContent())?.trim(), title, `${tag}: sheet title`);
        await dialog.getByText("Who's in").waitFor();
        await dialog.getByText("Alex · host").waitFor();
        await dialog.getByText("You're in").waitFor();
        assert.equal(await page.locator(".chat-screen").count(), 1, `${tag}: the chat is still there under it`);
        assert.equal(await page.locator(".chat-log").evaluate((node) => node.scrollTop), before, `${tag}: scroll kept while open`);
        await shot(page, `${kind}-details`, width, height);

        // Close it: back in the same chat, same spot.
        await closeByScrim(page);
        await page.locator(".chat-screen").waitFor();
        await page.locator(".chat-head h1", { hasText: title }).waitFor();
        await page.waitForTimeout(150);
        assert.equal(await page.locator("#chat-log").evaluate((node) => node.scrollTop), before, `${tag}: same scroll spot after closing`);
        await shot(page, `${kind}-back-in-chat`, width, height);

        // And the sheet opens again, then Back leaves the chat as before.
        await button.click();
        await dialog.waitFor();
        await closeByScrim(page);
        await page.getByRole("button", { name: "Back" }).click();
        await page.locator(".chat-screen").waitFor({ state: "detached" });
        await page.locator("article h3", { hasText: title }).waitFor();
      }

      // A circle chat keeps a plain heading: no button, no sheet.
      await page.locator(".tabbar").getByRole("button", { name: /^Chat/ }).click();
      await page.locator(".chat-msg", { hasText: "Hello circle" }).waitFor();
      const head = page.locator(".chat-head h1");
      assert.equal(await head.locator("button").count(), 0, `circle ${width}x${height}: no button in the heading`);
      assert.equal(await page.getByRole("button", { name: "Event details" }).count(), 0);
      assert.equal(await head.evaluate((node) => getComputedStyle(node).cursor), "auto");
      await head.click();
      await page.waitForTimeout(300);
      assert.equal(await page.getByRole("dialog").count(), 0, "no sheet opens from a circle chat title");
      await shot(page, "circle-chat", width, height);
      await page.getByRole("button", { name: "Back" }).click();
      assert.deepEqual(errors, [], `no page errors at ${width}x${height}`);
    } finally {
      await page.context().close();
    }
  }
});
