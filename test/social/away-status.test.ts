import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "../../src/db.js";
import { activeStatus, readStatusBody, StatusError, STATUS_TZ } from "../../src/social/status.js";
import { endOfDay } from "../../src/lib/time.js";
import { api, withApp, testEmail } from "../http.js";

type Person = { token: string; user: { id: string; name: string } };

const NOV_9_NOON_BERLIN = Date.parse("2026-11-09T11:00:00Z");

/** Friends: Phil, Bea. Climbing: Bea, Cam. Sam is on his own. */
async function seed(port: number) {
  const start = (name: string, code?: string): Promise<Person> =>
    api(port, "POST", "/api/auth/start", { body: code ? { name, email: testEmail(), code } : { name, email: testEmail() }, status: 201 });
  const phil = await start("Phil");
  const friends = (await api(port, "POST", "/api/circles", { token: phil.token, body: { name: "Friends" }, status: 201 })).circle;
  const bea = await start("Bea", friends.inviteCode);
  const climbing = (await api(port, "POST", "/api/circles", { token: bea.token, body: { name: "Climbing" }, status: 201 })).circle;
  const cam = await start("Cam", climbing.inviteCode);
  const sam = await start("Sam");
  await api(port, "POST", "/api/circles", { token: sam.token, body: { name: "Solo" }, status: 201 });
  return { phil, bea, cam, sam, friends, climbing };
}

const away = { type: "away", text: "🎾 Tennis vacation in Portugal", place: "Portugal", untilDay: "2026-11-13" };

test("end of day is the last ms of the Berlin calendar day, across DST", () => {
  // Winter, UTC+1: 13 Nov ends at 22:59:59.999Z.
  assert.equal(endOfDay("2026-11-13", "Europe/Berlin"), Date.parse("2026-11-13T22:59:59.999Z"));
  // Summer, UTC+2.
  assert.equal(endOfDay("2026-07-01", "Europe/Berlin"), Date.parse("2026-07-01T21:59:59.999Z"));
  // The spring-forward day (29 Mar 2026) is 23 hours, and its end is still the next local midnight.
  assert.equal(endOfDay("2026-03-29", "Europe/Berlin"), Date.parse("2026-03-29T21:59:59.999Z"));
  // The fall-back day (25 Oct 2026) is 25 hours.
  assert.equal(endOfDay("2026-10-25", "Europe/Berlin"), Date.parse("2026-10-25T22:59:59.999Z"));
  assert.equal(endOfDay("2026-12-31", "UTC"), Date.parse("2026-12-31T23:59:59.999Z"));
  assert.equal(STATUS_TZ, "Europe/Berlin");
});

test("validation: type allowlist, length caps, blank text is null, past days are refused", () => {
  const now = NOV_9_NOON_BERLIN;
  const bad = (body: Record<string, unknown>, pattern: RegExp) =>
    assert.throws(() => readStatusBody(body, now), (error: unknown) => error instanceof StatusError && pattern.test(error.message));
  bad({}, /Away or Busy/);
  bad({ type: "vacation" }, /Away or Busy/);
  bad({ type: "AWAY" }, /Away or Busy/);
  bad({ type: "away", text: "x".repeat(61) }, /at most 60/);
  bad({ type: "away", place: "y".repeat(41) }, /at most 40/);
  bad({ type: "away", text: 7 }, /must be text/);
  bad({ type: "away", untilDay: "2026-11-08" }, /passed/);
  bad({ type: "away", untilDay: "2026-02-30" }, /valid end day/);
  bad({ type: "away", untilDay: "13.11.2026" }, /valid end day/);
  bad({ type: "away", untilDay: 20261113 }, /valid end day/);

  const ok = readStatusBody({ type: "busy", text: "   ", place: "\n", untilDay: null }, now);
  assert.deepEqual(ok, { status_type: "busy", status_text: null, status_place: null, status_until: null });
  // Exactly 60 code points with an emoji fits.
  const sixty = `🎾${"a".repeat(59)}`;
  assert.equal(readStatusBody({ type: "away", text: sixty }, now).status_text, sixty);
  // Today in Berlin is fine, even when it is still yesterday in UTC terms elsewhere.
  const lateNight = Date.parse("2026-11-09T23:30:00Z"); // 00:30 on 10 Nov in Berlin.
  assert.throws(() => readStatusBody({ type: "away", untilDay: "2026-11-09" }, lateNight), /passed/);
  assert.equal(readStatusBody({ type: "away", untilDay: "2026-11-10" }, lateNight).status_until, Date.parse("2026-11-10T22:59:59.999Z"));
  assert.equal(readStatusBody({ type: "away", untilDay: "2026-11-09" }, now).status_until, Date.parse("2026-11-09T22:59:59.999Z"));
});

test("activeStatus hides an unknown type and anything past its end", () => {
  const row = { status_type: "away", status_text: "Trip", status_place: null, status_until: 1000 };
  assert.deepEqual(activeStatus(row, 1000), { type: "away", text: "Trip", place: null, until: 1000 });
  assert.equal(activeStatus(row, 1001), null);
  assert.equal(activeStatus({ ...row, status_type: "gone" }, 0), null);
  assert.equal(activeStatus({ ...row, status_type: null }, 0), null);
  assert.deepEqual(activeStatus({ ...row, status_until: null }, 9e15)?.type, "away");
  assert.equal(activeStatus(undefined, 0), null);
});

test("set, read and clear a status through /api/me/status", async () => {
  await withApp(async (ctx) => {
    ctx.at(NOV_9_NOON_BERLIN);
    const { port } = ctx;
    const { phil } = await seed(port);
    assert.equal((await api(port, "GET", "/api/me", { token: phil.token })).user.status, null);

    const set = await api(port, "PUT", "/api/me/status", { token: phil.token, body: away, status: 200 });
    const until = Date.parse("2026-11-13T22:59:59.999Z");
    const expected = { type: "away", text: "🎾 Tennis vacation in Portugal", place: "Portugal", until };
    assert.deepEqual(set.user.status, expected);
    assert.deepEqual(set.circle.members.find((m: { id: string }) => m.id === phil.user.id).status, expected);
    assert.deepEqual((await api(port, "GET", "/api/me/status", { token: phil.token, status: 200 })).status, expected);
    const row = ctx.db.prepare("SELECT status_type, status_text, status_place, status_until FROM users WHERE id = ?").get(phil.user.id);
    assert.deepEqual({ ...row }, { status_type: "away", status_text: expected.text, status_place: "Portugal", status_until: until });

    // PATCH works the same and replaces every field.
    const busy = await api(port, "PATCH", "/api/me/status", { token: phil.token, body: { type: "busy" }, status: 200 });
    assert.deepEqual(busy.user.status, { type: "busy", text: null, place: null, until: null });

    const cleared = await api(port, "DELETE", "/api/me/status", { token: phil.token, status: 200 });
    assert.equal(cleared.user.status, null);
    assert.equal(cleared.circle.members.find((m: { id: string }) => m.id === phil.user.id).status, null);
    const empty = ctx.db.prepare("SELECT status_type, status_text, status_place, status_until FROM users WHERE id = ?").get(phil.user.id);
    assert.deepEqual({ ...empty }, { status_type: null, status_text: null, status_place: null, status_until: null });

    for (const body of [{ type: "nope" }, { type: "away", text: "x".repeat(61) }, { type: "away", place: "p".repeat(41) }, { type: "away", untilDay: "2026-11-08" }]) {
      const bad = await api(port, "PUT", "/api/me/status", { token: phil.token, body, status: 400 });
      assert.ok(typeof bad.error === "string" && bad.error.length > 0);
    }
    assert.equal((await api(port, "GET", "/api/me", { token: phil.token })).user.status, null, "a refused write changes nothing");
    await api(port, "PUT", "/api/me/status", { body: away, status: 401 });
    await api(port, "DELETE", "/api/me/status", { status: 401 });
    await api(port, "GET", "/api/me/status", { status: 401 });
    await api(port, "POST", "/api/me/status", { token: phil.token, body: away, status: 405 });
  }, { tz: "Europe/Berlin" });
});

test("a status ends after the Berlin end day and is cleared from the row on the next own read", async () => {
  await withApp(async (ctx) => {
    ctx.at(NOV_9_NOON_BERLIN);
    const { port } = ctx;
    const { phil, bea, friends } = await seed(port);
    await api(port, "PUT", "/api/me/status", { token: phil.token, body: away, status: 200 });

    // 23:59 Berlin on the 13th: still away.
    ctx.at(Date.parse("2026-11-13T22:59:00Z"));
    const seenLate = await api(port, "GET", `/api/me?circle=${friends.id}`, { token: bea.token });
    assert.equal(seenLate.circle.members.find((m: { id: string }) => m.id === phil.user.id).status?.type, "away");

    // 00:00 Berlin on the 14th (still the 13th in UTC): gone for everyone.
    ctx.at(Date.parse("2026-11-13T23:00:00Z"));
    const seenAfter = await api(port, "GET", `/api/me?circle=${friends.id}`, { token: bea.token });
    assert.equal(seenAfter.circle.members.find((m: { id: string }) => m.id === phil.user.id).status, null);
    const stillStored = ctx.db.prepare("SELECT status_type FROM users WHERE id = ?").get(phil.user.id) as { status_type: string | null };
    assert.equal(stillStored.status_type, "away", "a friend's read does not write");

    const own = await api(port, "GET", "/api/me", { token: phil.token });
    assert.equal(own.user.status, null);
    const tidied = ctx.db.prepare("SELECT status_type, status_text, status_place, status_until FROM users WHERE id = ?").get(phil.user.id);
    assert.deepEqual({ ...tidied }, { status_type: null, status_text: null, status_place: null, status_until: null });
  }, { tz: "UTC" });
});

test("only people sharing a circle see a status, on members, events, rosters and past events", async () => {
  await withApp(async (ctx) => {
    ctx.at(NOV_9_NOON_BERLIN);
    const { port } = ctx;
    const { phil, bea, cam, sam, friends, climbing } = await seed(port);
    await api(port, "PUT", "/api/me/status", { token: phil.token, body: away, status: 200 });
    await api(port, "PUT", "/api/me/status", { token: cam.token, body: { type: "busy", text: "Exams" }, status: 200 });

    const statusOf = (members: Array<{ id: string; status: unknown }>, id: string) => members.find((m) => m.id === id)?.status ?? null;

    // Bea shares Friends with Phil and Climbing with Cam.
    const beaFriends = await api(port, "GET", `/api/me?circle=${friends.id}`, { token: bea.token });
    assert.equal((statusOf(beaFriends.circle.members, phil.user.id) as { type: string }).type, "away");
    const beaClimbing = await api(port, "GET", `/api/me?circle=${climbing.id}`, { token: bea.token });
    assert.equal((statusOf(beaClimbing.circle.members, cam.user.id) as { text: string }).text, "Exams");

    // Phil and Cam share no circle: neither sees the other, wherever they show up.
    const plan = (await api(port, "POST", `/api/plans?circle=${climbing.id}`, {
      token: bea.token,
      body: { note: "Bouldering", date: "2026-11-10", time: "18:00" },
      status: 201,
    })).plan;
    await api(port, "POST", `/api/plans/${plan.id}/join?circle=${climbing.id}`, { token: cam.token, status: 200 });
    await api(port, "PATCH", `/api/plans/${plan.id}?circle=${climbing.id}`, { token: bea.token, body: { circleIds: [climbing.id, friends.id] }, status: 200 });
    await api(port, "POST", `/api/plans/${plan.id}/join?circle=${friends.id}`, { token: phil.token, status: 200 });

    const philPlans = (await api(port, "GET", `/api/plans?circle=${friends.id}`, { token: phil.token })).plans;
    const philSees = philPlans[0].joined;
    assert.equal(statusOf(philSees, cam.user.id), null, "Phil does not see Cam's status");
    assert.equal((statusOf(philSees, phil.user.id) as { type: string }).type, "away", "own status on own row");
    const beaPlans = (await api(port, "GET", `/api/plans?circle=${climbing.id}`, { token: bea.token })).plans;
    assert.equal((statusOf(beaPlans[0].joined, cam.user.id) as { type: string }).type, "busy");
    assert.equal((statusOf(beaPlans[0].joined, phil.user.id) as { type: string }).type, "away");
    // The host's push roster carries it as userStatus, next to the delivery status.
    const roster = beaPlans[0].push.people as Array<{ id: string; status: string; userStatus: { type: string } | null }>;
    assert.equal(roster.find((p) => p.id === phil.user.id)?.userStatus?.type, "away");
    assert.equal(typeof roster.find((p) => p.id === phil.user.id)?.status, "string");
    const camPlans = (await api(port, "GET", `/api/plans?circle=${climbing.id}`, { token: cam.token })).plans;
    assert.equal(statusOf(camPlans[0].joined, phil.user.id), null, "Cam does not see Phil's status");

    // Socials: creator and guests.
    const social = (await api(port, "POST", `/api/socials?circle=${friends.id}`, { token: phil.token, body: { note: "Coffee" }, status: 201 })).social;
    assert.equal(social.creator.status.type, "away");
    const beaSocials = (await api(port, "GET", `/api/socials?circle=${friends.id}`, { token: bea.token })).socials;
    assert.equal(beaSocials[0].creator.status.type, "away");

    // A stranger sees nothing and cannot even read the circle.
    const samMe = await api(port, "GET", "/api/me", { token: sam.token });
    assert.ok(samMe.circle.members.every((m: { status: unknown }) => m.status === null));
    await api(port, "GET", `/api/me?circle=${friends.id}`, { token: sam.token, status: 404 });
    await api(port, "GET", `/api/plans?circle=${friends.id}`, { token: sam.token, status: 404 });

    // Past events keep the same rule.
    await api(port, "POST", `/api/plans/${plan.id}/end?circle=${climbing.id}`, { token: bea.token });
    ctx.at(Date.parse("2026-11-11T11:00:00Z"));
    const camPast = (await api(port, "GET", `/api/past?circle=${climbing.id}`, { token: cam.token })).days;
    const event = camPast.flatMap((day: { events: unknown[] }) => day.events).find((item: { id: string }) => item.id === plan.id);
    assert.ok(event, "past plan listed");
    assert.equal(statusOf(event.people, phil.user.id), null);
    assert.equal((statusOf(event.people, cam.user.id) as { type: string }).type, "busy");

    // Unauthenticated routes never carry a status.
    const preview = await api(port, "GET", `/api/invites/${friends.inviteCode}`, { status: 200 });
    assert.deepEqual(preview, { name: "Friends" });
    const loner = await api(port, "POST", "/api/auth/start", { body: { email: testEmail(), name: "Lou" }, status: 201 });
    assert.ok(!JSON.stringify(loner).includes("Tennis"), "a signup without a circle sees no one");
    // Joining a circle by invite makes Nia a member, so her signup answer and /api/me show it.
    const fresh = await api(port, "POST", "/api/auth/start", { body: { email: testEmail(), name: "Nia", code: friends.inviteCode }, status: 201 });
    assert.equal(statusOf(fresh.circle.members, phil.user.id) && "seen", "seen");
    const niaMe = await api(port, "GET", "/api/me", { token: fresh.token });
    assert.equal((statusOf(niaMe.circle.members, phil.user.id) as { type: string }).type, "away", "joining a circle shows it");
  }, { tz: "Europe/Berlin" });
});

test("away people are still notified exactly as before", async () => {
  await withApp(async (ctx) => {
    ctx.at(NOV_9_NOON_BERLIN);
    const { port, sent } = ctx;
    const { phil, bea, friends } = await seed(port);
    await api(port, "POST", "/api/push/subscribe", { token: phil.token, body: { endpoint: "https://push.example/phil", keys: { p256dh: "p", auth: "a" } }, status: 204 });
    await api(port, "PUT", "/api/me/status", { token: phil.token, body: away, status: 200 });
    sent.length = 0;
    await api(port, "POST", `/api/socials?circle=${friends.id}`, { token: bea.token, body: { note: "Pizza" }, status: 201 });
    assert.deepEqual(sent.map((item) => item.endpoint), ["https://push.example/phil"]);
  }, { tz: "Europe/Berlin", sent: "envelope" });
});

test("an older database gains the status columns", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hangry-status-"));
  const file = path.join(dir, "old.db");
  try {
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      buzz_token TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
    )`);
    old.close();
    const db = openDb(file);
    const cols = (db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>).map((col) => col.name);
    for (const name of ["status_type", "status_text", "status_place", "status_until"]) assert.ok(cols.includes(name), name);
    db.close();
    openDb(file).close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
