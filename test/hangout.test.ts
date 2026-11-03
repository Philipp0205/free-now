import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import type { PushPayload, PushSender } from "../src/push.js";
import { sendStartReminders } from "../src/remind.js";

const START = Date.parse("2026-06-01T15:00:00.000Z");

type Ctx = { port: number; db: DatabaseSync; sent: PushPayload[]; at: (ms: number) => void };

async function withApp(fn: (ctx: Ctx) => Promise<void>, tz = "UTC") {
  const sent: PushPayload[] = [];
  let now = START;
  const db = openDb(":memory:");
  const push: PushSender = { async send(_sub, payload) { sent.push(payload); } };
  const config = loadConfig({ PORT: "3000", APP_TZ: tz, DB_PATH: ":memory:" });
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

test("an invite link names the circle, joins in one step, and can be revoked", async () => {
  await withApp(async ({ port, db }) => {
    const alex = await api(port, "POST", "/api/auth/start", { body: { name: "Alex" }, status: 201 });
    const created = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "the roof" }, status: 201 });
    const code = created.circle.inviteCode as string;
    const preview = await api(port, "GET", `/api/invites/${code}`);
    assert.equal(preview.name, "the roof");

    const veit = await api(port, "POST", "/api/auth/start", { body: { name: "Veit", code }, status: 201 });
    assert.equal(veit.circle.name, "the roof");
    const me = await api(port, "GET", "/api/me", { token: veit.token });
    assert.equal(me.circle.name, "the roof");

    const renewed = await api(port, "POST", "/api/circles/invite", { token: alex.token, body: {}, status: 200 });
    assert.notEqual(renewed.circle.inviteCode, code);
    await api(port, "GET", `/api/invites/${code}`, { status: 404 });
    const again = await api(port, "GET", `/api/invites/${renewed.circle.inviteCode}`);
    assert.equal(again.name, "the roof");
    db.prepare("UPDATE circles SET invite_expires_at = ?").run(START - 1);
    await api(port, "GET", `/api/invites/${renewed.circle.inviteCode}`, { status: 404 });
  });
});

test("on my way and can't make it notify the host and can be changed", async () => {
  await withApp(async ({ port, sent }) => {
    const alex = await api(port, "POST", "/api/auth/start", { body: { name: "Alex" }, status: 201 });
    const created = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "friends" }, status: 201 });
    const veit = await api(port, "POST", "/api/auth/start", {
      body: { name: "Veit", code: created.circle.inviteCode },
      status: 201,
    });
    await api(port, "POST", "/api/push/subscribe", {
      token: alex.token,
      body: { endpoint: "https://push.example/alex", keys: { p256dh: "p", auth: "a" } },
      status: 204,
    });
    const social = await api(port, "POST", "/api/socials", {
      token: alex.token,
      body: { note: "Coffee?" },
      status: 201,
    });
    const coming = await api(port, "POST", `/api/socials/${social.social.id}/reply`, {
      token: veit.token,
      body: { reply: "coming", eta: 10 },
      status: 200,
    });
    assert.equal(coming.social.joined[0].reply, "coming");
    assert.equal(coming.social.joined[0].etaMin, 10);
    assert.equal(sent.at(-1)?.body, "Veit is on my way – 10 min");

    const declined = await api(port, "POST", `/api/socials/${social.social.id}/reply`, {
      token: veit.token,
      body: { reply: "declined" },
      status: 200,
    });
    assert.equal(declined.social.joined[0].reply, "declined");
    assert.equal(declined.social.joined[0].etaMin, null);
    assert.equal(sent.at(-1)?.body, "Veit can't make it");
    await api(port, "POST", `/api/socials/${social.social.id}/reply`, {
      token: veit.token,
      body: { reply: "coming", eta: 7 },
      status: 400,
    });
  });
});

test("later today pushes once, then reminds only people who are coming", async () => {
  await withApp(async ({ port, db, sent, at }) => {
    const philipp = await api(port, "POST", "/api/auth/start", { body: { name: "Philipp" }, status: 201 });
    const created = await api(port, "POST", "/api/circles", { token: philipp.token, body: { name: "friends" }, status: 201 });
    const alex = await api(port, "POST", "/api/auth/start", {
      body: { name: "Alex", code: created.circle.inviteCode },
      status: 201,
    });
    const sam = await api(port, "POST", "/api/auth/start", {
      body: { name: "Sam", code: created.circle.inviteCode },
      status: 201,
    });
    for (const [token, endpoint] of [[alex.token, "alex"], [sam.token, "sam"], [philipp.token, "phil"]] as const) {
      await api(port, "POST", "/api/push/subscribe", {
        token,
        body: { endpoint: `https://push.example/${endpoint}`, keys: { p256dh: "p", auth: "a" } },
        status: 204,
      });
    }
    const social = await api(port, "POST", "/api/socials", {
      token: philipp.token,
      body: { note: "Dinner", place: "Café X", startsAt: "18:00" },
      status: 201,
    });
    assert.equal(social.social.place, "Café X");
    assert.equal(sent[0].body, "Philipp is free from 18:00 – meet at Café X");
    assert.ok(social.social.startsAt > START);

    await api(port, "POST", `/api/socials/${social.social.id}/reply`, {
      token: alex.token,
      body: { reply: "coming", eta: 10 },
      status: 200,
    });
    await api(port, "POST", `/api/socials/${social.social.id}/reply`, {
      token: sam.token,
      body: { reply: "declined" },
      status: 200,
    });
    const before = sent.length;
    assert.equal(await sendStartReminders(db, { async send(_s, payload) { sent.push(payload); } }, START + 60_000), 0);
    assert.equal(sent.length, before);

    at(social.social.startsAt);
    assert.equal(await sendStartReminders(db, { async send(_s, payload) { sent.push(payload); } }, social.social.startsAt), 1);
    const reminder = sent.at(-1);
    assert.equal(reminder?.body, "Philipp is free – meet at Café X");
    assert.equal(reminder?.url, `/?social=${social.social.id}`);
    assert.equal(sent.filter((payload) => payload.body === reminder?.body).length, 1);

    await api(port, "POST", "/api/socials", {
      token: philipp.token,
      body: { note: "Too late", startsAt: "10:00" },
      status: 400,
    });
  }, "UTC");
});
