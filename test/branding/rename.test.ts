import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { FEED_NAME } from "../../src/calendar/calendar.js";
import { PRODID } from "../../src/calendar/ics.js";
import { api, testEmail, withApp } from "../http.js";

const PUBLIC = new URL("../../public/", import.meta.url);

/** Width and height from the IHDR chunk of a PNG file in public/. */
function pngSize(file: string): { width: number; height: number } {
  const bytes = fs.readFileSync(new URL(file, PUBLIC));
  assert.equal(bytes.subarray(1, 4).toString("latin1"), "PNG", `${file} is a PNG`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test("the confirm email says Spontaco in subject and body", async () => {
  await withApp(async (ctx) => {
    await api(ctx, "POST", "/api/auth/start", { body: { name: "Fake Ada", email: testEmail() }, status: 201 });
    assert.equal(ctx.mail.length, 1);
    const [mail] = ctx.mail;
    assert.equal(mail.subject, "Confirm your email for Spontaco");
    assert.match(mail.text, /Confirm your email address for Spontaco/);
    assert.doesNotMatch(`${mail.subject} ${mail.text} ${mail.html}`, /Hangry/);
  });
});

test("the push test notification is titled Spontaco", async () => {
  await withApp(async (ctx) => {
    const { json } = await api(ctx, "POST", "/api/auth/start", { body: { name: "Fake Ada", email: testEmail() }, status: 201 });
    await api(ctx, "POST", "/api/push/subscribe", {
      token: json.token,
      body: { endpoint: "https://push.example/fake-endpoint", keys: { p256dh: "p256dh-key", auth: "auth-key" } },
      status: 204,
    });
    await api(ctx, "POST", "/api/push/test", { token: json.token, body: {}, status: 200 });
    assert.equal(ctx.sent.length, 1);
    assert.equal(ctx.sent[0].title, "Spontaco");
    assert.equal(ctx.sent[0].body, "Push works");
  });
});

test("the landing and privacy pages are named Spontaco", async () => {
  await withApp(async (ctx) => {
    for (const route of ["/welcome", "/privacy"]) {
      const html = await (await fetch(`http://127.0.0.1:${ctx.port}${route}`)).text();
      assert.match(html, /<title>[^<]*Spontaco[^<]*<\/title>/, route);
      assert.doesNotMatch(html, /\bHangry\b/, route);
    }
    const welcome = await (await fetch(`http://127.0.0.1:${ctx.port}/welcome`)).text();
    assert.match(welcome, /<meta name="apple-mobile-web-app-title" content="Spontaco"/);
  });
});

test("calendar feeds and files are named Spontaco", () => {
  assert.equal(FEED_NAME, "Spontaco");
  assert.equal(PRODID, "-//Spontaco//Calendar 1.0//EN");
});

test("every app icon exists at its declared size and the manifest points at real files", () => {
  const sizes: Record<string, number> = {
    "icons/icon-32.png": 32,
    "icons/icon-180.png": 180,
    "icons/icon-192.png": 192,
    "icons/icon-512.png": 512,
    "icons/icon-maskable-192.png": 192,
    "icons/icon-maskable-512.png": 512,
  };
  for (const [file, side] of Object.entries(sizes)) assert.deepEqual(pngSize(file), { width: side, height: side }, file);

  const manifest = JSON.parse(fs.readFileSync(new URL("manifest.webmanifest", PUBLIC), "utf8")) as {
    icons: Array<{ src: string; sizes: string }>;
  };
  assert.ok(manifest.icons.length >= 4);
  for (const icon of manifest.icons) {
    const file = icon.src.replace(/^\//, "");
    assert.ok(fs.existsSync(new URL(file, PUBLIC)), `${icon.src} exists`);
    const side = Number(icon.sizes.split("x")[0]);
    assert.deepEqual(pngSize(file), { width: side, height: side }, icon.src);
  }
});
