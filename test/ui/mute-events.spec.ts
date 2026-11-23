import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA, useHangry } from "./harness.js";
import { testEmail } from "../http.js";

// Fake people only. Screenshots go to test/ui/screenshots (gitignored).
const SHOT_DIR = path.resolve("test/ui/screenshots/mute-events");
const hangry = useHangry({ tz: "UTC" });
const { call } = hangry;

async function shot(page: Page, name: string) {
  // Let the menu fade and the chat slide-in settle so the shot shows the resting screen.
  await page.waitForTimeout(600);
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const size = page.viewportSize()!;
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}-${size.width}x${size.height}.png`) });
}

async function openAs(token: string, width: number, height: number): Promise<Page> {
  const context = await hangry.browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: UA });
  await skipWhatsNew(context);
  await context.addInitScript((value) => {
    localStorage.setItem("fn_token", value);
    localStorage.setItem("fn_install_later", String(Date.now()));
  }, token);
  const page = await context.newPage();
  await page.goto(hangry.baseUrl);
  await page.locator(".tabbar").waitFor();
  return page;
}

/** Opens the card menu and returns the Mute or Unmute item it shows. */
async function menuItem(page: Page, card: string, name: "Mute" | "Unmute") {
  await page.locator(card).locator(".card-more").click();
  const item = page.getByRole("menuitem", { name, exact: true });
  await item.waitFor();
  return item;
}

for (const [width, height] of SIZES) {
  for (const [kind, cardClass] of [["social", "article.card-now"], ["plan", "article.card-plan"]] as const) {
    test(`at ${width}: a ${kind} is muted and unmuted from the card menu, and the chat header agrees`, { timeout: 120_000 }, async () => {
      const alex = await call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Alex" });
      const { circle } = await call("POST", "/api/circles", alex.token, { name: `Mute ${kind} ${width}` });
      const bea = await call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Bea", code: circle.inviteCode });
      hangry.confirmEmails();
      const note = `Noodles ${kind} ${width}`;
      const route = kind === "social" ? "socials" : "plans";
      const made = (await call("POST", `/api/${route}`, alex.token, kind === "plan" ? { note, time: "23:59" } : { note }))[kind];
      await call("POST", `/api/${route}/${made.id}/chat`, alex.token, { text: "See you there" });

      const page = await openAs(bea.token, width, height);
      const card = `${cardClass}:has(h3:text("${note}"))`;
      try {
        await page.locator(card).waitFor();
        const mute = await menuItem(page, card, "Mute");
        await shot(page, `${kind}-menu-mute`);
        await mute.click();

        const unmute = await menuItem(page, card, "Unmute");
        await shot(page, `${kind}-menu-unmute`);
        await unmute.click();
        await page.getByRole("menuitem").first().waitFor({ state: "detached" });

        // Muted again, so the chat header must show Unmute.
        await (await menuItem(page, card, "Mute")).click();
        await page.locator(card).locator(".chat-row").click();
        await page.locator(".chat-screen").waitFor();
        const header = page.getByRole("button", { name: /^(Mute|Unmute)$/ });
        await header.filter({ hasText: "Unmute" }).waitFor();
        await shot(page, `${kind}-chat-muted`);

        // Unmute from the header, back out, and the menu offers Mute again.
        await header.click();
        await header.filter({ hasText: /^Mute$/ }).waitFor();
        await page.getByRole("button", { name: "Back" }).click();
        await page.locator(".tabbar").waitFor();
        await menuItem(page, card, "Mute");
        assert.equal(await page.getByRole("menuitem", { name: "Unmute", exact: true }).count(), 0);
      } finally {
        await page.context().close();
      }
    });
  }
}
