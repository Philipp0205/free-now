import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import { chromium, type Browser, type Page } from "playwright-core";
import type { DatabaseSync } from "node:sqlite";
import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { openDb } from "../../src/db.js";
import { createNoopPushSender } from "../../src/push.js";

const CHROME_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36";
const ENTRIES = JSON.parse(
  fs.readFileSync(new URL("../../public/whats-new.json", import.meta.url), "utf8"),
) as Array<{ id: string; title: string; bullets: string[] }>;
const LATEST = ENTRIES[0].id;
/** Set to a folder to keep screenshots, for example WN_SHOT_DIR=.oc/shots. */
const SHOT_DIR = process.env.WN_SHOT_DIR ? path.resolve(process.env.WN_SHOT_DIR) : "";
const WIDTHS = [320, 360, 412];

let browser: Browser;
let baseUrl = "";
let db: DatabaseSync;
let closeServer: () => Promise<void> = async () => {};
let ip = 10;

test.before(async () => {
  db = openDb(":memory:");
  const config = loadConfig({ PORT: "3000", DB_PATH: ":memory:", APP_TZ: "UTC" });
  const server = http.createServer(createApp({
    db,
    push: createNoopPushSender(),
    config: { ...config, dbPath: ":memory:" },
    now: () => Date.now(),
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closeServer = async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  };
  try { browser = await chromium.launch({ channel: "chrome", headless: true }); }
  catch { browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true }); }
  if (SHOT_DIR) fs.mkdirSync(SHOT_DIR, { recursive: true });
});

test.after(async () => {
  await browser?.close();
  await closeServer();
});

test("the popup shows unseen entries once, and Got it marks them seen on the phone and the account", { timeout: 90_000 }, async () => {
  const alex = await person("Alex");
  const page = await openAs(alex.token);
  const errors = watchErrors(page);
  try {
    const dialog = page.getByRole("dialog", { name: "What's new" });
    await dialog.waitFor();
    for (const entry of ENTRIES) await dialog.getByRole("heading", { name: entry.title, exact: true }).waitFor({ state: "attached" });
    await dialog.getByText("Since you last opened Hangry.").waitFor();
    await waitForSeen(alex.token, LATEST);
    assert.equal(await page.evaluate(() => localStorage.getItem("fn_whats_new_seen")), LATEST);
    await dialog.getByRole("button", { name: "Got it" }).click();
    await dialog.waitFor({ state: "detached" });

    await page.reload();
    await page.getByRole("button", { name: "Now", exact: true }).waitFor();
    await page.waitForTimeout(3500);
    assert.equal(await page.getByRole("dialog", { name: "What's new" }).count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

test("only entries newer than the last one seen are shown, and the account wins over an older phone", { timeout: 90_000 }, async () => {
  const bea = await person("Bea");
  await post("/api/me/whats-new", { id: ENTRIES[1].id }, bea.token);
  const page = await openAs(bea.token, { seen: ENTRIES[3].id });
  try {
    const dialog = page.getByRole("dialog", { name: "What's new" });
    await dialog.waitFor();
    await dialog.getByRole("heading", { name: ENTRIES[0].title, exact: true }).waitFor();
    assert.equal(await dialog.locator(".whats-new-entry").count(), 1);
    await dialog.getByRole("button", { name: "Got it" }).click();
    await dialog.waitFor({ state: "detached" });
    await waitForSeen(bea.token, LATEST);
  } finally {
    await page.context().close();
  }

  // Seen on another phone already: this phone catches up quietly.
  const second = await openAs(bea.token);
  try {
    await second.getByRole("button", { name: "Now", exact: true }).waitFor();
    await second.waitForFunction((id) => localStorage.getItem("fn_whats_new_seen") === id, LATEST, { timeout: 10_000 });
    await second.waitForTimeout(1500);
    assert.equal(await second.getByRole("dialog", { name: "What's new" }).count(), 0);
  } finally {
    await second.context().close();
  }

  // A phone that already saw newer than the account tells the account.
  const cam = await person("Cam");
  const third = await openAs(cam.token, { seen: LATEST });
  try {
    await waitForSeen(cam.token, LATEST);
    await third.waitForTimeout(1500);
    assert.equal(await third.getByRole("dialog", { name: "What's new" }).count(), 0);
  } finally {
    await third.context().close();
  }
});

test("someone who signs up in the app starts with everything seen", { timeout: 90_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 360, height: 640 }, isMobile: true, hasTouch: true, userAgent: CHROME_UA });
  await context.addInitScript(() => localStorage.setItem("fn_install_later", String(Date.now())));
  const page = await context.newPage();
  const errors = watchErrors(page);
  try {
    await page.goto(baseUrl);
    await page.locator("input").first().fill("Nia");
    await page.locator("form button[type=submit]").first().click();
    await page.waitForFunction(() => Boolean(localStorage.getItem("fn_token")));
    await page.waitForFunction((id) => localStorage.getItem("fn_whats_new_seen") === id, LATEST, { timeout: 10_000 });
    const token = await page.evaluate(() => localStorage.getItem("fn_token") as string);
    await waitForSeen(token, LATEST);
    await post("/api/circles", { name: "Nia's" }, token);
    await page.reload();
    await page.getByRole("button", { name: "Now", exact: true }).waitFor();
    await page.waitForTimeout(3500);
    assert.equal(await page.getByRole("dialog", { name: "What's new" }).count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("What's new reopens from the You tab with every entry", { timeout: 90_000 }, async () => {
  const dana = await person("Dana");
  const page = await openAs(dana.token, { seen: LATEST });
  try {
    await openYou(page);
    await page.getByRole("button", { name: /What's new/ }).click();
    const dialog = page.getByRole("dialog", { name: "What's new" });
    await dialog.waitFor();
    assert.equal(await dialog.locator(".whats-new-entry").count(), ENTRIES.length);
    await dialog.getByText("Recent changes to Hangry.").waitFor();
    await dialog.getByRole("button", { name: "Done" }).click();
    await dialog.waitFor({ state: "detached" });
    await page.getByRole("button", { name: /What's new/ }).click();
    await dialog.waitFor();
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
  } finally {
    await page.context().close();
  }
});

test("Send feedback checks the text, sends it with the circle, and says thanks", { timeout: 90_000 }, async () => {
  const eli = await person("Eli");
  const page = await openAs(eli.token, { seen: LATEST });
  const errors = watchErrors(page);
  try {
    await openYou(page);
    await page.getByRole("button", { name: /Send feedback/ }).click();
    const dialog = page.getByRole("dialog", { name: "Send feedback" });
    await dialog.waitFor();
    const box = dialog.locator("textarea");
    assert.equal(await box.getAttribute("maxlength"), "2000");

    await dialog.getByRole("button", { name: "Send" }).click();
    await dialog.getByRole("alert").getByText("Write something first.").waitFor();
    assert.equal(await box.getAttribute("aria-invalid"), "true");
    await box.fill("   \n  ");
    await dialog.getByRole("button", { name: "Send" }).click();
    await dialog.getByText("Write something first.").waitFor();

    const typed = "  The map pins could be bigger.\nThanks!  ";
    await box.fill(typed);
    assert.equal(await dialog.getByRole("alert").count(), 0);
    assert.equal(await box.getAttribute("aria-invalid"), null);
    await dialog.getByText(`${typed.length}/2000`).waitFor();
    // A poll in the background must not wipe what is typed.
    await page.waitForTimeout(3500);
    assert.equal(await box.inputValue(), typed);
    await dialog.getByRole("button", { name: "Send" }).click();

    const done = page.getByRole("dialog", { name: "Feedback sent" });
    await done.getByRole("heading", { name: "Thanks!" }).waitFor();
    const row = db.prepare("SELECT * FROM feedback WHERE user_id = ?").get(eli.user.id) as Record<string, unknown>;
    assert.equal(row.text, "The map pins could be bigger.\nThanks!");
    assert.equal(row.circle_id, eli.circleId);
    assert.equal(row.app_version, "hangry-v17");

    await done.getByRole("button", { name: "Done" }).click();
    await done.waitFor({ state: "detached" });
    await page.getByRole("button", { name: /Send feedback/ }).click();
    await dialog.waitFor();
    assert.equal(await dialog.locator("textarea").inputValue(), "");
    await page.keyboard.press("Escape");
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

test("a feedback the server refuses keeps the text and shows why", { timeout: 90_000 }, async () => {
  const fay = await person("Fay");
  const page = await openAs(fay.token, { seen: LATEST });
  try {
    await page.route("**/api/feedback", (route) => route.fulfill({
      status: 429,
      contentType: "application/json",
      body: JSON.stringify({ error: "too many requests" }),
    }));
    await openYou(page);
    await page.getByRole("button", { name: /Send feedback/ }).click();
    const dialog = page.getByRole("dialog", { name: "Send feedback" });
    await dialog.locator("textarea").fill("Once more");
    await dialog.getByRole("button", { name: "Send" }).click();
    await dialog.getByRole("alert").getByText("That's a lot at once. Try again in a few minutes.").waitFor();
    assert.equal(await dialog.locator("textarea").inputValue(), "Once more");
  } finally {
    await page.context().close();
  }
});

test("popup, list, and feedback sheets fit 320, 360, and 412 wide phones", { timeout: 180_000 }, async () => {
  for (const width of WIDTHS) {
    const height = width === 320 ? 568 : width === 360 ? 640 : 915;
    const someone = await person(`Gus ${width}`);
    const page = await openAs(someone.token, { viewport: { width, height }, seen: ENTRIES[2].id });
    const errors = watchErrors(page);
    try {
      const popup = page.getByRole("dialog", { name: "What's new" });
      await popup.waitFor();
      await settle(page);
      await assertFits(page, `popup ${width}`);
      await shot(page, `whats-new-popup-${width}`);
      await popup.getByRole("button", { name: "Got it" }).click();
      await popup.waitFor({ state: "detached" });

      await openYou(page);
      await page.getByRole("button", { name: /Send feedback/ }).scrollIntoViewIfNeeded();
      await settle(page);
      await shot(page, `you-rows-${width}`);
      await page.getByRole("button", { name: /What's new/ }).click();
      await popup.waitFor();
      await settle(page);
      await assertFits(page, `list ${width}`);
      await shot(page, `whats-new-list-${width}`);
      await page.getByRole("button", { name: "Done" }).click();
      await popup.waitFor({ state: "detached" });

      await page.getByRole("button", { name: /Send feedback/ }).click();
      const form = page.getByRole("dialog", { name: "Send feedback" });
      await form.waitFor();
      await form.getByRole("button", { name: "Send" }).click();
      await form.getByRole("alert").waitFor();
      await form.locator("textarea").fill("Could the chat show who is typing? Also the map is lovely at night.");
      await form.locator("textarea").blur();
      await settle(page);
      await assertFits(page, `feedback ${width}`);
      await shot(page, `feedback-sheet-${width}`);
      await form.getByRole("button", { name: "Send" }).click();
      const done = page.getByRole("dialog", { name: "Feedback sent" });
      await done.waitFor();
      await settle(page);
      await assertFits(page, `thanks ${width}`);
      await shot(page, `feedback-thanks-${width}`);
      assert.deepEqual(errors, []);
    } finally {
      await page.context().close();
    }
  }
});

async function person(name: string) {
  const host = await post("/api/auth/start", { name });
  const circle = await post("/api/circles", { name: `${name}'s circle` }, host.token);
  return { token: host.token as string, user: host.user as { id: string }, circleId: circle.circle.id as string };
}

async function openAs(
  token: string,
  options: { viewport?: { width: number; height: number }; seen?: string } = {},
): Promise<Page> {
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 360, height: 640 },
    isMobile: true,
    hasTouch: true,
    userAgent: CHROME_UA,
    // Each phone its own address, so the feedback limit is per test.
    extraHTTPHeaders: { "x-forwarded-for": `203.0.113.${ip++}` },
  });
  await context.addInitScript(({ value, seen }) => {
    if (localStorage.getItem("fn_token")) return;
    localStorage.setItem("fn_token", value);
    localStorage.setItem("fn_install_later", String(Date.now()));
    if (seen) localStorage.setItem("fn_whats_new_seen", seen);
  }, { value: token, seen: options.seen ?? "" });
  const page = await context.newPage();
  await page.goto(baseUrl);
  return page;
}

async function openYou(page: Page) {
  await page.getByRole("button", { name: "You", exact: true }).click();
  await page.getByRole("button", { name: /Send feedback/ }).waitFor();
}

async function waitForSeen(token: string, id: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const me = await get("/api/me", token);
    if (me.user.whatsNewSeen === id) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`whatsNewSeen never became ${id}`);
}

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  return errors;
}

async function settle(page: Page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForTimeout(150);
}

/** Nothing in the open sheet spills sideways, and its action button is on screen. */
async function assertFits(page: Page, label: string) {
  const report = await page.evaluate(() => {
    const sheet = document.querySelector(".sheet");
    if (!sheet) return { error: "no sheet" };
    const box = sheet.getBoundingClientRect();
    const overflowing = Array.from(sheet.querySelectorAll("*"))
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && (rect.right > box.right + 0.5 || rect.left < box.left - 0.5);
      })
      .map((node) => `${node.tagName}.${(node as HTMLElement).className}`);
    const button = sheet.querySelector(".sheet-dock .btn")?.getBoundingClientRect();
    return {
      overflowing,
      sheetLeft: box.left,
      sheetRight: box.right,
      viewport: window.innerWidth,
      height: window.innerHeight,
      button: button ? { top: button.top, bottom: button.bottom } : null,
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
  assert.equal("error" in report, false, label);
  const fit = report as Exclude<typeof report, { error: string }>;
  assert.deepEqual(fit.overflowing, [], label);
  assert.ok(fit.sheetLeft >= 0 && fit.sheetRight <= fit.viewport + 0.5, label);
  assert.ok(fit.scrollWidth <= fit.viewport, `${label} scrolls sideways`);
  assert.ok(fit.button && fit.button.top >= 0 && fit.button.bottom <= fit.height + 0.5, `${label} button off screen`);
}

async function shot(page: Page, name: string) {
  if (!SHOT_DIR) return;
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) });
}

async function get(pathname: string, token: string) {
  const response = await fetch(`${baseUrl}${pathname}`, { headers: { authorization: `Bearer ${token}` } });
  return response.json();
}

async function post(pathname: string, body: unknown, token?: string) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (response.status >= 400) throw new Error(`${pathname} -> ${response.status} ${text}`);
  return text ? JSON.parse(text) : null;
}
