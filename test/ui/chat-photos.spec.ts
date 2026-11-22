import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { test } from "@playwright/test";
import type { Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA, useHangry } from "./harness.js";
import { testEmail } from "../http.js";

// Fake people and a generated picture only. Screenshots go to test/ui/screenshots (gitignored).
const SHOT_DIR = path.resolve("test/ui/screenshots/chat-photos");
const hangry = useHangry({ tz: "UTC" });
const { call } = hangry;

async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}-w${page.viewportSize()!.width}.png`) });
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

const FILE = { name: "lunch.png", mimeType: "image/png", buffer: gradientPng() };

/** Hana and Bea share a circle. Olli is in a circle of his own. */
async function seed(label: string) {
  const hana = await call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Hana" });
  const { circle } = await call("POST", "/api/circles", hana.token, { name: `Photos ${label}` });
  const bea = await call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Bea", code: circle.inviteCode });
  const olli = await call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Olli" });
  await call("POST", "/api/circles", olli.token, { name: `Elsewhere ${label}` });
  hangry.confirmEmails();
  return { hana, bea, olli, circle };
}

/** The circle Chat tab, as a phone, for this person. */
async function openChat(width: number, height: number, token: string, circleId: string): Promise<Page> {
  const context = await hangry.browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: UA, colorScheme: "dark" });
  await skipWhatsNew(context);
  await context.addInitScript(([value, circle]) => {
    localStorage.setItem("fn_install_later", String(Date.now()));
    localStorage.setItem("fn_installed", "1");
    localStorage.setItem("fn_token", value);
    localStorage.setItem("fn_circle", circle);
  }, [token, circleId]);
  const page = await context.newPage();
  await page.goto(hangry.baseUrl);
  await page.locator(".tabbar").waitFor();
  await page.locator(".tabbar").getByRole("button", { name: /^Chat/ }).click();
  await page.locator(".chat-compose").waitFor();
  return page;
}

/** Taps the photo button and answers the file chooser, like a person picking from their library. */
async function pickPhoto(page: Page): Promise<void> {
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.locator(".chat-compose").getByRole("button", { name: "Add a photo" }).tap(),
  ]);
  await chooser.setFiles(FILE);
}

/** Waits until the sent photo has decoded real pixels. */
async function photoLoaded(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const img = document.querySelector<HTMLImageElement>(".chat-log .chat-photo img");
    return !!img && img.complete && img.naturalWidth > 0;
  });
}

for (const [width, height] of SIZES) {
  test(`a photo is staged, sent, opened large and seen by a friend at ${width}`, { timeout: 180_000 }, async () => {
    const { hana, bea, circle } = await seed(`s${width}`);
    const page = await openChat(width, height, hana.token, circle.id);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      const compose = page.locator(".chat-compose");
      const photoButton = compose.getByRole("button", { name: "Add a photo" });
      await photoButton.waitFor();
      // Every control of the composer fits the row, whatever the width.
      const box = await compose.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1, `the composer fits ${width}`);
      for (const control of [photoButton, compose.locator("#chat-input"), compose.locator(".chat-send")]) {
        const part = await control.boundingBox();
        assert.ok(part && part.x >= 0 && part.x + part.width <= width + 1, `a control fits ${width}`);
        assert.ok(part.width >= 40 && part.height >= 40, "and is a real tap target");
      }
      await shot(page, "composer");

      await pickPhoto(page);
      const preview = compose.locator(".photo-preview");
      await preview.locator("img").waitFor();
      assert.equal(await page.locator(".chat-log .chat-photo").count(), 0, "picking sends nothing yet");
      await shot(page, "preview");

      await page.locator("#chat-input").fill("typed, not sent");
      await compose.locator(".chat-send").tap();
      await page.locator(".chat-log .chat-photo").waitFor();
      await photoLoaded(page);
      assert.equal(await preview.count(), 0, "the preview goes once it is sent");
      assert.equal(await page.locator("#chat-input").inputValue(), "typed, not sent", "the typed words stay in the box");
      const bubble = await page.locator(".chat-log .chat-photo img").boundingBox();
      assert.ok(bubble && bubble.x >= 0 && bubble.x + bubble.width <= width, "the photo stays inside the screen");
      await shot(page, "sent");

      await page.locator(".chat-log .chat-photo").tap();
      const lightbox = page.getByRole("dialog", { name: "Photo from you" });
      await lightbox.waitFor();
      const big = await lightbox.locator("img").boundingBox();
      assert.ok(big && big.width > bubble.width, "the large photo is bigger than the one in the chat");
      await shot(page, "lightbox");
      await page.keyboard.press("Escape");
      await lightbox.waitFor({ state: "detached" });

      const friend = await openChat(width, height, bea.token, circle.id);
      try {
        await friend.locator(".chat-log .chat-photo").waitFor();
        await photoLoaded(friend);
        await friend.locator(".chat-msg", { has: friend.locator(".chat-photo") }).getByText("Hana", { exact: true }).waitFor();
        await shot(friend, "friend-sees");
      } finally {
        await friend.context().close();
      }
      assert.deepEqual(errors, [], "no page errors");
    } finally {
      await page.context().close();
    }
  });
}

test("a staged photo can be cancelled and nothing is posted", { timeout: 120_000 }, async () => {
  const { hana, circle } = await seed("cancel");
  const page = await openChat(360, 640, hana.token, circle.id);
  try {
    await pickPhoto(page);
    const preview = page.locator(".chat-compose .photo-preview");
    await preview.locator("img").waitFor();
    await preview.getByRole("button", { name: "Remove photo" }).tap();
    await preview.waitFor({ state: "detached" });
    assert.equal(await page.locator(".chat-log .chat-photo").count(), 0);
    const thread = await call("GET", `/api/circles/chat?circle=${circle.id}`, hana.token);
    assert.equal(thread.chat.messages.filter((message: { photo: boolean }) => message.photo).length, 0);
    await shot(page, "cancelled");
  } finally {
    await page.context().close();
  }
});

test("a photo is private to its chat and the sender can delete it", { timeout: 120_000 }, async () => {
  const { hana, bea, olli, circle } = await seed("private");
  const page = await openChat(360, 640, hana.token, circle.id);
  try {
    await pickPhoto(page);
    await page.locator(".chat-compose .photo-preview img").waitFor();
    await page.locator(".chat-compose .chat-send").tap();
    await page.locator(".chat-log .chat-photo").waitFor();
    await photoLoaded(page);
    const thread = await call("GET", `/api/circles/chat?circle=${circle.id}`, hana.token);
    const id = thread.chat.messages.find((message: { photo: boolean }) => message.photo).id as string;
    const fetchAs = (token: string) => fetch(`${hangry.baseUrl}/api/messages/${id}/photo`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal((await fetchAs(bea.token)).status, 200, "a friend in the circle");
    assert.equal((await fetchAs(olli.token)).status, 404, "someone outside it");
    assert.equal((await fetch(`${hangry.baseUrl}/api/messages/${id}/photo`)).status, 401, "nobody signed out");

    await page.locator(".chat-log .chat-delete").tap();
    await page.getByRole("dialog", { name: "Delete this message?" }).getByRole("button", { name: "Delete", exact: true }).tap();
    await page.locator(".chat-log .chat-photo").waitFor({ state: "detached" });
    assert.equal((await fetchAs(bea.token)).status, 404, "gone for everyone once deleted");
    await shot(page, "deleted");
  } finally {
    await page.context().close();
  }
});
