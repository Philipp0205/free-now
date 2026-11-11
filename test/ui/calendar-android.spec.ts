import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, openYouSection, useHangry } from "./harness.js";

/** Screenshots land here. Override with CAL_SHOT_DIR. */
const SHOT_DIR = path.resolve(process.env.CAL_SHOT_DIR || "/workspace/hangry-calendar-android-artifacts");
const PIXEL = "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const GOOGLE_STEPS = "Google Calendar can only add a feed on a computer: open calendar.google.com, next to Other calendars tap +, choose From URL and paste the link.";
const APPLE_STEPS = [
  "If nothing opens on iPhone or iPad: Settings, Apps, Calendar, Calendar Accounts, Add Account, Other, Add Subscribed Calendar, then paste the link.",
  "On a Mac: in Calendar choose File, New Calendar Subscription, then paste the link.",
];
const ONCE = "The link is only shown once. To add it to another calendar, use Reset link (the old link stops working).";
const COPY_FAILED = "Copy failed. Press and hold the link to copy it.";

const hangry = useHangry({ tz: "Europe/Berlin" });
const { call } = hangry;

type Phone = { ua?: string; share?: boolean; clipboard?: "ok" | "reject"; execCommand?: boolean };

async function phone(width: number, height: number, token: string, opts: Phone = {}) {
  const context = await hangry.browser.newContext({
    viewport: { width, height },
    isMobile: true,
    hasTouch: true,
    userAgent: opts.ua ?? PIXEL,
    permissions: ["clipboard-read", "clipboard-write"],
  });
  await skipWhatsNew(context);
  // A string, not a function: tsx adds a __name helper to functions that does not exist in the page.
  const setup = JSON.stringify({ value: token, share: Boolean(opts.share), clipboard: opts.clipboard ?? "ok", execCommand: opts.execCommand ?? true });
  await context.addInitScript(`(() => {
    const opts = ${setup};
    localStorage.setItem("fn_install_later", String(Date.now()));
    localStorage.setItem("fn_token", opts.value);
    window.__shares = [];
    // Web Share present or absent on purpose, whatever the test browser ships.
    try { delete Navigator.prototype.share; } catch {}
    Object.defineProperty(navigator, "share", { configurable: true, value: opts.share ? async (data) => { window.__shares.push(data); } : undefined });
    if (opts.clipboard === "reject") {
      navigator.clipboard.writeText = () => Promise.reject(new DOMException("Denied", "NotAllowedError"));
    }
    if (!opts.execCommand) document.execCommand = () => false;
  })();`);
  await context.route("https://*.tile.openstreetmap.org/**", (route) => route.fulfill({ status: 204, body: "" }));
  const page = await context.newPage();
  await page.goto(hangry.baseUrl);
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
  return page;
}

/** The feed link is a secret: it is masked in every screenshot. */
async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const size = page.viewportSize()!;
  const file = path.join(SHOT_DIR, `${name}-${size.width}x${size.height}.png`);
  await page.screenshot({ path: file, mask: [page.locator(".feed-url")], maskColor: "#3a3a3c" });
  return file;
}

/** Node prints actual and expected on failure, so anything that holds the link is checked as a boolean. */
function check(ok: boolean, label: string): void {
  assert.ok(ok, label);
}

async function host(label: string) {
  const person = await call("POST", "/api/auth/start", undefined, { name: "Hana" });
  await call("POST", "/api/circles", person.token, { name: `Cal ${label}` });
  return person;
}

async function turnOn(page: Page) {
  await openYouSection(page, "Availability & calendar");
  const panel = page.getByRole("region", { name: "Calendar feed" });
  await panel.getByRole("button", { name: "Turn on calendar feed" }).click();
  await panel.locator(".feed-url").waitFor();
  return panel;
}

async function noSideScroll(page: Page) {
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(wide <= 1, `page scrolls sideways by ${wide}px`);
}

for (const [width, height] of SIZES) {
  test(`Android at ${width}: no webcal link, Copy link copies the https link, Google steps, Send link shares it`, { timeout: 120_000 }, async () => {
    const person = await host(`android ${width}`);
    const page = await phone(width, height, person.token, { share: true });
    try {
      const panel = await turnOn(page);
      assert.equal(await panel.locator('a[href^="webcal:"]').count(), 0, "no webcal link on Android");
      assert.equal(await panel.getByText("Open in", { exact: false }).count(), 0, "no Open in button on Android");
      check(/^http:\/\/127\.0\.0\.1:\d+\/cal\/[A-Za-z0-9_-]{43}\.ics$/.test(await panel.locator(".feed-url").innerText()), "the https feed link is shown");
      await panel.getByText(GOOGLE_STEPS, { exact: false }).waitFor();
      await panel.getByText("Other calendar apps: look for Add calendar from URL or Subscribe.").waitFor();
      await panel.getByText("Keep this link private.", { exact: false }).waitFor();
      await panel.getByText("Your calendar app decides how often it checks for changes", { exact: false }).waitFor();

      await panel.getByRole("button", { name: "Copy link" }).click();
      await page.locator(".toast", { hasText: "Link copied" }).waitFor();
      const same = await page.evaluate(async () => (await navigator.clipboard.readText()) === document.querySelector(".calendar-feed .feed-url")?.textContent);
      check(same, "the clipboard holds the https feed link");

      await panel.getByRole("button", { name: "Send link" }).click();
      await page.waitForFunction(() => (window as unknown as { __shares: unknown[] }).__shares.length === 1);
      const shared = await page.evaluate(() => {
        const [data] = (window as unknown as { __shares: Array<{ title?: string; url?: string }> }).__shares;
        return data?.title === "Hangry calendar" && data?.url === document.querySelector(".calendar-feed .feed-url")?.textContent && /^https?:/.test(data.url ?? "");
      });
      check(shared, "Send link shares the https link with the Hangry calendar title");

      await noSideScroll(page);
      await page.locator(".toast").waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
      await panel.scrollIntoViewIfNeeded();
      await panel.locator(".feed-manage").scrollIntoViewIfNeeded();
      await shot(page, "android-feed-on");
    } finally {
      await page.context().close();
    }
  });
}

test("Android without Web Share: Copy link only, no Send link", { timeout: 60_000 }, async () => {
  const person = await host("no share");
  const page = await phone(360, 640, person.token, { share: false });
  try {
    const panel = await turnOn(page);
    await panel.getByRole("button", { name: "Copy link" }).waitFor();
    assert.equal(await panel.getByRole("button", { name: "Send link" }).count(), 0);
    assert.equal(await panel.locator('a[href^="webcal:"]').count(), 0);
  } finally {
    await page.context().close();
  }
});

test("Copy falls back when the clipboard API rejects", { timeout: 60_000 }, async () => {
  const person = await host("fallback");
  const page = await phone(360, 640, person.token, { clipboard: "reject" });
  try {
    const panel = await turnOn(page);
    await panel.getByRole("button", { name: "Copy link" }).click();
    const toast = await page.locator(".toast").innerText();
    assert.ok(toast === "Link copied" || toast === COPY_FAILED, `copy toast: ${toast}`);
    assert.equal(await page.locator(".copy-buffer").count(), 0, "the hidden copy field is removed");
  } finally {
    await page.context().close();
  }
});

test("When both copy paths fail, the toast says press and hold and the link is selected", { timeout: 60_000 }, async () => {
  const person = await host("both fail");
  const page = await phone(360, 640, person.token, { clipboard: "reject", execCommand: false });
  try {
    const panel = await turnOn(page);
    await panel.getByRole("button", { name: "Copy link" }).click();
    await page.locator(".toast", { hasText: COPY_FAILED }).waitFor();
    const toastHasLink = await page.evaluate(() => (document.querySelector(".toast")?.textContent || "").includes("/cal/"));
    check(!toastHasLink, "the toast never shows the link");
    const selected = await page.evaluate(() => {
      const text = window.getSelection()?.toString() ?? "";
      return text.length > 0 && text === document.querySelector(".calendar-feed .feed-url")?.textContent;
    });
    check(selected, "the link text is selected for a manual copy");
    const userSelect = await panel.locator(".feed-url").evaluate((node) => getComputedStyle(node).userSelect);
    assert.equal(userSelect, "all");
    await shot(page, "android-copy-failed");
  } finally {
    await page.context().close();
  }
});

test("iPhone: Open in Apple Calendar is the webcal link, plus Copy link and the Settings steps", { timeout: 60_000 }, async () => {
  const person = await host("iphone");
  const page = await phone(390, 844, person.token, { ua: IPHONE, share: true });
  try {
    const panel = await turnOn(page);
    const url = await panel.locator(".feed-url").innerText();
    const href = await panel.getByRole("link", { name: "Open in Apple Calendar" }).getAttribute("href");
    check(href === url.replace(/^http:/, "webcal:"), "Open in Apple Calendar is the webcal link");
    await panel.getByRole("button", { name: "Copy link" }).waitFor();
    for (const step of APPLE_STEPS) await panel.getByText(step).waitFor();
    assert.equal(await panel.locator('a[href^="webcal:"]').count(), 1);
    await noSideScroll(page);
    await panel.locator(".feed-manage").scrollIntoViewIfNeeded();
    await shot(page, "iphone-feed-on");
  } finally {
    await page.context().close();
  }
});

test("after a reload, or Back and return, the link is gone and Reset link is explained", { timeout: 60_000 }, async () => {
  const person = await host("reload");
  const page = await phone(360, 640, person.token);
  try {
    let panel = await turnOn(page);
    // The phone's Back from the You tab, then back to You.
    await page.evaluate(() => history.back());
    await page.getByRole("heading", { name: "You", exact: true, level: 1 }).waitFor();
    await openYouSection(page, "Availability & calendar");
    await panel.getByText(ONCE, { exact: false }).waitFor();
    assert.equal(await panel.locator(".feed-url").count(), 0, "Back hides the link");

    await panel.getByRole("button", { name: "Reset link" }).click();
    await page.getByRole("dialog", { name: "Reset calendar link?" }).getByRole("button", { name: "Reset link" }).click();
    await panel.locator(".feed-url").waitFor();

    await page.reload();
    await openYouSection(page, "Availability & calendar");
    panel = page.getByRole("region", { name: "Calendar feed" });
    await panel.getByText(ONCE, { exact: false }).waitFor();
    await panel.getByText(/On since/).waitFor();
    assert.equal(await panel.locator(".feed-url").count(), 0, "no link after reload");
    assert.equal(await panel.locator('a[href^="webcal:"]').count(), 0, "no webcal link after reload");
    assert.equal(await panel.getByRole("button", { name: "Copy link" }).count(), 0);
    await panel.getByRole("button", { name: "Reset link" }).waitFor();
    await panel.locator(".feed-manage").scrollIntoViewIfNeeded();
    await shot(page, "android-feed-once");
  } finally {
    await page.context().close();
  }
});
