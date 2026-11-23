import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { test } from "@playwright/test";
import type { Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { openMoreOptions, openPlanSheet } from "./plan-sheet.js";
import { SIZES, UA, dismissPaymentReminder, useHangry } from "./harness.js";
import { testEmail } from "../http.js";

// Fake people and a generated picture only. Screenshots go to test/ui/screenshots (gitignored).
const SHOT_DIR = path.resolve("test/ui/screenshots/event-photos");
const hangry = useHangry({ tz: "UTC" });
const { call } = hangry;

async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}-w${page.viewportSize()!.width}.png`) });
}

function daysAhead(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const CRC = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of body) crc = CRC[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([head, body, tail]);
}

/** A 320x180 orange to teal gradient PNG, built in memory. */
function gradientPng(): Buffer {
  const w = 320;
  const h = 180;
  const rows = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const at = y * (w * 3 + 1);
    for (let x = 0; x < w; x++) {
      rows[at + 1 + x * 3] = Math.round(255 - (x / w) * 200);
      rows[at + 2 + x * 3] = Math.round(120 + (y / h) * 100);
      rows[at + 3 + x * 3] = Math.round(60 + (x / w) * 180);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const PNG = gradientPng();
const FILE = { name: "party.png", mimeType: "image/png", buffer: PNG };

/** Hana hosts a circle with Bea. */
async function seed(label: string) {
  const host = await call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Hana" });
  const { circle } = await call("POST", "/api/circles", host.token, { name: `Photos ${label}` });
  const bea = await call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Bea", code: circle.inviteCode });
  hangry.confirmEmails();
  return { host, bea, circle };
}

async function phone(width: number, height: number, token: string, circleId: string, opts: { compact?: boolean; scheme?: "light" | "dark" } = {}): Promise<Page> {
  const context = await hangry.browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: UA, colorScheme: opts.scheme ?? "dark" });
  await skipWhatsNew(context);
  await context.addInitScript(([value, circle, wantCompact]) => {
    localStorage.setItem("fn_install_later", String(Date.now()));
    localStorage.setItem("fn_installed", "1");
    localStorage.setItem("fn_token", value);
    localStorage.setItem("fn_circle", circle);
    if (wantCompact) localStorage.setItem("fn_compact_home", "1");
  }, [token, circleId, opts.compact ? "1" : ""]);
  await context.route(/arcgisonline|tile\.openstreetmap|basemaps\.cartocdn|protomaps|\.pmtiles/, (route) => route.fulfill({ status: 204, body: "" }));
  const page = await context.newPage();
  await page.goto(hangry.baseUrl);
  await page.getByRole("heading", { name: "Now", exact: true, level: 1 }).waitFor();
  await dismissPaymentReminder(page);
  return page;
}

/** Clicks the photo button and answers the file chooser it opens, like a person picking from their library. */
async function choosePhoto(page: Page, name: string): Promise<void> {
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name, exact: true }).click()]);
  await chooser.setFiles(FILE);
}

/** Waits until the <img> inside `selector` has decoded real pixels. */
async function loaded(page: Page, selector: string): Promise<void> {
  await page.waitForFunction((sel) => {
    const img = document.querySelector<HTMLImageElement>(`${sel} img`);
    return !!img && img.complete && img.naturalWidth > 0;
  }, selector);
}

test("a free post made with a photo shows it on the card, opens it large, and lets Bea see it", { timeout: 180_000 }, async () => {
  const { host, bea, circle } = await seed("free");
  for (const [width, height] of SIZES) {
    const page = await phone(width, height, host.token, circle.id);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.getByRole("button", { name: "Let friends know you're free now" }).click();
      const sheet = page.locator("form.sheet");
      await openMoreOptions(page);
      const field = sheet.locator(".event-photo-field");
      await field.scrollIntoViewIfNeeded();
      await field.getByRole("button", { name: "Add photo" }).waitFor();
      assert.equal(await field.locator(".event-photo-preview").count(), 0, "no preview before a pick");
      await choosePhoto(page, "Add photo");
      await field.locator(".event-photo-preview img").waitFor();
      await field.getByRole("button", { name: "Replace" }).waitFor();
      await field.getByRole("button", { name: "Remove" }).waitFor();
      const box = await field.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1, `the photo row fits ${width}`);
      await shot(page, "free-sheet-picked");

      await sheet.getByRole("button", { name: "I'm free", exact: true }).click();
      const card = page.locator("[data-social]");
      await card.waitFor();
      const photo = card.locator(".event-photo");
      await photo.waitFor();
      await loaded(page, "[data-social] .event-photo");
      await shot(page, "social-card-photo");

      await photo.click();
      const lightbox = page.getByRole("dialog", { name: "Photo from Hana" });
      await lightbox.waitFor();
      await shot(page, "lightbox");
      await page.keyboard.press("Escape");
      await lightbox.waitFor({ state: "detached" });
      await photo.click();
      await page.getByRole("button", { name: "Close photo" }).click();
      await lightbox.waitFor({ state: "detached" });

      const mine = (await call("GET", "/api/socials", host.token)).socials[0];
      assert.ok(mine.photoRev, "the payload carries a photo revision");
      assert.equal((await call("GET", "/api/socials", bea.token)).socials[0].photoRev, mine.photoRev, "Bea sees the photo too");
      assert.deepEqual(errors, []);
      await call("DELETE", `/api/socials/${mine.id}`, host.token);
    } finally {
      await page.context().close();
    }
  }
});

test("a plan made with a photo shows it on the card and the details sheet, and Edit can remove it", { timeout: 180_000 }, async () => {
  const { host, circle } = await seed("plan");
  const page = await phone(360, 640, host.token, circle.id);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await openPlanSheet(page);
    const sheet = page.locator("form.sheet");
    await sheet.locator("#sheet-note").fill("Lantern night");
    await sheet.locator("#plan-date").fill(daysAhead(1));
    await sheet.locator("#plan-time").fill("19:00");
    await openMoreOptions(page);
    await choosePhoto(page, "Add photo");
    await sheet.locator(".event-photo-preview img").waitFor();
    await shot(page, "plan-sheet-picked");
    await sheet.getByRole("button", { name: "Add plan", exact: true }).click();

    const card = page.locator(".card-plan", { hasText: "Lantern night" });
    await card.locator(".event-photo").waitFor();
    await loaded(page, ".card-plan .event-photo");
    await shot(page, "plan-card-photo");

    await card.getByRole("button", { name: "Open details" }).click();
    const details = page.getByRole("dialog", { name: "Details" });
    await details.locator(".detail-photo").waitFor();
    await loaded(page, ".detail-photo");
    await shot(page, "plan-details-photo");
    await page.keyboard.press("Escape");
    await details.waitFor({ state: "detached" });

    await card.locator(".card-more").click();
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
    const edit = page.getByRole("dialog", { name: "Edit" });
    await edit.locator(".event-photo-preview img").waitFor();
    await shot(page, "plan-edit-photo");
    await edit.getByRole("button", { name: "Remove" }).click();
    await edit.getByRole("button", { name: "Add photo" }).waitFor();
    await edit.getByRole("button", { name: "Save", exact: true }).click();
    await edit.waitFor({ state: "detached" });
    await card.waitFor();
    assert.equal(await card.locator(".event-photo").count(), 0, "no photo after Remove");
    assert.equal((await call("GET", "/api/plans", host.token)).plans[0].photoRev, undefined);
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

test("an event without a photo looks unchanged, and a guest never gets a photo row", { timeout: 180_000 }, async () => {
  const { host, bea, circle } = await seed("plain");
  await call("POST", "/api/plans", host.token, { note: "Plain picnic", date: daysAhead(1), time: "12:00" });
  const page = await phone(360, 640, host.token, circle.id);
  try {
    const card = page.locator(".card-plan", { hasText: "Plain picnic" });
    await card.waitFor();
    assert.equal(await card.locator(".event-photo").count(), 0, "no photo box on a plain card");
    await shot(page, "plain-card");
  } finally {
    await page.context().close();
  }
  const guest = await phone(360, 640, bea.token, circle.id);
  try {
    await guest.locator(".card-plan", { hasText: "Plain picnic" }).waitFor();
    assert.equal(await guest.locator(".event-photo-field").count(), 0, "a guest never gets the photo row");
  } finally {
    await guest.context().close();
  }
});

test("the photo looks right in Light and in Dark, and on a compact row", { timeout: 180_000 }, async () => {
  const { host, circle } = await seed("themes");
  const made = (await call("POST", "/api/plans", host.token, { note: "Pier walk", date: daysAhead(1), time: "17:00" })).plan;
  const up = await fetch(`${hangry.baseUrl}/api/plans/${made.id}/photo`, { method: "PUT", headers: { authorization: `Bearer ${host.token}`, "content-type": "image/png" }, body: PNG });
  assert.equal(up.status, 200);
  for (const scheme of ["light", "dark"] as const) {
    const page = await phone(360, 640, host.token, circle.id, { scheme });
    try {
      const card = page.locator(".card-plan", { hasText: "Pier walk" });
      await card.locator(".event-photo").waitFor();
      await loaded(page, ".card-plan .event-photo");
      await shot(page, `card-${scheme}`);
    } finally {
      await page.context().close();
    }
    const compact = await phone(360, 640, host.token, circle.id, { compact: true, scheme });
    try {
      const row = compact.locator(".compact-row", { hasText: "Pier walk" });
      await row.locator(".compact-photo img").waitFor();
      await loaded(compact, ".compact-photo");
      await shot(compact, `compact-${scheme}`);
    } finally {
      await compact.context().close();
    }
  }
});
