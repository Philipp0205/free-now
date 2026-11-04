import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { flushChatNotices } from "../src/chat.js";
import {
  addMember,
  insertCircle,
  insertPushDelivery,
  insertUser,
  markPushDelivered,
  markPushFailed,
  openDb,
  recordDisplay,
  upsertPushSub,
} from "../src/db.js";
import { reachOf, statusFor, summarizePush } from "../src/push-status.js";
import type { PushSender } from "../src/push.js";
import { api, withApp, type AppCtx, type SentPush } from "./http.js";

const NOW = 1_700_000_000_000;

test("reach is on, off, or not installed only when the client said so", () => {
  assert.equal(reachOf({ subs: 1, displayAt: null, standaloneAt: null, pushSeenAt: null }), "on");
  assert.equal(reachOf({ subs: 2, displayAt: 1, standaloneAt: null, pushSeenAt: 1 }), "on");
  assert.equal(reachOf({ subs: 0, displayAt: null, standaloneAt: null, pushSeenAt: null }), "off");
  assert.equal(reachOf({ subs: 0, displayAt: 1, standaloneAt: 1, pushSeenAt: null }), "off");
  assert.equal(reachOf({ subs: 0, displayAt: 1, standaloneAt: null, pushSeenAt: 5 }), "off");
  assert.equal(reachOf({ subs: 0, displayAt: 1, standaloneAt: null, pushSeenAt: null }), "not_installed");
});

test("a member is delivered if any device acked, otherwise sent, failed, or off", () => {
  assert.equal(statusFor([{ user_id: "a", status: "delivered", http_status: null }, { user_id: "a", status: "failed", http_status: 500 }], "on"), "delivered");
  assert.equal(statusFor([{ user_id: "a", status: "sent", http_status: null }, { user_id: "a", status: "failed", http_status: 500 }], "on"), "sent");
  assert.equal(statusFor([{ user_id: "a", status: "failed", http_status: 410 }], "off"), "failed");
  assert.equal(statusFor([], "not_installed"), "not_installed");
  assert.equal(statusFor([], "off"), "off");
  assert.equal(statusFor([], "on"), "off");
});

test("status aggregation uses the latest batch and skips the host", () => {
  const db = openDb(":memory:");
  insertUser(db, { id: "host", name: "Alex", token_hash: "h", buzz_token: "b", created_at: NOW });
  insertUser(db, { id: "bea", name: "Bea", token_hash: "h2", buzz_token: "b2", created_at: NOW });
  insertUser(db, { id: "cam", name: "Cam", token_hash: "h3", buzz_token: "b3", created_at: NOW });
  insertUser(db, { id: "dana", name: "Dana", token_hash: "h4", buzz_token: "b4", created_at: NOW });
  insertCircle(db, { id: "c", name: "friends", invite_code: "ABCD2345", created_by: "host", created_at: NOW }, "host", NOW);
  addMember(db, "c", "bea", NOW + 1);
  addMember(db, "c", "cam", NOW + 2);
  addMember(db, "c", "dana", NOW + 3);
  recordDisplay(db, "cam", false, NOW);
  upsertPushSub(db, { id: "sub-1", userId: "bea", endpoint: "https://push.example/1", p256dh: "p", auth: "a", createdAt: NOW });
  upsertPushSub(db, { id: "sub-2", userId: "bea", endpoint: "https://push.example/2", p256dh: "p", auth: "a", createdAt: NOW });
  insertPushDelivery(db, { id: "old-1", userId: "bea", subId: "sub-1", circleId: "c", kind: "social", refId: "s", batchId: "old", createdAt: NOW });
  markPushDelivered(db, "old-1");
  insertPushDelivery(db, { id: "new-1", userId: "bea", subId: "sub-1", circleId: "c", kind: "social", refId: "s", batchId: "new", createdAt: NOW + 10 });
  markPushDelivered(db, "new-1");
  insertPushDelivery(db, { id: "new-2", userId: "bea", subId: "sub-2", circleId: "c", kind: "social", refId: "s", batchId: "new", createdAt: NOW + 10 });
  markPushFailed(db, "new-2", 500);
  insertPushDelivery(db, { id: "dana-1", userId: "dana", subId: "gone", circleId: "c", kind: "social", refId: "s", batchId: "new", createdAt: NOW + 10 });
  markPushFailed(db, "dana-1", 410);

  const summary = summarizePush(db, "c", "social", "s", "host");
  assert.equal(summary.total, 3);
  assert.equal(summary.delivered, 1);
  assert.deepEqual(summary.people.map((person) => ({ name: person.name, status: person.status, httpStatus: person.httpStatus })), [
    { name: "Bea", status: "delivered", httpStatus: null },
    { name: "Cam", status: "not_installed", httpStatus: null },
    { name: "Dana", status: "failed", httpStatus: 410 },
  ]);
  const cols = db.prepare("PRAGMA table_info(push_deliveries)").all().map((row) => (row as { name: string }).name);
  for (const hidden of ["body", "title", "payload", "endpoint", "p256dh", "auth"]) {
    assert.equal(cols.includes(hidden), false, hidden);
  }
  db.close();
});

test("an older database gains delivery rows and display columns", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hangry-push-"));
  const file = path.join(dir, "old.sqlite");
  const raw = new DatabaseSync(file);
  raw.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      buzz_token TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
    );
  `);
  raw.prepare("INSERT INTO users (id, name, token_hash, buzz_token, created_at) VALUES (?, ?, ?, ?, ?)").run("u", "Alex", "h", "b", 1);
  raw.close();
  const db = openDb(file);
  try {
    const cols = db.prepare("PRAGMA table_info(users)").all().map((row) => (row as { name: string }).name);
    assert.ok(cols.includes("display_at") && cols.includes("standalone_at") && cols.includes("push_seen_at"));
    const user = db.prepare("SELECT name, display_at FROM users WHERE id = ?").get("u") as { name: string; display_at: number | null };
    assert.equal(user.name, "Alex");
    assert.equal(user.display_at, null);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'push_deliveries'").get() != null, true);
    recordDisplay(db, "u", true, 5);
    const after = db.prepare("SELECT display_at, standalone_at FROM users WHERE id = ?").get("u") as { display_at: number; standalone_at: number };
    assert.equal(after.display_at, 5);
    assert.equal(after.standalone_at, 5);
    recordDisplay(db, "u", false, 9);
    const kept = db.prepare("SELECT standalone_at, display_at FROM users WHERE id = ?").get("u") as { standalone_at: number; display_at: number };
    assert.equal(kept.standalone_at, 5);
    assert.equal(kept.display_at, 9);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the service worker acks without blocking the notification", () => {
  const source = fs.readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
  assert.match(source, /addEventListener\("push"/);
  assert.match(source, /showNotification/);
  assert.match(source, /\/api\/push\/ack/);
  assert.match(source, /\.catch\(\(\) => \{\}\)/);
});

test("a free post records one row per subscription and an ack marks it delivered", async () => {
  const sent: SentPush[] = [];
  const lines: string[] = [];
  const log = console.log;
  const err = console.error;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  const push: PushSender = {
    async send(sub, payload) {
      sent.push({ endpoint: sub.endpoint, payload });
      if (sub.endpoint.endsWith("-dead")) {
        const error = new Error(`gone ${sub.endpoint} p256dh-key`);
        (error as { statusCode?: number }).statusCode = 410;
        throw error;
      }
      if (sub.endpoint.endsWith("-down")) {
        const error = new Error("unavailable");
        (error as { statusCode?: number }).statusCode = 500;
        throw error;
      }
    },
  };
  try {
    await withApp(async (ctx) => {
      const alex = await signUp(ctx, "Alex");
      const circle = await api(ctx, "POST", "/api/circles", { token: alex.token, body: { name: "friends" }, status: 201 });
      const code = circle.json.circle.inviteCode as string;
      const bea = await signUp(ctx, "Bea");
      const cam = await signUp(ctx, "Cam");
      const dana = await signUp(ctx, "Dana");
      const sam = await signUp(ctx, "Sam");
      await api(ctx, "POST", "/api/circles/join", { token: bea.token, body: { code }, status: 200 });
      await api(ctx, "POST", "/api/circles/join", { token: cam.token, body: { code }, status: 200 });
      await api(ctx, "POST", "/api/circles/join", { token: dana.token, body: { code }, status: 200 });
      await subscribe(ctx, bea.token, "https://push.example/bea");
      await subscribe(ctx, bea.token, "https://push.example/bea-down");
      await subscribe(ctx, dana.token, "https://push.example/dana-dead");
      await api(ctx, "POST", "/api/me/display", { token: cam.token, body: { standalone: false }, status: 204 });
      await api(ctx, "POST", "/api/me/display", { token: dana.token, body: { standalone: false }, status: 204 });

      const before = await api(ctx, "GET", "/api/me", { token: alex.token });
      const reach = Object.fromEntries(before.json.circle.members.map((member: { name: string; reach: string }) => [member.name, member.reach]));
      assert.equal(reach.Bea, "on");
      assert.equal(reach.Cam, "not_installed");
      assert.equal(reach.Alex, "off");

      const created = await api(ctx, "POST", "/api/socials", {
        token: alex.token,
        body: { note: "Secret rooftop" },
        status: 201,
      });
      assert.equal(created.json.social.push.total, 3);
      const socialId = created.json.social.id as string;
      const live = sent.find((item) => item.endpoint === "https://push.example/bea");
      const down = sent.find((item) => item.endpoint === "https://push.example/bea-down");
      const dead = sent.find((item) => item.endpoint === "https://push.example/dana-dead");
      assert.equal(typeof live?.payload.id, "string");
      assert.equal(typeof down?.payload.id, "string");
      assert.equal(typeof dead?.payload.id, "string");

      const ack = await fetch(`http://127.0.0.1:${ctx.port}/api/push/ack`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: live?.payload.id }),
      });
      const ackText = await ack.text();
      assert.equal(ack.status, 204);
      assert.equal(ackText, "");
      await api(ctx, "POST", "/api/push/ack", { body: { id: live?.payload.id }, status: 204 });
      await api(ctx, "POST", "/api/push/ack", { body: { id: dead?.payload.id }, status: 204 });
      await api(ctx, "POST", "/api/push/ack", { body: { id: "nope" }, status: 400 });
      await api(ctx, "POST", "/api/push/ack", { body: {}, status: 400 });
      await api(ctx, "POST", "/api/push/ack", {
        body: { id: "00000000-0000-4000-8000-000000000000" },
        status: 204,
      });

      const host = await api(ctx, "GET", "/api/socials", { token: alex.token });
      const people = host.json.socials[0].push.people as Array<{ name: string; status: string; httpStatus: number | null }>;
      assert.equal(host.json.socials[0].push.delivered, 1);
      assert.deepEqual(people.map((person) => person.name), ["Bea", "Cam", "Dana"]);
      assert.equal(people.find((person) => person.name === "Bea")?.status, "delivered");
      assert.equal(people.find((person) => person.name === "Cam")?.status, "not_installed");
      const danaPerson = people.find((person) => person.name === "Dana");
      assert.equal(danaPerson?.status, "failed");
      assert.equal(danaPerson?.httpStatus, 410);

      const friend = await api(ctx, "GET", "/api/socials", { token: bea.token });
      assert.equal(Object.hasOwn(friend.json.socials[0], "push"), false);
      const outsider = await fetch(`http://127.0.0.1:${ctx.port}/api/socials?circle=${circle.json.circle.id}`, {
        headers: { authorization: `Bearer ${sam.token}` },
      });
      assert.equal(outsider.status, 404);

      await api(ctx, "POST", `/api/circles/members/${cam.user.id}`, { token: alex.token, body: { admin: true }, status: 200 });
      const admin = await api(ctx, "GET", "/api/socials", { token: cam.token });
      assert.equal(admin.json.socials[0].push.delivered, 1);

      const afterDead = await api(ctx, "GET", "/api/me", { token: dana.token });
      const danaReach = afterDead.json.circle.members.find((member: { name: string }) => member.name === "Dana").reach;
      assert.equal(danaReach, "off");
      const stillThere = ctx.db.prepare("SELECT COUNT(*) AS n FROM push_subs WHERE endpoint = ?").get("https://push.example/dana-dead") as { n: number };
      assert.equal(Number(stillThere.n), 0);
      const kept = ctx.db.prepare("SELECT COUNT(*) AS n FROM push_subs WHERE endpoint = ?").get("https://push.example/bea-down") as { n: number };
      assert.equal(Number(kept.n), 1);

      const replies = ctx.db.prepare("SELECT COUNT(*) AS n FROM push_deliveries").get() as { n: number };
      await subscribe(ctx, alex.token, "https://push.example/alex");
      await api(ctx, "POST", `/api/socials/${socialId}/reply`, { token: bea.token, body: { reply: "in" }, status: 200 });
      const afterReply = ctx.db.prepare("SELECT COUNT(*) AS n FROM push_deliveries").get() as { n: number };
      assert.equal(Number(afterReply.n), Number(replies.n));

      ctx.advance(15_000);
      await api(ctx, "POST", "/api/socials", { token: alex.token, body: { note: "Secret rooftop later" }, status: 200 });
      const again = await api(ctx, "GET", "/api/socials", { token: alex.token });
      assert.equal(again.json.socials[0].push.people.find((person: { name: string }) => person.name === "Bea").status, "sent");
      assert.equal(again.json.socials[0].push.delivered, 0);

      const plan = await api(ctx, "POST", "/api/plans", { token: alex.token, body: { note: "Dinner" }, status: 201 });
      assert.equal(plan.json.plan.push.people.find((person: { name: string }) => person.name === "Bea").status, "sent");
      assert.equal(plan.json.plan.push.total, 3);

      const beforeBuzz = sent.length;
      ctx.advance(15_000);
      const buzzed = await api(ctx, "POST", `/api/buzz/${alex.buzzToken}`, { body: { note: "Buzz spot" }, status: 200 });
      assert.ok(sent.length > beforeBuzz);
      assert.equal(buzzed.json.social.push.people.find((person: { name: string }) => person.name === "Bea").status, "sent");

      await api(ctx, "POST", "/api/push/test", { token: bea.token, body: {}, status: 200 });
      const tracked = ctx.db.prepare("SELECT DISTINCT kind FROM push_deliveries").all() as Array<{ kind: string }>;
      assert.deepEqual(tracked.map((row) => row.kind).sort(), ["plan", "social"]);

      await api(ctx, "POST", `/api/socials/${socialId}/chat`, { token: alex.token, body: { text: "downstairs" }, status: 201 });
      await flushChatNotices(true);
      const chatRows = ctx.db.prepare("SELECT COUNT(*) AS n FROM push_deliveries WHERE kind = 'chat'").get() as { n: number };
      assert.ok(Number(chatRows.n) >= 1);

      const stored = ctx.db.prepare("SELECT user_id, status, http_status FROM push_deliveries").all() as Array<{ user_id: string; status: string; http_status: number | null }>;
      assert.equal(JSON.stringify(stored).includes("Secret"), false);
      assert.equal(JSON.stringify(stored).includes("push.example"), false);
    }, { push });
  } finally {
    console.log = log;
    console.error = err;
  }
  const text = lines.join("\n");
  assert.match(text, /push send user=\S+ status=ok/);
  assert.match(text, /push send user=\S+ status=410/);
  assert.match(text, /push send user=\S+ status=500/);
  assert.match(text, /push ack status=ok/);
  assert.equal(text.includes("Secret"), false);
  assert.equal(text.includes("push.example"), false);
  assert.equal(text.includes("p256dh"), false);
});

async function signUp(ctx: AppCtx<SentPush>, name: string) {
  const { json } = await api(ctx, "POST", "/api/auth/start", { body: { name }, status: 201 });
  return json as { token: string; user: { id: string }; buzzToken: string };
}

async function subscribe(ctx: AppCtx<SentPush>, token: string, endpoint: string) {
  await api(ctx, "POST", "/api/push/subscribe", {
    token,
    body: { endpoint, keys: { p256dh: "p", auth: "a" } },
    status: 204,
  });
}
