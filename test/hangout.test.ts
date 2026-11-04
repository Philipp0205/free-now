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
import { addMember, insertCircle, insertSocial, insertUser, openDb, setSocialReply } from "../src/db.js";
import type { PushSender } from "../src/push.js";
import { sendStartReminders } from "../src/remind.js";
import { START, api, withApp } from "./http.js";

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
    await api(port, "GET", `/api/invites/${renewed.circle.inviteCode}`, { status: 410 });
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
    assert.equal(sent.at(-1)?.title, "Reply");
    assert.equal(sent.at(-1)?.body, "Veit is there in 10 min");

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
    assert.equal(sent[0].body, "Philipp is free from 18:00 – meet at Café X – Dinner");
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
    assert.equal(reminder?.body, "Starting now: Philipp at Café X");
    assert.equal(reminder?.url, `/?social=${social.social.id}`);
    assert.equal(sent.filter((payload) => payload.body === reminder?.body).length, 1);

    await api(port, "POST", "/api/socials", {
      token: philipp.token,
      body: { note: "Too late", startsAt: "10:00" },
      status: 400,
    });
    await api(port, "POST", "/api/socials", {
      token: philipp.token,
      body: { later: true },
      status: 400,
    });
    await api(port, "POST", "/api/socials", {
      token: philipp.token,
      body: { later: true, startsAt: null },
      status: 400,
    });
  }, { tz: "UTC" });
});

test("a start reminder is due once, and skips closed, later, and unscheduled socials", async () => {
  const db = openDb(":memory:");
  const now = 1_700_000_000_000;
  try {
    insertUser(db, { id: "host", name: "Philipp", token_hash: "h", buzz_token: "b", created_at: now });
    insertUser(db, { id: "alex", name: "Alex", token_hash: "h2", buzz_token: "b2", created_at: now });
    insertCircle(db, {
      id: "c",
      name: "friends",
      invite_code: "ABCD2345",
      created_by: "host",
      created_at: now,
    }, "host", now);
    addMember(db, "c", "alex", now);

    insertSocial(db, {
      id: "due",
      circleId: "c",
      creatorId: "host",
      note: "Dinner",
      createdAt: now - 60_000,
      expiresAt: now + 60_000,
      lat: null,
      lng: null,
      place: "Café X",
      startsAt: now,
    });
    setSocialReply(db, "due", "alex", now, "coming", 10, null);

    insertSocial(db, {
      id: "quiet",
      circleId: "c",
      creatorId: "host",
      note: "No one",
      createdAt: now - 60_000,
      expiresAt: now + 60_000,
      lat: null,
      lng: null,
      place: "Park",
      startsAt: now - 1,
    });

    insertSocial(db, {
      id: "later",
      circleId: "c",
      creatorId: "host",
      note: "Later",
      createdAt: now,
      expiresAt: now + 120_000,
      lat: null,
      lng: null,
      startsAt: now + 1,
    });
    setSocialReply(db, "later", "alex", now, "coming", null, null);

    insertSocial(db, {
      id: "closed",
      circleId: "c",
      creatorId: "host",
      note: "Over",
      createdAt: now - 120_000,
      expiresAt: now,
      lat: null,
      lng: null,
      startsAt: now - 10,
    });
    setSocialReply(db, "closed", "alex", now, "coming", null, null);

    insertSocial(db, {
      id: "plain",
      circleId: "c",
      creatorId: "host",
      note: "Now",
      createdAt: now,
      expiresAt: now + 60_000,
      lat: null,
      lng: null,
    });
    setSocialReply(db, "plain", "alex", now, "coming", null, null);

    insertSocial(db, {
      id: "done",
      circleId: "c",
      creatorId: "host",
      note: "Already",
      createdAt: now - 60_000,
      expiresAt: now + 60_000,
      lat: null,
      lng: null,
      startsAt: now - 5,
    });
    db.prepare("UPDATE socials SET reminded_at = ? WHERE id = ?").run(now - 5, "done");
    setSocialReply(db, "done", "alex", now, "coming", null, null);

    const push: PushSender = { async send() {} };
    assert.equal(await sendStartReminders(db, push, now), 2);

    const reminded = db.prepare("SELECT id, reminded_at FROM socials").all() as Array<{ id: string; reminded_at: number | null }>;
    const at = Object.fromEntries(reminded.map((row) => [row.id, row.reminded_at]));
    assert.equal(at.due, now);
    assert.equal(at.quiet, now);
    assert.equal(at.later, null);
    assert.equal(at.closed, null);
    assert.equal(at.plain, null);
    assert.equal(at.done, now - 5);

    const notes = db.prepare("SELECT user_id, title, body, kind, ref_id FROM notifications").all() as Array<{
      user_id: string;
      title: string;
      body: string;
      kind: string;
      ref_id: string | null;
    }>;
    assert.equal(notes.length, 1);
    assert.equal(notes[0].user_id, "alex");
    assert.equal(notes[0].title, "Free now");
    assert.equal(notes[0].body, "Starting now: Philipp at Café X");
    assert.equal(notes[0].kind, "social-start");
    assert.equal(notes[0].ref_id, "due");

    assert.equal(await sendStartReminders(db, push, now), 0);
    const again = db.prepare("SELECT reminded_at FROM socials WHERE id = ?").get("due") as { reminded_at: number };
    assert.equal(again.reminded_at, now);
  } finally {
    db.close();
  }
});

test("a start-time change notifies immediately, and a quick ETA does not send a second push", async () => {
  await withApp(async ({ port, sent }) => {
    const dana = await api(port, "POST", "/api/auth/start", { body: { name: "Dana" }, status: 201 });
    const created = await api(port, "POST", "/api/circles", { token: dana.token, body: { name: "friends" }, status: 201 });
    const philipp = await api(port, "POST", "/api/auth/start", {
      body: { name: "Philipp", code: created.circle.inviteCode },
      status: 201,
    });
    await api(port, "POST", "/api/push/subscribe", {
      token: philipp.token,
      body: { endpoint: "https://push.example/philipp", keys: { p256dh: "p", auth: "a" } },
      status: 204,
    });
    await api(port, "POST", "/api/push/subscribe", {
      token: dana.token,
      body: { endpoint: "https://push.example/dana", keys: { p256dh: "p", auth: "a" } },
      status: 204,
    });
    const social = await api(port, "POST", "/api/socials", {
      token: philipp.token,
      body: { note: "Coffee" },
      status: 201,
    });
    const before = sent.length;
    const shifted = await api(port, "POST", "/api/socials", {
      token: philipp.token,
      body: { startsAt: "23:30" },
      status: 200,
    });
    assert.ok(shifted.social.startsAt > START);
    assert.equal(sent.length, before + 1);
    assert.equal(sent.at(-1)?.body, "Philipp is now free from 23:30");

    const quiet = sent.length;
    await api(port, "POST", `/api/socials/${social.social.id}/reply`, {
      token: dana.token,
      body: { reply: "coming" },
      status: 200,
    });
    assert.equal(sent.length, quiet);
    await api(port, "POST", `/api/socials/${social.social.id}/reply`, {
      token: dana.token,
      body: { reply: "coming", eta: 10 },
      status: 200,
    });
    assert.equal(sent.length, quiet + 1);
    assert.equal(sent.at(-1)?.body, "Dana is in");

    await api(port, "POST", `/api/socials/${social.social.id}/reply`, {
      token: dana.token,
      body: { reply: "coming", eta: 20 },
      status: 200,
    });
    assert.equal(sent.length, quiet + 1);
  }, { tz: "UTC" });
});

test("a circle with no invite expiry needs a new link", async () => {
  await withApp(async ({ port, db }) => {
    const alex = await api(port, "POST", "/api/auth/start", { body: { name: "Alex" }, status: 201 });
    const created = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "old" }, status: 201 });
    db.prepare("UPDATE circles SET invite_expires_at = NULL").run();
    await api(port, "GET", `/api/invites/${created.circle.inviteCode}`, { status: 404 });
  });
});

test("opening an older database backfills invite expiry from created_at", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hangry-"));
  const file = path.join(dir, "old.sqlite");
  const raw = new DatabaseSync(file);
  raw.exec(`
    CREATE TABLE circles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      invite_code TEXT NOT NULL UNIQUE,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  raw.prepare("INSERT INTO circles (id, name, invite_code, created_by, created_at) VALUES (?, ?, ?, ?, ?)").run(
    "c1",
    "old",
    "OLDCODE",
    "u1",
    1_000,
  );
  raw.close();
  const db = openDb(file);
  try {
    const row = db.prepare("SELECT invite_expires_at FROM circles WHERE id = ?").get("c1") as { invite_expires_at: number };
    assert.equal(row.invite_expires_at, 1_000 + 14 * 24 * 60 * 60 * 1000);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a picked arrival time is stored and each change pushes once", async () => {
  await withApp(async ({ port, sent, at }) => {
    const alex = await api(port, "POST", "/api/auth/start", { body: { name: "Alex" }, status: 201 });
    const created = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "friends" }, status: 201 });
    const veit = await api(port, "POST", "/api/auth/start", {
      body: { name: "Fritz", code: created.circle.inviteCode },
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
    const tapped = await api(port, "POST", `/api/socials/${social.social.id}/reply`, {
      token: veit.token,
      body: { reply: "in" },
      status: 200,
    });
    assert.equal(tapped.social.joined[0].arriveAt, null);
    const picked = await api(port, "POST", `/api/socials/${social.social.id}/reply`, {
      token: veit.token,
      body: { reply: "in", arriveAt: "16:00" },
      status: 200,
    });
    assert.equal(picked.social.joined[0].etaMin, null);
    assert.equal(sent.at(-1)?.body, "Fritz is in, arriving 16:00");
    const before = sent.length;
    await api(port, "POST", `/api/socials/${social.social.id}/reply`, {
      token: veit.token,
      body: { reply: "in", arriveAt: "16:20" },
      status: 200,
    });
    assert.equal(sent.length, before + 1);
    assert.equal(sent.at(-1)?.body, "Fritz is in, arriving 16:20");
    await api(port, "POST", `/api/socials/${social.social.id}/reply`, {
      token: veit.token,
      body: { reply: "in", arriveAt: "14:00" },
      status: 400,
    });
    await api(port, "POST", `/api/socials/${social.social.id}/reply`, {
      token: veit.token,
      body: { reply: "in", arriveAt: "18:00" },
      status: 400,
    });

    const later = await api(port, "POST", "/api/socials", {
      token: alex.token,
      body: { note: "Dinner", startsAt: "18:00" },
      status: 200,
    });
    await api(port, "POST", `/api/socials/${later.social.id}/reply`, {
      token: veit.token,
      body: { reply: "in", arriveAt: "17:30" },
      status: 400,
    });
    const dinner = await api(port, "POST", `/api/socials/${later.social.id}/reply`, {
      token: veit.token,
      body: { reply: "in", arriveAt: "19:40" },
      status: 200,
    });
    assert.equal(dinner.social.joined[0].arriveAt, Date.parse("2026-06-01T19:40:00.000Z"));
    assert.equal(sent.at(-1)?.body, "Fritz is in, arriving 19:40");

    const plan = await api(port, "POST", "/api/plans", {
      token: alex.token,
      body: { note: "Bouldering" },
      status: 201,
    });
    await api(port, "POST", `/api/plans/${plan.plan.id}/reply`, {
      token: veit.token,
      body: { reply: "in", arriveAt: "18:00" },
      status: 200,
    });
    assert.equal(sent.at(-1)?.body, "Fritz is in, arriving 18:00");
    assert.equal(sent.at(-1)?.url, `/?plan=${plan.plan.id}`);
    const impossible = await api(port, "POST", `/api/plans/${plan.plan.id}/reply`, {
      token: veit.token,
      body: { reply: "in", arriveAt: "25:00" },
      status: 400,
    });
    assert.equal(impossible.error, "Pick a time you can arrive.");
    const earlyMorning = await api(port, "POST", `/api/plans/${plan.plan.id}/reply`, {
      token: veit.token,
      body: { reply: "in", arriveAt: "05:00" },
      status: 400,
    });
    assert.equal(earlyMorning.error, "Pick a time you can arrive.");
    at(Date.parse("2026-06-02T19:00:00.000Z"));
    await api(port, "POST", `/api/plans/${plan.plan.id}/reply`, {
      token: veit.token,
      body: { reply: "in", arriveAt: "18:00" },
      status: 400,
    });
    const shifted = await api(port, "POST", `/api/plans/${plan.plan.id}/reply`, {
      token: veit.token,
      body: { reply: "in", arriveAt: "19:40" },
      status: 200,
    });
    assert.equal(shifted.plan.joined[0].arriveAt, Date.parse("2026-06-02T19:40:00.000Z"));
    assert.equal(sent.at(-1)?.body, "Fritz is in, arriving 19:40");
  });
});

test("any minute from the start through the window is a valid arrival, including 19:06", async () => {
  await withApp(async ({ port }) => {
    const alex = await api(port, "POST", "/api/auth/start", { body: { name: "Alex" }, status: 201 });
    const created = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "friends" }, status: 201 });
    const sam = await api(port, "POST", "/api/auth/start", {
      body: { name: "Sam", code: created.circle.inviteCode },
      status: 201,
    });
    const later = await api(port, "POST", "/api/socials", {
      token: alex.token,
      body: { note: "Dinner", startsAt: "19:06" },
      status: 201,
    });
    assert.equal(later.social.creator.name, "Alex");
    assert.equal(later.social.startsAt, Date.parse("2026-06-01T19:06:00.000Z"));
    const atStart = await api(port, "POST", `/api/socials/${later.social.id}/reply`, {
      token: sam.token,
      body: { reply: "in", arriveAt: "19:06" },
      status: 200,
    });
    assert.equal(atStart.social.joined[0].arriveAt, Date.parse("2026-06-01T19:06:00.000Z"));
    const nextMinute = await api(port, "POST", `/api/socials/${later.social.id}/reply`, {
      token: sam.token,
      body: { reply: "in", arriveAt: "19:07" },
      status: 200,
    });
    assert.equal(nextMinute.social.joined[0].arriveAt, Date.parse("2026-06-01T19:07:00.000Z"));
    await api(port, "POST", `/api/socials/${later.social.id}/reply`, {
      token: sam.token,
      body: { reply: "in", arriveAt: "19:05" },
      status: 400,
    });
    const atEnd = await api(port, "POST", `/api/socials/${later.social.id}/reply`, {
      token: sam.token,
      body: { reply: "in", arriveAt: "21:06" },
      status: 200,
    });
    assert.equal(atEnd.social.joined[0].arriveAt, Date.parse("2026-06-01T21:06:00.000Z"));
    await api(port, "POST", `/api/socials/${later.social.id}/reply`, {
      token: sam.token,
      body: { reply: "in", arriveAt: "21:07" },
      status: 400,
    });

    const live = await api(port, "POST", "/api/socials", {
      token: sam.token,
      body: { note: "Coffee" },
      status: 201,
    });
    const nowMinute = await api(port, "POST", `/api/socials/${live.social.id}/reply`, {
      token: alex.token,
      body: { reply: "in", arriveAt: "15:00" },
      status: 200,
    });
    assert.equal(nowMinute.social.joined[0].arriveAt, Date.parse("2026-06-01T15:00:00.000Z"));

    const plan = await api(port, "POST", "/api/plans", {
      token: alex.token,
      body: { note: "Tomorrow dinner" },
      status: 201,
    });
    const planMinute = await api(port, "POST", `/api/plans/${plan.plan.id}/reply`, {
      token: sam.token,
      body: { reply: "in", arriveAt: "19:06" },
      status: 200,
    });
    assert.equal(planMinute.plan.joined[0].arriveAt, Date.parse("2026-06-02T19:06:00.000Z"));
    await api(port, "POST", `/api/plans/${plan.plan.id}/reply`, {
      token: sam.token,
      body: { reply: "in", arriveAt: "23:59" },
      status: 200,
    });
  });
});

test("a member cannot rename the circle or the name others see", async () => {
  await withApp(async ({ port, db }) => {
    const alex = await api(port, "POST", "/api/auth/start", { body: { name: "Amanda" }, status: 201 });
    const created = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "friends" }, status: 201 });
    assert.equal(created.circle.youAreAdmin, true);
    const sam = await api(port, "POST", "/api/auth/start", {
      body: { name: "Sam", code: created.circle.inviteCode },
      status: 201,
    });
    assert.equal(sam.circle.youAreAdmin, false);
    const posted = await api(port, "POST", "/api/socials", {
      token: alex.token,
      body: { note: "Dinner", startsAt: "19:06" },
      status: 201,
    });
    const renamedSelf = await api(port, "PATCH", "/api/me", {
      token: sam.token,
      body: { name: "Sam" },
      status: 200,
    });
    assert.equal(renamedSelf.user.name, "Sam");
    const circleDenied = await api(port, "PATCH", "/api/circles", {
      token: sam.token,
      body: { name: "Amanda's +1" },
      status: 403,
    });
    assert.equal(circleDenied.error, "Only an admin can do that.");
    const seen = await api(port, "GET", "/api/socials", { token: sam.token });
    assert.equal(seen.socials[0].creator.name, "Amanda");
    assert.equal(seen.socials[0].id, posted.social.id);
    const still = await api(port, "GET", "/api/me", { token: sam.token });
    assert.equal(still.user.name, "Sam");
    assert.equal(still.circle.name, "friends");

    const renamed = await api(port, "PATCH", "/api/me", {
      token: alex.token,
      body: { name: "Amanda" },
      status: 200,
    });
    assert.equal(renamed.user.name, "Amanda");
    const circle = await api(port, "PATCH", "/api/circles", {
      token: alex.token,
      body: { name: "Roof" },
      status: 200,
    });
    assert.equal(circle.circle.name, "Roof");

    db.prepare("UPDATE memberships SET is_admin = 1 WHERE user_id = ?").run(sam.user.id);
    db.prepare("UPDATE memberships SET is_admin = 0 WHERE user_id = ?").run(alex.user.id);
    const adminCircle = await api(port, "PATCH", "/api/circles", {
      token: sam.token,
      body: { name: "Yard" },
      status: 200,
    });
    assert.equal(adminCircle.circle.name, "Yard");
    await api(port, "PATCH", "/api/circles", {
      token: alex.token,
      body: { name: "Nope" },
      status: 403,
    });
    const cards = await api(port, "GET", "/api/socials", { token: sam.token });
    assert.equal(cards.socials[0].creator.name, "Amanda");
  });
});

test("the old Railway host redirects to the configured public origin", async () => {
  const db = openDb(":memory:");
  const config = loadConfig({ PORT: "3000", DB_PATH: ":memory:", PUBLIC_BASE_URL: "https://hangry.example" });
  const server = http.createServer(createApp({
    db,
    push: { async send() { /* unused */ } },
    config: { ...config, dbPath: ":memory:" },
    now: () => Date.now(),
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  try {
    const redirected = await new Promise<{ status: number; location: string | undefined }>((resolve, reject) => {
      const request = http.request({
        hostname: "127.0.0.1",
        port,
        path: "/join/ABC?x=1",
        headers: { host: "hangry-production-64c4.up.railway.app" },
      }, (response) => {
        response.resume();
        resolve({ status: response.statusCode ?? 0, location: response.headers.location });
      });
      request.on("error", reject);
      request.end();
    });
    assert.equal(redirected.status, 301);
    assert.equal(redirected.location, "https://hangry.example/join/ABC?x=1");
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});

test("Berlin midnight puts a plan on tomorrow and keeps a later-today start on today", async () => {
  await withApp(async ({ port, at }) => {
    const alex = await api(port, "POST", "/api/auth/start", { body: { name: "Alex" }, status: 201 });
    await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "friends" }, status: 201 });
    // 23:50 Europe/Berlin (CEST, UTC+2). Local midnight is 22:00Z.
    const beforeMidnight = Date.parse("2026-06-01T21:50:00.000Z");
    at(beforeMidnight);

    const plan = await api(port, "POST", "/api/plans", {
      token: alex.token,
      body: { note: "Late walk" },
      status: 201,
    });
    assert.equal(plan.plan.forDate, "2026-06-02");
    assert.equal(plan.plan.whenLabel, "Tomorrow");
    const listedPlan = await api(port, "GET", "/api/plans", { token: alex.token });
    assert.equal(listedPlan.plans.length, 1);
    assert.equal(listedPlan.plans[0].forDate, "2026-06-02");
    assert.equal(listedPlan.plans[0].whenLabel, "Tomorrow");

    const tonight = await api(port, "POST", "/api/socials", {
      token: alex.token,
      body: { note: "Still out", startsAt: "23:55" },
      status: 201,
    });
    assert.equal(tonight.social.startsAt, Date.parse("2026-06-01T21:55:00.000Z"));

    const pastMidnight = await api(port, "POST", "/api/socials", {
      token: alex.token,
      body: { note: "After midnight", startsAt: "00:10" },
      status: 400,
    });
    assert.equal(pastMidnight.error, "Pick a time later today.");
    const nextDay = await api(port, "POST", "/api/socials", {
      token: alex.token,
      body: { startsAt: Date.parse("2026-06-01T22:10:00.000Z") },
      status: 400,
    });
    assert.equal(nextDay.error, "Pick a time later today.");

    const listed = await api(port, "GET", "/api/socials", { token: alex.token });
    assert.equal(listed.socials.length, 1);
    assert.equal(listed.socials[0].note, "Still out");
    assert.equal(listed.socials[0].startsAt, Date.parse("2026-06-01T21:55:00.000Z"));

    at(Date.parse("2026-06-02T21:59:00.000Z"));
    const today = await api(port, "GET", "/api/plans", { token: alex.token });
    assert.equal(today.plans.length, 1);
    assert.equal(today.plans[0].whenLabel, "Today");

    at(Date.parse("2026-06-02T22:00:00.000Z"));
    const gone = await api(port, "GET", "/api/plans", { token: alex.token });
    assert.deepEqual(gone.plans, []);
  }, { tz: "Europe/Berlin" });
});

test("Berlin late night still accepts only a later clock on the same day", async () => {
  await withApp(async ({ port, at }) => {
    const alex = await api(port, "POST", "/api/auth/start", { body: { name: "Alex" }, status: 201 });
    await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "friends" }, status: 201 });

    // 23:15 CET. The half-hour default is still today.
    at(Date.parse("2026-11-04T22:15:00.000Z"));
    const half = await api(port, "POST", "/api/socials", {
      token: alex.token,
      body: { note: "Half", startsAt: "23:30" },
      status: 201,
    });
    assert.equal(half.social.startsAt, Date.parse("2026-11-04T22:30:00.000Z"));

    // 23:16 CET. 23:59 is still today. The next-day clock the picker falls back to is not.
    at(Date.parse("2026-11-04T22:16:00.000Z"));
    const capped = await api(port, "POST", "/api/socials", {
      token: alex.token,
      body: { note: "Capped", startsAt: "23:59" },
      status: 200,
    });
    assert.equal(capped.social.startsAt, Date.parse("2026-11-04T22:59:00.000Z"));
    const earlyTomorrow = await api(port, "POST", "/api/socials", {
      token: alex.token,
      body: { startsAt: "00:30" },
      status: 400,
    });
    assert.equal(earlyTomorrow.error, "Pick a time later today.");

    // 23:59 CET. 23:59 is no longer later, and 00:30 is tomorrow.
    at(Date.parse("2026-11-04T22:59:00.000Z"));
    const tooLate = await api(port, "POST", "/api/socials", {
      token: alex.token,
      body: { startsAt: "23:59" },
      status: 400,
    });
    assert.equal(tooLate.error, "Pick a time later today.");
    const namedTomorrow = await api(port, "POST", "/api/socials", {
      token: alex.token,
      body: { startsAt: "00:30" },
      status: 400,
    });
    assert.equal(namedTomorrow.error, "Pick a time later today.");

    // 00:00 CET is a new day, so 00:30 is later today again.
    at(Date.parse("2026-11-04T23:00:00.000Z"));
    const midnight = await api(port, "POST", "/api/socials", {
      token: alex.token,
      body: { note: "Midnight", startsAt: "00:30" },
      status: 200,
    });
    assert.equal(midnight.social.startsAt, Date.parse("2026-11-04T23:30:00.000Z"));
  }, { tz: "Europe/Berlin" });
});
