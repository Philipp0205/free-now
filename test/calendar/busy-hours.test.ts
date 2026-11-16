import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { getUserTimezone, openDb, setUserTimezone } from "../../src/db.js";
import { endOfDay, isTimeZone } from "../../src/lib/time.js";
import { readStatusBody, StatusError } from "../../src/social/status.js";
import { api, withApp, testEmail } from "../http.js";

type Person = { token: string; user: { id: string; name: string } };
type Member = { id: string; status: { type: string; until: number | null; source?: string } | null };

const BERLIN = "Europe/Berlin";
// 2026-11-11 is a Wednesday; Berlin is UTC+1.
const WED_10 = Date.parse("2026-11-11T09:00:00Z");
const WED_18 = Date.parse("2026-11-11T17:00:00Z");
const SUN_10 = Date.parse("2026-11-15T09:00:00Z");
const WED_1700 = Date.parse("2026-11-11T16:00:00Z");
const weekdays = { timezone: BERLIN, blocks: [{ days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" }] };

async function seed(port: number) {
  const start = (name: string, code?: string): Promise<Person> =>
    api(port, "POST", "/api/auth/start", { body: code ? { name, email: testEmail(), code } : { name, email: testEmail() }, status: 201 });
  const phil = await start("Phil");
  const friends = (await api(port, "POST", "/api/circles", { token: phil.token, body: { name: "Friends" }, status: 201 })).circle;
  const bea = await start("Bea", friends.inviteCode);
  return { phil, bea, friends };
}

const me = (port: number, person: Person) => api(port, "GET", "/api/me", { token: person.token });
const seenBy = async (port: number, viewer: Person, circleId: string, id: string) => {
  const got = await api(port, "GET", `/api/me?circle=${circleId}`, { token: viewer.token });
  return (got.circle.members as Member[]).find((member) => member.id === id)?.status ?? null;
};
const setHours = (port: number, person: Person, body: unknown = weekdays, status = 200) =>
  api(port, "PUT", "/api/me/busy-hours", { token: person.token, body, status });

test("isTimeZone and the stored zone helpers refuse unknown names", () => {
  assert.equal(isTimeZone("Europe/Lisbon"), true);
  assert.equal(isTimeZone("Mars/Base"), false);
  const db = openDb(":memory:");
  db.prepare("INSERT INTO users (id, name, token_hash, buzz_token, created_at) VALUES ('u', 'U', 'h', 'b', 1)").run();
  assert.equal(getUserTimezone(db, "u"), null);
  assert.equal(setUserTimezone(db, "u", "Mars/Base"), false);
  assert.equal(getUserTimezone(db, "u"), null);
  assert.equal(setUserTimezone(db, "u", "Europe/Lisbon"), true);
  assert.equal(getUserTimezone(db, "u"), "Europe/Lisbon");
  db.close();
});

test("readStatusBody takes an epoch ms until, which wins over untilDay", () => {
  const now = WED_10;
  const hour = now + 3_600_000;
  assert.equal(readStatusBody({ type: "busy", until: hour }, now).status_until, hour);
  assert.equal(readStatusBody({ type: "busy", until: hour, untilDay: "2026-11-20" }, now).status_until, hour);
  assert.equal(readStatusBody({ type: "busy", until: null, untilDay: "2026-11-12" }, now).status_until, endOfDay("2026-11-12", BERLIN));
  assert.equal(readStatusBody({ type: "busy", until: "" }, now).status_until, null);
  const bad = (until: unknown) => assert.throws(() => readStatusBody({ type: "busy", until }, now), StatusError);
  bad(now);
  bad(now - 1);
  bad(now + 367 * 86_400_000);
  bad("soon");
  bad(Number.NaN);
  bad(Infinity);
  bad(true);
  assert.equal(readStatusBody({ type: "busy", until: now + 366 * 86_400_000 }, now).status_until, now + 366 * 86_400_000);
  assert.equal(readStatusBody({ type: "away", untilDay: "2026-11-12" }, now, "Europe/Lisbon").status_until, endOfDay("2026-11-12", "Europe/Lisbon"));
});

test("PUT status with an until instant, then it ends and is cleared on the own read", async () => {
  await withApp(async (ctx) => {
    ctx.at(WED_10);
    const { port } = ctx;
    const { phil, bea, friends } = await seed(port);
    const until = WED_10 + 90 * 60_000;
    const set = await api(port, "PUT", "/api/me/status", { token: phil.token, body: { type: "busy", until }, status: 200 });
    assert.deepEqual(set.user.status, { type: "busy", text: null, place: null, until });
    assert.equal((await me(port, phil)).user.status.until, until);
    assert.equal((await seenBy(port, bea, friends.id, phil.user.id))?.until, until);

    ctx.at(until + 1);
    assert.equal((await seenBy(port, bea, friends.id, phil.user.id)), null);
    assert.equal((await me(port, phil)).user.status, null);
    const row = ctx.db.prepare("SELECT status_type, status_until FROM users WHERE id = ?").get(phil.user.id);
    assert.deepEqual({ ...row }, { status_type: null, status_until: null });
  }, { tz: BERLIN });
});

test("status until and timezone validation over HTTP", async () => {
  await withApp(async (ctx) => {
    ctx.at(WED_10);
    const { port } = ctx;
    const { phil } = await seed(port);
    const put = (body: unknown, status: number) => api(port, "PUT", "/api/me/status", { token: phil.token, body, status });
    await put({ type: "busy", until: WED_10 - 1000 }, 400);
    await put({ type: "busy", until: WED_10 }, 400);
    await put({ type: "busy", until: "tomorrow" }, 400);
    await put({ type: "busy", until: WED_10 + 400 * 86_400_000 }, 400);
    await put({ type: "busy", timezone: "Mars/Base" }, 400);
    await put({ type: "busy", timezone: 5 }, 400);
    assert.equal((await me(port, phil)).user.timezone, null, "a refused write stores nothing");
    assert.equal((await me(port, phil)).user.status, null);
  }, { tz: BERLIN });
});

test("untilDay is Berlin end of day without a zone, and the stored zone when given", async () => {
  await withApp(async (ctx) => {
    ctx.at(WED_10);
    const { port } = ctx;
    const { phil } = await seed(port);
    const body = { type: "away", untilDay: "2026-11-13" };
    const first = await api(port, "PUT", "/api/me/status", { token: phil.token, body, status: 200 });
    assert.equal(first.user.status.until, endOfDay("2026-11-13", BERLIN));
    assert.equal(first.user.timezone, null);
    const berlinExplicit = await api(port, "PUT", "/api/me/status", { token: phil.token, body: { ...body, timezone: BERLIN }, status: 200 });
    assert.equal(berlinExplicit.user.status.until, endOfDay("2026-11-13", BERLIN));

    const lisbon = await api(port, "PUT", "/api/me/status", { token: phil.token, body: { ...body, timezone: "Europe/Lisbon" }, status: 200 });
    assert.equal(lisbon.user.timezone, "Europe/Lisbon");
    assert.equal(lisbon.user.status.until, endOfDay("2026-11-13", "Europe/Lisbon"));
    // The body may omit the zone later: the stored one still counts the day.
    const again = await api(port, "PUT", "/api/me/status", { token: phil.token, body, status: 200 });
    assert.equal(again.user.status.until, endOfDay("2026-11-13", "Europe/Lisbon"));
    assert.equal(ctx.db.prepare("SELECT timezone FROM users WHERE id = ?").get(phil.user.id)?.timezone, "Europe/Lisbon");
  }, { tz: BERLIN });
});

test("weekly hours: save, read, and the effective status for me and a friend", async () => {
  await withApp(async (ctx) => {
    const { port } = ctx;
    ctx.at(WED_10);
    const { phil, bea, friends } = await seed(port);
    assert.deepEqual(await api(port, "GET", "/api/me/busy-hours", { token: phil.token, status: 200 }), { schedule: null });
    assert.equal((await me(port, phil)).user.busyHours, null);

    const put = await setHours(port, phil);
    assert.deepEqual(put.schedule.blocks, weekdays.blocks);
    assert.equal(put.schedule.timezone, BERLIN);
    assert.equal(put.schedule.updatedAt, WED_10);
    assert.deepEqual((await api(port, "GET", "/api/me/busy-hours", { token: phil.token })).schedule, put.schedule);
    const mine = await me(port, phil);
    assert.deepEqual(mine.user.busyHours, put.schedule);
    assert.equal(mine.user.timezone, BERLIN);

    const busy = { type: "busy", text: null, place: null, until: WED_1700, source: "schedule" };
    assert.deepEqual(mine.user.status, busy);
    assert.deepEqual(await seenBy(port, bea, friends.id, phil.user.id), busy);
    const row = ctx.db.prepare("SELECT status_type FROM users WHERE id = ?").get(phil.user.id) as { status_type: string | null };
    assert.equal(row.status_type, null, "computed on read, never stored");

    ctx.at(WED_18);
    assert.equal((await me(port, phil)).user.status, null);
    assert.equal(await seenBy(port, bea, friends.id, phil.user.id), null);
    ctx.at(SUN_10);
    assert.equal((await me(port, phil)).user.status, null);
    assert.equal(await seenBy(port, bea, friends.id, phil.user.id), null);
    // 17:00 sharp is outside, one minute earlier is inside.
    ctx.at(WED_1700);
    assert.equal((await me(port, phil)).user.status, null);
    ctx.at(WED_1700 - 60_000);
    assert.equal((await me(port, phil)).user.status.source, "schedule");
  }, { tz: BERLIN });
});

test("weekly hours follow the schedule zone, and the end is the latest overlapping block", async () => {
  await withApp(async (ctx) => {
    const { port } = ctx;
    ctx.at(Date.parse("2026-11-11T09:30:00Z"));
    const { phil } = await seed(port);
    // 09:30Z is 09:30 in Lisbon (winter, UTC+0) and 10:30 in Berlin.
    await setHours(port, phil, { timezone: "Europe/Lisbon", blocks: [{ days: [3], start: "09:00", end: "10:00" }, { days: [3], start: "09:30", end: "12:00" }] });
    assert.equal((await me(port, phil)).user.status.until, Date.parse("2026-11-11T12:00:00Z"));
    await setHours(port, phil, { timezone: BERLIN, blocks: [{ days: [3], start: "09:00", end: "10:00" }] });
    assert.equal((await me(port, phil)).user.status, null);
  }, { tz: "UTC" });
});

test("manual Busy or Away overrides the weekly pattern", async () => {
  await withApp(async (ctx) => {
    const { port } = ctx;
    ctx.at(WED_10);
    const { phil, bea, friends } = await seed(port);
    await setHours(port, phil);
    await api(port, "PUT", "/api/me/status", { token: phil.token, body: { type: "busy", text: "Deep work" }, status: 200 });
    const manual = { type: "busy", text: "Deep work", place: null, until: null };
    assert.deepEqual((await me(port, phil)).user.status, manual);
    assert.deepEqual(await seenBy(port, bea, friends.id, phil.user.id), manual);
    await api(port, "PUT", "/api/me/status", { token: phil.token, body: { type: "away", text: "Trip" }, status: 200 });
    assert.equal((await me(port, phil)).user.status.type, "away");
    assert.equal((await seenBy(port, bea, friends.id, phil.user.id))?.type, "away");
    // Clearing the manual one lets the pattern show again.
    await api(port, "DELETE", "/api/me/status", { token: phil.token, status: 200 });
    assert.equal((await me(port, phil)).user.status.source, "schedule");
  }, { tz: BERLIN });
});

test("an I'm free clears manual Busy and hides schedule busy while it is live", async () => {
  await withApp(async (ctx) => {
    const { port } = ctx;
    ctx.at(WED_10);
    const { phil, bea, friends } = await seed(port);
    await setHours(port, phil);
    await api(port, "PUT", "/api/me/status", { token: phil.token, body: { type: "busy" }, status: 200 });
    const social = (await api(port, "POST", `/api/socials?circle=${friends.id}`, { token: phil.token, body: { note: "Coffee" }, status: 201 })).social;
    assert.equal(ctx.db.prepare("SELECT status_type FROM users WHERE id = ?").get(phil.user.id)?.status_type, null);
    assert.equal((await me(port, phil)).user.status, null, "free now, so no schedule busy");
    assert.equal(await seenBy(port, bea, friends.id, phil.user.id), null);

    await api(port, "DELETE", `/api/socials/${social.id}?circle=${friends.id}`, { token: phil.token, status: 204 });
    assert.equal((await me(port, phil)).user.status.source, "schedule", "back in the block once it ends");
    assert.equal((await seenBy(port, bea, friends.id, phil.user.id))?.source, "schedule");

    // It also ends by time.
    await api(port, "POST", `/api/socials?circle=${friends.id}`, { token: phil.token, body: { note: "Again" }, status: 201 });
    assert.equal((await me(port, phil)).user.status, null);
    ctx.at(WED_10 + 2 * 3_600_000 + 1000);
    assert.equal((await me(port, phil)).user.status?.source, "schedule");
  }, { tz: BERLIN });
});

test("an I'm free in another circle also hides the pattern, and Away stays", async () => {
  await withApp(async (ctx) => {
    const { port } = ctx;
    ctx.at(WED_10);
    const { phil, bea, friends } = await seed(port);
    const other = (await api(port, "POST", "/api/circles", { token: phil.token, body: { name: "Other" }, status: 201 })).circle;
    await setHours(port, phil);
    await api(port, "POST", `/api/socials?circle=${other.id}`, { token: phil.token, body: { note: "Hi" }, status: 201 });
    assert.equal(await seenBy(port, bea, friends.id, phil.user.id), null);

    await api(port, "PUT", "/api/me/status", { token: phil.token, body: { type: "away", text: "Trip" }, status: 200 });
    await api(port, "POST", `/api/socials?circle=${friends.id}`, { token: phil.token, body: { note: "Hi" }, status: 201 });
    assert.equal((await me(port, phil)).user.status.type, "away", "a live social does not hide Away");
    assert.equal((await seenBy(port, bea, friends.id, phil.user.id))?.type, "away");
  }, { tz: BERLIN });
});

test("an I'm free later does not clear Busy or hide schedule busy before it starts", async () => {
  await withApp(async (ctx) => {
    const { port } = ctx;
    ctx.at(WED_10);
    const { phil, bea, friends } = await seed(port);
    await setHours(port, phil);
    await api(port, "PUT", "/api/me/status", { token: phil.token, body: { type: "busy", text: "Focus" }, status: 200 });
    await api(port, "POST", `/api/socials?circle=${friends.id}`, { token: phil.token, body: { note: "Later", startsInMin: 60 }, status: 201 });
    assert.equal((await me(port, phil)).user.status.text, "Focus");

    await api(port, "DELETE", "/api/me/status", { token: phil.token, status: 200 });
    assert.equal((await me(port, phil)).user.status.source, "schedule");
    assert.equal((await seenBy(port, bea, friends.id, phil.user.id))?.source, "schedule");
    // Once the start has passed, the social is live and the pattern is hidden.
    ctx.at(WED_10 + 61 * 60_000);
    assert.equal((await me(port, phil)).user.status, null);
    assert.equal(await seenBy(port, bea, friends.id, phil.user.id), null);
  }, { tz: BERLIN });
});

test("delete, empty blocks and validation of weekly hours", async () => {
  await withApp(async (ctx) => {
    const { port } = ctx;
    ctx.at(WED_10);
    const { phil } = await seed(port);
    const rows = () => (ctx.db.prepare("SELECT COUNT(*) AS n FROM busy_hours").get() as { n: number }).n;

    await setHours(port, phil);
    assert.equal(rows(), 1);
    assert.deepEqual(await api(port, "DELETE", "/api/me/busy-hours", { token: phil.token, status: 200 }), { schedule: null });
    assert.equal(rows(), 0);
    await setHours(port, phil);
    assert.deepEqual(await setHours(port, phil, { timezone: BERLIN, blocks: [] }), { schedule: null });
    assert.equal(rows(), 0);

    // Normalised: days sorted and unique.
    const clean = await setHours(port, phil, { timezone: BERLIN, blocks: [{ days: [5, 1, 5, 3], start: "08:00", end: "09:30" }] });
    assert.deepEqual(clean.schedule.blocks, [{ days: [1, 3, 5], start: "08:00", end: "09:30" }]);

    const block = { days: [1], start: "09:00", end: "10:00" };
    const bad: unknown[] = [
      {},
      { timezone: BERLIN },
      { timezone: BERLIN, blocks: "all" },
      { timezone: BERLIN, blocks: [block, block, block, block] },
      { timezone: BERLIN, blocks: [{ ...block, start: "22:00", end: "06:00" }] },
      { timezone: BERLIN, blocks: [{ ...block, start: "10:00", end: "10:00" }] },
      { timezone: BERLIN, blocks: [{ ...block, days: [] }] },
      { timezone: BERLIN, blocks: [{ ...block, days: [0] }] },
      { timezone: BERLIN, blocks: [{ ...block, days: [8] }] },
      { timezone: BERLIN, blocks: [{ ...block, days: [1.5] }] },
      { timezone: BERLIN, blocks: [{ ...block, days: ["1"] }] },
      { timezone: BERLIN, blocks: [{ ...block, days: 1 }] },
      { timezone: BERLIN, blocks: [{ ...block, start: "9:00" }] },
      { timezone: BERLIN, blocks: [{ ...block, end: "24:00" }] },
      { timezone: BERLIN, blocks: [{ ...block, end: "10:60" }] },
      { timezone: BERLIN, blocks: [{ ...block, start: 900 }] },
      { timezone: BERLIN, blocks: [null] },
      { timezone: "Mars/Base", blocks: [block] },
      { blocks: [block] },
    ];
    for (const body of bad) {
      const got = await setHours(port, phil, body, 400);
      assert.ok(typeof got.error === "string" && got.error.length > 0, JSON.stringify(body));
    }
    assert.deepEqual((await api(port, "GET", "/api/me/busy-hours", { token: phil.token })).schedule.blocks, clean.schedule.blocks, "refused writes change nothing");

    // Three blocks are fine.
    await setHours(port, phil, { timezone: BERLIN, blocks: [block, { ...block, days: [2] }, { ...block, days: [3] }] });

    await api(port, "GET", "/api/me/busy-hours", { status: 401 });
    await api(port, "PUT", "/api/me/busy-hours", { body: weekdays, status: 401 });
    await api(port, "POST", "/api/me/busy-hours", { token: phil.token, body: weekdays, status: 405 });
  }, { tz: BERLIN });
});

test("an older database gains users.timezone and the busy_hours table", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hangry-busy-"));
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
    assert.ok(cols.includes("timezone"));
    const hours = (db.prepare("PRAGMA table_info(busy_hours)").all() as Array<{ name: string }>).map((col) => col.name);
    assert.deepEqual(hours, ["user_id", "timezone", "blocks", "updated_at"]);
    db.close();
    openDb(file).close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
