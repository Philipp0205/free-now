import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { api, withApp } from "./http.js";

const WELCOME = fs.readFileSync(new URL("../public/welcome.html", import.meta.url), "utf8");
const INDEX = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const MANIFEST = JSON.parse(fs.readFileSync(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"));
const SW = fs.readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");

async function get(port: number, pathname: string, init: RequestInit = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { redirect: "manual", ...init });
  return { status: response.status, headers: response.headers, text: await response.text() };
}

test("/welcome serves the static landing page, not the app shell", async () => {
  await withApp(async ({ port }) => {
    for (const pathname of ["/welcome", "/welcome/", "/welcome?ref=x"]) {
      const page = await get(port, pathname);
      assert.equal(page.status, 200, pathname);
      assert.match(page.headers.get("content-type") ?? "", /^text\/html/);
      assert.equal(page.text, WELCOME, pathname);
      assert.doesNotMatch(page.text, /app\.js/, "the landing page does not boot the app");
    }
    const head = await fetch(`http://127.0.0.1:${port}/welcome`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
  });
});

test("/ and app paths still serve the app shell", async () => {
  await withApp(async ({ port }) => {
    for (const pathname of ["/", "/join/ABCDEFGH", "/?plan=x&circle=y", "/some/unknown/route", "/welcomex", "/welcome/extra"]) {
      const page = await get(port, pathname);
      assert.equal(page.status, 200, pathname);
      assert.equal(page.text, INDEX, `${pathname} is the app shell`);
    }
  });
});

test("/welcome does not mask API errors or unknown files", async () => {
  await withApp(async ({ port }) => {
    const anonApi = await get(port, "/api/welcome");
    assert.equal(anonApi.status, 401, "anonymous unknown API stays an auth error");
    assert.match(anonApi.headers.get("content-type") ?? "", /application\/json/);
    assert.doesNotMatch(anonApi.text, /<html/i);
    const me = await api(port, "POST", "/api/auth/start", { body: { name: "Fake Tester" }, status: 201 });
    const unknownApi = await get(port, "/api/welcome", { headers: { authorization: `Bearer ${me.token}` } });
    assert.equal(unknownApi.status, 404);
    assert.deepEqual(JSON.parse(unknownApi.text), { error: "not found" });
    const noAuth = await get(port, "/api/me");
    assert.equal(noAuth.status, 401);
    assert.match(noAuth.headers.get("content-type") ?? "", /application\/json/);
    const missingFile = await get(port, "/welcome.missing.css");
    assert.equal(missingFile.status, 404);
    assert.deepEqual(JSON.parse(missingFile.text), { error: "not found" });
    const post = await get(port, "/welcome", { method: "POST" });
    assert.equal(post.status, 405);
    const feed = await get(port, "/cal/not-a-token.ics");
    assert.equal(feed.status, 404);
    assert.equal(feed.text, "");
  });
});

test("/welcome is the same on every host and never redirects", async () => {
  await withApp(async ({ port }) => {
    for (const host of ["www.imhangry.app", "hangry.up.railway.app", "localhost"]) {
      const page = await get(port, "/welcome", { headers: { host } });
      assert.equal(page.status, 200, host);
      assert.equal(page.text, WELCOME, host);
    }
    const root = await get(port, "/", { headers: { host: "www.imhangry.app" } });
    assert.equal(root.status, 200);
    assert.equal(root.text, INDEX, "/ is not redirected to /welcome");
  }, { env: { PUBLIC_BASE_URL: "https://www.imhangry.app" } });
});

test("a signed-in token does not change /welcome or /", async () => {
  await withApp(async ({ port }) => {
    const me = await api(port, "POST", "/api/auth/start", { body: { name: "Fake Tester" }, status: 201 });
    await api(port, "POST", "/api/circles", { token: me.token, body: { name: "Fake circle" }, status: 201 });
    const auth = { authorization: `Bearer ${me.token}` };
    assert.equal((await get(port, "/welcome", { headers: auth })).text, WELCOME);
    assert.equal((await get(port, "/", { headers: auth })).text, INDEX);
  });
});

test("the landing page holds no private data and links to the app", () => {
  assert.doesNotMatch(WELCOME, /fn_token|localStorage|<script/i, "no script, no session access");
  assert.doesNotMatch(WELCOME, /\u2014/, "no em dashes");
  assert.match(WELCOME, /href="\/"[^>]*>Open Hangry</);
  assert.match(WELCOME, /href="\/"[^>]*>Get started</);
  assert.match(WELCOME, /Example/);
  assert.match(WELCOME, /href="\/welcome\.css"/);
});

test("the PWA still starts at / and the worker never caches /welcome as the shell", () => {
  assert.equal(MANIFEST.start_url, "/");
  assert.equal(MANIFEST.scope, "/");
  assert.equal(MANIFEST.id, "/");
  const shell = /const SHELL = (\[[^\]]*\]);/.exec(SW)?.[1] ?? "[]";
  assert.ok(JSON.parse(shell).includes("/"));
  assert.ok(!JSON.parse(shell).includes("/welcome"), "the landing page is not part of the app shell");
});

/** Visible text of the landing page, without tags or comments. */
function visibleText(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<head>[\s\S]*?<\/head>/, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

test("the landing page leads with the button: tap, friends are told, whoever can comes", () => {
  const text = visibleText(WELCOME);
  const hero = /<section class="wl-hero"[\s\S]*?<\/section>/.exec(WELCOME)?.[0] ?? "";
  assert.match(WELCOME, /<h1 id="wl-title">Free right now\? Hit the buzzer\.<\/h1>/);
  assert.match(hero, /<p class="wl-lede">Tap the buzzer\. Your friends get notified\. See who’s up for meeting\.<\/p>/);
  assert.match(hero, /aria-label="Example of a spontaneous meetup, step by step"/);
  assert.match(visibleText(hero), /your friends are told/i);
  assert.match(visibleText(hero), /You tap the buzzer.*Your friends are told.*Whoever can, comes/);
  assert.doesNotMatch(visibleText(hero), /\bplans?\b|calendar|schedul/i, "planning is not in the hero");
  assert.ok(text.indexOf("Hit the buzzer") < text.indexOf("Plans for any day"), "the buzzer comes before planning");
  assert.match(text, /Also in Hangry/, "planning is presented as extra");
  // Truthful about what the button does: it opens a sheet, then I'm free sends it.
  assert.match(text, /press I'm free/);
  assert.match(text, /Tap the buzzer Tap the glowing buzzer, add a note or a place if you like, and press I'm free/);
  assert.doesNotMatch(text, /instantly|one press and|everyone gets a push/i);
  // Push only reaches friends who turned it on; others see Alerts.
  assert.match(text, /turned on notifications get a push\. Everyone else sees it under Alerts/);
  // The example push uses the app's real wording.
  assert.match(text, /Free now Alex is free – meet at Schlossplatz/);
  assert.match(text, /Join On my way Can't make it/);
});

test("the landing page makes no tracking, count, or testimonial claims", () => {
  const text = visibleText(WELCOME);
  assert.doesNotMatch(text, /live location|real[- ]time location|track(s|ing)? (your )?friends|see where (your )?friends are|follow your friends|always on/i);
  assert.match(text, /Pins are meetup spots, not people\./);
  assert.match(text, /Hangry does not follow anyone's location in the background\./);
  assert.match(text, /rounded to about 100 metres, only if they tap for it/);
  assert.doesNotMatch(text, /\b\d[\d,]*\+?\s+(users|people|friends|circles|meetups|downloads)\b/i, "no made-up counts");
  assert.doesNotMatch(text, /testimonial|★|rated|loved by|trusted by|best app/i);
  assert.doesNotMatch(text, /\u2014/, "no em dashes");
  assert.match(text, /Real places in central Stuttgart\. The friends and meetups are made up\./);
  assert.match(text, /The map shows real Stuttgart places\. The friends and meetups on this page are made up\./);
  assert.doesNotMatch(text, /made-up (spots|places)|places and the map above are examples/i, "the places are real; only the people are invented");
});

/** Zoom-16 world pixel of a coordinate (Web Mercator, 256 px tiles). */
function z16(lat: number, lng: number) {
  const size = 256 * 2 ** 16;
  const rad = (lat * Math.PI) / 180;
  return {
    x: ((lng + 180) / 360) * size,
    y: ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * size,
  };
}

test("the example map is real OpenStreetMap tiles of central Stuttgart with honest attribution", () => {
  const tiles = [...WELCOME.matchAll(/<img class="wl-tile" style="left:(\d+)px;top:(\d+)px" src="([^"]+)"([^>]*)>/g)];
  assert.equal(tiles.length, 15, "5x3 tiles");
  for (const [, left, top, src, rest] of tiles) {
    const m = /^https:\/\/tile\.openstreetmap\.org\/16\/(\d+)\/(\d+)\.png$/.exec(src);
    assert.ok(m, `standard OSM tile URL: ${src}`);
    assert.equal(Number(left), (Number(m[1]) - 34437) * 256, `${src} sits in its column`);
    assert.equal(Number(top), (Number(m[2]) - 22567) * 256, `${src} sits in its row`);
    assert.match(rest, /referrerpolicy="strict-origin-when-cross-origin"/, "tiles send a Referer even though the page is no-referrer");
    assert.match(rest, /loading="lazy"/, "no prefetching tiles nobody looks at");
  }
  assert.doesNotMatch(WELCOME, /arcgisonline|cartocdn|mapbox|google/i, "only OSM tiles, matching the attribution");
  assert.match(WELCOME, /<p class="wl-attr">© <a href="https:\/\/www\.openstreetmap\.org\/copyright"[^>]*>OpenStreetMap<\/a> contributors<\/p>/);
  assert.match(WELCOME, /<div class="wl-map" role="img" aria-label="Example map of central Stuttgart/);
});

test("example pins sit on the real Stuttgart spots they name", () => {
  const spots: Record<string, [number, number]> = {
    // The Jubiläumssäule, in the middle of Schlossplatz.
    Schlossplatz: [48.7785664, 9.1798704],
    Eckensee: [48.7797884, 9.1827333],
    "Kleiner Schlossplatz": [48.77814, 9.1761817],
    Marktplatz: [48.7751882, 9.1785179],
  };
  const pins = [...WELCOME.matchAll(/<span class="wl-pin wl-pin-(social)" data-spot="([^"]+)" style="left:(\d+)px;top:(\d+)px;--person:#[0-9a-f]{6}">([A-Z])<\/span>/g)];
  assert.deepEqual(pins.map((pin) => pin[2]), Object.keys(spots));
  assert.deepEqual(pins.map((pin) => pin[1]), ["social", "social", "social", "social"], "all pink free-now pins, like the app's social pins");
  assert.doesNotMatch(WELCOME, /wl-pin-plan|wl-key-plan/, "the map example is about free now, not plans");
  for (const [, , spot, left, top] of pins) {
    const world = z16(...spots[spot]);
    assert.ok(Math.abs(world.x - 34437 * 256 - Number(left)) <= 1, `${spot} x`);
    assert.ok(Math.abs(world.y - 22567 * 256 - Number(top)) <= 1, `${spot} y`);
  }
});

test("/welcome keeps its static, no-referrer headers while tiles opt in per image", async () => {
  await withApp(async ({ port }) => {
    const page = await get(port, "/welcome");
    assert.equal(page.headers.get("referrer-policy"), "no-referrer");
    assert.equal(page.headers.get("x-frame-options"), "DENY");
    const css = await get(port, "/welcome.css");
    assert.equal(css.status, 200);
    assert.match(css.text, /\.wl-map-canvas/);
  });
});
