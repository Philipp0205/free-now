import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { Page, Response } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { UA as CHROME_UA, useHangry } from "./harness.js";

/**
 * The dark Protomaps basemap over a real regional archive, and the raster map outside it.
 * Needs the Stuttgart extract; it is never copied into the repo. Override with PROTOMAPS_FILE.
 */
const ARCHIVE = process.env.PROTOMAPS_FILE || "/workspace/hangry-protomaps-logs/stuttgart.pmtiles";
const HAVE_ARCHIVE = fs.existsSync(ARCHIVE);
const SKIP = HAVE_ARCHIVE ? false : `no PMTiles archive at ${ARCHIVE} (set PROTOMAPS_FILE to run this spec)`;
/** Screenshots land here. Override with PROTOMAPS_SHOT_DIR. */
const SHOT_DIR = path.resolve(process.env.PROTOMAPS_SHOT_DIR || "/workspace/hangry-protomaps-logs/shots");
const SIZES: Array<[number, number]> = [[320, 568], [360, 640], [412, 915]];
const PLAN_NOTE = "Rooftop dinner";
const STUTTGART: [number, number] = [48.7784, 9.18];
const BERLIN: [number, number] = [52.52, 13.405];
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

const hangry = useHangry({ tz: "UTC", env: HAVE_ARCHIVE ? { MAP_PMTILES_PATH: ARCHIVE } : {} });

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

async function phone(width: number, height: number, token: string, brokenPhoto: string, options: { worker?: boolean } = {}) {
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

async function buzz(page: Page) {
  return page.locator(".leaflet-marker-icon.pin-now .pin-body").evaluate((node) => ({
    body: getComputedStyle(node).animationName,
    ring: getComputedStyle(node, "::before").animationName,
  }));
}

test("dark vector map over Stuttgart with every pin feature, raster in Berlin and zoomed out, archive read in small ranges and never cached", { skip: SKIP, timeout: 300_000 }, async () => {
  const size = fs.statSync(ARCHIVE).size;
  const host = await hangry.call("POST", "/api/auth/start", undefined, { name: "Hana" });
  const { circle } = await hangry.call("POST", "/api/circles", host.token, { name: "Friends" });
  const join = (name: string) => hangry.call("POST", "/api/auth/start", undefined, { name, code: circle.inviteCode });
  const [ana, ben, cyd, dee] = [await join("Ana"), await join("Ben"), await join("Cyd"), await join("Dee")];
  await uploadPhotos([host.token, ana.token, cyd.token]);
  const { plan } = await hangry.call("POST", "/api/plans", host.token, {
    note: PLAN_NOTE, date: daysAhead(1), time: "19:00", place: "Schlossplatz", lat: STUTTGART[0], lng: STUTTGART[1], precise: true,
  });
  for (const person of [ana, ben, cyd, dee]) await hangry.call("POST", `/api/plans/${plan.id}/reply`, person.token, { reply: "in" });
  await hangry.call("POST", "/api/socials", ben.token, { note: "Coffee now", place: "Marktplatz", lat: 48.7752, lng: 9.1772, precise: true });

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
      await settleOn(page, "vector", `${width} Stuttgart`);
      const pixels = await darkWithStreets(page);
      assert.ok(pixels.dark && pixels.streets, `${width}: dark background with streets ${JSON.stringify(pixels)}`);
      assert.equal(raster.hits, 0, `${width}: no raster tiles inside the archive`);
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
      await page.screenshot({ path: path.join(SHOT_DIR, `protomaps-stuttgart-w${width}.png`) });

      await page.emulateMedia({ reducedMotion: "reduce" });
      const still = await buzz(page);
      assert.equal(still.body, "none", `${width}: no shake with reduced motion`);
      assert.equal(still.ring, "none", `${width}: no pulse with reduced motion`);
      await page.screenshot({ path: path.join(SHOT_DIR, `protomaps-reduced-w${width}.png`) });
      await page.emulateMedia({ reducedMotion: "no-preference" });

      await planPin.click();
      await page.locator(".map-card", { hasText: PLAN_NOTE }).waitFor({ timeout: 5000 });
      await page.screenshot({ path: path.join(SHOT_DIR, `protomaps-card-w${width}.png`) });

      // The archive was read in byte ranges, a tiny part of the file.
      assert.ok(archive.statuses.length > 0, `${width}: archive requested`);
      assert.ok(archive.statuses.every((status) => status === 206), `${width}: only 206 replies ${archive.statuses}`);
      assert.ok(archive.ranges.every((range) => /^bytes=\d+-\d+$/.test(range)), `${width}: every request had a Range ${archive.ranges}`);
      assert.ok(archive.bytes < size / 20, `${width}: read ${archive.bytes} of ${size} bytes`);

      // Berlin is outside the archive: the raster map with its own credit, full detail.
      await moveTo(page, BERLIN, 15);
      await settleOn(page, "raster", `${width} Berlin`);
      assert.ok(raster.hits > 0, `${width}: raster tiles requested in Berlin`);
      await page.screenshot({ path: path.join(SHOT_DIR, `protomaps-berlin-w${width}.png`) });

      // Zoomed out to Europe over Stuttgart: the view leaves the archive, so raster again.
      await moveTo(page, STUTTGART, 5);
      await settleOn(page, "raster", `${width} Europe`);
      await page.screenshot({ path: path.join(SHOT_DIR, `protomaps-europe-w${width}.png`) });

      // And back in: dark again.
      await moveTo(page, STUTTGART, 15);
      await settleOn(page, "vector", `${width} back in Stuttgart`);
      assert.ok(archive.bytes < size / 10, `${width}: still a small part of the file (${archive.bytes} of ${size})`);

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
function archiveBounds(): { west: number; south: number; east: number; north: number; maxzoom: number } {
  const header = Buffer.alloc(127);
  const fd = fs.openSync(ARCHIVE, "r");
  try {
    fs.readSync(fd, header, 0, 127, 0);
  } finally {
    fs.closeSync(fd);
  }
  const [west, south, east, north] = [102, 106, 110, 114].map((at) => header.readInt32LE(at) / 1e7);
  return { west, south, east, north, maxzoom: header[101] };
}

test("edges, deep zoom, and an archive that fails mid-session: raster where vector cannot draw, no blank map, no swap loop", { skip: SKIP, timeout: 300_000 }, async () => {
  const cover = archiveBounds();
  const host = await hangry.call("POST", "/api/auth/start", undefined, { name: "Ida" });
  await hangry.call("POST", "/api/circles", host.token, { name: "Edge" });
  await hangry.call("POST", "/api/plans", host.token, {
    note: "Edge walk", date: daysAhead(1), time: "18:00", place: "Schlossplatz", lat: STUTTGART[0], lng: STUTTGART[1], precise: true,
  });

  fs.mkdirSync(SHOT_DIR, { recursive: true });
  for (const [width, height] of SIZES) {
    const { page, raster, archive } = await phone(width, height, host.token, "nobody", { worker: false });
    try {
      await page.locator(".tabbar").getByRole("button", { name: /^Map/ }).click();
      await page.locator(".leaflet-marker-icon.pin-plan").waitFor({ timeout: 10_000 });
      await moveTo(page, STUTTGART, 14);
      await settleOn(page, "vector", `${width} center`);

      // Center inside the archive, north edge past it: raster, so no blank strip along the edge.
      await moveTo(page, STUTTGART, 14);
      const inside = await view(page);
      const edgeLat = cover.north - (inside.north - inside.south) / 4;
      await moveTo(page, [edgeLat, STUTTGART[1]], 14);
      const edge = await view(page);
      assert.ok(edge.lat < cover.north && edge.lat > cover.south && edge.lng > cover.west && edge.lng < cover.east, `${width}: center inside ${JSON.stringify(edge)}`);
      assert.ok(edge.north > cover.north, `${width}: north edge outside (${edge.north} > ${cover.north})`);
      await settleOn(page, "raster", `${width} edge`);
      await page.screenshot({ path: path.join(SHOT_DIR, `protomaps-edge-w${width}.png`) });

      // Past the archive's last zoom level its deepest data is drawn larger: still vector, not blank.
      const deep = cover.maxzoom + 3;
      await moveTo(page, STUTTGART, deep);
      assert.equal((await view(page)).zoom, deep, `${width}: zoomed to ${deep}`);
      await settleOn(page, "vector", `${width} z${deep}`);
      const pixels = await darkWithStreets(page);
      assert.ok(pixels.dark && pixels.streets, `${width}: z${deep} is drawn ${JSON.stringify(pixels)}`);
      await page.screenshot({ path: path.join(SHOT_DIR, `protomaps-deep-w${width}.png`) });

      // The archive goes away mid-session. Pans inside Stuttgart need new tiles and fail.
      await moveTo(page, STUTTGART, 15);
      await settleOn(page, "vector", `${width} before failure`);
      const before = await layerAdds(page);
      const okBefore = archive.statuses.length;
      let aborted = 0;
      await page.context().route("**/tiles/basemap.pmtiles", (route) => {
        aborted += 1;
        return route.abort("connectionreset");
      });
      const spots: Array<[number, number]> = [[48.792, 9.205], [48.752, 9.145], [48.768, 9.255], [48.81, 9.17], [48.735, 9.2]];
      await moveTo(page, spots[0], 15);
      await settleOn(page, "raster", `${width} after failure`);
      assert.ok(aborted > 0, `${width}: the archive was asked for and failed`);
      const afterFirst = await layerAdds(page);
      for (const spot of spots.slice(1)) {
        await moveTo(page, spot, 15);
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
      await moveTo(page, STUTTGART, 15);
      await page.waitForTimeout(600);
      assert.equal(aborted, abortedAfterSwap, `${width}: the archive is not retried once it failed`);
      await page.screenshot({ path: path.join(SHOT_DIR, `protomaps-failed-w${width}.png`) });
    } finally {
      await page.context().close();
    }
  }
});
