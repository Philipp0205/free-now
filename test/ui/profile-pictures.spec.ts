import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { openDb } from "../../src/db.js";
import { createNoopPushSender } from "../../src/push.js";
import { skipWhatsNew } from "./whats-new-seen.js";
import { openYouSection } from "./harness.js";

const SHOT_DIR = process.env.HANG_SHOT_DIR || "/workspace/hangry-shots/profile-pictures/";
const CHROME_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36";

let browser: Browser;
let baseUrl = "";
let tmpRoot = "";
let avatarDir = "";
let closeServer: () => Promise<void> = async () => {};

function shot(name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  return path.join(SHOT_DIR, name);
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

/**
 * A 320×240 test "photo" made in pure Node: warm gradient with a light disc in the middle.
 * Landscape on purpose, so the client has to centre-crop it to a square.
 */
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

async function call(method: string, urlPath: string, token?: string, body?: Record<string, unknown>) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  assert.ok(res.ok, `${method} ${urlPath} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : {};
}

async function people() {
  const host = await call("POST", "/api/auth/start", undefined, { name: "Hana" });
  const { circle } = await call("POST", "/api/circles", host.token, { name: "Friends" });
  const friend = await call("POST", "/api/auth/start", undefined, { name: "Finn", code: circle.inviteCode });
  return { host, friend, circle };
}

async function phone(width: number, height: number, video = false): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: { width, height },
    isMobile: true,
    hasTouch: true,
    userAgent: CHROME_UA,
    colorScheme: "light",
    ...(video ? { recordVideo: { dir: shot("video-tmp"), size: { width, height } } } : {}),
  });
  await skipWhatsNew(context);
  await context.route("https://server.arcgisonline.com/**", (route) => route.fulfill({ status: 204, body: "" }));
  return { context, page: await context.newPage() };
}

async function asUser(page: Page, token: string) {
  await page.goto(`${baseUrl}/robots.txt`);
  await page.evaluate((value) => {
    localStorage.clear();
    localStorage.setItem("fn_token", value);
    localStorage.setItem("fn_installed", "1");
    localStorage.setItem("fn_install_later", String(Date.now()));
  }, token);
  await page.goto(baseUrl);
  await page.locator("nav.tabbar").waitFor();
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
}

const tab = (page: Page, name: string) => page.locator("nav.tabbar").getByRole("button", { name, exact: true }).click();

/** The <img> really decoded a 256×256 photo, and it is a circle the size it should be. */
async function photoOk(page: Page, selector: string, size: number) {
  const img = page.locator(selector).first();
  await img.waitFor({ timeout: 10_000 });
  const info = await img.evaluate(async (node: HTMLImageElement) => {
    await node.decode().catch(() => {});
    const box = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return { natural: node.naturalWidth, w: box.width, h: box.height, fit: style.objectFit, radius: style.borderRadius, src: node.src };
  });
  assert.equal(info.natural, 256, `decoded photo ${JSON.stringify(info)}`);
  assert.ok(Math.abs(info.w - size) < 0.6 && Math.abs(info.h - size) < 0.6, `size ${JSON.stringify(info)}`);
  assert.equal(info.fit, "cover");
  assert.equal(info.radius, "50%");
  assert.match(info.src, /^blob:/, "loaded with the Bearer token, not a bare URL");
}

async function choosePhoto(page: Page, file: string) {
  const chooser = page.waitForEvent("filechooser");
  await page.locator(".profile-hero .avatar-btn").click();
  await (await chooser).setFiles(file);
}

test.before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hangry-pp-ui-"));
  const dbFile = path.join(tmpRoot, "ui.sqlite");
  const db = openDb(dbFile);
  const config = loadConfig({ PORT: "3000", DB_PATH: dbFile, APP_TZ: "UTC" });
  avatarDir = config.avatarDir;
  const server = http.createServer(createApp({ db, push: createNoopPushSender(), config, now: () => Date.now() }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closeServer = async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  };
  fs.writeFileSync(path.join(tmpRoot, "photo.png"), testPhoto());
  try { browser = await chromium.launch({ channel: "chrome", headless: true }); }
  catch { browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true }); }
});

test.after(async () => {
  await browser?.close();
  await closeServer();
});

test("add a photo on You; it shows on the hero, plan card, members and details; remove brings initials back", { timeout: 180_000 }, async () => {
  const { host, friend } = await people();
  const plan = (await call("POST", "/api/plans", host.token, { note: "Rooftop drinks", time: "19:30" })).plan;
  await call("POST", `/api/plans/${plan.id}/join`, friend.token);
  const photo = path.join(tmpRoot, "photo.png");

  const { context, page } = await phone(360, 640);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await asUser(page, host.token);
    await openYouSection(page, "Profile");
    const hero = page.locator(".profile-hero");
    assert.equal(await hero.locator("span.avatar.lg").innerText(), "H");
    assert.equal(await hero.getByRole("button", { name: "Remove photo" }).count(), 0, "no Remove without a photo");

    await choosePhoto(page, photo);
    await page.getByRole("status").getByText("Photo saved").waitFor();
    await photoOk(page, ".profile-hero img.avatar.lg", 72);
    await hero.getByRole("button", { name: "Remove photo" }).waitFor();
    await hero.locator("button.text-btn", { hasText: "Change photo" }).waitFor();
    const me = await call("GET", "/api/me", host.token);
    assert.ok(me.user.avatarRev > 0);
    const stored = fs.readdirSync(avatarDir).filter((name) => name.startsWith(host.user.id));
    assert.equal(stored.length, 1, `one file ${stored}`);
    const bytes = fs.statSync(path.join(avatarDir, stored[0])).size;
    assert.ok(bytes <= 50 * 1024, `≤50 KB, got ${bytes}`);
    await page.locator(".toast").waitFor({ state: "detached", timeout: 6000 });
    await page.screenshot({ path: shot("you-with-photo-w360.png") });

    // Plan card on Now.
    await tab(page, "Now");
    const card = page.locator(".card-plan", { hasText: "Rooftop drinks" });
    await photoOk(page, `.card-plan[data-plan="${plan.id}"] .avatars img.avatar[data-person="${host.user.id}"]`, 28);
    assert.equal(await card.locator(`.avatars span.avatar[data-person="${friend.user.id}"]`).innerText(), "F", "Finn keeps initials");
    await page.screenshot({ path: shot("card-with-photo-w360.png") });

    // Details sheet: Who's in.
    await card.getByRole("button", { name: "Open details" }).click();
    const details = page.getByRole("dialog", { name: "Details" });
    await details.getByText("Who's in").waitFor();
    await photoOk(page, `.sheet .guest-row img.avatar[data-person="${host.user.id}"]`, 28);
    await page.keyboard.press("Escape");
    await details.waitFor({ state: "detached" });

    // Members list.
    await tab(page, "Circle");
    await photoOk(page, `.member-row img.avatar[data-person="${host.user.id}"]`, 40);
    await page.screenshot({ path: shot("members-with-photo-w360.png") });

    // w390 You shot.
    await page.setViewportSize({ width: 390, height: 844 });
    await openYouSection(page, "Profile");
    await photoOk(page, ".profile-hero img.avatar.lg", 72);
    await page.screenshot({ path: shot("you-with-photo-w390.png") });
    await page.setViewportSize({ width: 360, height: 640 });

    // Finn, in the same circle, sees it on the card too (fetched with his own token).
    const finn = await phone(360, 640);
    try {
      await asUser(finn.page, friend.token);
      await photoOk(finn.page, `.card-plan .avatars img.avatar[data-person="${host.user.id}"]`, 28);
    } finally {
      await finn.context.close();
    }

    // Remove.
    await hero.getByRole("button", { name: "Remove photo" }).click();
    await page.getByRole("status").getByText("Photo removed").waitFor();
    await hero.locator("span.avatar.lg").waitFor();
    assert.equal(await hero.locator("span.avatar.lg").innerText(), "H");
    assert.equal(await hero.getByRole("button", { name: "Remove photo" }).count(), 0);
    await hero.locator("button.text-btn", { hasText: "Add photo" }).waitFor();
    assert.deepEqual(fs.readdirSync(avatarDir).filter((name) => name.startsWith(host.user.id)), []);
    await page.locator(".toast").waitFor({ state: "detached", timeout: 6000 });
    await page.screenshot({ path: shot("you-initials-after-remove-w360.png") });
    await tab(page, "Now");
    await page.locator(`.card-plan .avatars span.avatar[data-person="${host.user.id}"]`).waitFor();
    assert.equal(await page.locator(".card-plan img.avatar").count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("demo video: set photo → card → remove at 360×640", { timeout: 120_000 }, async () => {
  const { host } = await people();
  await call("POST", "/api/plans", host.token, { note: "Pizza night", time: "20:00" });
  const { context, page } = await phone(360, 640, true);
  try {
    await asUser(page, host.token);
    await page.waitForTimeout(600);
    await openYouSection(page, "Profile");
    await page.waitForTimeout(800);
    await choosePhoto(page, path.join(tmpRoot, "photo.png"));
    await page.locator(".profile-hero img.avatar.lg").waitFor();
    await page.waitForTimeout(1200);
    await tab(page, "Now");
    await page.locator(".card-plan img.avatar").waitFor();
    await page.waitForTimeout(1200);
    await openYouSection(page, "Profile");
    await page.waitForTimeout(600);
    await page.locator(".profile-hero").getByRole("button", { name: "Remove photo" }).click();
    await page.locator(".profile-hero span.avatar.lg").waitFor();
    await page.waitForTimeout(1200);
  } finally {
    await context.close();
  }
  const video = page.video();
  assert.ok(video, "video recorded");
  const target = shot("demo.webm");
  await video.saveAs(target);
  await video.delete();
  fs.rmSync(shot("video-tmp"), { recursive: true, force: true });
  assert.ok(fs.statSync(target).size > 10_000, "demo.webm has frames");
});
