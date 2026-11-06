import http from "node:http";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { chromium, type Browser } from "playwright-core";
import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { openDb } from "../../src/db.js";
import { createNoopPushSender, type PushSender } from "../../src/push.js";

/** Android Chrome on a Pixel 8. */
export const UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36";
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
};

export type Server = { baseUrl: string; db: DatabaseSync; close: () => Promise<void> };

/** Headless Chrome: the installed channel, else the system binary. */
export async function launchChrome(): Promise<Browser> {
  try { return await chromium.launch({ channel: "chrome", headless: true }); }
  catch { return await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true }); }
}

/** The app on 127.0.0.1 with a random port and an in-memory db. */
export async function startServer(opts: ServerOptions = {}): Promise<Server> {
  const db = opts.db ?? openDb(":memory:");
  const config = loadConfig({ PORT: "3000", DB_PATH: ":memory:", APP_TZ: opts.tz ?? "Europe/Berlin", ...opts.env });
  const server = http.createServer(createApp({
    db,
    push: opts.push ?? createNoopPushSender(),
    config: { ...config, dbPath: ":memory:" },
    now: opts.now ?? (() => Date.now()),
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = async () => {
    await opts.beforeClose?.();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  };
  return { baseUrl, db, close };
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
 * Registers test.before (server, then Chrome) and test.after (Chrome, then server).
 * Read baseUrl, browser and db inside tests; they exist once before() has run.
 */
export function useHangry(opts: ServerOptions = {}) {
  let server: Server | undefined;
  let browser: Browser | undefined;
  test.before(async () => {
    server = await startServer(opts);
    browser = await launchChrome();
  });
  test.after(async () => {
    await browser?.close();
    await server?.close();
  });
  const live = <T>(value: T | undefined): T => {
    if (value === undefined) throw new Error("useHangry: test.before has not run yet");
    return value;
  };
  return {
    get baseUrl() { return live(server).baseUrl; },
    get db() { return live(server).db; },
    get browser() { return live(browser); },
    call: (method: string, pathname: string, token?: string, body?: unknown) => call(live(server).baseUrl, method, pathname, token, body),
  };
}
