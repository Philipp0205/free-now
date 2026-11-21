import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { test } from "@playwright/test";
import type { Page } from "playwright-core";
import { UA, testEmail, useHangry } from "./harness.js";
import { skipWhatsNew } from "./whats-new-seen.js";
import { readBuilt } from "../built.js";

// Fake people and plans only. Screenshots go to test/ui/screenshots (gitignored).
const SHOT_DIR = path.resolve("test/ui/screenshots/app-update");

const hangry = useHangry({ tz: "UTC" });

const PTR_MIN_MS = Number(/export const PTR_MIN_MS = (\d+);/.exec(fs.readFileSync(path.resolve("public/js/native.js"), "utf8"))?.[1]);

/**
 * A front for the real test server that serves the built /js/app.js and /sw.js as "build A", "build B", ... and
 * passes everything else through. Switching the build changes the bytes of /sw.js (a comment) and the running
 * version (window.__HANGRY_BUILD__ and the APP_VERSION label). dist/client itself is only read, never written,
 * so the other UI specs are not affected.
 */
async function startBuilds() {
  const upstream = new URL(hangry.baseUrl);
  const appJs = readBuilt("js/app.js");
  const swJs = readBuilt("sw.js");
  assert.ok(appJs.includes("hangry-v145"), "the built bundle carries the version label");
  let current = "A";
  const counts = { sw: 0 };
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://x").pathname;
    const headers = { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" };
    if (req.method === "GET" && pathname === "/js/app.js") {
      const label = current;
      const body = `${appJs.replaceAll("hangry-v145", `hangry-v145-${label.toLowerCase()}`)}\nwindow.__HANGRY_BUILD__=${JSON.stringify(label)};\n`;
      res.writeHead(200, headers);
      res.end(body);
      return;
    }
    if (req.method === "GET" && pathname === "/sw.js") {
      counts.sw += 1;
      res.writeHead(200, headers);
      res.end(`${swJs}\n// test build ${current}\n`);
      return;
    }
    const forward = http.request(
      { host: upstream.hostname, port: upstream.port, method: req.method, path: req.url, headers: { ...req.headers, host: upstream.host } },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      },
    );
    forward.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(forward);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    counts,
    serve(label: string) { current = label; },
    close: async () => {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function seed() {
  const host = await hangry.call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Hana" });
  const circle = (await hangry.call("POST", "/api/circles", host.token, { name: "Update crew" })).circle;
  for (const name of ["Finn", "Uma"]) {
    await hangry.call("POST", "/api/auth/start", undefined, { email: testEmail(), name, code: circle.inviteCode });
  }
  const day = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  await hangry.call("POST", "/api/plans", host.token, { note: "Sushi night", date: day, time: "19:30" });
  return host;
}

/**
 * A phone on build A. The 3s poll is off (test only). Date.now can be pushed forward with window.__skew, so the
 * one-minute throttle can be crossed without waiting.
 */
async function openOnBuildA(token: string, baseUrl: string, width = 390, height = 844) {
  const context = await hangry.browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: UA, colorScheme: "dark" });
  await skipWhatsNew(context);
  await context.addInitScript((value) => {
    localStorage.setItem("fn_token", value);
    localStorage.setItem("fn_installed", "1");
    localStorage.setItem("fn_install_later", String(Date.now()));
    const original = window.setInterval.bind(window);
    window.setInterval = ((handler: TimerHandler, ms?: number, ...args: unknown[]) => (
      ms === 3000 ? 0 : original(handler, ms, ...args)
    )) as typeof window.setInterval;
    const realNow = Date.now.bind(Date);
    Date.now = () => realNow() + ((window as unknown as { __skew?: number }).__skew || 0);
  }, token);
  await context.route("https://*.tile.openstreetmap.org/**", (route) => route.fulfill({ status: 204, body: "" }));
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const log = { loads: 0, lastLoadAt: 0 };
  page.on("load", () => { log.loads += 1; log.lastLoadAt = Date.now(); });
  await page.goto(baseUrl);
  await page.locator("nav.tabbar").waitFor();
  await page.locator(".card-plan").first().waitFor();
  assert.equal(await runningBuild(page), "A", "build A is running");
  // The worker has installed and claimed the page, so a later takeover is an update.
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  assert.match(await page.evaluate(() => navigator.serviceWorker.controller!.scriptURL), /\/sw\.js$/);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(300);
  return { page, log, errors };
}

const runningBuild = (page: Page) => page.evaluate(() => (window as unknown as { __HANGRY_BUILD__?: string }).__HANGRY_BUILD__ ?? "");
const waitForBuild = (page: Page, label: string) => page.waitForFunction((want) => (window as unknown as { __HANGRY_BUILD__?: string }).__HANGRY_BUILD__ === want, label, { timeout: 30_000 });
const tab = (page: Page, name: string) => page.locator("nav.tabbar").getByRole("button", { name, exact: true });

async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) });
}

/** A one finger drag straight down, with real touch events. Resolves with a function that lifts the finger. */
async function pullDown(page: Page, { distance = 160, fromY = 140 } = {}) {
  const cdp = await page.context().newCDPSession(page);
  const x = Math.round(page.viewportSize()!.width / 2);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: fromY }] });
  for (let step = 1; step <= 8; step += 1) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: fromY + Math.round((distance * step) / 8) }] });
  }
  return async () => {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await cdp.detach();
  };
}

/** What coming back to the app does: fire visibilitychange on a visible page. */
const comeBack = (page: Page) => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
const skewClock = (page: Page, ms: number) => page.evaluate((value) => { (window as unknown as { __skew: number }).__skew = value; }, ms);

test("a pull to refresh picks up a new build after the spinner hold, and a second pull does not reload again", { timeout: 150_000 }, async () => {
  const builds = await startBuilds();
  const host = await seed();
  const { page, log, errors } = await openOnBuildA(host.token, builds.baseUrl);
  try {
    assert.equal(log.loads, 1);
    await shot(page, "pull-build-a");

    // Deploy: the server now answers with build B.
    builds.serve("B");
    const lift = await pullDown(page);
    await page.locator(".ak-ptr").waitFor();
    await lift();
    const liftedAt = Date.now();
    await waitForBuild(page, "B");
    assert.equal(log.loads, 2, "one extra load, into the new build");
    assert.ok(log.lastLoadAt - liftedAt >= PTR_MIN_MS - 250, `the reload came after the spinner hold (${log.lastLoadAt - liftedAt}ms)`);
    await page.locator("nav.tabbar").waitFor();
    await page.locator(".card-plan").first().waitFor();
    assert.match(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? ""), /\/sw\.js$/, "the new worker controls the page");
    await shot(page, "pull-build-b");

    // Pull again on the new build: the data refreshes and nothing reloads.
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(500);
    const again = await pullDown(page);
    await page.locator(".ak-ptr").waitFor();
    await again();
    await page.waitForFunction(() => {
      const node = document.querySelector(".ak-ptr");
      return !node || (!node.classList.contains("ak-ptr-loading") && Number(getComputedStyle(node).opacity) === 0);
    });
    await page.waitForTimeout(2000);
    assert.equal(log.loads, 2, "no reload loop");
    assert.equal(await runningBuild(page), "B");
    // Coming back to the app on the same build does not reload either.
    await skewClock(page, 120_000);
    await comeBack(page);
    await page.waitForTimeout(1500);
    assert.equal(log.loads, 2, "still one extra load");
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
    await builds.close();
  }
});

test("coming back to the app checks quietly, at most about once a minute, then reloads into the new build", { timeout: 150_000 }, async () => {
  const builds = await startBuilds();
  const host = await seed();
  const { page, log, errors } = await openOnBuildA(host.token, builds.baseUrl, 360, 640);
  try {
    builds.serve("B");
    // Inside the first minute the visit is not checked: build A keeps running.
    await comeBack(page);
    await page.waitForTimeout(2000);
    assert.equal(log.loads, 1, "inside the window nothing is checked");
    assert.equal(await runningBuild(page), "A");

    // A minute later it is, and the new build loads without any pull.
    await skewClock(page, 61_000);
    await comeBack(page);
    await waitForBuild(page, "B");
    assert.equal(log.loads, 2);
    await page.locator("nav.tabbar").waitFor();
    await page.waitForTimeout(1500);
    assert.equal(log.loads, 2, "no reload loop");
    await shot(page, "visible-build-b");
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
    await builds.close();
  }
});

test("a focused field or unsent text holds the reload, and it applies once that is gone", { timeout: 180_000 }, async () => {
  const builds = await startBuilds();
  const host = await seed();
  const { page, log, errors } = await openOnBuildA(host.token, builds.baseUrl);
  try {
    // 1. Unsent text in the chat composer, field still focused.
    await tab(page, "Chat").tap();
    await page.locator(".chat-screen").waitFor();
    const input = page.locator("#chat-input");
    await input.tap();
    await input.pressSequentially("pizza maybe");
    builds.serve("B");
    await skewClock(page, 61_000);
    await comeBack(page);
    // The new worker installs and takes over, but the page stays put.
    await page.waitForTimeout(3500);
    assert.equal(log.loads, 1, "no reload while text is unsent");
    assert.equal(await runningBuild(page), "A");
    assert.equal(await input.inputValue(), "pizza maybe", "the draft is not lost");
    await shot(page, "held-composer");

    // Emptied but still focused: the person is still in the field.
    await input.fill("");
    await page.waitForTimeout(2500);
    assert.equal(log.loads, 1, "no reload while the field has focus");

    // Leaving the field is the next safe moment.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await waitForBuild(page, "B");
    assert.equal(log.loads, 2, "one extra load");
    await page.locator("nav.tabbar").waitFor();
    await page.locator(".card-plan").first().waitFor();

    // 2. Unsent text in a sheet field, not focused. Closing the sheet makes it safe.
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Let friends know you're free now" }).tap();
    await page.locator(".sheet").waitFor();
    const note = page.locator("#sheet-note");
    await note.fill("Rooftop coffee??");
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    builds.serve("C");
    await skewClock(page, 61_000);
    await comeBack(page);
    await page.waitForTimeout(3500);
    assert.equal(log.loads, 2, "no reload while the sheet holds text");
    assert.equal(await runningBuild(page), "B");
    assert.equal(await note.inputValue(), "Rooftop coffee??", "the sheet text is not lost");
    await shot(page, "held-sheet");

    await page.locator(".scrim").tap({ position: { x: 5, y: 5 } });
    await waitForBuild(page, "C");
    assert.equal(log.loads, 3, "one more load, into the newest build");
    await page.locator("nav.tabbar").waitFor();
    await page.waitForTimeout(1500);
    assert.equal(log.loads, 3, "no reload loop");
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
    await builds.close();
  }
});
