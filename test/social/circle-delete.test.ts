import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { flushChatNotices } from "../../src/chat/chat.js";
import { api, START, withApp, testEmail } from "../http.js";

const ADMIN = "a".repeat(32);
const CIRCLE_ID_TABLES = ["buzz_circles", "calendar_share", "chats", "circle_removals", "feedback", "memberships", "notifications", "plan_circles", "plans", "push_deliveries", "socials"];

test("deleting a circle leaves no orphan rows", async () => {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((part) => String(part)).join(" "));
  };
  try {
    await withApp(async ({ port, db }) => {
      const seeded = await seedCircle(port, db);
      const { alex, bea, cam, nia, sam, friends, uni } = seeded;
      await flushChatNotices(true);

      const before = belong(db, friends.circle.id);
      for (const [table, rows] of Object.entries(before)) {
        assert.ok(rows > 0, `${table} should have a row before delete`);
      }
      assert.deepEqual(circleIdTables(db), CIRCLE_ID_TABLES);
      const source = fs.readFileSync(new URL("../../src/db.ts", import.meta.url), "utf8");
      const commentStart = source.indexOf("Tables that reference circle_id:");
      const commentEnd = source.indexOf("Also removed in that same transaction");
      assert.ok(commentStart > 0 && commentEnd > commentStart);
      const comment = source.slice(commentStart, commentEnd);
      for (const table of CIRCLE_ID_TABLES) assert.match(comment, new RegExp(`\\b${table}\\b`));

      const people = count(db, "SELECT COUNT(*) AS n FROM users");
      const subs = count(db, "SELECT COUNT(*) AS n FROM push_subs");
      const sessions = count(db, "SELECT COUNT(*) AS n FROM sessions");
      const uniSocials = count(db, "SELECT COUNT(*) AS n FROM socials WHERE circle_id = ?", uni.circle.id);
      const uniNotes = count(db, "SELECT COUNT(*) AS n FROM notifications WHERE circle_id = ?", uni.circle.id);
      assert.ok(uniSocials > 0);
      assert.ok(uniNotes > 0);
      assert.ok(subs > 0);

      const write = await hit(port, "POST", "/api/admin/query", {
        token: ADMIN,
        forwarded: "203.0.113.21",
        body: { sql: "DELETE FROM circles" },
      });
      assert.equal(write.status, 400);
      assert.deepEqual(write.json, { error: "query is not allowed" });
      assert.deepEqual(belong(db, friends.circle.id), before);

      const denied = await api(port, "DELETE", "/api/circles", { token: bea.token, status: 403 });
      assert.equal(denied.error, "Only an admin can do that.");
      assert.deepEqual(belong(db, friends.circle.id), before);

      const badToken = await hit(port, "POST", `/api/admin/circles/${friends.circle.id}/delete`, {
        token: "b".repeat(32),
        forwarded: "203.0.113.22",
      });
      assert.equal(badToken.status, 404);
      assert.deepEqual(badToken.json, { error: "not found" });
      const missing = await hit(port, "POST", `/api/admin/circles/${crypto.randomUUID()}/delete`, {
        token: ADMIN,
        forwarded: "203.0.113.21",
      });
      assert.equal(missing.status, 404);
      assert.deepEqual(missing.json, { error: "not found" });
      const malformed = await hit(port, "POST", "/api/admin/circles/not-a-circle/delete", {
        token: ADMIN,
        forwarded: "203.0.113.21",
      });
      assert.equal(malformed.status, 404);
      assert.deepEqual(belong(db, friends.circle.id), before);

      const removed = await hit(port, "POST", `/api/admin/circles/${friends.circle.id}/delete`, {
        token: ADMIN,
        forwarded: "203.0.113.21",
      });
      assert.equal(removed.status, 200);
      assert.deepEqual(removed.json, {
        deleted: true,
        circle: { id: friends.circle.id, name: "Friends" },
        counts: before,
      });
      assert.ok(logs.some((line) => line === `admin circle delete ok id=${friends.circle.id}`));
      assert.equal(logs.some((line) => line.includes(ADMIN)), false);

      const after = belong(db, friends.circle.id);
      for (const [table, rows] of Object.entries(after)) assert.equal(rows, 0, table);
      for (const table of circleIdTables(db)) {
        assert.equal(count(db, `SELECT COUNT(*) AS n FROM ${table} WHERE circle_id = ?`, friends.circle.id), 0, table);
      }
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
      assert.equal(count(db, "SELECT COUNT(*) AS n FROM users"), people);
      assert.equal(count(db, "SELECT COUNT(*) AS n FROM push_subs"), subs);
      assert.equal(count(db, "SELECT COUNT(*) AS n FROM sessions"), sessions);
      assert.equal(count(db, "SELECT COUNT(*) AS n FROM users WHERE id = ?", nia.user.id), 1);
      assert.equal(count(db, "SELECT COUNT(*) AS n FROM socials WHERE circle_id = ?", uni.circle.id), uniSocials);
      assert.equal(count(db, "SELECT COUNT(*) AS n FROM notifications WHERE circle_id = ?", uni.circle.id), uniNotes);
      assert.equal(count(db, "SELECT COUNT(*) AS n FROM memberships WHERE circle_id = ? AND user_id = ?", uni.circle.id, sam.user.id), 1);

      const alexNow = await api(port, "GET", "/api/me", { token: alex.token });
      assert.equal(alexNow.circle.id, uni.circle.id);
      const beaNow = await api(port, "GET", "/api/me", { token: bea.token });
      assert.equal(beaNow.circle, null);
      assert.deepEqual(beaNow.circles, []);
      const camNow = await api(port, "GET", "/api/me", { token: cam.token });
      assert.equal(camNow.user.name, "Cam");
      assert.equal(camNow.circle, null);

      const again = await hit(port, "POST", `/api/admin/circles/${friends.circle.id}/delete`, {
        token: ADMIN,
        forwarded: "203.0.113.21",
      });
      assert.equal(again.status, 404);
      assert.deepEqual(again.json, { error: "not found" });
    }, { env: { ADMIN_TOKEN: ADMIN } });
  } finally {
    console.log = original;
    await flushChatNotices(true);
  }
});

test("an admin can delete a circle and the other members are told", async () => {
  await withApp(async ({ port, db, sent }) => {
    const alex = await api(port, "POST", "/api/auth/start", { body: { email: testEmail(), name: "Alex" }, status: 201 });
    const friends = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Friends" }, status: 201 });
    const bea = await api(port, "POST", "/api/auth/start", {
      body: { email: testEmail(), name: "Bea", code: friends.circle.inviteCode },
      status: 201,
    });
    const cam = await api(port, "POST", "/api/auth/start", {
      body: { email: testEmail(), name: "Cam", code: friends.circle.inviteCode },
      status: 201,
    });
    const club = await api(port, "POST", "/api/circles", { token: bea.token, body: { name: "Book club" }, status: 201 });
    const sam = await api(port, "POST", "/api/auth/start", { body: { email: testEmail(), name: "Sam" }, status: 201 });
    await api(port, "POST", "/api/circles", { token: sam.token, body: { name: "Sam's" }, status: 201 });
    await api(port, "POST", "/api/socials", { token: alex.token, body: { note: "Coffee" }, status: 201 });
    for (const person of [alex, bea, cam, sam]) {
      await api(port, "POST", "/api/push/subscribe", {
        token: person.token,
        body: { endpoint: `https://push.example/${person.user.id}`, keys: { p256dh: "p", auth: "a" } },
        status: 204,
      });
    }

    const denied = await api(port, "DELETE", "/api/circles", { token: cam.token, status: 403 });
    assert.equal(denied.error, "Only an admin can do that.");
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM circles WHERE id = ?", friends.circle.id), 1);

    sent.length = 0;
    const removed = await api(port, "DELETE", "/api/circles", { token: alex.token, status: 200 });
    assert.equal(removed.circle, null);
    assert.equal(removed.user.name, "Alex");
    assert.deepEqual(removed.circles, []);

    const pushes = sent.filter((item) => item.payload.body.includes("was deleted by"));
    assert.equal(pushes.length, 2);
    for (const push of pushes) {
      assert.equal(push.payload.title, "Circle deleted");
      assert.equal(push.payload.body, "Friends was deleted by Alex");
      assert.equal(push.payload.url, "/");
    }
    const endpoints = pushes.map((item) => item.endpoint).sort();
    assert.deepEqual(endpoints, [
      `https://push.example/${bea.user.id}`,
      `https://push.example/${cam.user.id}`,
    ].sort());

    const gone = await api(port, "GET", `/api/me?circle=${friends.circle.id}`, { token: bea.token, status: 404 });
    assert.deepEqual(gone, { error: "not found" });
    const beaNow = await api(port, "GET", "/api/me", { token: bea.token });
    assert.equal(beaNow.circle.id, club.circle.id);
    assert.equal(beaNow.circle.name, "Book club");
    const camNow = await api(port, "GET", "/api/me", { token: cam.token });
    assert.equal(camNow.circle, null);
    assert.equal(camNow.user.id, cam.user.id);
    const samNow = await api(port, "GET", "/api/socials", { token: sam.token });
    assert.equal(samNow.socials.length, 0);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM users WHERE id = ?", alex.user.id), 1);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?", bea.user.id), 1);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM notifications WHERE circle_id = ?", friends.circle.id), 0);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM socials WHERE circle_id = ?", friends.circle.id), 0);
  }, { sent: "envelope" });
});

test("a bare buzz falls back to the most recently joined circle that remains", async () => {
  await withApp(async ({ port, at }) => {
    const alex = await api(port, "POST", "/api/auth/start", { body: { email: testEmail(), name: "Alex" }, status: 201 });
    const home = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Home" }, status: 201 });
    at(START + 1000);
    const uni = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Uni" }, status: 201 });
    at(START + 2000);
    const work = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Work" }, status: 201 });
    at(START + 3000);
    const bea = await api(port, "POST", "/api/auth/start", {
      body: { email: testEmail(), name: "Bea", code: home.circle.inviteCode },
      status: 201,
    });
    at(START + 4000);
    await api(port, "POST", "/api/circles/join", { token: bea.token, body: { code: uni.circle.inviteCode }, status: 200 });

    await api(port, "POST", `/api/buzz/${alex.buzzToken}`, { body: { note: "At work" }, status: 201 });
    const workList = await api(port, "GET", `/api/socials?circle=${work.circle.id}`, { token: alex.token });
    assert.equal(workList.socials.some((social: { note: string }) => social.note === "At work"), true);

    await api(port, "POST", `/api/buzz/${bea.buzzToken}`, { body: { note: "On campus" }, status: 201 });
    const uniList = await api(port, "GET", `/api/socials?circle=${uni.circle.id}`, { token: bea.token });
    assert.equal(uniList.socials.some((social: { note: string }) => social.note === "On campus"), true);

    const afterWork = await api(port, "DELETE", `/api/circles?circle=${work.circle.id}`, { token: alex.token, status: 200 });
    assert.equal(afterWork.circle.id, home.circle.id);
    assert.equal(afterWork.circles.some((circle: { id: string }) => circle.id === work.circle.id), false);

    await api(port, "POST", `/api/buzz/${alex.buzzToken}`, { body: { note: "Back to uni" }, status: 201 });
    const alexUni = await api(port, "GET", `/api/socials?circle=${uni.circle.id}`, { token: alex.token });
    assert.equal(alexUni.socials.some((social: { note: string }) => social.note === "Back to uni"), true);
    const alexHome = await api(port, "GET", `/api/socials?circle=${home.circle.id}`, { token: alex.token });
    assert.equal(alexHome.socials.some((social: { note: string }) => social.note === "Back to uni"), false);

    await api(port, "POST", `/api/buzz/${bea.buzzToken}`, { body: { note: "Still uni" }, status: 200 });
    const beaUni = await api(port, "GET", `/api/socials?circle=${uni.circle.id}`, { token: bea.token });
    assert.equal(beaUni.socials.some((social: { note: string }) => social.note === "Still uni"), true);

    await api(port, "DELETE", `/api/circles?circle=${uni.circle.id}`, { token: alex.token, status: 200 });
    const beaSwitched = await api(port, "GET", `/api/me?circle=${uni.circle.id}`, { token: bea.token, status: 404 });
    assert.deepEqual(beaSwitched, { error: "not found" });
    const beaHome = await api(port, "GET", "/api/me", { token: bea.token });
    assert.equal(beaHome.circle.id, home.circle.id);

    await api(port, "POST", `/api/buzz/${alex.buzzToken}`, { body: { note: "Only home" }, status: 201 });
    await api(port, "POST", `/api/buzz/${bea.buzzToken}`, { body: { note: "Bea home" }, status: 201 });
    const homeList = await api(port, "GET", `/api/socials?circle=${home.circle.id}`, { token: alex.token });
    assert.equal(homeList.socials.some((social: { note: string }) => social.note === "Only home"), true);
    assert.equal(homeList.socials.some((social: { note: string }) => social.note === "Bea home"), true);

    await api(port, "DELETE", `/api/circles?circle=${home.circle.id}`, { token: alex.token, status: 200 });
    const alone = await api(port, "GET", "/api/me", { token: bea.token });
    assert.equal(alone.circle, null);
    assert.equal(alone.user.name, "Bea");
    const nowhere = await api(port, "POST", `/api/buzz/${bea.buzzToken}`, { body: { note: "Nowhere" }, status: 409 });
    assert.equal(nowhere.error, "join a circle first");
    const alexGone = await api(port, "GET", "/api/me", { token: alex.token });
    assert.equal(alexGone.circle, null);
    assert.equal(alexGone.user.name, "Alex");
  });
});

test("operator routes stay hidden without a token", async () => {
  await withApp(async ({ port }) => {
    const id = crypto.randomUUID();
    const deleted = await api(port, "POST", `/api/admin/circles/${id}/delete`, { status: 404 });
    assert.deepEqual(deleted, { error: "not found" });
    const flagged = await api(port, "POST", `/api/admin/circles/${id}/members/${id}/admin`, {
      body: { admin: true },
      status: 404,
    });
    assert.deepEqual(flagged, { error: "not found" });
  });
});

test("an operator can promote and demote a member, and cannot leave zero admins", async () => {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((part) => String(part)).join(" "));
  };
  try {
    await withApp(async ({ port, db }) => {
      const alex = await api(port, "POST", "/api/auth/start", { body: { email: testEmail(), name: "Alex" }, status: 201 });
      const friends = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Friends" }, status: 201 });
      const bea = await api(port, "POST", "/api/auth/start", {
        body: { email: testEmail(), name: "Bea", code: friends.circle.inviteCode },
        status: 201,
      });
      const sam = await api(port, "POST", "/api/auth/start", { body: { email: testEmail(), name: "Sam" }, status: 201 });
      await api(port, "POST", "/api/circles", { token: sam.token, body: { name: "Elsewhere" }, status: 201 });
      const circleId = friends.circle.id as string;
      const flag = (userId: string) => count(
        db,
        "SELECT is_admin AS n FROM memberships WHERE circle_id = ? AND user_id = ?",
        circleId,
        userId,
      );

      const last = await hit(port, "POST", `/api/admin/circles/${circleId}/members/${alex.user.id}/admin`, {
        token: ADMIN,
        forwarded: "203.0.113.31",
        body: { admin: false },
      });
      assert.equal(last.status, 409);
      assert.deepEqual(last.json, { error: "A circle needs an admin." });
      assert.equal(flag(alex.user.id), 1);
      assert.equal(count(db, "SELECT COUNT(*) AS n FROM memberships WHERE circle_id = ? AND is_admin = 1", circleId), 1);

      const promoted = await hit(port, "POST", `/api/admin/circles/${circleId}/members/${bea.user.id}/admin`, {
        token: ADMIN,
        forwarded: "203.0.113.31",
        body: { admin: true },
      });
      assert.equal(promoted.status, 200);
      assert.deepEqual(promoted.json, {
        ok: true,
        circle: { id: circleId, name: "Friends" },
        user: { id: bea.user.id, name: "Bea" },
        admin: true,
      });
      const beaMe = await api(port, "GET", "/api/me", { token: bea.token });
      assert.equal(beaMe.circle.youAreAdmin, true);

      const demoted = await hit(port, "POST", `/api/admin/circles/${circleId}/members/${alex.user.id}/admin`, {
        token: ADMIN,
        forwarded: "203.0.113.31",
        body: { admin: false },
      });
      assert.equal(demoted.status, 200);
      assert.equal(demoted.json.admin, false);
      assert.equal(demoted.json.user.name, "Alex");
      assert.equal(flag(alex.user.id), 0);
      assert.equal(flag(bea.user.id), 1);
      const alexMe = await api(port, "GET", "/api/me", { token: alex.token });
      assert.equal(alexMe.circle.youAreAdmin, false);

      const stillLast = await hit(port, "POST", `/api/admin/circles/${circleId}/members/${bea.user.id}/admin`, {
        token: ADMIN,
        forwarded: "203.0.113.31",
        body: { admin: false },
      });
      assert.equal(stillLast.status, 409);
      assert.deepEqual(stillLast.json, { error: "A circle needs an admin." });
      assert.equal(flag(bea.user.id), 1);
      const viaApp = await api(port, "POST", `/api/circles/members/${bea.user.id}`, {
        token: bea.token,
        body: { admin: false },
        status: 409,
      });
      assert.equal(viaApp.error, "A circle needs an admin.");
      assert.equal(flag(bea.user.id), 1);

      const outsider = await hit(port, "POST", `/api/admin/circles/${circleId}/members/${sam.user.id}/admin`, {
        token: ADMIN,
        forwarded: "203.0.113.31",
        body: { admin: true },
      });
      assert.equal(outsider.status, 404);
      assert.deepEqual(outsider.json, { error: "not found" });
      const unknown = await hit(port, "POST", `/api/admin/circles/${circleId}/members/${crypto.randomUUID()}/admin`, {
        token: ADMIN,
        forwarded: "203.0.113.31",
        body: { admin: true },
      });
      assert.equal(unknown.status, 404);
      const noCircle = await hit(port, "POST", `/api/admin/circles/${crypto.randomUUID()}/members/${bea.user.id}/admin`, {
        token: ADMIN,
        forwarded: "203.0.113.31",
        body: { admin: false },
      });
      assert.equal(noCircle.status, 404);
      const badBody = await hit(port, "POST", `/api/admin/circles/${circleId}/members/${bea.user.id}/admin`, {
        token: ADMIN,
        forwarded: "203.0.113.31",
        body: { admin: "no" },
      });
      assert.equal(badBody.status, 404);
      assert.equal(flag(bea.user.id), 1);

      const badToken = await hit(port, "POST", `/api/admin/circles/${circleId}/members/${alex.user.id}/admin`, {
        token: "b".repeat(32),
        forwarded: "203.0.113.32",
        body: { admin: true },
      });
      assert.equal(badToken.status, 404);
      assert.deepEqual(badToken.json, { error: "not found" });
      assert.equal(flag(alex.user.id), 0);

      assert.ok(logs.some((line) => line.startsWith("admin member admin ok ")));
      assert.equal(logs.some((line) => line.includes(ADMIN)), false);
    }, { env: { ADMIN_TOKEN: ADMIN } });
  } finally {
    console.log = original;
  }
});

async function seedCircle(port: number, db: DatabaseSync) {
  const alex = await api(port, "POST", "/api/auth/start", { body: { email: testEmail(), name: "Alex" }, status: 201 });
  const friends = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Friends" }, status: 201 });
  const bea = await api(port, "POST", "/api/auth/start", {
    body: { email: testEmail(), name: "Bea", code: friends.circle.inviteCode },
    status: 201,
  });
  await api(port, "POST", "/api/push/subscribe", {
    token: bea.token,
    body: { endpoint: "https://push.example/bea", keys: { p256dh: "p", auth: "a" } },
    status: 204,
  });
  const cam = await api(port, "POST", "/api/auth/start", {
    body: { email: testEmail(), name: "Cam", code: friends.circle.inviteCode },
    status: 201,
  });
  const nia = await api(port, "POST", "/api/auth/start", {
    body: { email: testEmail(), name: "Nia", code: friends.circle.inviteCode },
    status: 201,
  });

  const old = await api(port, "POST", "/api/socials", { token: alex.token, body: { note: "Old" }, status: 201 });
  await api(port, "POST", `/api/socials/${old.social.id}/chat`, { token: alex.token, body: { text: "earlier" }, status: 201 });
  await api(port, "DELETE", `/api/socials/${old.social.id}`, { token: alex.token, status: 204 });
  await api(port, "POST", "/api/socials", {
    token: cam.token,
    body: { note: "Later", startsAt: "18:00" },
    status: 201,
  });
  const coffee = await api(port, "POST", "/api/socials", { token: bea.token, body: { note: "Coffee" }, status: 201 });
  const dinner = await api(port, "POST", "/api/plans", { token: alex.token, body: { note: "Dinner" }, status: 201 });
  const hike = await api(port, "POST", "/api/plans", { token: bea.token, body: { note: "Hike" }, status: 201 });
  await api(port, "DELETE", `/api/plans/${hike.plan.id}`, { token: bea.token, status: 204 });
  db.prepare("UPDATE plans SET for_date = ? WHERE id = ?").run("2026-05-01", hike.plan.id);

  db.prepare(
    `INSERT INTO social_joins (social_id, user_id, joined_at, reply, eta_min, arrive_at, blocked, removed_by)
     VALUES (?, ?, ?, 'coming', NULL, ?, 0, NULL)`,
  ).run(coffee.social.id, cam.user.id, START, START + 20 * 60 * 1000);
  db.prepare(
    `INSERT INTO social_joins (social_id, user_id, joined_at, reply, eta_min, arrive_at, blocked, removed_by)
     VALUES (?, ?, ?, 'removed', NULL, NULL, 1, 'Alex')`,
  ).run(coffee.social.id, alex.user.id, START);
  db.prepare(
    `INSERT INTO plan_joins (plan_id, user_id, joined_at, reply, arrive_at, blocked, removed_by)
     VALUES (?, ?, ?, 'coming', ?, 0, NULL)`,
  ).run(dinner.plan.id, bea.user.id, START, START + 60 * 60 * 1000);
  db.prepare(
    `INSERT INTO plan_joins (plan_id, user_id, joined_at, reply, arrive_at, blocked, removed_by)
     VALUES (?, ?, ?, 'removed', NULL, 1, 'Alex')`,
  ).run(dinner.plan.id, cam.user.id, START);

  await api(port, "POST", "/api/circles/chat", { token: bea.token, body: { text: "hello" }, status: 201 });
  const thread = await api(port, "GET", "/api/circles/chat", { token: alex.token });
  await api(port, "POST", `/api/chats/${thread.chat.id}/mute`, { token: alex.token, body: { muted: true }, status: 204 });
  await api(port, "POST", `/api/socials/${coffee.social.id}/chat`, { token: bea.token, body: { text: "downstairs" }, status: 201 });
  await api(port, "POST", `/api/plans/${dinner.plan.id}/chat`, { token: alex.token, body: { text: "tomorrow" }, status: 201 });
  await api(port, "DELETE", `/api/circles/members/${nia.user.id}`, { token: alex.token, status: 204 });

  const uni = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Uni" }, status: 201 });
  const sam = await api(port, "POST", "/api/auth/start", {
    body: { email: testEmail(), name: "Sam", code: uni.circle.inviteCode },
    status: 201,
  });
  await api(port, "POST", "/api/socials", { token: sam.token, body: { note: "Seminar" }, status: 201 });
  return { alex, bea, cam, nia, sam, friends, uni };
}

function belong(db: DatabaseSync, circleId: string): Record<string, number> {
  const inChats = "chat_id IN (SELECT id FROM chats WHERE circle_id = ?)";
  const inSocials = "social_id IN (SELECT id FROM socials WHERE circle_id = ?)";
  const inPlans = "plan_id IN (SELECT id FROM plans WHERE circle_id = ?)";
  return {
    messages: count(db, `SELECT COUNT(*) AS n FROM messages WHERE ${inChats}`, circleId),
    chat_reads: count(db, `SELECT COUNT(*) AS n FROM chat_reads WHERE ${inChats}`, circleId),
    chat_mutes: count(db, `SELECT COUNT(*) AS n FROM chat_mutes WHERE ${inChats}`, circleId),
    chats: count(db, "SELECT COUNT(*) AS n FROM chats WHERE circle_id = ?", circleId),
    social_joins: count(db, `SELECT COUNT(*) AS n FROM social_joins WHERE ${inSocials}`, circleId),
    socials: count(db, "SELECT COUNT(*) AS n FROM socials WHERE circle_id = ?", circleId),
    plan_joins: count(db, `SELECT COUNT(*) AS n FROM plan_joins WHERE ${inPlans}`, circleId),
    plan_circles: count(db, `SELECT COUNT(*) AS n FROM plan_circles WHERE circle_id = ? OR ${inPlans}`, circleId, circleId),
    plans: count(db, "SELECT COUNT(*) AS n FROM plans WHERE circle_id = ?", circleId),
    memberships: count(db, "SELECT COUNT(*) AS n FROM memberships WHERE circle_id = ?", circleId),
    circle_removals: count(db, "SELECT COUNT(*) AS n FROM circle_removals WHERE circle_id = ?", circleId),
    notifications: count(db, "SELECT COUNT(*) AS n FROM notifications WHERE circle_id = ?", circleId),
    push_deliveries: count(db, "SELECT COUNT(*) AS n FROM push_deliveries WHERE circle_id = ?", circleId),
    circles: count(db, "SELECT COUNT(*) AS n FROM circles WHERE id = ?", circleId),
  };
}

function circleIdTables(db: DatabaseSync): string[] {
  const names = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  ).all() as Array<{ name: string }>;
  return names
    .map((row) => row.name)
    .filter((name) => /^[a-z_]+$/.test(name))
    .filter((name) => {
      const cols = db.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>;
      return cols.some((col) => col.name === "circle_id");
    })
    .sort();
}

function count(db: DatabaseSync, sql: string, ...params: Array<string | number>): number {
  const row = db.prepare(sql).get(...params) as { n: number | bigint };
  return Number(row.n);
}

async function hit(
  port: number,
  method: string,
  pathname: string,
  options: { token?: string; body?: unknown; forwarded: string },
): Promise<{ status: number; json: any }> {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: {
      "x-forwarded-for": options.forwarded,
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}
