import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA, useHangry } from "./harness.js";

/** Screenshots land in .oc/shots/ (git-ignored); WELCOME_SHOT_DIR overrides. */
const SHOT_DIR = path.resolve(process.env.WELCOME_SHOT_DIR || ".oc/shots");
/** WELCOME_REAL_TILES=1 lets the example map fetch real OpenStreetMap tiles (for screenshots). Otherwise tiles are stubbed. */
const REAL_TILES = process.env.WELCOME_REAL_TILES === "1";
const H1 = "Free right now? Hit the buzzer.";
/** The 5x3 zoom-16 tiles over central Stuttgart that the example map uses. */
const STUTTGART_TILES = [22567, 22568, 22569].flatMap((y) => [34437, 34438, 34439, 34440, 34441].map((x) => `https://tile.openstreetmap.org/16/${x}/${y}.png`));
/** 1x1 transparent PNG, so stubbed tiles still count as loaded images. */
const BLANK_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

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

/** Records tile requests and their Referer; real tiles only with WELCOME_REAL_TILES=1. */
async function watchTiles(context: Awaited<ReturnType<typeof phone>>) {
  const seen: Array<{ url: string; referer: string }> = [];
  await context.route("https://tile.openstreetmap.org/**", async (route) => {
    seen.push({ url: route.request().url(), referer: (await route.request().headerValue("referer")) ?? "" });
    if (REAL_TILES) await route.continue();
    else await route.fulfill({ status: 200, contentType: "image/png", body: BLANK_PNG });
  });
  return seen;
}

async function overflow(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const wide = [...document.querySelectorAll("body *")]
      .filter((node) => {
        // The example map clips its oversized tile canvas; .wl-map itself is still checked.
        if (node.closest(".wl-map-canvas")) return false;
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
    const tiles = await watchTiles(context);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    const response = await page.goto(`${hangry.baseUrl}/welcome`);
    assert.equal(response?.status(), 200);
    assert.equal(page.url(), `${hangry.baseUrl}/welcome`, "no redirect");
    await page.getByRole("heading", { level: 1, name: H1 }).waitFor();
    const fit = await overflow(page);
    assert.equal(fit.scroll, fit.client, `no horizontal scroll at ${width}`);
    assert.deepEqual(fit.wide, [], `nothing pokes out at ${width}`);
    const cta = page.locator("a.wl-btn[data-cta=hero]");
    const box = await cta.boundingBox();
    assert.ok(box && box.y + box.height <= height, `Open Hangry is in the first screen at ${width} (bottom ${box?.y! + box?.height!})`);
    assert.ok(box!.height >= 44, "CTA is a comfortable tap target");
    assert.equal(await page.locator(".wl-tag", { hasText: "Example" }).count(), 2, "the demo and the map are labelled as examples");
    // No named helpers inside evaluate: tsx would wrap them in __name, which the page lacks.
    const [orbTop, h1Top, plansTop] = await page.evaluate(() => [".wl-hero .wl-orb", "h1", "#wl-what"]
      .map((sel) => document.querySelector(sel)!.getBoundingClientRect().top));
    const firstScreen = { orb: orbTop < height, h1: h1Top < height, plansBelow: plansTop > height };
    assert.deepEqual(firstScreen, { orb: true, h1: true, plansBelow: true }, "the button leads; planning is further down");
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SHOT_DIR, `welcome-top-w${width}.png`) });

    const map = page.locator(".wl-map");
    await map.scrollIntoViewIfNeeded();
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>(".wl-tile")]
      .filter((img) => { const r = img.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; })
      .every((img) => img.complete && img.naturalWidth > 0), null, { timeout: 20_000 });
    type Box = { left: number; right: number; top: number; bottom: number };
    // A string, so tsx cannot add its __name helper to the page code.
    const geo: { map: Box; attr: Box; tag: Box; pins: Array<Box & { spot: string }>; attrText: string; attrHref: string } = await page.evaluate(`(() => {
      function box(el) { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; }
      const attr = document.querySelector(".wl-attr");
      return {
        map: box(document.querySelector(".wl-map")),
        attr: box(attr),
        tag: box(document.querySelector(".wl-map-tag")),
        pins: [...document.querySelectorAll(".wl-pin")].map((pin) => Object.assign({ spot: pin.dataset.spot }, box(pin))),
        attrText: attr.textContent.trim(),
        attrHref: attr.querySelector("a").getAttribute("href"),
      };
    })()`);
    const inside = (r: Box) => r.left >= geo.map.left && r.right <= geo.map.right && r.top >= geo.map.top && r.bottom <= geo.map.bottom;
    assert.deepEqual(geo.pins.map((pin) => pin.spot), ["Schlossplatz", "Eckensee", "Kleiner Schlossplatz", "Marktplatz"]);
    for (const pin of geo.pins) {
      assert.ok(inside(pin), `${pin.spot} is inside the map at ${width}`);
      assert.ok(pin.bottom <= geo.attr.top || pin.right <= geo.attr.left, `${pin.spot} does not cover the attribution at ${width}`);
      const clearOfTag = pin.left >= geo.tag.right || pin.right <= geo.tag.left || pin.top >= geo.tag.bottom || pin.bottom <= geo.tag.top;
      assert.ok(clearOfTag, `${pin.spot} is not under the Example tag at ${width}`);
    }
    assert.ok(inside(geo.attr), `attribution is visible on the map at ${width}`);
    assert.equal(geo.attrText, "© OpenStreetMap contributors");
    assert.equal(geo.attrHref, "https://www.openstreetmap.org/copyright");
    assert.ok(tiles.length > 0, "the map asked for tiles once it was on screen");
    for (const tile of tiles) {
      assert.ok(STUTTGART_TILES.includes(tile.url), `only the Stuttgart tiles: ${tile.url}`);
      assert.equal(tile.referer, `${hangry.baseUrl}/`, "tiles get a Referer, as the OSM tile policy asks");
    }
    assert.equal(new Set(tiles.map((tile) => tile.url)).size, tiles.length, "each tile is fetched once");
    await map.screenshot({ path: path.join(SHOT_DIR, `welcome-map-w${width}.png`) });
    const fitMap = await overflow(page);
    assert.equal(fitMap.scroll, fitMap.client, `no horizontal scroll with the map at ${width}`);
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
  const privacy = page.getByRole("link", { name: "Privacy" });
  assert.equal(await privacy.getAttribute("href"), "/privacy");
  assert.equal(await privacy.getAttribute("class"), "gate-about");
  const fit = await overflow(page);
  assert.equal(fit.scroll, fit.client);
  await page.screenshot({ path: path.join(SHOT_DIR, "login-link-w360.png") });
  await link.click();
  await page.waitForURL(`${hangry.baseUrl}/welcome`);
  await page.getByRole("heading", { level: 1, name: H1 }).waitFor();

  await page.goto(`${hangry.baseUrl}/join/${circle.inviteCode}`);
  await page.locator(".lede", { hasText: "Join Fake circle" }).waitFor();
  assert.equal(await page.getByRole("link", { name: "What is Hangry?" }).count(), 0, "the invite screen stays focused");
  assert.equal(await page.getByRole("link", { name: "Privacy" }).getAttribute("href"), "/privacy", "the legal link stays");

  await page.getByRole("button", { name: "I already have an account" }).waitFor();
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
  await page.getByRole("heading", { level: 1, name: H1 }).waitFor();
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
        if (await cache.match("/js/app.js")) return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("app shell never cached");
  });
  await page.goto(`${hangry.baseUrl}/welcome`);
  await page.getByRole("heading", { level: 1, name: H1 }).waitFor();

  await context.setOffline(true);
  await page.goto(`${hangry.baseUrl}/`);
  await page.locator("#name").waitFor();
  assert.equal(await page.locator("h1.wordmark", { hasText: "Hangry" }).count(), 1, "offline / is the app, not the landing page");
  await page.goto(`${hangry.baseUrl}/welcome`);
  await page.getByRole("heading", { level: 1, name: H1 }).waitFor();
  await context.setOffline(false);
  await context.close();
});
