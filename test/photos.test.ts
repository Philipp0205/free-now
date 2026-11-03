import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { clearExpiredLocations, openDb } from "../src/db.js";

const START = Date.parse("2026-06-01T15:00:00.000Z");
const TTL = 2 * 60 * 60 * 1000;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

type Ctx = { base: string; db: DatabaseSync; advance: (ms: number) => void };

async function withApp(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  let now = START;
  const db = openDb(":memory:");
  const config = loadConfig({ PORT: "3000", DB_PATH: ":memory:", APP_TZ: "UTC", SOCIAL_TTL_MS: String(TTL) });
  const push = { async send() {} };
  const server = http.createServer(createApp({ db, push, config: { ...config, dbPath: ":memory:" }, now: () => now }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn({ base: `http://127.0.0.1:${port}`, db, advance: (ms) => { now += ms; } });
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
}

async function call(ctx: Ctx, method: string, path: string, token: string, body?: unknown) {
  const response = await fetch(`${ctx.base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

async function upload(ctx: Ctx, path: string, token: string, bytes: Uint8Array, type = "image/jpeg") {
  const response = await fetch(`${ctx.base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": type },
    body: bytes,
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

async function circleOfTwo(ctx: Ctx) {
  const alex = (await call(ctx, "POST", "/api/auth/start", "", { name: "Alex" })).json;
  const circle = (await call(ctx, "POST", "/api/circles", alex.token, { name: "friends" })).json.circle;
  const veit = (await call(ctx, "POST", "/api/auth/start", "", { name: "Veit" })).json;
  await call(ctx, "POST", "/api/circles/join", veit.token, { code: circle.inviteCode });
  const sam = (await call(ctx, "POST", "/api/auth/start", "", { name: "Sam" })).json;
  await call(ctx, "POST", "/api/circles", sam.token, { name: "other" });
  return { alex: alex.token as string, veit: veit.token as string, sam: sam.token as string };
}

test("the host adds a gallery photo to a social and the circle sees it", async () => {
  await withApp(async (ctx) => {
    const { alex, veit, sam } = await circleOfTwo(ctx);
    const social = (await call(ctx, "POST", "/api/socials", alex, { note: "cooking sesh at my place?" })).json.social;
    assert.deepEqual(social.photos, []);

    const first = await upload(ctx, `/api/socials/${social.id}/photos`, alex, JPEG);
    assert.equal(first.status, 201);
    assert.equal(first.json.photos.length, 1);

    const listed = (await call(ctx, "GET", "/api/socials", veit)).json.socials[0];
    assert.deepEqual(listed.photos.map((photo: { id: string }) => photo.id), first.json.photos.map((photo: { id: string }) => photo.id));

    const file = await fetch(`${ctx.base}/api/photos/${listed.photos[0].id}`, { headers: { authorization: `Bearer ${veit}` } });
    assert.equal(file.status, 200);
    assert.equal(file.headers.get("content-type"), "image/jpeg");
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), JPEG);

    const outsider = await fetch(`${ctx.base}/api/photos/${listed.photos[0].id}`, { headers: { authorization: `Bearer ${sam}` } });
    assert.equal(outsider.status, 404);
    const anonymous = await fetch(`${ctx.base}/api/photos/${listed.photos[0].id}`);
    assert.equal(anonymous.status, 401);
  });
});

test("only the host can change the photo, and it is one real image", async () => {
  await withApp(async (ctx) => {
    const { alex, veit } = await circleOfTwo(ctx);
    const social = (await call(ctx, "POST", "/api/socials", alex, { note: "dinner" })).json.social;
    const path = `/api/socials/${social.id}/photos`;

    assert.equal((await upload(ctx, path, veit, JPEG)).status, 403);
    assert.equal((await upload(ctx, path, alex, new TextEncoder().encode("<svg onload=alert(1)>"), "image/svg+xml")).status, 415);
    assert.equal((await upload(ctx, path, alex, JPEG, "text/plain")).status, 415);

    assert.equal((await upload(ctx, path, alex, JPEG)).status, 201);
    assert.equal((await upload(ctx, path, alex, PNG, "image/png")).status, 409);

    const photos = (await call(ctx, "GET", "/api/socials", alex)).json.socials[0].photos;
    assert.equal((await call(ctx, "DELETE", `${path}/${photos[0].id}`, veit)).status, 403);
    const removed = await call(ctx, "DELETE", `${path}/${photos[0].id}`, alex);
    assert.equal(removed.status, 200);
    assert.equal(removed.json.photos.length, 0);
    const replaced = await upload(ctx, path, alex, PNG, "image/png");
    assert.equal(replaced.status, 201);
    assert.equal(replaced.json.photos.length, 1);
  });
});

test("plans take photos too, and photos go when the social ends", async () => {
  await withApp(async (ctx) => {
    const { alex, veit } = await circleOfTwo(ctx);
    const plan = (await call(ctx, "POST", "/api/plans", alex, { note: "Walk and dinner" })).json.plan;
    const added = await upload(ctx, `/api/plans/${plan.id}/photos`, alex, JPEG);
    assert.equal(added.status, 201);
    const listedPlan = (await call(ctx, "GET", "/api/plans", veit)).json.plans[0];
    assert.equal(listedPlan.photos.length, 1);

    const social = (await call(ctx, "POST", "/api/socials", alex, { note: "now" })).json.social;
    const photo = (await upload(ctx, `/api/socials/${social.id}/photos`, alex, JPEG)).json.photos[0];
    ctx.advance(TTL + 1000);
    assert.equal((await upload(ctx, `/api/socials/${social.id}/photos`, alex, JPEG)).status, 410);
    clearExpiredLocations(ctx.db, START + TTL + 1000, "2026-06-01");
    const gone = await fetch(`${ctx.base}/api/photos/${photo.id}`, { headers: { authorization: `Bearer ${veit}` } });
    assert.equal(gone.status, 404);
    // Tomorrow's plan keeps its photo.
    const kept = await fetch(`${ctx.base}/api/photos/${listedPlan.photos[0].id}`, { headers: { authorization: `Bearer ${veit}` } });
    assert.equal(kept.status, 200);
  });
});
