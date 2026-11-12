import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { openDb } from "../../src/db.js";
import { api, withApp, type AppCtx } from "../http.js";

type Person = { token: string; buzzToken: string };

async function signUp(ctx: AppCtx, name: string): Promise<Person> {
  const { json } = await api(ctx, "POST", "/api/auth/start", { body: { name }, status: 201 });
  return json;
}

async function pair(ctx: AppCtx) {
  const alex = await signUp(ctx, "Alex");
  const circle = await api(ctx, "POST", "/api/circles", { token: alex.token, body: { name: "friends" }, status: 201 });
  const veit = await signUp(ctx, "Veit");
  await api(ctx, "POST", "/api/circles/join", { token: veit.token, body: { code: circle.json.circle.inviteCode }, status: 200 });
  return { alex, veit };
}

async function seen(ctx: AppCtx, token: string) {
  const { json } = await api(ctx, "GET", "/api/socials", { token, status: 200 });
  return json.socials as Array<{ id: string; buzzedAt: number | null }>;
}

test("a Flic press stamps buzzedAt on the social a member sees", async () => {
  await withApp(async (ctx) => {
    const { alex, veit } = await pair(ctx);
    const pressed = await api(ctx, "POST", `/api/buzz/${alex.buzzToken}`, { body: { note: "coffee" }, status: 201 });
    const list = await seen(ctx, veit.token);
    assert.equal(list.length, 1);
    assert.equal(list[0].buzzedAt, pressed.json.social.buzzedAt);
    assert.equal(typeof list[0].buzzedAt, "number");
  });
});

test("a later press on the live social moves buzzedAt forward", async () => {
  await withApp(async (ctx) => {
    const { alex, veit } = await pair(ctx);
    await api(ctx, "POST", `/api/buzz/${alex.buzzToken}`, { status: 201 });
    const first = (await seen(ctx, veit.token))[0].buzzedAt as number;
    ctx.advance(60_000);
    const again = await api(ctx, "POST", `/api/buzz/${alex.buzzToken}`, { status: 200 });
    const second = (await seen(ctx, veit.token))[0].buzzedAt as number;
    assert.ok(second > first);
    assert.equal(again.json.social.buzzedAt, second);
  });
});

test("a social posted in the app has no buzzedAt", async () => {
  await withApp(async (ctx) => {
    const { alex, veit } = await pair(ctx);
    const posted = await api(ctx, "POST", "/api/socials", { token: alex.token, body: { note: "tea" }, status: 201 });
    assert.equal(posted.json.social.buzzedAt, null);
    const list = await seen(ctx, veit.token);
    assert.equal(list.length, 1);
    assert.equal(list[0].buzzedAt, null);
  });
});

test("an older database gains the buzzed_at column", () => {
  const file = path.join(os.tmpdir(), `hangry-buzz-${Date.now()}.sqlite`);
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE socials (
      id TEXT PRIMARY KEY, circle_id TEXT NOT NULL, creator_id TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_notified_at INTEGER NOT NULL
    );
  `);
  legacy.close();
  const db = openDb(file);
  const cols = db.prepare("PRAGMA table_info(socials)").all() as Array<{ name: string; type: string; notnull: number }>;
  const col = cols.find((c) => c.name === "buzzed_at");
  assert.ok(col);
  assert.equal(col.type, "INTEGER");
  assert.equal(col.notnull, 0);
  db.close();
  fs.unlinkSync(file);
});

test("a fresh database has the buzzed_at column", () => {
  const db = openDb(":memory:");
  const cols = db.prepare("PRAGMA table_info(socials)").all().map((c) => (c as { name: string }).name);
  assert.ok(cols.includes("buzzed_at"));
  db.close();
});
