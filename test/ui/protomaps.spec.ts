import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Page, Response } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { UA as CHROME_UA, useHangry } from "./harness.js";

/**
 * The dark Protomaps basemap over a real regional archive, and the raster map outside it.
 * Default archive: the checked-in Schlossplatz fixture (see test/fixtures/README.md),
 * bounds 9.17–9.19 E, 48.77–48.785 N, zoom 12–15. PROTOMAPS_FILE points at another one.
 * A missing archive fails the spec: it never skips.
 */
const ARCHIVE = path.resolve(process.env.PROTOMAPS_FILE || fileURLToPath(new URL("../fixtures/stuttgart-schlossplatz.pmtiles", import.meta.url)));
/** Screenshots land here, like the other specs. Override with PROTOMAPS_SHOT_DIR. */
const SHOT_DIR = path.resolve(process.env.PROTOMAPS_SHOT_DIR || ".oc/shots");
const SIZES: Array<[number, number]> = [[320, 568], [360, 640], [412, 915]];
const PLAN_NOTE = "Rooftop dinner";
/** The plan pin, on Schlossplatz. */
const SCHLOSSPLATZ: [number, number] = [48.7784, 9.18];
/** Where the map looks at the fixture: at z16 the whole view fits its bounds on all three phones. */
const CENTER: [number, number] = [48.777, 9.179];
const VECTOR_ZOOM = 16;
const BERLIN: [number, number] = [52.52, 13.405];
/** Roughly the middle of Germany, far outside the fixture. */
const EUROPE: [number, number] = [51.1657, 10.4515];
/** The live buzzer, on Marktplatz. */
const MARKTPLATZ: [number, number] = [48.7752, 9.1772];
/** A 1×1 PNG, so raster tiles really load (and get .leaflet-tile-loaded). */
const TILE_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const CAPTURE_MAPS = `
  window.__maps = [];
  // Every basemap layer added to a tile pane: a swap adds one. Counts oscillation.
  window.__layerAdds = 0;
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.classList && node.classList.contains("leaflet-layer") && record.target.classList && record.target.classList.contains("leaflet-tile-pane")) {
          window.__layerAdds += 1;
        }
      }
    }
  }).observe(document, { childList: true, subtree: true });
  let leaflet;
  Object.defineProperty(window, "L", {
    configurable: true,
    get() { return leaflet; },
    set(value) {
      leaflet = value;
      if (value && value.Map && value.Map.addInitHook) value.Map.addInitHook(function () { window.__maps.push(this); });
    },
  });
`;

const hangry = useHangry({ tz: "UTC", env: { MAP_PMTILES_PATH: ARCHIVE } });

/** Runs first. Without the archive the server falls back to raster and every case below would mislead. */
test("the PMTiles archive for this spec is present and enabled", async () => {
  assert.ok(fs.existsSync(ARCHIVE), `no PMTiles archive at ${ARCHIVE}: restore test/fixtures/stuttgart-schlossplatz.pmtiles or set PROTOMAPS_FILE`);
  const meta = await hangry.call("GET", "/api/meta");
  assert.equal(meta.mapPmtilesUrl, "/tiles/basemap.pmtiles", "the server accepted the archive");
  const cover = archiveBounds();
  assert.deepEqual(meta.mapPmtilesBounds, [cover.west, cover.south, cover.east, cover.north]);
  assert.equal(meta.mapPmtilesMinZoom, cover.minzoom);
  assert.equal(meta.mapPmtilesMaxZoom, cover.maxzoom);
  const inside = (lat: number, lng: number) => lat > cover.south && lat < cover.north && lng > cover.west && lng < cover.east;
  assert.ok(inside(...SCHLOSSPLATZ) && inside(...CENTER) && inside(...MARKTPLATZ), "the spec's places are inside the archive");
});

function daysAhead(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

/** A JPEG made by the browser's canvas, uploaded like the You tab does. */
async function uploadPhotos(tokens: string[]): Promise<void> {
  const context = await hangry.browser.newContext({ serviceWorkers: "block" });
  try {
    const page = await context.newPage();
    await page.goto(`${hangry.baseUrl}/robots.txt`);
    const statuses = await page.evaluate(async (list) => {
      const canvas = document.createElement("canvas");
      canvas.width = 160;
      canvas.height = 160;
      const ctx = canvas.getContext("2d")!;
      const out: number[] = [];
      for (const [i, token] of list.entries()) {
        ctx.fillStyle = ["#e86a3a", "#3a8fe8", "#6ae83a"][i % 3];
        ctx.fillRect(0, 0, 160, 160);
        ctx.fillStyle = "#fff4d6";
        ctx.beginPath();
        ctx.arc(80, 80, 40, 0, Math.PI * 2);
        ctx.fill();
        const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/jpeg", 0.9));
        const response = await fetch("/api/me/avatar", { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "image/jpeg" }, body: blob });
        out.push(response.status);
      }
      return out;
    }, tokens);
    assert.deepEqual(statuses, tokens.map(() => 200), "photos uploaded");
  } finally {
    await context.close();
  }
}

type Archive = { statuses: number[]; ranges: string[]; bytes: number };

async function phone(width: number, height: number, token: string, brokenPhoto: string, options: { worker?: boolean; archiveDelay?: number } = {}) {
  const worker = options.worker ?? true;
  const context = await hangry.browser.newContext({
    viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: CHROME_UA,
    // Without the worker every archive request goes through context.route, so a spec can fail it.
    serviceWorkers: worker ? "allow" : "block",
  });
  await skipWhatsNew(context);
  // Keep every Leaflet map the app makes, through Leaflet's own init hook, so the spec can pan it.
  // A plain string: a TS function here would be rewritten by tsx with helpers the page lacks.
  await context.addInitScript(CAPTURE_MAPS);
  const raster = { hits: 0 };
  await context.route("https://server.arcgisonline.com/**", (route) => {
    raster.hits += 1;
    return route.fulfill({ status: 200, contentType: "image/png", body: TILE_PNG });
  });
  if (options.archiveDelay) {
    const delay = options.archiveDelay;
    await context.route("**/tiles/basemap.pmtiles", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      await route.continue().catch(() => {});
    });
  }
  const broken = { hits: 0 };
  await context.route(`**/api/users/${brokenPhoto}/avatar**`, (route) => {
    broken.hits += 1;
    return route.fulfill({ status: 200, contentType: "image/webp", body: Buffer.from("not an image at all") });
  });
  const page = await context.newPage();
  const archive: Archive = { statuses: [], ranges: [], bytes: 0 };
  page.on("response", (response: Response) => {
    if (!response.url().includes("/tiles/basemap.pmtiles")) return;
    archive.statuses.push(response.status());
    archive.ranges.push(response.request().headers().range ?? "");
    archive.bytes += Number(response.headers()["content-length"] ?? 0);
  });
  await page.goto(`${hangry.baseUrl}/robots.txt`);
  await page.evaluate((value) => {
    localStorage.clear();
    localStorage.setItem("fn_token", value);
    localStorage.setItem("fn_installed", "1");
    localStorage.setItem("fn_install_later", String(Date.now()));
  }, token);
  await page.goto(hangry.baseUrl);
  if (worker) {
    // Let the worker install and take over, so the map loads through it like on a phone.
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
    await page.reload();
    assert.ok(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)), `${width}: worker controls the page`);
  }
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
  return { page, raster, broken, archive };
}

/** What the live map is drawing right now. */
async function basemap(page: Page) {
  return page.evaluate(() => {
    const map = document.getElementById("hangry-map")!;
    return {
      layers: map.querySelectorAll(".leaflet-tile-pane > .leaflet-layer").length,
      canvases: map.querySelectorAll("canvas.leaflet-tile").length,
      drawn: [...map.querySelectorAll<HTMLCanvasElement>("canvas.leaflet-tile")].filter((c) => c.width > 0).length,
      images: map.querySelectorAll("img.leaflet-tile.leaflet-tile-loaded").length,
      attribution: map.querySelector(".leaflet-control-attribution")?.textContent ?? "",
      filter: getComputedStyle(map.querySelector(".leaflet-tile-pane")!).filter,
    };
  });
}

/** The vector canvas is not blank: it has the dark background and lighter street pixels. */
async function darkWithStreets(page: Page): Promise<{ dark: boolean; streets: boolean }> {
  return page.evaluate(() => {
    let dark = false;
    let streets = false;
    for (const canvas of document.querySelectorAll<HTMLCanvasElement>("#hangry-map canvas.leaflet-tile")) {
      if (!canvas.width) continue;
      const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 0; i < data.length; i += 4 * 37) {
        const light = (data[i] + data[i + 1] + data[i + 2]) / 3;
        if (light < 60) dark = true;
        if (light > 70) streets = true;
      }
    }
    return { dark, streets };
  });
}

/** Layers added to the tile pane so far (one per swap, plus the first). */
async function layerAdds(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __layerAdds: number }).__layerAdds);
}

/** The live map's view: center and edges. */
async function view(page: Page) {
  return page.evaluate(() => {
    const maps = (window as unknown as { __maps: Array<any> }).__maps;
    const live = maps.filter((map) => map.getContainer()?.id === "hangry-map" && map.getContainer().isConnected).pop();
    const b = live.getBounds();
    const c = live.getCenter();
    return { lat: c.lat, lng: c.lng, zoom: live.getZoom(), west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() };
  });
}

async function moveTo(page: Page, center: [number, number], zoom: number): Promise<void> {
  await page.evaluate(([lat, lng, z]) => {
    const maps = (window as unknown as { __maps: Array<any> }).__maps;
    const live = maps.filter((map) => map.getContainer()?.id === "hangry-map" && map.getContainer().isConnected).pop();
    live.setView([lat, lng], z, { animate: false });
  }, [center[0], center[1], zoom] as const);
}

/** Waits for one basemap layer that matches, then makes sure nothing keeps swapping. */
async function settleOn(page: Page, kind: "vector" | "raster", label: string) {
  const deadline = Date.now() + 15_000;
  let state = await basemap(page);
  while (Date.now() < deadline) {
    state = await basemap(page);
    const ready = kind === "vector" ? state.drawn > 0 && state.images === 0 : state.images > 0 && state.canvases === 0;
    if (state.layers === 1 && ready) break;
    await page.waitForTimeout(150);
  }
  assert.equal(state.layers, 1, `${label}: one basemap layer (${JSON.stringify(state)})`);
  await page.waitForTimeout(1200);
  const again = await basemap(page);
  assert.equal(again.layers, 1, `${label}: still one layer, no swap loop`);
  if (kind === "vector") {
    assert.ok(again.drawn > 0 && again.images === 0, `${label}: dark vector tiles (${JSON.stringify(again)})`);
    assert.match(again.attribution, /Protomaps/, `${label}: Protomaps credit`);
    assert.match(again.attribution, /OpenStreetMap/, `${label}: OpenStreetMap credit`);
    assert.doesNotMatch(again.attribution, /Esri/, `${label}: no Esri credit over the vector map`);
  } else {
    assert.ok(again.images > 0 && again.canvases === 0, `${label}: raster tiles (${JSON.stringify(again)})`);
    assert.match(again.attribution, /Esri/, `${label}: Esri credit`);
    assert.doesNotMatch(again.attribution, /Protomaps/, `${label}: no Protomaps credit over raster tiles`);
  }
  assert.equal(again.filter, "none", `${label}: no CSS filter on the tiles`);
  return again;
}

/**
 * Let every finite animation and transition end (tab and page fades, the card, the menu),
 * so a screenshot never catches the UI half faded in. The pin buzz loops forever and is left alone.
 */
const SETTLE = `Promise.race([
  Promise.all(document.getAnimations()
    .filter((a) => a.effect && a.effect.getComputedTiming().iterations !== Infinity)
    .map((a) => a.finished.catch(() => undefined))),
  new Promise((resolve) => setTimeout(resolve, 3000)),
]).then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))`;

async function shot(page: Page, name: string): Promise<void> {
  await page.evaluate(SETTLE);
  await page.screenshot({ path: path.join(SHOT_DIR, name) });
}

/** Opacity as the eye sees it: the element's own times every ancestor's. */
const SEEN_OPACITY = `(node) => {
  let value = 1;
  for (let el = node; el; el = el.parentElement) value *= Number(getComputedStyle(el).opacity);
  return value;
}`;

async function seenOpacity(page: Page, selector: string): Promise<number[]> {
  return page.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].map(${SEEN_OPACITY})`);
}

async function buzz(page: Page) {
  return page.locator(".leaflet-marker-icon.pin-now .pin-body").evaluate((node) => ({
    body: getComputedStyle(node).animationName,
    ring: getComputedStyle(node, "::before").animationName,
  }));
}

test("dark vector map over Stuttgart with every pin feature, raster in Berlin and zoomed out, archive read in small ranges and never cached", { timeout: 300_000 }, async () => {
  const size = fs.statSync(ARCHIVE).size;
  const host = await hangry.call("POST", "/api/auth/start", undefined, { name: "Hana" });
  const { circle } = await hangry.call("POST", "/api/circles", host.token, { name: "Friends" });
  const join = (name: string) => hangry.call("POST", "/api/auth/start", undefined, { name, code: circle.inviteCode });
  const [ana, ben, cyd, dee] = [await join("Ana"), await join("Ben"), await join("Cyd"), await join("Dee")];
  await uploadPhotos([host.token, ana.token, cyd.token]);
  const { plan } = await hangry.call("POST", "/api/plans", host.token, {
    note: PLAN_NOTE, date: daysAhead(1), time: "19:00", place: "Schlossplatz", lat: SCHLOSSPLATZ[0], lng: SCHLOSSPLATZ[1], precise: true,
  });
  for (const person of [ana, ben, cyd, dee]) await hangry.call("POST", `/api/plans/${plan.id}/reply`, person.token, { reply: "in" });
  await hangry.call("POST", "/api/socials", ben.token, { note: "Coffee now", place: "Marktplatz", lat: MARKTPLATZ[0], lng: MARKTPLATZ[1], precise: true });

  fs.mkdirSync(SHOT_DIR, { recursive: true });
  for (const [width, height] of SIZES) {
    const { page, raster, broken, archive } = await phone(width, height, host.token, cyd.user.id);
    try {
      await page.locator(".tabbar").getByRole("button", { name: /^Map/ }).click();
      const planPin = page.locator(".leaflet-marker-icon.pin-plan");
      const nowPin = page.locator(".leaflet-marker-icon.pin-social");
      await planPin.waitFor({ timeout: 10_000 });
      await nowPin.waitFor({ timeout: 10_000 });

      // Stuttgart: the dark vector map, drawn, with the pins on top.
      await moveTo(page, CENTER, VECTOR_ZOOM);
      // Once the view is centered inside, no more raster tiles are asked for.
      await settleOn(page, "vector", `${width} Stuttgart`);
      const rasterInside = raster.hits;
      const pixels = await darkWithStreets(page);
      assert.ok(pixels.dark && pixels.streets, `${width}: dark background with streets ${JSON.stringify(pixels)}`);
      assert.equal(await planPin.locator(".pin-when").innerText(), "Tomorrow", `${width}: date label`);
      assert.equal(await planPin.locator(".pin-crowd .pin-face").count(), 3, `${width}: crowd faces`);
      assert.equal(await planPin.locator(".pin-crowd .pin-more").innerText(), "+1", `${width}: crowd overflow`);
      const hostPhoto = planPin.locator(".pin-body > .pin-letter img.pin-photo");
      await hostPhoto.waitFor({ timeout: 10_000 });
      assert.ok(await hostPhoto.evaluate(async (img: HTMLImageElement) => { await img.decode().catch(() => {}); return img.naturalWidth; }) > 0, `${width}: host photo`);
      const brokenFace = planPin.locator(`.pin-face[data-person="${cyd.user.id}"]`);
      await page.waitForTimeout(400);
      assert.ok(broken.hits > 0, `${width}: the broken photo was requested`);
      assert.equal(await brokenFace.locator("img").count(), 0, `${width}: broken photo removed`);
      assert.equal(await brokenFace.innerText(), "C", `${width}: broken photo shows the initial`);
      const moving = await buzz(page);
      assert.equal(moving.body, "pin-buzz", `${width}: live pin shakes`);
      assert.equal(moving.ring, "pin-ring", `${width}: live pin pulses`);
      await shot(page, `protomaps-stuttgart-w${width}.png`);

      await page.emulateMedia({ reducedMotion: "reduce" });
      const still = await buzz(page);
      assert.equal(still.body, "none", `${width}: no shake with reduced motion`);
      assert.equal(still.ring, "none", `${width}: no pulse with reduced motion`);
      await shot(page, `protomaps-reduced-w${width}.png`);
      // Back to full motion. This replays the page fade from opacity 0, which is what
      // dimmed the card screenshot before: the settle in shot() waits it out.
      await page.emulateMedia({ reducedMotion: "no-preference" });

      await planPin.click();
      const card = page.locator(".map-card", { hasText: PLAN_NOTE });
      await card.waitFor({ timeout: 5000 });
      await shot(page, `protomaps-card-w${width}.png`);
      assert.equal(raster.hits, rasterInside, `${width}: no raster tiles while inside the archive`);
      assert.deepEqual(await seenOpacity(page, ".map-card"), [1], `${width}: the card is fully opaque`);
      const buttons = await seenOpacity(page, ".map-card button");
      assert.ok(buttons.length >= 3 && buttons.every((value) => value === 1), `${width}: every card button is fully opaque ${buttons}`);
      assert.equal((await seenOpacity(page, ".page"))[0], 1, `${width}: the page under the card is not faded`);
      const share = card.getByRole("button", { name: /Share/ });
      await share.click({ trial: true, timeout: 2000 });
      const box = (await share.boundingBox())!;
      const onTop = await page.evaluate(`(() => {
        const hit = document.elementFromPoint(${box.x + box.width / 2}, ${box.y + box.height / 2});
        return Boolean(hit && hit.closest(".map-card button") && /Share/.test(hit.closest("button").textContent));
      })()`);
      assert.ok(onTop, `${width}: nothing covers the Share button`);

      // The archive was read in byte ranges, a tiny part of the file.
      assert.ok(archive.statuses.length > 0, `${width}: archive requested`);
      assert.ok(archive.statuses.every((status) => status === 206), `${width}: only 206 replies ${archive.statuses}`);
      assert.ok(archive.ranges.every((range) => /^bytes=\d+-\d+$/.test(range)), `${width}: every request had a Range ${archive.ranges}`);
      assert.ok(archive.bytes < size / 2, `${width}: read ${archive.bytes} of ${size} bytes`);
      assert.ok(archive.ranges.length > 1, `${width}: several small reads, not one big one`);

      // Berlin is outside the archive: the raster map with its own credit, full detail.
      await moveTo(page, BERLIN, 15);
      await settleOn(page, "raster", `${width} Berlin`);
      assert.ok(raster.hits > rasterInside, `${width}: raster tiles requested in Berlin`);
      await shot(page, `protomaps-berlin-w${width}.png`);

      // Zoomed out to Europe over Stuttgart: below the archive's zoom range, so raster again.
      await moveTo(page, CENTER, 5);
      await settleOn(page, "raster", `${width} Europe`);
      await shot(page, `protomaps-europe-w${width}.png`);

      // One level below the archive's minzoom, centred on it: raster.
      const below = archiveBounds().minzoom - 1;
      await moveTo(page, CENTER, below);
      assert.equal((await view(page)).zoom, below, `${width}: at z${below}`);
      await settleOn(page, "raster", `${width} below minzoom (z${below})`);

      // And back in: dark again.
      await moveTo(page, CENTER, VECTOR_ZOOM);
      await settleOn(page, "vector", `${width} back in Stuttgart`);
      assert.ok(archive.bytes < size, `${width}: never the whole file (${archive.bytes} of ${size})`);

      // The worker cached the app shell (with the vendor file) but nothing from /tiles/.
      const cached = await page.evaluate(async () => {
        const urls: string[] = [];
        for (const key of await caches.keys()) {
          for (const request of await (await caches.open(key)).keys()) urls.push(new URL(request.url).pathname);
        }
        return urls;
      });
      assert.ok(cached.includes("/vendor/protomaps-leaflet/protomaps-leaflet.js"), `${width}: vendor file in the shell cache`);
      assert.deepEqual(cached.filter((url) => url.startsWith("/tiles/")), [], `${width}: no archive bytes cached`);
    } finally {
      await page.context().close();
    }
  }
});

/** Archive header bounds, read the same way the server does. */
function archiveBounds(): { west: number; south: number; east: number; north: number; minzoom: number; maxzoom: number } {
  const header = Buffer.alloc(127);
  const fd = fs.openSync(ARCHIVE, "r");
  try {
    fs.readSync(fd, header, 0, 127, 0);
  } finally {
    fs.closeSync(fd);
  }
  const [west, south, east, north] = [102, 106, 110, 114].map((at) => header.readInt32LE(at) / 1e7);
  return { west, south, east, north, minzoom: header[100], maxzoom: header[101] };
}

test("edges, deep zoom, and an archive that fails mid-session: raster where vector cannot draw, no blank map, no swap loop", { timeout: 300_000 }, async () => {
  const cover = archiveBounds();
  const host = await hangry.call("POST", "/api/auth/start", undefined, { name: "Ida" });
  await hangry.call("POST", "/api/circles", host.token, { name: "Edge" });
  await hangry.call("POST", "/api/plans", host.token, {
    note: "Edge walk", date: daysAhead(1), time: "18:00", place: "Schlossplatz", lat: SCHLOSSPLATZ[0], lng: SCHLOSSPLATZ[1], precise: true,
  });

  fs.mkdirSync(SHOT_DIR, { recursive: true });
  for (const [width, height] of SIZES) {
    const { page, raster, archive } = await phone(width, height, host.token, "nobody", { worker: false });
    try {
      await page.locator(".tabbar").getByRole("button", { name: /^Map/ }).click();
      await page.locator(".leaflet-marker-icon.pin-plan").waitFor({ timeout: 10_000 });
      await moveTo(page, CENTER, VECTOR_ZOOM);
      await settleOn(page, "vector", `${width} center`);

      // Center inside the archive, north edge past it: still vector, the dark map sticks.
      const inside = await view(page);
      const edgeLat = cover.north - (inside.north - inside.south) / 4;
      await moveTo(page, [edgeLat, CENTER[1]], VECTOR_ZOOM);
      const edge = await view(page);
      assert.ok(edge.lat < cover.north && edge.lat > cover.south && edge.lng > cover.west && edge.lng < cover.east, `${width}: center inside ${JSON.stringify(edge)}`);
      assert.ok(edge.north > cover.north, `${width}: north edge outside (${edge.north} > ${cover.north})`);
      await settleOn(page, "vector", `${width} edge`);
      await shot(page, `protomaps-edge-w${width}.png`);

      // Zoomed out to the archive's minzoom over Stuttgart: every edge sticks out, center inside, still vector.
      await moveTo(page, CENTER, cover.minzoom);
      const wide = await view(page);
      assert.equal(wide.zoom, cover.minzoom, `${width}: at z${cover.minzoom}`);
      assert.ok(wide.west < cover.west && wide.east > cover.east && wide.south < cover.south && wide.north > cover.north, `${width}: view overhangs on all sides ${JSON.stringify(wide)}`);
      await settleOn(page, "vector", `${width} wide z${cover.minzoom}`);
      await shot(page, `protomaps-wide-w${width}.png`);

      // Center just past the north edge, edges still overlapping the archive: raster.
      const outLat = cover.north + (inside.north - inside.south) / 4;
      await moveTo(page, [outLat, CENTER[1]], VECTOR_ZOOM);
      const out = await view(page);
      assert.ok(out.lat > cover.north && out.south < cover.north, `${width}: center outside, view overlaps ${JSON.stringify(out)}`);
      await settleOn(page, "raster", `${width} center outside`);
      // A zoomed-out view centered on central Europe, in the archive's zoom range: raster.
      await moveTo(page, EUROPE, cover.minzoom);
      await settleOn(page, "raster", `${width} Europe center z${cover.minzoom}`);
      await moveTo(page, CENTER, VECTOR_ZOOM);
      await settleOn(page, "vector", `${width} back in after edge`);

      // Past the archive's last zoom level its deepest data is drawn larger: still vector, not blank.
      const deep = cover.maxzoom + 3;
      await moveTo(page, CENTER, deep);
      assert.equal((await view(page)).zoom, deep, `${width}: zoomed to ${deep}`);
      await settleOn(page, "vector", `${width} z${deep}`);
      const pixels = await darkWithStreets(page);
      assert.ok(pixels.dark && pixels.streets, `${width}: z${deep} is drawn ${JSON.stringify(pixels)}`);
      await shot(page, `protomaps-deep-w${width}.png`);

      // The archive goes away mid-session. Pans inside the fixture need new tiles and fail.
      await moveTo(page, CENTER, VECTOR_ZOOM);
      await settleOn(page, "vector", `${width} before failure`);
      const before = await layerAdds(page);
      const okBefore = archive.statuses.length;
      let aborted = 0;
      await page.context().route("**/tiles/basemap.pmtiles", (route) => {
        aborted += 1;
        return route.abort("connectionreset");
      });
      // All inside the fixture at z16 on every phone. The first crosses into a data tile not loaded yet.
      const spots: Array<[number, number]> = [[48.7775, 9.1853], [48.7778, 9.1755], [48.7768, 9.1835], [48.7785, 9.1775], [48.7775, 9.181]];
      await moveTo(page, spots[0], VECTOR_ZOOM);
      await settleOn(page, "raster", `${width} after failure`);
      assert.ok(aborted > 0, `${width}: the archive was asked for and failed`);
      const afterFirst = await layerAdds(page);
      for (const spot of spots.slice(1)) {
        await moveTo(page, spot, VECTOR_ZOOM);
        await page.waitForTimeout(400);
        const state = await basemap(page);
        assert.equal(state.layers, 1, `${width}: one layer at ${spot}`);
        assert.equal(state.canvases, 0, `${width}: no vector canvas at ${spot}`);
      }
      await settleOn(page, "raster", `${width} after pans`);
      assert.ok(raster.hits > 0, `${width}: raster tiles fetched`);
      assert.ok(afterFirst - before <= 1, `${width}: one swap to raster (${before} -> ${afterFirst})`);
      assert.equal(await layerAdds(page), afterFirst, `${width}: no more swaps over ${spots.length - 1} pans`);
      assert.equal(archive.statuses.length, okBefore, `${width}: no archive reply got through`);
      const abortedAfterSwap = aborted;
      await moveTo(page, CENTER, VECTOR_ZOOM);
      await page.waitForTimeout(600);
      assert.equal(aborted, abortedAfterSwap, `${width}: the archive is not retried once it failed`);
      await shot(page, `protomaps-failed-w${width}.png`);
    } finally {
      await page.context().close();
    }
  }
});

/** Raster tiles are drawn and no vector canvas is in the map. */
const RASTER_DRAWN = `(() => {
  const map = document.getElementById("hangry-map");
  return Boolean(map && map.querySelector("img.leaflet-tile.leaflet-tile-loaded") && !map.querySelector("canvas.leaflet-tile"));
})()`;

test("a slow archive: raster tiles show right away, then the dark map takes over", { timeout: 300_000 }, async () => {
  const host = await hangry.call("POST", "/api/auth/start", undefined, { name: "Sol" });
  await hangry.call("POST", "/api/circles", host.token, { name: "Slow" });
  await hangry.call("POST", "/api/plans", host.token, {
    note: "Slow dinner", date: daysAhead(1), time: "19:00", place: "Schlossplatz", lat: SCHLOSSPLATZ[0], lng: SCHLOSSPLATZ[1], precise: true,
  });
  const ARCHIVE_DELAY = 4000;
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  for (const [width, height] of SIZES) {
    // Every archive read is held back, the head read ahead on the idle app too.
    const { page, raster, archive } = await phone(width, height, host.token, "nobody", { worker: false, archiveDelay: ARCHIVE_DELAY });
    try {
      const clicked = Date.now();
      await page.locator(".tabbar").getByRole("button", { name: /^Map/ }).click();
      await page.waitForFunction(RASTER_DRAWN, null, { timeout: 3000, polling: 50 });
      const rasterAfter = Date.now() - clicked;
      assert.ok(rasterAfter < 2000, `${width}: raster drawn ${rasterAfter} ms after the tap, not after the ${ARCHIVE_DELAY} ms archive`);
      assert.ok(raster.hits > 0, `${width}: raster tiles fetched`);
      await shot(page, `protomaps-slow-raster-w${width}.png`);
      await settleOn(page, "vector", `${width} slow archive ready`);
      assert.ok(archive.statuses.length > 0 && archive.statuses.every((status) => status === 206), `${width}: archive read ${archive.statuses}`);
      assert.equal(await layerAdds(page), 2, `${width}: raster first, then one swap to vector`);
      // Tile reads are held back too: wait for the streets to be painted before the picture.
      const paintBy = Date.now() + 20_000;
      let pixels = await darkWithStreets(page);
      while (!(pixels.dark && pixels.streets) && Date.now() < paintBy) {
        await page.waitForTimeout(200);
        pixels = await darkWithStreets(page);
      }
      assert.ok(pixels.dark && pixels.streets, `${width}: the dark map is drawn ${JSON.stringify(pixels)}`);
      await shot(page, `protomaps-slow-vector-w${width}.png`);
    } finally {
      await page.context().close();
    }
  }
});

test("on an idle app the map files and the archive head load ahead, so the Map tab opens dark at once", { timeout: 300_000 }, async () => {
  const meta = await hangry.call("GET", "/api/meta");
  const head = meta.mapPmtilesHead as number;
  assert.ok(Number.isSafeInteger(head) && head >= 16384, `head size in meta (${head})`);
  const host = await hangry.call("POST", "/api/auth/start", undefined, { name: "Wim" });
  await hangry.call("POST", "/api/circles", host.token, { name: "Warm" });
  await hangry.call("POST", "/api/plans", host.token, {
    note: "Warm dinner", date: daysAhead(1), time: "19:00", place: "Schlossplatz", lat: SCHLOSSPLATZ[0], lng: SCHLOSSPLATZ[1], precise: true,
  });
  for (const [width, height] of SIZES) {
    const { page, raster, archive } = await phone(width, height, host.token, "nobody", { worker: false });
    try {
      // Still on Now: Leaflet, the vector script and the head arrive without opening the map.
      await page.waitForFunction(`Boolean(window.L && window.protomapsL)`, null, { timeout: 10_000 });
      const deadline = Date.now() + 10_000;
      while (!archive.ranges.includes(`bytes=0-${head - 1}`) && Date.now() < deadline) await page.waitForTimeout(50);
      assert.deepEqual(archive.ranges, [`bytes=0-${head - 1}`], `${width}: one head read ahead`);
      assert.equal(await page.locator("#hangry-map").count(), 0, `${width}: map not open yet`);
      assert.equal(await page.locator("link[data-leaflet]").count(), 1, `${width}: Leaflet css in place`);

      await page.locator(".tabbar").getByRole("button", { name: /^Map/ }).click();
      await page.locator(".leaflet-marker-icon.pin-plan").waitFor({ timeout: 10_000 });
      await settleOn(page, "vector", `${width} warm open`);
      assert.equal(await layerAdds(page), 1, `${width}: straight to the dark map, no raster first`);
      assert.equal(raster.hits, 0, `${width}: no raster tiles`);
      assert.equal(archive.ranges.filter((range) => range.startsWith("bytes=0-")).length, 1, `${width}: the head was not read again ${archive.ranges}`);
      await shot(page, `protomaps-warm-w${width}.png`);
    } finally {
      await page.context().close();
    }
  }
});
