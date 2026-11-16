import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { avatarKind } from "../src/lib/avatar.js";
import { createApp } from "../src/app.js";
import { avatarDirFor, loadConfig } from "../src/config.js";
import { getPlan, openDb } from "../src/db.js";
import { shareMeta, sharePreview } from "../src/social/plan-share.js";
import { createNoopPushSender } from "../src/push/push.js";
import { api, testEmail } from "./http.js";

/** Modernizr's 1×1 lossless WebP: a real, decodable image in 38 bytes. */
const WEBP = Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64");
/** SOI + APP0/JFIF header + EOI. The server only checks the magic bytes. */
const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

type Ctx = { port: number; dir: string; dbFile: string };

async function withAvatarApp(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hangry-avatar-test-"));
  const dbFile = path.join(root, "test.sqlite");
  const db = openDb(dbFile);
  const config = loadConfig({ PORT: "3000", DB_PATH: dbFile, APP_TZ: "UTC" });
  assert.equal(config.avatarDir, path.join(root, "avatars"), "avatars live next to the db");
  const server = http.createServer(createApp({ db, push: createNoopPushSender(), config, now: () => Date.now() }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  try {
    await fn({ port: (server.address() as AddressInfo).port, dir: config.avatarDir, dbFile });
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function put(port: number, token: string, data: Buffer, type = "image/webp") {
  return fetch(`http://127.0.0.1:${port}/api/me/avatar`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": type },
    body: new Uint8Array(data),
  });
}

function get(port: number, token: string | null, userId: string, rev: unknown = 1, headers: Record<string, string> = {}) {
  return fetch(`http://127.0.0.1:${port}/api/users/${userId}/avatar?v=${rev}`, {
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
  });
}

async function people(port: number) {
  const alex = await api(port, "POST", "/api/auth/start", { body: { email: testEmail(), name: "Alex" }, status: 201 });
  const { circle } = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Friends" }, status: 201 });
  const bea = await api(port, "POST", "/api/auth/start", { body: { email: testEmail(), name: "Bea", code: circle.inviteCode }, status: 201 });
  const stranger = await api(port, "POST", "/api/auth/start", { body: { email: testEmail(), name: "Sam" }, status: 201 });
  await api(port, "POST", "/api/circles", { token: stranger.token, body: { name: "Elsewhere" }, status: 201 });
  return { alex, bea, stranger };
}

test("avatar dir sits next to the db; an in-memory db never points at the cwd or /data", () => {
  assert.equal(avatarDirFor("/data/free-now.sqlite"), "/data/avatars");
  assert.equal(avatarDirFor("/tmp/x/db.sqlite"), "/tmp/x/avatars");
  const mem = loadConfig({ DB_PATH: ":memory:" }).avatarDir;
  assert.ok(mem.startsWith(os.tmpdir()), mem);
  assert.equal(loadConfig({}, "/srv/app").avatarDir, "/srv/app/data/avatars");
});

test("magic bytes: RIFF….WEBP and FF D8 FF only", () => {
  assert.equal(avatarKind(WEBP)?.mime, "image/webp");
  assert.equal(avatarKind(JPEG)?.mime, "image/jpeg");
  assert.equal(avatarKind(PNG), null);
  assert.equal(avatarKind(Buffer.from("RIFF0000WAVE")), null);
  assert.equal(avatarKind(Buffer.alloc(0)), null);
});

test("upload a webp, read it back with long-lived cache headers, then remove it", async () => {
  await withAvatarApp(async ({ port, dir }) => {
    const { alex, bea } = await people(port);
    const before = await api(port, "GET", "/api/me", { token: alex.token, status: 200 });
    assert.equal(before.user.avatarRev, null);
    assert.equal((await get(port, alex.token, alex.user.id)).status, 404);

    const up = await put(port, alex.token, WEBP);
    assert.equal(up.status, 200);
    const me = await up.json();
    const rev = me.user.avatarRev;
    assert.ok(Number.isInteger(rev) && rev > 0, `rev ${rev}`);
    assert.ok(fs.existsSync(path.join(dir, `${alex.user.id}.webp`)));
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")), [], "no temp file left");

    // A circle-mate sees the rev on every person object, and can load the photo.
    const beaMe = await api(port, "GET", "/api/me", { token: bea.token, status: 200 });
    assert.equal(beaMe.circle.members.find((m: { id: string }) => m.id === alex.user.id).avatarRev, rev);
    assert.equal(beaMe.circle.members.find((m: { id: string }) => m.id === bea.user.id).avatarRev, null);
    const plan = (await api(port, "POST", "/api/plans", { token: alex.token, body: { note: "Pizza" }, status: 201 })).plan;
    assert.equal(plan.creator.avatarRev, rev);
    await api(port, "POST", `/api/plans/${plan.id}/join`, { token: bea.token, status: 200 });
    const social = (await api(port, "POST", "/api/socials", { token: bea.token, body: { note: "Coffee" }, status: 201 })).social;
    assert.equal(social.creator.avatarRev, null);
    await api(port, "POST", `/api/socials/${social.id}/join`, { token: alex.token, status: 200 });
    const socials = (await api(port, "GET", "/api/socials", { token: bea.token, status: 200 })).socials;
    assert.equal(socials[0].joined[0].avatarRev, rev);
    const plans = (await api(port, "GET", "/api/plans", { token: alex.token, status: 200 })).plans;
    assert.equal(plans[0].push.people.find((p: { id: string }) => p.id === bea.user.id).avatarRev, null);

    for (const token of [alex.token, bea.token]) {
      const res = await get(port, token, alex.user.id, rev);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "image/webp");
      assert.match(res.headers.get("cache-control") ?? "", /max-age=31536000/);
      assert.match(res.headers.get("cache-control") ?? "", /immutable/);
      assert.equal(res.headers.get("etag"), `"${rev}"`);
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), WEBP);
    }
    const again = await get(port, bea.token, alex.user.id, rev, { "if-none-match": `"${rev}"` });
    assert.equal(again.status, 304);

    // JPEG replaces the webp; the rev moves on so no cache serves the old one.
    const jpg = await (await put(port, alex.token, JPEG, "image/jpeg")).json();
    assert.ok(jpg.user.avatarRev > rev);
    assert.ok(!fs.existsSync(path.join(dir, `${alex.user.id}.webp`)));
    const asJpeg = await get(port, bea.token, alex.user.id, jpg.user.avatarRev);
    assert.equal(asJpeg.headers.get("content-type"), "image/jpeg");
    assert.deepEqual(Buffer.from(await asJpeg.arrayBuffer()), JPEG);

    const removed = await api(port, "DELETE", "/api/me/avatar", { token: alex.token, status: 200 });
    assert.equal(removed.user.avatarRev, null);
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith(alex.user.id)), []);
    assert.equal((await get(port, bea.token, alex.user.id, jpg.user.avatarRev)).status, 404);
    const after = await api(port, "GET", "/api/me", { token: bea.token, status: 200 });
    assert.equal(after.circle.members.find((m: { id: string }) => m.id === alex.user.id).avatarRev, null);
    // Removing twice is fine.
    await api(port, "DELETE", "/api/me/avatar", { token: alex.token, status: 200 });
  });
});

test("non-images and oversized bodies are rejected; nothing is written", async () => {
  await withAvatarApp(async ({ port, dir }) => {
    const { alex } = await people(port);
    assert.equal((await put(port, alex.token, PNG, "image/png")).status, 400);
    assert.equal((await put(port, alex.token, Buffer.from("<svg onload=alert(1)>"), "image/webp")).status, 400);
    assert.equal((await put(port, alex.token, Buffer.alloc(0))).status, 400);
    const big = Buffer.concat([WEBP, Buffer.alloc(81 * 1024)]);
    assert.equal((await put(port, alex.token, big)).status, 413);
    assert.equal((await api(port, "GET", "/api/me", { token: alex.token, status: 200 })).user.avatarRev, null);
    assert.equal(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0, 0);
    // Signed out: no upload, no read.
    const anon = await fetch(`http://127.0.0.1:${port}/api/me/avatar`, { method: "PUT", body: new Uint8Array(WEBP) });
    assert.equal(anon.status, 401);
  });
});

test("a stranger with no shared circle gets the same 404 as no photo", async () => {
  await withAvatarApp(async ({ port }) => {
    const { alex, stranger } = await people(port);
    const rev = (await (await put(port, alex.token, WEBP)).json()).user.avatarRev;
    const res = await get(port, stranger.token, alex.user.id, rev);
    assert.equal(res.status, 404);
    const body = await res.text();
    const none = await get(port, stranger.token, "00000000-0000-4000-8000-000000000000", rev);
    assert.equal(none.status, 404);
    assert.equal(await none.text(), body, "same answer as an unknown person");
    assert.equal((await get(port, null, alex.user.id, rev)).status, 401);
    assert.equal((await get(port, stranger.token, "not-a-uuid")).status, 404);
  });
});

test("share link preview and Open Graph tags carry no photo", async () => {
  await withAvatarApp(async ({ port, dbFile }) => {
    const { alex } = await people(port);
    await put(port, alex.token, WEBP);
    const plan = (await api(port, "POST", "/api/plans", { token: alex.token, body: { note: "Pizza", time: "19:30" }, status: 201 })).plan;
    const { shareId } = await api(port, "POST", `/api/plans/${plan.id}/share`, { token: alex.token, status: 200 });
    const preview = await api(port, "GET", `/api/plans/share/${shareId}`, { status: 200 });
    assert.deepEqual(Object.keys(preview).sort(), ["ended", "member", "note", "time", "whenLabel"]);
    assert.doesNotMatch(JSON.stringify(preview), /avatar/i);
    const html = await (await fetch(`http://127.0.0.1:${port}/p/${shareId}`)).text();
    assert.doesNotMatch(html, /avatar/i);
    assert.match(html, /og:image" content="[^"]*\/icons\/icon-512\.png"/);

    const db = openDb(dbFile);
    try {
      const row = getPlan(db, plan.id);
      const today = row!.for_date;
      assert.doesNotMatch(JSON.stringify(sharePreview(db, shareId, null, today)), /avatar/i);
      const meta = shareMeta(row, today);
      assert.deepEqual(Object.keys(meta).sort(), ["description", "title"]);
      assert.doesNotMatch(JSON.stringify(meta), /avatar/i);
    } finally {
      db.close();
    }
  });
});

test("an old users table gets avatar_rev", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hangry-avatar-col-"));
  try {
    const file = path.join(root, "db.sqlite");
    const old = openDb(file);
    old.exec("ALTER TABLE users DROP COLUMN avatar_rev");
    old.close();
    const db = openDb(file);
    const columns = (db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>).map((row) => row.name);
    assert.ok(columns.includes("avatar_rev"));
    db.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
