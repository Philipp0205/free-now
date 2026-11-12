import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { openDb } from "../../src/db.js";
import type { PushPayload, PushSender } from "../../src/push/push.js";

const START = Date.parse("2026-06-01T15:00:00.000Z");

type Ctx = { port: number; db: DatabaseSync; sent: PushPayload[]; at: (ms: number) => void };

async function withApp(fn: (ctx: Ctx) => Promise<void>) {
  const sent: PushPayload[] = [];
  let now = START;
  const db = openDb(":memory:");
  const push: PushSender = { async send(_sub, payload) { sent.push(payload); } };
  const config = loadConfig({ PORT: "3000", APP_TZ: "UTC", DB_PATH: ":memory:" });
  const server = http.createServer(createApp({ db, push, config: { ...config, dbPath: ":memory:" }, now: () => now }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn({ port, db, sent, at(ms) { now = ms; } });
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

function pkColumns(db: DatabaseSync): string[] {
  const rows = db.prepare("PRAGMA table_info(memberships)").all() as Array<{ name: string; pk: number }>;
  return rows.filter((row) => row.pk > 0).sort((a, b) => a.pk - b.pk).map((row) => row.name);
}

test("a main-era database and a stack-tip database both keep their memberships", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hangry-circles-"));
  try {
    const mainFile = path.join(dir, "main.sqlite");
    const main = new DatabaseSync(mainFile);
    main.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, buzz_token TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
      CREATE TABLE circles (id TEXT PRIMARY KEY, name TEXT NOT NULL, invite_code TEXT NOT NULL UNIQUE, created_by TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE memberships (user_id TEXT PRIMARY KEY, circle_id TEXT NOT NULL, joined_at INTEGER NOT NULL);
      CREATE TABLE notifications (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, kind TEXT NOT NULL, ref_id TEXT, created_at INTEGER NOT NULL, read_at INTEGER);
    `);
    main.prepare("INSERT INTO users (id, name, token_hash, buzz_token, created_at) VALUES ('u1', 'Alex', 'h1', 'b1', 1)").run();
    main.prepare("INSERT INTO circles (id, name, invite_code, created_by, created_at) VALUES ('c1', 'Uni friends', 'CODEMAIN', 'u1', 1)").run();
    main.prepare("INSERT INTO memberships (user_id, circle_id, joined_at) VALUES ('u1', 'c1', 10)").run();
    main.prepare("INSERT INTO notifications (id, user_id, title, body, kind, ref_id, created_at, read_at) VALUES ('n1', 'u1', 'Free now', 'Ada is free', 'social', 's1', 10, NULL)").run();
    main.close();

    const openedMain = openDb(mainFile);
    assert.deepEqual(pkColumns(openedMain), ["user_id", "circle_id"]);
    const mainRows = openedMain.prepare("SELECT user_id, circle_id, is_admin FROM memberships").all() as Array<{ user_id: string; circle_id: string; is_admin: number }>;
    assert.deepEqual(mainRows.map((row) => ({ ...row })), [{ user_id: "u1", circle_id: "c1", is_admin: 1 }]);
    const note = openedMain.prepare("SELECT circle_id FROM notifications WHERE id = 'n1'").get() as { circle_id: string };
    assert.equal(note.circle_id, "c1");
    openedMain.prepare("INSERT INTO circles (id, name, invite_code, created_by, created_at, invite_expires_at) VALUES ('c2', 'Home', 'CODEHOME', 'u1', 2, 3)").run();
    openedMain.prepare("INSERT INTO memberships (user_id, circle_id, joined_at, is_admin) VALUES ('u1', 'c2', 20, 0)").run();
    openedMain.close();

    const tipFile = path.join(dir, "tip.sqlite");
    const tip = new DatabaseSync(tipFile);
    tip.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, buzz_token TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
      CREATE TABLE circles (id TEXT PRIMARY KEY, name TEXT NOT NULL, invite_code TEXT NOT NULL UNIQUE, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, invite_expires_at INTEGER);
      CREATE TABLE memberships (user_id TEXT PRIMARY KEY, circle_id TEXT NOT NULL, joined_at INTEGER NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE circle_removals (circle_id TEXT NOT NULL, user_id TEXT NOT NULL, invite_code TEXT NOT NULL, PRIMARY KEY (circle_id, user_id));
      CREATE TABLE plans (id TEXT PRIMARY KEY, circle_id TEXT NOT NULL, creator_id TEXT NOT NULL, note TEXT NOT NULL, for_date TEXT NOT NULL, created_at INTEGER NOT NULL, ended_at INTEGER);
      CREATE TABLE notifications (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, kind TEXT NOT NULL, ref_id TEXT, created_at INTEGER NOT NULL, read_at INTEGER);
    `);
    tip.prepare("INSERT INTO users (id, name, token_hash, buzz_token, created_at) VALUES ('u1', 'Alex', 'h1', 'b1', 1)").run();
    tip.prepare("INSERT INTO users (id, name, token_hash, buzz_token, created_at) VALUES ('u2', 'Bea', 'h2', 'b2', 2)").run();
    tip.prepare("INSERT INTO circles (id, name, invite_code, created_by, created_at) VALUES ('c1', 'Uni friends', 'CODETIP', 'u1', 1)").run();
    tip.prepare("INSERT INTO memberships (user_id, circle_id, joined_at, is_admin) VALUES ('u1', 'c1', 10, 1)").run();
    tip.prepare("INSERT INTO memberships (user_id, circle_id, joined_at, is_admin) VALUES ('u2', 'c1', 20, 0)").run();
    tip.prepare("INSERT INTO circle_removals (circle_id, user_id, invite_code) VALUES ('c1', 'u9', 'OLD')").run();
    tip.close();

    const openedTip = openDb(tipFile);
    assert.deepEqual(pkColumns(openedTip), ["user_id", "circle_id"]);
    const tipRows = openedTip.prepare("SELECT user_id, circle_id, is_admin FROM memberships ORDER BY joined_at").all() as Array<{ user_id: string; circle_id: string; is_admin: number }>;
    assert.deepEqual(tipRows.map((row) => ({ ...row })), [
      { user_id: "u1", circle_id: "c1", is_admin: 1 },
      { user_id: "u2", circle_id: "c1", is_admin: 0 },
    ]);
    const banned = openedTip.prepare("SELECT invite_code FROM circle_removals WHERE user_id = 'u9'").get() as { invite_code: string };
    assert.equal(banned.invite_code, "OLD");
    openedTip.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("one account can keep two circles apart", async () => {
  await withApp(async ({ port, db, sent }) => {
    const alex = await api(port, "POST", "/api/auth/start", { body: { name: "Alex" }, status: 201 });
    const uni = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Uni friends" }, status: 201 });
    const bea = await api(port, "POST", "/api/auth/start", { body: { name: "Bea", code: uni.circle.inviteCode }, status: 201 });
    const cam = await api(port, "POST", "/api/auth/start", { body: { name: "Cam", code: uni.circle.inviteCode }, status: 201 });
    const home = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Home" }, status: 201 });
    assert.equal(home.circle.name, "Home");
    assert.equal(home.circle.youAreAdmin, true);

    const mine = await api(port, "GET", "/api/me", { token: alex.token });
    assert.deepEqual(mine.circles.map((circle: { name: string }) => circle.name).sort(), ["Home", "Uni friends"]);
    const viewed = await api(port, "GET", `/api/me?circle=${home.circle.id}`, { token: alex.token });
    assert.equal(viewed.circle.name, "Home");

    await api(port, "POST", `/api/socials?circle=${home.circle.id}`, {
      token: alex.token,
      body: { note: "Soup" },
      status: 201,
    });
    const uniList = await api(port, "GET", `/api/socials?circle=${uni.circle.id}`, { token: bea.token });
    assert.equal(uniList.socials.length, 0);
    assert.equal(sent.length, 0);
    const homeList = await api(port, "GET", `/api/socials?circle=${home.circle.id}`, { token: alex.token });
    assert.equal(homeList.socials[0].note, "Soup");
    await api(port, "GET", `/api/socials?circle=${home.circle.id}`, { token: bea.token, status: 404 });
    await api(port, "GET", "/api/socials", { token: alex.token, status: 400 });

    await api(port, "POST", "/api/push/subscribe", {
      token: bea.token,
      body: { endpoint: "https://push.example/bea", keys: { p256dh: "p256dh-key", auth: "auth-key" } },
      status: 204,
    });
    await api(port, "POST", "/api/push/subscribe", {
      token: cam.token,
      body: { endpoint: "https://push.example/cam", keys: { p256dh: "p256dh-key", auth: "auth-key" } },
      status: 204,
    });
    sent.length = 0;
    await api(port, "POST", `/api/plans?circle=${uni.circle.id}`, {
      token: alex.token,
      body: { note: "Dinner" },
      status: 201,
    });
    assert.deepEqual(sent.map((item) => item.body).sort(), ["Alex: Dinner", "Alex: Dinner"]);
    assert.equal(sent.every((item) => !item.url.includes("circle=")), true);

    const homeCode = home.circle.inviteCode as string;
    const joined = await api(port, "POST", "/api/circles/join", { token: bea.token, body: { code: homeCode }, status: 200 });
    assert.equal(joined.circle.name, "Home");
    const beaMe = await api(port, "GET", "/api/me", { token: bea.token });
    assert.deepEqual(beaMe.circles.map((circle: { name: string }) => circle.name).sort(), ["Home", "Uni friends"]);

    sent.length = 0;
    const late = await api(port, "POST", `/api/plans?circle=${uni.circle.id}`, {
      token: alex.token,
      body: { note: "Late dinner" },
      status: 201,
    });
    const named = sent.find((item) => item.body === "Alex: Late dinner · Uni friends");
    const plain = sent.find((item) => item.body === "Alex: Late dinner");
    assert.ok(named);
    assert.ok(plain);
    assert.equal(named.url, `/?plan=${late.plan.id}&circle=${uni.circle.id}`);
    assert.equal(plain.url, `/?plan=${late.plan.id}`);
    const beaNotes = await api(port, "GET", `/api/notifications?circle=${uni.circle.id}`, { token: bea.token });
    assert.ok(beaNotes.notifications.some((note: { body: string }) => note.body === "Alex: Late dinner · Uni friends"));
    const homeNotes = await api(port, "GET", `/api/notifications?circle=${home.circle.id}`, { token: bea.token });
    assert.equal(homeNotes.notifications.length, 0);

    await api(port, "POST", `/api/circles/members/${bea.user.id}?circle=${home.circle.id}`, {
      token: alex.token,
      body: { admin: true },
      status: 200,
    });
    const beaHome = await api(port, "GET", `/api/me?circle=${home.circle.id}`, { token: bea.token });
    const beaUni = await api(port, "GET", `/api/me?circle=${uni.circle.id}`, { token: bea.token });
    assert.equal(beaHome.circle.youAreAdmin, true);
    assert.equal(beaUni.circle.youAreAdmin, false);

    await api(port, "DELETE", `/api/circles/members/${bea.user.id}?circle=${uni.circle.id}`, { token: alex.token, status: 204 });
    await api(port, "GET", `/api/socials?circle=${uni.circle.id}`, { token: bea.token, status: 404 });
    await api(port, "GET", `/api/socials?circle=${home.circle.id}`, { token: bea.token });
    const blocked = await api(port, "POST", "/api/circles/join", {
      token: bea.token,
      body: { code: uni.circle.inviteCode },
      status: 403,
    });
    assert.match(blocked.error, /removed you/);

    await api(port, "POST", `/api/circles/leave?circle=${home.circle.id}`, { token: alex.token, status: 200 });
    const after = await api(port, "GET", "/api/me", { token: alex.token });
    assert.deepEqual(after.circles.map((circle: { name: string }) => circle.name), ["Uni friends"]);
    const beaStillAdmin = db.prepare("SELECT is_admin FROM memberships WHERE user_id = ? AND circle_id = ?").get(bea.user.id, home.circle.id) as { is_admin: number };
    assert.equal(beaStillAdmin.is_admin, 1);

    await api(port, "POST", `/api/circles/leave?circle=${uni.circle.id}`, { token: alex.token, status: 200 });
    const camAdmin = db.prepare("SELECT is_admin FROM memberships WHERE user_id = ? AND circle_id = ?").get(cam.user.id, uni.circle.id) as { is_admin: number };
    assert.equal(camAdmin.is_admin, 1);
    const alexCircles = await api(port, "GET", "/api/me", { token: alex.token });
    assert.equal(alexCircles.circle, null);
  });
});

test("an admin edit and a test push show in that circle's alerts", async () => {
  await withApp(async ({ port, sent }) => {
    const alex = await api(port, "POST", "/api/auth/start", { body: { name: "Alex" }, status: 201 });
    const home = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Home" }, status: 201 });
    const bea = await api(port, "POST", "/api/auth/start", { body: { name: "Bea", code: home.circle.inviteCode }, status: 201 });
    await api(port, "POST", `/api/circles/members/${bea.user.id}?circle=${home.circle.id}`, {
      token: alex.token,
      body: { admin: true },
      status: 200,
    });
    const uni = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Uni" }, status: 201 });
    await api(port, "POST", "/api/push/subscribe", {
      token: alex.token,
      body: { endpoint: "https://push.example/alex", keys: { p256dh: "p256dh-key", auth: "auth-key" } },
      status: 204,
    });
    const plan = await api(port, "POST", `/api/plans?circle=${home.circle.id}`, {
      token: alex.token,
      body: { note: "Dinner" },
      status: 201,
    });
    sent.length = 0;
    await api(port, "PATCH", `/api/plans/${plan.plan.id}?circle=${home.circle.id}`, {
      token: bea.token,
      body: { time: "20:00" },
      status: 200,
    });
    const homeNotes = await api(port, "GET", `/api/notifications?circle=${home.circle.id}`, { token: alex.token });
    const edited = homeNotes.notifications.find((note: { title: string }) => note.title === "Dinner moved to Tue 2 Jun · 20:00");
    assert.ok(edited);
    assert.match(edited.body, /Tap to see the plan\./);
    assert.match(edited.body, /· Home/);
    const uniNotes = await api(port, "GET", `/api/notifications?circle=${uni.circle.id}`, { token: alex.token });
    assert.equal(uniNotes.notifications.some((note: { title: string }) => note.title.includes("moved to")), false);
    const push = sent.find((item) => item.title === "Dinner moved to Tue 2 Jun · 20:00");
    assert.equal(push?.url, `/?plan=${plan.plan.id}&circle=${home.circle.id}`);

    const social = await api(port, "POST", `/api/socials?circle=${home.circle.id}`, {
      token: alex.token,
      body: { note: "Coffee" },
      status: 201,
    });
    sent.length = 0;
    await api(port, "PATCH", `/api/socials/${social.social.id}?circle=${home.circle.id}`, {
      token: bea.token,
      body: { note: "Tea" },
      status: 200,
    });
    const freeNotes = await api(port, "GET", `/api/notifications?circle=${home.circle.id}`, { token: alex.token });
    const freeEdit = freeNotes.notifications.find((note: { title: string }) => note.title === "Bea edited your free post: Tea");
    assert.ok(freeEdit);
    assert.match(freeEdit.body, /· Home/);

    await api(port, "POST", `/api/push/test?circle=${home.circle.id}`, { token: alex.token, body: {}, status: 200 });
    const tested = await api(port, "GET", `/api/notifications?circle=${home.circle.id}`, { token: alex.token });
    assert.equal(tested.notifications.some((note: { kind: string; body: string }) => note.kind === "test" && note.body.startsWith("Push works")), true);
    const testedUni = await api(port, "GET", `/api/notifications?circle=${uni.circle.id}`, { token: alex.token });
    assert.equal(testedUni.notifications.some((note: { kind: string }) => note.kind === "test"), false);
  });
});

test("a buzz with no circle posts to the circle joined last", async () => {
  await withApp(async ({ port, at }) => {
    const alex = await api(port, "POST", "/api/auth/start", { body: { name: "Alex" }, status: 201 });
    const home = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Home" }, status: 201 });
    at(START + 1000);
    const uni = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Uni" }, status: 201 });
    const bare = await api(port, "POST", `/api/buzz/${alex.buzzToken}`, { body: { note: "Bare" }, status: 201 });
    assert.equal(bare.social.note, "Bare");
    const uniList = await api(port, "GET", `/api/socials?circle=${uni.circle.id}`, { token: alex.token });
    assert.equal(uniList.socials.some((social: { note: string }) => social.note === "Bare"), true);
    const homeList = await api(port, "GET", `/api/socials?circle=${home.circle.id}`, { token: alex.token });
    assert.equal(homeList.socials.length, 0);
    await api(port, "POST", `/api/buzz/${alex.buzzToken}?circle=${home.circle.id}`, {
      body: { note: "At home" },
      status: 201,
    });
    const aimed = await api(port, "GET", `/api/socials?circle=${home.circle.id}`, { token: alex.token });
    assert.equal(aimed.socials.some((social: { note: string }) => social.note === "At home"), true);
  });
});

test("a DELETE on the buzz token ends the social in the circle a buzz would post to", async () => {
  await withApp(async ({ port, at }) => {
    const alex = await api(port, "POST", "/api/auth/start", { body: { name: "Alex" }, status: 201 });
    const home = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Home" }, status: 201 });
    at(START + 1000);
    const uni = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Uni" }, status: 201 });
    const live = async (circleId: string) =>
      (await api(port, "GET", `/api/socials?circle=${circleId}`, { token: alex.token })).socials.length;

    await api(port, "DELETE", "/api/buzz/not-a-real-token", { status: 404 });
    await api(port, "POST", `/api/buzz/${alex.buzzToken}`, { status: 201 });
    await api(port, "POST", `/api/buzz/${alex.buzzToken}?circle=${home.circle.id}`, { status: 201 });

    await api(port, "DELETE", `/api/buzz/${alex.buzzToken}`, { status: 204 });
    assert.equal(await live(uni.circle.id), 0);
    assert.equal(await live(home.circle.id), 1);
    // Nothing live there any more: still fine.
    await api(port, "DELETE", `/api/buzz/${alex.buzzToken}`, { status: 204 });

    await api(port, "DELETE", `/api/buzz/${alex.buzzToken}?circle=${home.circle.id}`, { status: 204 });
    assert.equal(await live(home.circle.id), 0);
    await api(port, "POST", `/api/buzz/${alex.buzzToken}`, { status: 201 });
  });
});
