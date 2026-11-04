import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { HISTORY_DAYS, openDb, sweep } from "../src/db.js";
import type { PushPayload, PushSender } from "../src/push.js";
import { addDays } from "../src/time.js";

const START = Date.parse("2026-06-01T15:00:00.000Z");

async function withApp(fn: (ctx: {
  port: number;
  db: DatabaseSync;
  sent: PushPayload[];
  at: (ms: number) => void;
  now: () => number;
}) => Promise<void>) {
  const sent: PushPayload[] = [];
  let now = START;
  const db = openDb(":memory:");
  const push: PushSender = { async send(_sub, payload) { sent.push(payload); } };
  const config = loadConfig({ PORT: "3000", APP_TZ: "UTC", DB_PATH: ":memory:" });
  const server = http.createServer(createApp({ db, push, config: { ...config, dbPath: ":memory:" }, now: () => now }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn({ port, db, sent, at(ms) { now = ms; }, now: () => now });
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

test("ended hangouts stay in Past for 90 days, without a new push", async () => {
  await withApp(async ({ port, db, sent, at, now }) => {
    const alex = await api(port, "POST", "/api/auth/start", { body: { name: "Alex" }, status: 201 });
    const created = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "friends" }, status: 201 });
    const fritz = await api(port, "POST", "/api/auth/start", { body: { name: "Fritz", code: created.circle.inviteCode }, status: 201 });
    const nia = await api(port, "POST", "/api/auth/start", { body: { name: "Nia", code: created.circle.inviteCode }, status: 201 });
    const outsider = await api(port, "POST", "/api/auth/start", { body: { name: "Out" }, status: 201 });
    await api(port, "POST", "/api/circles", { token: outsider.token, body: { name: "other" }, status: 201 });
    const social = await api(port, "POST", "/api/socials", {
      token: alex.token,
      body: { note: "Coffee", place: "Cafe", lat: 48.1, lng: 11.5 },
      status: 201,
    });
    await api(port, "POST", `/api/socials/${social.social.id}/reply`, {
      token: fritz.token,
      body: { reply: "in", arriveAt: "16:00" },
      status: 200,
    });
    await api(port, "POST", `/api/socials/${social.social.id}/reply`, { token: nia.token, body: { reply: "in" }, status: 200 });
    await api(port, "DELETE", `/api/socials/${social.social.id}/people/${nia.user.id}`, { token: alex.token, status: 204 });
    const plan = await api(port, "POST", "/api/plans", {
      token: alex.token,
      body: { note: "Dinner", place: "Kitchen", time: "19:00" },
      status: 201,
    });
    const before = sent.length;
    await api(port, "DELETE", `/api/socials/${social.social.id}`, { token: alex.token, status: 204 });
    await api(port, "DELETE", `/api/plans/${plan.plan.id}`, { token: alex.token, status: 204 });
    assert.equal(sent.length, before);
    const activeSocials = await api(port, "GET", "/api/socials", { token: alex.token });
    const activePlans = await api(port, "GET", "/api/plans", { token: alex.token });
    assert.equal(activeSocials.socials.length, 0);
    assert.equal(activePlans.plans.length, 0);
    const past = await api(port, "GET", "/api/past", { token: alex.token });
    assert.equal(past.days[0].label, "Today");
    const notes = past.days.flatMap((day: { events: Array<{ note: string }> }) => day.events.map((event) => event.note)).sort();
    assert.deepEqual(notes, ["Coffee", "Dinner"]);
    const coffee = past.days.flatMap((day: { events: Array<{ note: string }> }) => day.events).find((event: { note: string }) => event.note === "Coffee");
    assert.equal(coffee.host.name, "Alex");
    assert.equal(coffee.place, "Cafe");
    assert.equal(coffee.time, "15:00");
    assert.equal(coffee.people.length, 1);
    assert.equal(coffee.people[0].name, "Fritz");
    assert.equal(typeof coffee.people[0].arriveAt, "number");
    const stored = db.prepare("SELECT lat, lng, place FROM socials WHERE id = ?").get(social.social.id) as { lat: number | null; lng: number | null; place: string };
    assert.equal(stored.lat, null);
    assert.equal(stored.lng, null);
    assert.equal(stored.place, "Cafe");
    const hidden = await api(port, "GET", "/api/past", { token: nia.token });
    assert.equal(hidden.days.flatMap((day: { events: unknown[] }) => day.events).some((event: { note: string }) => event.note === "Coffee"), false);
    const elsewhere = await api(port, "GET", "/api/past", { token: outsider.token });
    assert.deepEqual(elsewhere.days, []);
    const closed = await api(port, "GET", `/api/socials/${social.social.id}/chat`, { token: fritz.token });
    assert.equal(closed.chat.closed, true);
    const denied = await api(port, "POST", `/api/socials/${social.social.id}/chat`, { token: fritz.token, body: { text: "still?" }, status: 403 });
    assert.equal(denied.error, "This chat is closed.");

    at(START + 2 * 24 * 60 * 60 * 1000);
    const later = await api(port, "POST", "/api/socials", { token: fritz.token, body: { note: "Walk" }, status: 201 });
    const pushes = sent.length;
    at(START + 3 * 24 * 60 * 60 * 1000);
    const aged = await api(port, "GET", "/api/past", { token: alex.token });
    assert.equal(aged.days.some((day: { events: Array<{ note: string }> }) => day.events.some((event) => event.note === "Walk")), true);
    assert.equal(sent.length, pushes);
    sweep(db, now(), addDays("2026-06-04", -HISTORY_DAYS), "2026-06-04");
    const kept = await api(port, "GET", "/api/past", { token: alex.token });
    assert.equal(kept.days.flatMap((day: { events: unknown[] }) => day.events).length >= 2, true);
    sweep(db, START + 100 * 24 * 60 * 60 * 1000, "2026-03-01", "2026-09-09");
    const gone = await api(port, "GET", "/api/past", { token: alex.token });
    assert.deepEqual(gone.days, []);
  });
});

test("an ended plan rejects reply, join, and a new arrival time", async () => {
  await withApp(async ({ port, db, sent }) => {
    const alex = await api(port, "POST", "/api/auth/start", { body: { name: "Alex" }, status: 201 });
    const created = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "friends" }, status: 201 });
    const fritz = await api(port, "POST", "/api/auth/start", { body: { name: "Fritz", code: created.circle.inviteCode }, status: 201 });
    const sam = await api(port, "POST", "/api/auth/start", { body: { name: "Sam", code: created.circle.inviteCode }, status: 201 });
    await api(port, "POST", "/api/push/subscribe", {
      token: alex.token,
      body: { endpoint: `https://push.example/${alex.user.id}`, keys: { p256dh: "p", auth: "a" } },
      status: 204,
    });
    const plan = await api(port, "POST", "/api/plans", { token: alex.token, body: { note: "Dinner" }, status: 201 });
    await api(port, "POST", `/api/plans/${plan.plan.id}/reply`, { token: fritz.token, body: { reply: "in" }, status: 200 });
    await api(port, "DELETE", `/api/plans/${plan.plan.id}`, { token: alex.token, status: 204 });
    const pushes = sent.length;
    const alerts = Number((db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = 'plan-reply'").get(alex.user.id) as { n: number | bigint }).n);
    const before = db.prepare("SELECT reply, arrive_at FROM plan_joins WHERE plan_id = ? AND user_id = ?").get(plan.plan.id, fritz.user.id) as { reply: string; arrive_at: number | null };

    const arrival = await api(port, "POST", `/api/plans/${plan.plan.id}/reply`, {
      token: fritz.token,
      body: { reply: "in", arriveAt: "19:40" },
      status: 410,
    });
    const again = await api(port, "POST", `/api/plans/${plan.plan.id}/join`, { token: fritz.token, body: {}, status: 410 });
    const fresh = await api(port, "POST", `/api/plans/${plan.plan.id}/reply`, { token: sam.token, body: { reply: "in" }, status: 410 });
    const joined = await api(port, "POST", `/api/plans/${plan.plan.id}/join`, { token: sam.token, body: {}, status: 410 });
    for (const result of [arrival, again, fresh, joined]) assert.equal(result.error, "That plan has ended.");

    const after = db.prepare("SELECT reply, arrive_at FROM plan_joins WHERE plan_id = ? AND user_id = ?").get(plan.plan.id, fritz.user.id) as { reply: string; arrive_at: number | null };
    assert.equal(after.reply, before.reply);
    assert.equal(after.arrive_at, before.arrive_at);
    const samRow = db.prepare("SELECT COUNT(*) AS n FROM plan_joins WHERE plan_id = ? AND user_id = ?").get(plan.plan.id, sam.user.id) as { n: number | bigint };
    assert.equal(Number(samRow.n), 0);
    assert.equal(sent.length, pushes);
    const alertsAfter = Number((db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = 'plan-reply'").get(alex.user.id) as { n: number | bigint }).n);
    assert.equal(alertsAfter, alerts);
  });
});

test("Past lists each day under one heading", async () => {
  await withApp(async ({ port, at }) => {
    const alex = await api(port, "POST", "/api/auth/start", { body: { name: "Alex" }, status: 201 });
    await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "friends" }, status: 201 });
    await api(port, "POST", "/api/plans", { token: alex.token, body: { note: "Dinner" }, status: 201 });
    at(Date.parse("2026-06-01T20:00:00.000Z"));
    const late = await api(port, "POST", "/api/socials", { token: alex.token, body: { note: "Late" }, status: 201 });
    await api(port, "DELETE", `/api/socials/${late.social.id}`, { token: alex.token, status: 204 });
    at(Date.parse("2026-06-02T10:00:00.000Z"));
    const morning = await api(port, "POST", "/api/socials", { token: alex.token, body: { note: "Morning" }, status: 201 });
    await api(port, "DELETE", `/api/socials/${morning.social.id}`, { token: alex.token, status: 204 });
    at(Date.parse("2026-06-03T12:00:00.000Z"));
    const past = await api(port, "GET", "/api/past", { token: alex.token });
    const labels = past.days.map((day: { label: string }) => day.label);
    assert.deepEqual(labels, ["Yesterday", "1 Jun"]);
    assert.deepEqual(past.days[0].events.map((event: { note: string }) => event.note), ["Morning", "Dinner"]);
    assert.deepEqual(past.days[1].events.map((event: { note: string }) => event.note), ["Late"]);
  });
});

test("cleanup removes an event chat with its messages", async () => {
  await withApp(async ({ port, db, at, now }) => {
    const alex = await api(port, "POST", "/api/auth/start", { body: { name: "Alex" }, status: 201 });
    await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "friends" }, status: 201 });
    const social = await api(port, "POST", "/api/socials", { token: alex.token, body: { note: "Coffee" }, status: 201 });
    const plan = await api(port, "POST", "/api/plans", { token: alex.token, body: { note: "Dinner" }, status: 201 });
    await api(port, "POST", `/api/socials/${social.social.id}/chat`, { token: alex.token, body: { text: "See you" }, status: 201 });
    await api(port, "POST", `/api/plans/${plan.plan.id}/chat`, { token: alex.token, body: { text: "Tomorrow" }, status: 201 });
    await api(port, "POST", "/api/circles/chat", { token: alex.token, body: { text: "Hello" }, status: 201 });
    const socialChat = db.prepare("SELECT id FROM chats WHERE kind = 'social' AND ref_id = ?").get(social.social.id) as { id: string };
    const planChat = db.prepare("SELECT id FROM chats WHERE kind = 'plan' AND ref_id = ?").get(plan.plan.id) as { id: string };
    at(START + 100 * 24 * 60 * 60 * 1000);
    sweep(db, now(), "2026-03-01", "2026-09-09");
    const socialGone = await api(port, "GET", `/api/socials/${social.social.id}/chat`, { token: alex.token, status: 404 });
    const planGone = await api(port, "GET", `/api/plans/${plan.plan.id}/chat`, { token: alex.token, status: 404 });
    assert.equal(socialGone.error, "chat not found");
    assert.equal(planGone.error, "chat not found");
    const left = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE chat_id IN (?, ?)").get(socialChat.id, planChat.id) as { n: number | bigint };
    assert.equal(Number(left.n), 0);
    const chats = db.prepare("SELECT COUNT(*) AS n FROM chats WHERE id IN (?, ?)").get(socialChat.id, planChat.id) as { n: number | bigint };
    assert.equal(Number(chats.n), 0);
    const circle = await api(port, "GET", "/api/circles/chat", { token: alex.token });
    assert.equal(circle.chat.messages.some((message: { text: string }) => message.text === "Hello"), true);
  });
});
