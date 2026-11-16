import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { UA, openYou, openYouSection, useHangry } from "./harness.js";
import { testEmail } from "../http.js";
const SHOT_DIR = path.resolve("test/ui/screenshots/settings-menu");
const hangry = useHangry();
const SIZE = { width: 360, height: 640 } as const;
const SECTIONS = [
  "Profile",
  "Availability & calendar",
  "Notifications",
  "Assistants",
  "Account",
] as const;

test("the You tab is a short menu with sub-screens and Back", { timeout: 90_000 }, async () => {
  const { context, page } = await phone();
  try {
    await openYou(page);
    for (const title of [...SECTIONS, "What's new", "Send feedback"]) {
      await page.locator(".page").getByRole("button", { name: title, exact: true }).waitFor();
    }
    assert.equal(await page.getByRole("button", { name: "Save name" }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Leave circle" }).count(), 0);
    assert.equal(await page.getByRole("heading", { name: "Assistant tokens" }).count(), 0);
    assert.equal(await page.getByRole("heading", { name: "Calendar feed" }).count(), 0);
    await shot(page, "menu");

    await openYouSection(page, "Profile");
    await page.getByRole("button", { name: "Back", exact: true }).waitFor();
    await page.getByRole("button", { name: "Save name" }).waitFor();
    await page.locator(".profile-hero").waitFor();
    await shot(page, "profile");
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await page.getByRole("heading", { name: "You", exact: true, level: 1 }).waitFor();

    await openYouSection(page, "Availability & calendar");
    await page.getByRole("heading", { name: "Availability & calendar", exact: true, level: 1 }).waitFor();
    await page.getByText("Busy until", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Set weekly hours" }).waitFor();
    await page.getByRole("heading", { name: "Calendar feed" }).waitFor();
    await page.getByRole("region", { name: "Calendar availability" }).waitFor();
    await shot(page, "availability");
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await page.getByRole("heading", { name: "You", exact: true, level: 1 }).waitFor();

    await openYouSection(page, "Notifications");
    await page.locator("button.notif-row").waitFor();
    await shot(page, "notifications");
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await page.getByRole("heading", { name: "You", exact: true, level: 1 }).waitFor();

    await openYouSection(page, "Assistants");
    await page.getByRole("region", { name: "Assistant tokens" }).waitFor();
    await shot(page, "assistants");
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await page.getByRole("heading", { name: "You", exact: true, level: 1 }).waitFor();

    await openYouSection(page, "Account");
    await page.getByRole("button", { name: "Show recovery code" }).waitFor();
    await page.getByRole("button", { name: "Leave circle" }).waitFor();
    await page.getByRole("button", { name: "Sign out" }).waitFor();
    await shot(page, "account");

    // The in-app Back button returns to the menu. History back from a section does too, then leaves You for Now.
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await page.getByRole("heading", { name: "You", exact: true, level: 1 }).waitFor();

    await openYouSection(page, "Account");
    const url = page.url();
    await page.evaluate(() => history.back());
    await page.getByRole("heading", { name: "You", exact: true, level: 1 }).waitFor();
    assert.equal(page.url(), url, "Back stayed inside the app");
    await page.evaluate(() => history.back());
    await page.getByRole("heading", { name: "Now", exact: true, level: 1 }).waitFor();
    assert.equal(page.url(), url, "Back stayed inside the app");
  } finally {
    await context.close();
  }
});

test("returning from Google Calendar opens Availability & calendar", { timeout: 90_000 }, async () => {
  const person = await hangry.call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Hana" });
  await hangry.call("POST", "/api/circles", person.token, { name: "Crew" });
  const context = await hangry.browser.newContext({
    viewport: SIZE,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: UA,
  });
  await skipWhatsNew(context);
  await context.addInitScript((token) => {
    localStorage.setItem("fn_token", token);
    localStorage.setItem("fn_installed", "1");
    localStorage.setItem("fn_install_later", String(Date.now()));
  }, person.token);
  const page = await context.newPage();
  try {
    await page.goto(`${hangry.baseUrl}/?calendar=google`);
    await page.locator(".tabbar").waitFor();
    const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
    if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
    await page.getByRole("heading", { name: "Availability & calendar", exact: true, level: 1 }).waitFor();
    await page.getByRole("region", { name: "Calendar availability" }).waitFor();
    await shot(page, "calendar-landing");
  } finally {
    await context.close();
  }
});

async function phone(): Promise<{ context: Awaited<ReturnType<typeof hangry.browser.newContext>>; page: Page }> {
  const person = await hangry.call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Hana" });
  await hangry.call("POST", "/api/circles", person.token, { name: "Crew" });
  const context = await hangry.browser.newContext({
    viewport: SIZE,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: UA,
  });
  await skipWhatsNew(context);
  await context.addInitScript((token) => {
    localStorage.setItem("fn_token", token);
    localStorage.setItem("fn_installed", "1");
    localStorage.setItem("fn_install_later", String(Date.now()));
  }, person.token);
  const page = await context.newPage();
  await page.goto(hangry.baseUrl);
  await page.locator(".tabbar").waitFor();
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
  return { context, page };
}

async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({
    path: path.join(SHOT_DIR, `${name}.png`),
    mask: [page.locator(".code-block"), page.locator(".agent-token-secret"), page.locator(".feed-url")],
    maskColor: "#3a3a3c",
  });
}
