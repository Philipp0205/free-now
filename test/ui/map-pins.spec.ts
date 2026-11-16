import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "@playwright/test";
import zlib from "node:zlib";
import type { Page } from "playwright-core";
import { shortDate } from "../../public/js/when.js";
import { skipWhatsNew } from "./whats-new-seen.js";
import { UA as CHROME_UA, openEventsMap, openYouSection, useHangry } from "./harness.js";
import { testEmail } from "../http.js";
/** Screenshots land here. Override with MAP_PINS_SHOT_DIR. */
const SHOT_DIR = path.resolve(process.env.MAP_PINS_SHOT_DIR || "/workspace/hangry-mapbuzz-logs/shots");
const SIZES: Array<[number, number]> = [[320, 568], [360, 640], [412, 915]];
const PLAN_NOTE = "Rooftop dinner";

const hangry = useHangry({ tz: "UTC" });

function daysAhead(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Same generated test "photo" as profile-pictures.spec.ts: a warm gradient with a light disc. */
function testPhoto(width = 320, height = 240): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const dx = x - width / 2;
      const dy = y - height / 2;
      const inDisc = dx * dx + dy * dy < 70 * 70;
      const i = row + 1 + x * 3;
      raw[i] = inDisc ? 255 : Math.round(230 - (y / height) * 120);
      raw[i + 1] = inDisc ? 214 : Math.round(80 + (x / width) * 90);
      raw[i + 2] = inDisc ? 120 : Math.round(60 + (y / height) * 150);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Upload on the You tab, the way profile-pictures.spec.ts does. */
async function uploadPhoto(token: string, file: string) {
  const page = await phone(360, 640, token);
  try {
    await openYouSection(page, "Profile");
    const chooser = page.waitForEvent("filechooser");
    await page.locator(".profile-hero .avatar-btn").click();
    await (await chooser).setFiles(file);
    await page.getByRole("status").getByText("Photo saved").waitFor();
  } finally {
    await page.context().close();
  }
}

/** The pin photo really decoded. */
async function photoLoaded(page: Page, selector: string): Promise<number> {
  const img = page.locator(selector).first();
  await img.waitFor({ timeout: 10_000 });
  return img.evaluate(async (node: HTMLImageElement) => {
    await node.decode().catch(() => {});
    return node.naturalWidth;
  });
}

async function people() {
  const host = await hangry.call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Hana" });
  const { circle } = await hangry.call("POST", "/api/circles", host.token, { name: "Friends" });
  const join = (name: string) => hangry.call("POST", "/api/auth/start", undefined, { email: testEmail(), name, code: circle.inviteCode });
  const going = [await join("Ana"), await join("Ben"), await join("Cyd"), await join("Dee")];
  const maybe = await join("Max");
  return { host, going, maybe };
}

/** How often the broken photo was served, so its fallback check is not vacuous. */
let brokenHits = 0;

async function phone(width: number, height: number, token: string, brokenPhoto = ""): Promise<Page> {
  const context = await hangry.browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: CHROME_UA });
  await skipWhatsNew(context);
  await context.route("https://server.arcgisonline.com/**", (route) => route.fulfill({ status: 204, body: "" }));
  // This person's photo arrives as bytes that are not an image, so the <img> fails to decode.
  if (brokenPhoto) {
    await context.route(`**/api/users/${brokenPhoto}/avatar**`, (route) => {
      brokenHits += 1;
      return route.fulfill({ status: 200, contentType: "image/webp", body: Buffer.from("not an image at all") });
    });
  }
  const page = await context.newPage();
  await page.goto(`${hangry.baseUrl}/robots.txt`);
  await page.evaluate((value) => {
    localStorage.clear();
    localStorage.setItem("fn_token", value);
    localStorage.setItem("fn_installed", "1");
    localStorage.setItem("fn_install_later", String(Date.now()));
  }, token);
  await page.goto(hangry.baseUrl);
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
  return page;
}

/** Animation names on the buzzer body and its ring, plus the ring's shadow. */
async function buzz(page: Page) {
  return page.locator(".leaflet-marker-icon.pin-now .pin-body").evaluate((node) => ({
    body: getComputedStyle(node).animationName,
    ring: getComputedStyle(node, "::before").animationName,
    ringShadow: getComputedStyle(node, "::before").boxShadow,
  }));
}

test("map pins: day labels, photos with a broken-photo fallback, a going crowd with +N, a live buzzer that calms down for reduced motion", { timeout: 240_000 }, async () => {
  const { host, going, maybe } = await people();
  // Ana is a crowd face with a photo, Ben posts the live buzzer (and is in the crowd), Cyd's photo will not load.
  const [ana, ben, cyd] = going;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hangry-map-pins-"));
  const photo = path.join(tmp, "photo.png");
  fs.writeFileSync(photo, testPhoto());
  for (const person of [host, ana, ben, cyd]) await uploadPhoto(person.token, photo);
  fs.rmSync(tmp, { recursive: true, force: true });

  const { plan } = await hangry.call("POST", "/api/plans", host.token, {
    note: PLAN_NOTE, date: daysAhead(1), time: "19:00", place: "Schlossplatz", lat: 48.7784, lng: 9.18, precise: true,
  });
  const laterDay = daysAhead(5);
  const laterLabel = shortDate(laterDay, daysAhead(0));
  await hangry.call("POST", "/api/plans", ana.token, {
    note: "Lake swim", date: laterDay, time: "10:00", place: "Max-Eyth-See", lat: 48.7835, lng: 9.1725, precise: true,
  });
  for (const person of going) await hangry.call("POST", `/api/plans/${plan.id}/reply`, person.token, { reply: "in" });
  await hangry.call("POST", `/api/plans/${plan.id}/reply`, maybe.token, { reply: "maybe" });
  await hangry.call("POST", "/api/socials", ben.token, { note: "Coffee now", place: "Marktplatz", lat: 48.7752, lng: 9.1772, precise: true });

  fs.mkdirSync(SHOT_DIR, { recursive: true });
  for (const [width, height] of SIZES) {
    brokenHits = 0;
    const page = await phone(width, height, host.token, cyd.user.id);
    try {
      await openEventsMap(page);
      const planPin = page.locator(".leaflet-marker-icon.pin-plan").filter({ has: page.locator(".pin-when", { hasText: "Tomorrow" }) });
      const laterPin = page.locator(".leaflet-marker-icon.pin-plan").filter({ hasNot: page.locator(".pin-when", { hasText: "Tomorrow" }) });
      const nowPin = page.locator(".leaflet-marker-icon.pin-social");
      await planPin.waitFor({ timeout: 10_000 });
      await nowPin.waitFor({ timeout: 10_000 });
      await page.waitForTimeout(500);

      // The future plan shows its day.
      assert.equal(await planPin.locator(".pin-when").innerText(), "Tomorrow", `${width}: plan label`);
      assert.equal(await nowPin.locator(".pin-when").count(), 0, `${width}: a live buzzer has no date`);
      const later = await laterPin.locator(".pin-when").innerText();
      assert.match(later, /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2} [A-Z][a-z]{2}$/, `${width}: short date ${later}`);
      assert.equal(later, laterLabel, `${width}: the app's short date`);

      // Photos: host and buzzer poster on their pins, Ana in the crowd. Cyd's broken photo falls back to "C".
      assert.ok(await photoLoaded(page, ".leaflet-marker-icon.pin-plan:has(.pin-crowd) .pin-body > .pin-letter img.pin-photo") > 0, `${width}: host photo`);
      assert.ok(await photoLoaded(page, ".leaflet-marker-icon.pin-social .pin-body > .pin-letter img.pin-photo") > 0, `${width}: buzzer photo`);
      assert.ok(await photoLoaded(page, `.leaflet-marker-icon.pin-plan .pin-face[data-person="${ana.user.id}"] img.pin-photo`) > 0, `${width}: Ana's face`);
      const broken = planPin.locator(`.pin-face[data-person="${cyd.user.id}"]`);
      await page.waitForTimeout(500);
      assert.ok(brokenHits > 0, `${width}: the broken photo was requested`);
      assert.equal(await broken.locator("img").count(), 0, `${width}: broken photo removed`);
      assert.equal(await broken.innerText(), "C", `${width}: broken photo shows the initial`);

      // Host is the pin; three of the four friends In are faces, the fourth is +1. Maybe stays off.
      const faces = planPin.locator(".pin-crowd .pin-face");
      assert.equal(await faces.count(), 3, `${width}: three faces`);
      assert.equal(await planPin.locator(".pin-crowd .pin-more").innerText(), "+1", `${width}: overflow`);
      const ids = await faces.evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.person));
      assert.ok(!ids.includes(maybe.user.id), `${width}: Maybe is not in the crowd`);
      assert.ok(!ids.includes(host.user.id), `${width}: the host is not repeated`);
      assert.deepEqual(ids, [ana.user.id, ben.user.id, cyd.user.id], `${width}: the first three In`);
      assert.equal(await planPin.locator(".pin-crowd").evaluate((node) => getComputedStyle(node).pointerEvents), "none");

      // The live buzzer buzzes; the plan never does.
      assert.ok(await nowPin.evaluate((node) => node.classList.contains("pin-now")), `${width}: buzzer class`);
      assert.equal(await planPin.evaluate((node) => node.classList.contains("pin-now")), false, `${width}: plan is not now`);
      assert.equal(await planPin.locator(".pin-body").evaluate((node) => getComputedStyle(node).animationName), "none");
      const moving = await buzz(page);
      assert.equal(moving.body, "pin-buzz", `${width}: shake`);
      assert.equal(moving.ring, "pin-ring", `${width}: ring pulse`);
      const zNow = await nowPin.evaluate((node) => Number(getComputedStyle(node).zIndex));
      const zPlan = await planPin.evaluate((node) => Number(getComputedStyle(node).zIndex));
      assert.ok(zNow > zPlan, `${width}: buzzer on top (${zNow} > ${zPlan})`);
      await page.screenshot({ path: path.join(SHOT_DIR, `map-pins-w${width}.png`) });

      // Reduced motion: still, but the thicker ring stays.
      await page.emulateMedia({ reducedMotion: "reduce" });
      const still = await buzz(page);
      assert.equal(still.body, "none", `${width}: no shake`);
      assert.equal(still.ring, "none", `${width}: no pulse`);
      assert.match(still.ringShadow, /7px/, `${width}: static ring ${still.ringShadow}`);
      assert.ok(await nowPin.evaluate((node) => node.classList.contains("pin-now")), `${width}: still marked now`);
      await page.screenshot({ path: path.join(SHOT_DIR, `map-pins-reduced-w${width}.png`) });
      await page.emulateMedia({ reducedMotion: "no-preference" });

      // Tapping the plan pin still opens its card.
      await planPin.click();
      await page.locator(".map-card", { hasText: PLAN_NOTE }).waitFor({ timeout: 5000 });
      await page.screenshot({ path: path.join(SHOT_DIR, `map-pins-card-w${width}.png`) });
    } finally {
      await page.context().close();
    }
  }
});
