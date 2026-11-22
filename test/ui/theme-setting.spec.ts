import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { BrowserContext, Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { UA, openYouSection, useHangry } from "./harness.js";
import { testEmail } from "../http.js";

// The theme setting (You, Appearance): System follows the phone, Dark and Light are forced per device. Fake people only.
const SHOT_DIR = path.resolve("test/ui/screenshots/theme-setting");
const hangry = useHangry({ tz: "UTC" });
const SIZE = { width: 360, height: 640 } as const;
type Scheme = "light" | "dark";
const PAGE: Record<Scheme, { color: string; hex: string }> = {
  dark: { color: "rgb(0, 0, 0)", hex: "#000000" },
  light: { color: "rgb(255, 255, 255)", hex: "#ffffff" },
};
const other = (scheme: Scheme): Scheme => (scheme === "dark" ? "light" : "dark");

/** A phone on the given OS scheme, signed in as a fake host with one Ramen plan card on Now. */
async function phone(osScheme: Scheme): Promise<{ context: BrowserContext; page: Page }> {
  const person = await hangry.call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Hana" });
  const { circle } = await hangry.call("POST", "/api/circles", person.token, { name: "Crew" });
  hangry.confirmEmails();
  await hangry.call("POST", `/api/socials?circle=${circle.id}`, person.token, { note: "Ramen" });
  const context = await hangry.browser.newContext({
    viewport: SIZE,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: UA,
    colorScheme: osScheme,
  });
  await skipWhatsNew(context);
  await context.addInitScript(({ token, circleId }) => {
    localStorage.setItem("fn_token", token);
    localStorage.setItem("fn_circle", circleId);
    localStorage.setItem("fn_installed", "1");
    localStorage.setItem("fn_install_later", String(Date.now()));
  }, { token: person.token, circleId: circle.id });
  const page = await context.newPage();
  await page.goto(hangry.baseUrl);
  await page.locator(".tabbar").waitFor();
  return { context, page };
}

async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().endTime !== Infinity).map((a) => a.finished.catch(() => null))).then(() => undefined));
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) });
}

const forced = (page: Page) => page.locator("html").getAttribute("data-ak-scheme");
const pageColor = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const stored = (page: Page) => page.evaluate(() => localStorage.getItem("fn_theme"));
const themeColors = (page: Page) => page.evaluate(() => [...document.querySelectorAll('meta[name="theme-color"]')].map((meta) => meta.getAttribute("content")));

async function choose(page: Page, name: "System" | "Dark" | "Light") {
  await page.locator(".theme-seg").getByRole("button", { name, exact: true }).click();
}

async function assertPage(page: Page, scheme: Scheme, what: string) {
  await page.waitForFunction((want) => getComputedStyle(document.body).backgroundColor === want, PAGE[scheme].color);
  assert.equal(await pageColor(page), PAGE[scheme].color, `${what}: page is ${scheme}`);
  await page.waitForFunction(
    (hex) => { const metas = [...document.querySelectorAll('meta[name="theme-color"]')]; return metas.length > 0 && metas.every((meta) => meta.getAttribute("content") === hex); },
    PAGE[scheme].hex,
  );
  assert.deepEqual([...new Set(await themeColors(page))], [PAGE[scheme].hex], `${what}: theme-color follows`);
}

for (const os of ["dark", "light"] as const) {
  const flip = other(os);
  test(`${os} OS: Settings offers System, Dark and Light, System first, and forcing ${flip} repaints and survives a reload`, { timeout: 120_000 }, async () => {
    const { context, page } = await phone(os);
    try {
      await openYouSection(page, "Appearance");
      const group = page.locator(".theme-seg");
      for (const name of ["System", "Dark", "Light"]) await group.getByRole("button", { name, exact: true }).waitFor();
      assert.equal(await group.getByRole("button").count(), 3);
      assert.equal(await group.getByRole("button", { name: "System", exact: true }).getAttribute("aria-pressed"), "true", "System is selected by default");
      assert.equal(await group.getByRole("button", { name: "Dark", exact: true }).getAttribute("aria-pressed"), "false");
      assert.equal(await group.getByRole("button", { name: "Light", exact: true }).getAttribute("aria-pressed"), "false");
      assert.equal(await forced(page), null, "System leaves the scheme unset");
      assert.equal(await stored(page), null, "nothing is saved until a choice is made");
      await assertPage(page, os, "default");
      await shot(page, `appearance-system-${os}-os`);

      await choose(page, flip === "dark" ? "Dark" : "Light");
      assert.equal(await forced(page), flip);
      assert.equal(await stored(page), flip, "the choice is kept on this device");
      assert.equal(await page.locator(".theme-seg").getByRole("button", { name: flip === "dark" ? "Dark" : "Light", exact: true }).getAttribute("aria-pressed"), "true");
      await assertPage(page, flip, `forced ${flip}`);
      await shot(page, `appearance-${flip}-forced-on-${os}-os`);

      // Home cards follow the scheme: paper with near-black type in light, dark art with white type in dark.
      await page.locator(".tabbar").getByRole("button", { name: "Now", exact: true }).click();
      const title = page.locator("article.card h3", { hasText: "Ramen" });
      await title.waitFor();
      const cardInk = flip === "light" ? "rgb(22, 18, 15)" : "rgb(255, 255, 255)";
      assert.equal(await title.evaluate((node) => getComputedStyle(node).color), cardInk, `card title is ${flip} ink`);
      assert.equal(await page.locator("article.card").first().evaluate((node) => getComputedStyle(node).colorScheme), flip, `the card is ${flip}`);
      await shot(page, `now-${flip}-forced-on-${os}-os`);

      // A reload keeps the choice, and the page is already right before the app script has run.
      await page.route("**/js/app.js", (route) => route.abort());
      await page.reload();
      assert.equal(await forced(page), flip, "the inline script set the scheme with the app script blocked");
      assert.equal(await pageColor(page), PAGE[flip].color, "no flash of the OS scheme before the app starts");
      await page.unroute("**/js/app.js");
      await page.reload();
      await page.locator(".tabbar").waitFor();
      await assertPage(page, flip, "after reload");
      await openYouSection(page, "Appearance");
      assert.equal(await page.locator(".theme-seg").getByRole("button", { name: flip === "dark" ? "Dark" : "Light", exact: true }).getAttribute("aria-pressed"), "true", "the choice shows after reload");

      // Back to System follows the OS again.
      await choose(page, "System");
      assert.equal(await forced(page), null, "System clears the forced scheme");
      assert.equal(await stored(page), "system");
      await assertPage(page, os, "back to System");
      await page.emulateMedia({ colorScheme: flip });
      await assertPage(page, flip, "System follows an OS change");
      await page.emulateMedia({ colorScheme: os });
      await assertPage(page, os, "System follows the OS back");
    } finally {
      await context.close();
    }
  });
}

test("an invalid saved value means System, and Light on a dark OS paints a light Settings page", { timeout: 90_000 }, async () => {
  const { context, page } = await phone("dark");
  try {
    await page.evaluate(() => localStorage.setItem("fn_theme", "neon"));
    await page.reload();
    await page.locator(".tabbar").waitFor();
    assert.equal(await forced(page), null, "a bad value forces nothing");
    await assertPage(page, "dark", "bad value");
    await openYouSection(page, "Appearance");
    assert.equal(await page.locator(".theme-seg").getByRole("button", { name: "System", exact: true }).getAttribute("aria-pressed"), "true");
    await choose(page, "Light");
    await assertPage(page, "light", "forced light");
    const heading = await page.locator(".panel h3").first().evaluate((node) => getComputedStyle(node).color);
    assert.equal(heading, "rgb(0, 0, 0)", "panel text is dark on the light page");
  } finally {
    await context.close();
  }
});
