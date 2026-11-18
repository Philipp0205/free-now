import http from "node:http";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { test } from "@playwright/test";
import { chromium, firefox, webkit, type Browser, type Page } from "playwright-core";
import { createApp } from "../../src/app.js";
import { flushChatNotices } from "../../src/chat/chat.js";
import { loadConfig } from "../../src/config.js";
import { openDb } from "../../src/db.js";
import { type MailMessage, stubMailer } from "../../src/app-kit/mailer.ts";
import { testEmail } from "../http.js";
import type { CalendarNet } from "../../src/calendar/freebusy.js";
import type { GiphyFetch } from "../../src/chat/giphy.js";
import { createNoopPushSender, type PushSender } from "../../src/push/push.js";

export { testEmail };

/** Android Chrome on a Pixel 8. */
export const UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36";
/** The Events tab (formerly Map) opens on Calendar by default; this opens it and switches to the live map. */
export async function openEventsMap(page: Page): Promise<void> {
  await page.locator(".tabbar").getByRole("button", { name: "Events", exact: true }).click();
  await page.locator(".events-view").getByRole("button", { name: "Map", exact: true }).click();
}

/** Opens the You tab and waits for its menu heading. */
export async function openYou(page: Page): Promise<void> {
  await page.locator(".tabbar").getByRole("button", { name: "You", exact: true }).click();
  await page.getByRole("heading", { name: "You", exact: true, level: 1 }).waitFor();
}

/** Opens the You tab, then one of its menu rows (Profile, Availability & calendar, ...), and waits for that screen's heading. */
export async function openYouSection(page: Page, title: string): Promise<void> {
  await openYou(page);
  await page.locator(".page").getByRole("button", { name: title, exact: true }).click();
  await page.getByRole("heading", { name: title, exact: true, level: 1 }).waitFor();
}

/** The three phone sizes we check UI at. */
export const SIZES = [[320, 568], [360, 640], [412, 915]] as const;

export type ServerOptions = {
  /** APP_TZ for the server. Defaults to Europe/Berlin. */
  tz?: string;
  push?: PushSender;
  now?: () => number;
  /** Bring your own db. It is still closed on close(). Defaults to a fresh in-memory db. */
  db?: DatabaseSync;
  /** Extra env for loadConfig, for example fake VAPID keys. */
  env?: Record<string, string>;
  /** Runs first on close(), before the server stops. */
  beforeClose?: () => Promise<void>;
  /** Fake DNS and HTTP for the calendar availability import. */
  calendarNet?: CalendarNet;
  /** Fake Giphy for the GIF picker. With GIPHY_API_KEY in env, no run ever reaches api.giphy.com. */
  giphyFetch?: GiphyFetch;
};

export type Server = { baseUrl: string; db: DatabaseSync; mail: MailMessage[]; close: () => Promise<void> };

/** Headless Chrome: the installed channel, else the system binary. */
export async function launchChrome(): Promise<Browser> {
  try { return await chromium.launch({ channel: "chrome", headless: true }); }
  catch { return await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true }); }
}

/** The browser for a Playwright project: desktop-firefox and desktop-webkit use those engines, anything else Chrome. */
export async function launchBrowser(project: string): Promise<Browser> {
  if (project === "desktop-firefox") return firefox.launch({ headless: true });
  if (project === "desktop-webkit") return webkit.launch({ headless: true });
  return launchChrome();
}

/** The app on 127.0.0.1 with a random port and an in-memory db. */
export async function startServer(opts: ServerOptions = {}): Promise<Server> {
  const db = opts.db ?? openDb(":memory:");
  const config = loadConfig({ PORT: "3000", DB_PATH: ":memory:", APP_TZ: opts.tz ?? "Europe/Berlin", ...opts.env });
  const mailer = stubMailer();
  const server = http.createServer(createApp({
    db,
    push: opts.push ?? createNoopPushSender(),
    config: { ...config, dbPath: ":memory:" },
    now: opts.now ?? (() => Date.now()),
    calendarNet: opts.calendarNet,
    giphyFetch: opts.giphyFetch,
    mailer,
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = async () => {
    await opts.beforeClose?.();
    // chat.ts keeps pending notice slots at module level. A Playwright worker runs several spec
    // files in one process, so drain this app's slots before its db closes, or the next file
    // would flush slots that point at a closed db.
    await flushChatNotices(true);
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  };
  return { baseUrl, db, mail: mailer.sent, close };
}

/** JSON API call. Throws on a non-OK status; returns the parsed body, or null when empty. */
export async function call(baseUrl: string, method: string, pathname: string, token?: string, body?: unknown): Promise<any> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${pathname} -> ${response.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

/**
 * Registers test.beforeAll (server, then Chrome) and test.afterAll (Chrome, then server).
 * Read baseUrl, browser and db inside tests; they exist once beforeAll has run.
 */
export function useHangry(opts: ServerOptions = {}) {
  let server: Server | undefined;
  let browser: Browser | undefined;
  test.beforeAll(async () => {
    server = await startServer(opts);
    browser = await launchBrowser(test.info().project.name);
  });
  test.afterAll(async () => {
    await browser?.close();
    await server?.close();
  });
  const live = <T>(value: T | undefined): T => {
    if (value === undefined) throw new Error("useHangry: test.beforeAll has not run yet");
    return value;
  };
  return {
    get baseUrl() { return live(server).baseUrl; },
    get db() { return live(server).db; },
    get mail() { return live(server).mail; },
    /** Marks every address on file as confirmed, so layout specs are not measured under the "Confirm your email" banner. */
    confirmEmails() {
      live(server).db.prepare("UPDATE users SET email_verified_at = ? WHERE email IS NOT NULL AND email_verified_at IS NULL").run(Date.now());
    },
    get browser() { return live(browser); },
    call: (method: string, pathname: string, token?: string, body?: unknown) => call(live(server).baseUrl, method, pathname, token, body),
  };
}
