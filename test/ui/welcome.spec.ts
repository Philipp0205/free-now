import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA, useHangry } from "./harness.js";

/** Screenshots land in .oc/shots/ (git-ignored); WELCOME_SHOT_DIR overrides. */
const SHOT_DIR = path.resolve(process.env.WELCOME_SHOT_DIR || ".oc/shots");

const hangry = useHangry();
const { call } = hangry;

async function phone(width: number, height: number, token?: string) {
  const mobile = width < 900;
  const context = await hangry.browser.newContext({
    viewport: { width, height },
    isMobile: mobile,
    hasTouch: mobile,
    ...(mobile ? { userAgent: UA } : {}),
  });
  await skipWhatsNew(context);
  await context.addInitScript((value) => {
    localStorage.setItem("fn_install_later", String(Date.now()));
    if (value) localStorage.setItem("fn_token", value);
  }, token ?? "");
  await context.route("https://*.tile.openstreetmap.org/**", (route) => route.fulfill({ status: 204, body: "" }));
  return context;
}

async function overflow(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const wide = [...document.querySelectorAll("body *")]
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && (rect.right > doc.clientWidth + 0.5 || rect.left < -0.5);
      })
      .map((node) => `${node.tagName.toLowerCase()}.${(node as HTMLElement).className}`);
    return { scroll: doc.scrollWidth, client: doc.clientWidth, wide };
  });
}

const VIEWS = [...SIZES, [1280, 800]] as const;

for (const [width, height] of VIEWS) {
  test(`at ${width}: /welcome fits, shows the CTA up top, and Open Hangry goes to the app`, { timeout: 60_000 }, async () => {
    const context = await phone(width, height);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    const response = await page.goto(`${hangry.baseUrl}/welcome`);
    assert.equal(response?.status(), 200);
    assert.equal(page.url(), `${hangry.baseUrl}/welcome`, "no redirect");
    await page.getByRole("heading", { level: 1, name: "Make plans with your friends." }).waitFor();
    const fit = await overflow(page);
    assert.equal(fit.scroll, fit.client, `no horizontal scroll at ${width}`);
    assert.deepEqual(fit.wide, [], `nothing pokes out at ${width}`);
    const cta = page.locator("a.wl-btn[data-cta=hero]");
    const box = await cta.boundingBox();
    assert.ok(box && box.y + box.height <= height, `Open Hangry is in the first screen at ${width} (bottom ${box?.y! + box?.height!})`);
    assert.ok(box!.height >= 44, "CTA is a comfortable tap target");
    assert.equal(await page.locator(".wl-tag", { hasText: "Example" }).count(), 2, "both cards are labelled as examples");
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SHOT_DIR, `welcome-top-w${width}.png`) });
    await page.screenshot({ path: path.join(SHOT_DIR, `welcome-full-w${width}.png`), fullPage: true });
    await cta.click();
    await page.waitForURL(`${hangry.baseUrl}/`);
    await page.locator("h1.wordmark", { hasText: "Hangry" }).waitFor();
    await page.locator("#name").waitFor();
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test("signed out: the login view links to /welcome quietly, an invite link does not", { timeout: 60_000 }, async () => {
  const host = await call("POST", "/api/auth/start", undefined, { name: "Fake Host" });
  const { circle } = await call("POST", "/api/circles", host.token, { name: "Fake circle" });
  const context = await phone(360, 640);
  const page = await context.newPage();
  await page.goto(`${hangry.baseUrl}/`);
  await page.locator("#name").waitFor();
  const link = page.getByRole("link", { name: "What is Hangry?" });
  assert.equal(await link.getAttribute("href"), "/welcome");
  const fit = await overflow(page);
  assert.equal(fit.scroll, fit.client);
  await page.screenshot({ path: path.join(SHOT_DIR, "login-link-w360.png") });
  await link.click();
  await page.waitForURL(`${hangry.baseUrl}/welcome`);
  await page.getByRole("heading", { level: 1, name: "Make plans with your friends." }).waitFor();

  await page.goto(`${hangry.baseUrl}/join/${circle.inviteCode}`);
  await page.locator(".lede", { hasText: "Join Fake circle" }).waitFor();
  assert.equal(await page.getByRole("link", { name: "What is Hangry?" }).count(), 0, "the invite screen stays focused");

  await page.getByRole("button", { name: "I have a recovery code" }).waitFor();
  await page.goto(`${hangry.baseUrl}/`);
  await page.getByRole("button", { name: "I have a recovery code" }).click();
  await page.locator("#recover-code").waitFor();
  assert.equal(await page.getByRole("button", { name: "Sign back in" }).count(), 1, "recovery still works");
  await context.close();
});

test("signed in: / opens the app, deep links work, /welcome does not redirect", { timeout: 60_000 }, async () => {
  const me = await call("POST", "/api/auth/start", undefined, { name: "Fake Rosa" });
  const { circle } = await call("POST", "/api/circles", me.token, { name: "Fake Rosa circle" });
  const { plan } = await call("POST", "/api/plans", me.token, { note: "Example picnic", time: "19:00" });
  const context = await phone(412, 915, me.token);
  const page = await context.newPage();
  await page.goto(`${hangry.baseUrl}/`);
  await page.locator("nav.tabbar").waitFor();
  assert.equal(page.url(), `${hangry.baseUrl}/`);
  assert.equal(await page.getByRole("link", { name: "What is Hangry?" }).count(), 0);

  await page.goto(`${hangry.baseUrl}/?plan=${plan.id}&circle=${circle.id}`);
  await page.locator("nav.tabbar").waitFor();
  await page.getByText("Example picnic").first().waitFor();
  assert.equal(new URL(page.url()).pathname, "/", "deep link stays in the app");

  await page.goto(`${hangry.baseUrl}/welcome`);
  await page.getByRole("heading", { level: 1, name: "Make plans with your friends." }).waitFor();
  assert.equal(page.url(), `${hangry.baseUrl}/welcome`);
  const text = await page.locator("body").innerText();
  assert.doesNotMatch(text, /Fake Rosa|Example picnic/, "the landing page shows no account data");
  await page.locator("a.wl-top-link").click();
  await page.waitForURL(`${hangry.baseUrl}/`);
  await page.locator("nav.tabbar").waitFor();
  await context.close();
});

test("PWA: manifest starts at /, and offline / still opens the cached app after visiting /welcome", { timeout: 90_000 }, async () => {
  const context = await phone(360, 640);
  const page = await context.newPage();
  const manifest = await (await page.request.get(`${hangry.baseUrl}/manifest.webmanifest`)).json();
  assert.equal(manifest.start_url, "/");
  await page.goto(`${hangry.baseUrl}/`);
  await page.locator("#name").waitFor();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve) => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }));
    }
  });
  await page.evaluate(async () => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const keys = await caches.keys();
      for (const key of keys) {
        const cache = await caches.open(key);
        if (await cache.match("/app.js")) return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("app shell never cached");
  });
  await page.goto(`${hangry.baseUrl}/welcome`);
  await page.getByRole("heading", { level: 1, name: "Make plans with your friends." }).waitFor();

  await context.setOffline(true);
  await page.goto(`${hangry.baseUrl}/`);
  await page.locator("#name").waitFor();
  assert.equal(await page.locator("h1.wordmark", { hasText: "Hangry" }).count(), 1, "offline / is the app, not the landing page");
  await page.goto(`${hangry.baseUrl}/welcome`);
  await page.getByRole("heading", { level: 1, name: "Make plans with your friends." }).waitFor();
  await context.setOffline(false);
  await context.close();
});
