import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import type { PushPayload, PushSender } from "../src/push.js";

const START = Date.parse("2026-06-01T15:00:00.000Z");

async function withApp(fn: (ctx: { port: number; sent: PushPayload[]; at: (ms: number) => void }) => Promise<void>) {
  const sent: PushPayload[] = [];
  let now = START;
  const db = openDb(":memory:");
  const push: PushSender = { async send(_sub, payload) { sent.push(payload); } };
  const config = loadConfig({ PORT: "3000", APP_TZ: "UTC", DB_PATH: ":memory:" });
  const server = http.createServer(createApp({ db, push, config: { ...config, dbPath: ":memory:" }, now: () => now }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn({ port, sent, at(ms) { now = ms; } });
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

test("the creator is admin and a new member is not", async () => {
  await withApp(async ({ port }) => {
    const alex = await api(port, "POST", "/api/auth/start", { body: { name: "Alex" }, status: 201 });
    const created = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "friends" }, status: 201 });
    assert.equal(created.circle.youAreAdmin, true);
    assert.equal(created.circle.members[0].admin, true);
    const fritz = await api(port, "POST", "/api/auth/start", {
      body: { name: "Fritz", code: created.circle.inviteCode },
      status: 201,
    });
    assert.equal(fritz.circle.youAreAdmin, false);
    assert.equal(fritz.circle.members.find((member: { name: string; admin: boolean }) => member.name === "Fritz").admin, false);
  });
});

test("only an admin can remove a member, and that ends their posts", async () => {
  await withApp(async ({ port, at }) => {
    const alex = await api(port, "POST", "/api/auth/start", { body: { name: "Alex" }, status: 201 });
    const created = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "friends" }, status: 201 });
    at(START + 1000);
    const fritz = await api(port, "POST", "/api/auth/start", {
      body: { name: "Fritz", code: created.circle.inviteCode },
      status: 201,
    });
    const social = await api(port, "POST", "/api/socials", { token: fritz.token, body: { note: "Coffee" }, status: 201 });
    await api(port, "POST", "/api/plans", { token: fritz.token, body: { note: "Bouldering" }, status: 201 });
    const fritzId = fritz.user.id as string;
    await api(port, "DELETE", `/api/circles/members/${fritzId}`, { token: fritz.token, status: 403 });
    await api(port, "DELETE", `/api/circles/members/${fritzId}`, { token: alex.token, status: 204 });
    const after = await api(port, "GET", "/api/me", { token: fritz.token });
    assert.equal(after.circle, null);
    const socials = await api(port, "GET", "/api/socials", { token: alex.token });
    assert.equal(socials.socials.length, 0);
    const plans = await api(port, "GET", "/api/plans", { token: alex.token });
    assert.equal(plans.plans.length, 0);
    assert.ok(social.social.id);
  });
});

test("a circle keeps an admin, and leaving promotes the longest-standing member", async () => {
  await withApp(async ({ port, at }) => {
    const alex = await api(port, "POST", "/api/auth/start", { body: { name: "Alex" }, status: 201 });
    const created = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "friends" }, status: 201 });
    const alexId = (await api(port, "GET", "/api/me", { token: alex.token })).user.id as string;
    at(START + 1000);
    const fritz = await api(port, "POST", "/api/auth/start", {
      body: { name: "Fritz", code: created.circle.inviteCode },
      status: 201,
    });
    at(START + 2000);
    await api(port, "POST", "/api/auth/start", {
      body: { name: "Sam", code: created.circle.inviteCode },
      status: 201,
    });
    const demote = await api(port, "POST", `/api/circles/members/${alexId}`, {
      token: alex.token,
      body: { admin: false },
      status: 409,
    });
    assert.equal(demote.error, "A circle needs an admin.");
    await api(port, "DELETE", `/api/circles/members/${alexId}`, { token: alex.token, status: 409 });
    await api(port, "POST", "/api/circles/leave", { token: alex.token, status: 200 });
    const host = await api(port, "GET", "/api/me", { token: fritz.token });
    assert.equal(host.circle.youAreAdmin, true);
    assert.equal(host.circle.members.find((member: { name: string }) => member.name === "Sam").admin, false);
  });
});

test("an admin can edit or end someone else's free post and plan", async () => {
  await withApp(async ({ port, sent }) => {
    const alex = await api(port, "POST", "/api/auth/start", { body: { name: "Alex" }, status: 201 });
    const created = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "friends" }, status: 201 });
    const fritz = await api(port, "POST", "/api/auth/start", {
      body: { name: "Fritz", code: created.circle.inviteCode },
      status: 201,
    });
    await api(port, "POST", "/api/push/subscribe", {
      token: fritz.token,
      body: { endpoint: "https://push.example/fritz", keys: { p256dh: "p", auth: "a" } },
      status: 204,
    });
    const sam = await api(port, "POST", "/api/auth/start", {
      body: { name: "Sam", code: created.circle.inviteCode },
      status: 201,
    });
    const social = await api(port, "POST", "/api/socials", { token: fritz.token, body: { note: "Coffee" }, status: 201 });
    const plan = await api(port, "POST", "/api/plans", { token: fritz.token, body: { note: "Bouldering" }, status: 201 });
    await api(port, "PATCH", `/api/socials/${social.social.id}`, {
      token: sam.token,
      body: { note: "Nope" },
      status: 403,
    });
    const edited = await api(port, "PATCH", `/api/plans/${plan.plan.id}`, {
      token: alex.token,
      body: { note: "Climbing", place: "Gym" },
      status: 200,
    });
    assert.equal(edited.plan.note, "Climbing");
    assert.equal(edited.plan.place, "Gym");
    await api(port, "DELETE", `/api/socials/${social.social.id}`, { token: alex.token, status: 204 });
    assert.equal(sent.at(-1)?.title, "Ended");
    assert.equal(sent.at(-1)?.body, "Alex ended Coffee");
    const socials = await api(port, "GET", "/api/socials", { token: alex.token });
    assert.equal(socials.socials.length, 0);
  });
});

test("opening an older database makes the creator the admin", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hangry-admin-"));
  const file = path.join(dir, "old.sqlite");
  const raw = new DatabaseSync(file);
  raw.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      buzz_token TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE circles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      invite_code TEXT NOT NULL UNIQUE,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE memberships (
      user_id TEXT PRIMARY KEY,
      circle_id TEXT NOT NULL,
      joined_at INTEGER NOT NULL
    );
  `);
  raw.prepare("INSERT INTO users (id, name, token_hash, buzz_token, created_at) VALUES (?, ?, ?, ?, ?)").run("u1", "Alex", "h1", "b1", 1);
  raw.prepare("INSERT INTO users (id, name, token_hash, buzz_token, created_at) VALUES (?, ?, ?, ?, ?)").run("u2", "Fritz", "h2", "b2", 2);
  raw.prepare("INSERT INTO circles (id, name, invite_code, created_by, created_at) VALUES (?, ?, ?, ?, ?)").run("c1", "friends", "CODE", "u1", 1);
  raw.prepare("INSERT INTO memberships (user_id, circle_id, joined_at) VALUES (?, ?, ?)").run("u1", "c1", 10);
  raw.prepare("INSERT INTO memberships (user_id, circle_id, joined_at) VALUES (?, ?, ?)").run("u2", "c1", 20);
  raw.close();
  const db = openDb(file);
  try {
    const rows = db.prepare("SELECT user_id, is_admin FROM memberships ORDER BY joined_at").all() as Array<{ user_id: string; is_admin: number }>;
    assert.equal(rows[0].user_id, "u1");
    assert.equal(rows[0].is_admin, 1);
    assert.equal(rows[1].user_id, "u2");
    assert.equal(rows[1].is_admin, 0);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
