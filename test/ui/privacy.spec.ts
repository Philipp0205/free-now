import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Page } from "playwright-core";
import { fakeGoogle, type Fake } from "../fake-google.js";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA, openYouSection, useHangry } from "./harness.js";
import { testEmail } from "../http.js";
/** Screenshots land here (gitignored). Override with PRIVACY_SHOT_DIR. */
const SHOT_DIR = path.resolve(process.env.PRIVACY_SHOT_DIR || "test/ui/screenshots/privacy");

const fake: Fake = await fakeGoogle();
const googleEnv: Record<string, string> = {};
for (const [key, value] of Object.entries(fake.env)) if (value !== undefined) googleEnv[key] = value;
test.afterAll(async () => {
  await fake.close();
});

const hangry = useHangry({ env: googleEnv });

async function context(width: number, height: number, token?: string) {
  const mobile = width < 900;
  const ctx = await hangry.browser.newContext({
    viewport: { width, height },
    isMobile: mobile,
    hasTouch: mobile,
    ...(mobile ? { userAgent: UA } : {}),
  });
  await skipWhatsNew(ctx);
  await ctx.addInitScript((value) => {
    localStorage.setItem("fn_install_later", String(Date.now()));
    if (value) localStorage.setItem("fn_token", value);
  }, token ?? "");
  await ctx.route("https://*.tile.openstreetmap.org/**", (route) => route.fulfill({ status: 204, body: "" }));
  return ctx;
}

async function shot(page: Page, name: string, width: number, fullPage = false) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.waitForFunction(() => document.getAnimations().every((item) => item.playState !== "running" || item.effect?.getComputedTiming().iterations === Infinity));
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}-${width}.png`), fullPage });
}

async function noSideScroll(page: Page) {
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(wide <= 1, `page scrolls sideways by ${wide}px`);
}

for (const [width, height] of [...SIZES, [1280, 800]] as const) {
  test(`at ${width}: /privacy is a dark Hangry page with the full policy`, { timeout: 60_000 }, async () => {
    const ctx = await context(width, height);
    const page = await ctx.newPage();
    try {
      await page.goto(`${hangry.baseUrl}/privacy`);
      await page.getByRole("heading", { level: 1, name: "Privacy" }).waitFor();
      assert.equal(await page.getByRole("link", { name: "Hangry home" }).getAttribute("href"), "/welcome");
      assert.equal(await page.getByRole("link", { name: "Open Hangry" }).getAttribute("href"), "/");
      await page.getByText("Last updated: 15 November 2026").waitFor();
      for (const heading of ["Your account", "Location", "Calendar", "Assistant tokens", "Where it is hosted", "Deleting your data", "Contact"]) {
        await page.getByRole("heading", { level: 2, name: heading }).waitFor();
      }
      assert.equal(await page.locator("script").count(), 0, "no script");
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      assert.equal(bg, "rgb(0, 0, 0)", "dark background");
      const target = await page.getByRole("link", { name: "Open Hangry" }).boundingBox();
      assert.ok(target && target.height >= 36, `Open Hangry is tappable: ${target?.height}`);
      await noSideScroll(page);
      await shot(page, "policy-top", width);
      await shot(page, "policy-full", width, true);
      await page.getByRole("link", { name: "Open Hangry" }).click();
      await page.waitForURL(`${hangry.baseUrl}/`);
      await page.locator("#name").waitFor();
    } finally {
      await ctx.close();
    }
  });
}

for (const [width, height] of SIZES) {
  test(`at ${width}: the login screen links to Privacy, and the link opens the policy`, { timeout: 60_000 }, async () => {
    const host = await hangry.call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Fake Host" });
    const { circle } = await hangry.call("POST", "/api/circles", host.token, { name: "Fake circle" });
    const ctx = await context(width, height);
    const page = await ctx.newPage();
    try {
      await page.goto(`${hangry.baseUrl}/`);
      await page.locator("#name").waitFor();
      const privacy = page.getByRole("link", { name: "Privacy" });
      assert.equal(await privacy.getAttribute("href"), "/privacy");
      assert.equal(await privacy.getAttribute("class"), "gate-about");
      assert.equal(await page.getByRole("link", { name: "What is Hangry?" }).getAttribute("href"), "/welcome");
      await noSideScroll(page);
      await shot(page, "login", width);
      await privacy.click();
      await page.waitForURL(`${hangry.baseUrl}/privacy`);
      await page.getByRole("heading", { level: 1, name: "Privacy" }).waitFor();

      await page.goto(`${hangry.baseUrl}/join/${circle.inviteCode}`);
      await page.locator(".lede", { hasText: "Join Fake circle" }).waitFor();
      assert.equal(await page.getByRole("link", { name: "What is Hangry?" }).count(), 0, "hidden on an invite");
      assert.equal(await page.getByRole("link", { name: "Privacy" }).getAttribute("href"), "/privacy");
      await noSideScroll(page);
      await shot(page, "login-invite", width);
    } finally {
      await ctx.close();
    }
  });

  test(`at ${width}: the Google Calendar facts link to the privacy policy`, { timeout: 60_000 }, async () => {
    const alex = await hangry.call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Alex" });
    const { circle } = await hangry.call("POST", "/api/circles", alex.token, { name: `Friends ${width}` });
    const ctx = await context(width, height, alex.token);
    await ctx.addInitScript((id) => localStorage.setItem("fn_circle", id), circle.id);
    const page = await ctx.newPage();
    try {
      await page.goto(`${hangry.baseUrl}/`);
      await openYouSection(page, "Availability & calendar");
      const facts = page.locator(".sync-facts");
      await facts.waitFor();
      await facts.getByText("What Hangry can and can't see").waitFor();
      await facts.getByText("Hangry never receives event titles or details, and never stores them.", { exact: false }).waitFor();
      const link = facts.getByRole("link", { name: "privacy policy" });
      assert.equal(await link.getAttribute("href"), "/privacy");
      await facts.getByText("has the same details.", { exact: false }).waitFor();
      await facts.evaluate((node) => node.scrollIntoView({ block: "start" }));
      await page.waitForTimeout(250);
      await noSideScroll(page);
      await shot(page, "google-facts", width);
    } finally {
      await ctx.close();
    }
  });
}
