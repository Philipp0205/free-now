import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import type { PushPayload, PushSender } from "../src/push.js";

const START = Date.parse("2026-06-01T15:00:00.000Z");

async function withApp(fn: (port: number, sent: PushPayload[]) => Promise<void>) {
  const sent: PushPayload[] = [];
  const db = openDb(":memory:");
  const push: PushSender = { async send(_sub, payload) { sent.push(payload); } };
  const config = loadConfig({ PORT: "3000", APP_TZ: "UTC", DB_PATH: ":memory:" });
  const server = http.createServer(createApp({ db, push, config: { ...config, dbPath: ":memory:" }, now: () => START }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn(port, sent);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
}

async function api(port: number, method: string, pathname: string, options: { token?: string; body?: unknown; status?: number } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: {
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (options.status !== undefined && response.status !== options.status) {
    throw new Error(`${method} ${pathname} -> ${response.status} ${text}`);
  }
  return json;
}

async function circle(port: number) {
  const alex = await api(port, "POST", "/api/auth/start", { body: { name: "Alex" }, status: 201 });
  const created = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "friends" }, status: 201 });
  const veit = await api(port, "POST", "/api/auth/start", { body: { name: "Veit" }, status: 201 });
  await api(port, "POST", "/api/circles/join", { token: veit.token, body: { code: created.circle.inviteCode }, status: 200 });
  await api(port, "POST", "/api/push/subscribe", {
    token: veit.token,
    body: { endpoint: "https://push.example/veit", keys: { p256dh: "p", auth: "a" } },
    status: 204,
  });
  return { alex, veit };
}

test("shared locations are rounded, optional, and kept off push text", async () => {
  await withApp(async (port, sent) => {
    const { alex } = await circle(port);
    const social = await api(port, "POST", "/api/socials", {
      token: alex.token,
      body: { note: "Rooftop coffee??", lat: 52.520008, lng: 13.404954 },
      status: 201,
    });
    assert.deepEqual(social.social.location, { lat: 52.52, lng: 13.405 });
    assert.equal(sent[0].body, "Alex is free now");
    assert.equal(sent[0].body.includes("52."), false);
    assert.equal(sent[0].title.includes("13."), false);

    const quiet = await api(port, "POST", "/api/socials", {
      token: alex.token,
      body: { note: "Rooftop coffee??" },
      status: 200,
    });
    assert.deepEqual(quiet.social.location, { lat: 52.52, lng: 13.405 });

    const cleared = await api(port, "POST", "/api/socials", {
      token: alex.token,
      body: { note: "Rooftop coffee??", lat: null, lng: null },
      status: 200,
    });
    assert.equal(cleared.social.location, null);

    await api(port, "POST", "/api/socials", {
      token: alex.token,
      body: { note: "nope", lat: 120, lng: 10 },
      status: 400,
    });
  });
});

test("a plan can name a place and share a pin without putting coordinates in the push", async () => {
  await withApp(async (port, sent) => {
    const { alex, veit } = await circle(port);
    const plan = await api(port, "POST", "/api/plans", {
      token: alex.token,
      body: { note: "Walk and dinner", place: "Roof", lat: 52.5204, lng: 13.4049 },
      status: 201,
    });
    assert.equal(plan.plan.place, "Roof");
    assert.deepEqual(plan.plan.location, { lat: 52.52, lng: 13.405 });
    assert.equal(sent.at(-1)?.body, "Alex: Walk and dinner · Roof");
    assert.equal(JSON.stringify(sent.at(-1)).includes("52.52"), false);

    const listed = await api(port, "GET", "/api/plans", { token: veit.token });
    assert.equal(listed.plans[0].place, "Roof");
    assert.deepEqual(listed.plans[0].location, { lat: 52.52, lng: 13.405 });
  });
});

test("an older database gains location columns", () => {
  const file = path.join(os.tmpdir(), `hangry-old-${Date.now()}.sqlite`);
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, buzz_token TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
    CREATE TABLE circles (id TEXT PRIMARY KEY, name TEXT NOT NULL, invite_code TEXT NOT NULL UNIQUE, created_by TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE memberships (user_id TEXT PRIMARY KEY, circle_id TEXT NOT NULL, joined_at INTEGER NOT NULL);
    CREATE TABLE socials (
      id TEXT PRIMARY KEY, circle_id TEXT NOT NULL, creator_id TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_notified_at INTEGER NOT NULL
    );
    CREATE TABLE plans (
      id TEXT PRIMARY KEY, circle_id TEXT NOT NULL, creator_id TEXT NOT NULL, note TEXT NOT NULL,
      for_date TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE social_joins (social_id TEXT NOT NULL, user_id TEXT NOT NULL, joined_at INTEGER NOT NULL, PRIMARY KEY (social_id, user_id));
    CREATE TABLE plan_joins (plan_id TEXT NOT NULL, user_id TEXT NOT NULL, joined_at INTEGER NOT NULL, PRIMARY KEY (plan_id, user_id));
    CREATE TABLE push_subs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE notifications (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, kind TEXT NOT NULL, ref_id TEXT, created_at INTEGER NOT NULL, read_at INTEGER);
  `);
  legacy.close();
  const db = openDb(file);
  const socialCols = db.prepare("PRAGMA table_info(socials)").all().map((row) => (row as { name: string }).name);
  const planCols = db.prepare("PRAGMA table_info(plans)").all().map((row) => (row as { name: string }).name);
  assert.ok(socialCols.includes("lat") && socialCols.includes("lng"));
  assert.ok(planCols.includes("lat") && planCols.includes("lng") && planCols.includes("place"));
  db.close();
  fs.unlinkSync(file);
});
