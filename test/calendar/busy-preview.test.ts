import assert from "node:assert/strict";
import test from "node:test";
import { circleAvailability, ownFriendView, STALE_AFTER_MS, type CalendarNet, type Transport } from "../../src/calendar/freebusy.js";
import { expandBusyHours } from "../../src/social/status.js";
import { api, START, withApp } from "../http.js";

const H = 3_600_000;
const LINK = "https://calendar.example.test/private-0123456789abcdef/basic.ics";
const PREVIEW = "/api/me/calendar-sync/preview";
const TITLES = ["Tennis lesson", "Dentist", "Overlap one", "Overlap two"];

function fakeNet(body: string): CalendarNet {
  return {
    async resolve() {
      return [{ address: "93.184.216.34", family: 4 }];
    },
    request: (async () => ({
      status: 200,
      headers: {},
      body: (async function* () {
        yield Buffer.from(body);
      })(),
      destroy() {},
    })) as Transport,
  };
}

function ics(...events: Array<{ start: number; end: number; title: string }>): string {
  const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    ...events.flatMap((e, i) => [
      "BEGIN:VEVENT",
      `UID:e${i}`,
      `DTSTART:${stamp(e.start)}`,
      `DTEND:${stamp(e.end)}`,
      `SUMMARY:${e.title}`,
      "END:VEVENT",
    ]),
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

// Two overlapping events merge into one block, plus one separate block.
const FEED = ics(
  { start: START + H, end: START + 3 * H, title: "Overlap one" },
  { start: START + 2 * H, end: START + 4 * H, title: "Overlap two" },
  { start: START + 6 * H, end: START + 7 * H, title: "Tennis lesson" },
  { start: START + 30 * H, end: START + 31 * H, title: "Dentist" },
);

async function setup(port: number, share = true) {
  const alex = await api(port, "POST", "/api/auth/start", { body: { name: "Alex" }, status: 201 });
  const friends = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Friends" }, status: 201 });
  const bea = await api(port, "POST", "/api/auth/start", { body: { name: "Bea", code: friends.circle.inviteCode }, status: 201 });
  const work = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Work" }, status: 201 });
  await api(port, "PUT", "/api/me/calendar-sync", { token: alex.token, body: { url: LINK }, status: 200 });
  if (share) {
    await api(port, "PATCH", "/api/me/calendar-sync", { token: alex.token, body: { sharedCircleIds: [friends.circle.id] }, status: 200 });
  }
  return { alex, bea, friends: friends.circle, work: work.circle };
}

const blocks = [
  { start: START + H, end: START + 4 * H },
  { start: START + 6 * H, end: START + 7 * H },
  { start: START + 30 * H, end: START + 31 * H },
];

test("connected and shared: merged busy blocks and the shared circle names", async () => {
  await withApp(async ({ port }) => {
    const { alex, friends } = await setup(port);
    const view = await api(port, "GET", PREVIEW, { token: alex.token, status: 200 });
    assert.equal(view.now, START);
    assert.equal(view.connected, true);
    assert.equal(view.source, "ics");
    assert.equal(view.lastSyncAt, START);
    assert.equal(view.lastSyncOk, true);
    assert.equal(view.stale, false);
    assert.deepEqual(view.sharedCircles, [{ id: friends.id, name: "Friends" }]);
    assert.deepEqual(view.calendar, blocks);
    assert.deepEqual(view.weekly, []);
    assert.equal(view.status, null);
  }, { calendarNet: fakeNet(FEED) });
});

test("not shared: no circles listed, blocks still returned; not connected: empty", async () => {
  await withApp(async ({ port }) => {
    const { alex, bea } = await setup(port, false);
    const view = await api(port, "GET", PREVIEW, { token: alex.token, status: 200 });
    assert.deepEqual(view.sharedCircles, []);
    assert.deepEqual(view.calendar, blocks);
    assert.equal(view.stale, false);
    const none = await api(port, "GET", PREVIEW, { token: bea.token, status: 200 });
    assert.deepEqual(
      { ...none, now: undefined },
      { now: undefined, connected: false, source: null, lastSyncAt: null, lastSyncOk: null, stale: false, sharedCircles: [], calendar: [], weekly: [], status: null },
    );
  }, { calendarNet: fakeNet(FEED) });
});

test("a circle the owner left is not listed as shared", async () => {
  await withApp(async ({ port, db }) => {
    const { alex, friends } = await setup(port);
    db.prepare("DELETE FROM memberships WHERE user_id = ? AND circle_id = ?").run(alex.user.id, friends.id);
    const view = await api(port, "GET", PREVIEW, { token: alex.token, status: 200 });
    assert.deepEqual(view.sharedCircles, []);
  }, { calendarNet: fakeNet(FEED) });
});

test("stale data shows an empty calendar and stale=true, like friends get", async () => {
  await withApp(async ({ port, db, advance }) => {
    const { alex, bea, friends } = await setup(port);
    db.prepare("UPDATE calendar_sync SET next_sync_at = ?").run(START + 100 * H);
    advance(STALE_AFTER_MS);
    assert.equal((await api(port, "GET", PREVIEW, { token: alex.token, status: 200 })).stale, false);
    advance(1);
    const view = await api(port, "GET", PREVIEW, { token: alex.token, status: 200 });
    assert.equal(view.connected, true);
    assert.equal(view.stale, true);
    assert.deepEqual(view.calendar, []);
    assert.deepEqual(view.sharedCircles.map((c: { id: string }) => c.id), [friends.id]);
    const seen = await api(port, "GET", `/api/circles/availability?circle=${friends.id}`, { token: bea.token, status: 200 });
    assert.deepEqual(seen.people, []);

    // An old last_ok_at set directly behaves the same.
    advance(-STALE_AFTER_MS - 1);
    assert.equal((await api(port, "GET", PREVIEW, { token: alex.token })).stale, false);
    db.prepare("UPDATE calendar_sync SET last_ok_at = ?").run(START - STALE_AFTER_MS - 1);
    const old = await api(port, "GET", PREVIEW, { token: alex.token, status: 200 });
    assert.equal(old.stale, true);
    assert.deepEqual(old.calendar, []);
  }, { calendarNet: fakeNet(FEED) });
});

test("parity: a circle member sees the same busy, until and free as the preview says", async () => {
  await withApp(async ({ port, db }) => {
    const { alex, bea, friends } = await setup(port);
    const view = await api(port, "GET", PREVIEW, { token: alex.token, status: 200 });
    assert.equal(view.calendar.length, 3);
    const at = (ms: number) => api(port, "GET", `/api/circles/availability?circle=${friends.id}&at=${ms}`, { token: bea.token, status: 200 });
    for (const block of view.calendar as Array<{ start: number; end: number }>) {
      const middle = Math.floor((block.start + block.end) / 2);
      for (const t of [block.start, middle, block.end - 1]) {
        const got = await at(t);
        assert.deepEqual(got.people, [{ id: alex.user.id, state: "busy", until: block.end }], `busy at ${t}`);
        // The same function the route uses.
        assert.deepEqual(circleAvailability(db, friends.id, bea.user.id, t, START).get(alex.user.id), { state: "busy", until: block.end });
      }
      const after = await at(block.end);
      assert.equal(after.people[0].state, "free");
    }
    // Between blocks: free until the next block starts.
    const gap = await at(START + 5 * H);
    assert.deepEqual(gap.people, [{ id: alex.user.id, state: "free", until: START + 6 * H }]);
  }, { calendarNet: fakeNet(FEED) });
});

test("parity at the edge of the synced window: nothing past window_end, clipped at it", async () => {
  await withApp(async ({ port, db }) => {
    const { alex } = await setup(port);
    const windowEnd = START + 31 * H - 30 * 60_000;
    db.prepare("UPDATE calendar_sync SET window_end = ?").run(windowEnd);
    const view = ownFriendView(db, alex.user.id, START);
    assert.deepEqual(view.calendar.at(-1), { start: START + 30 * H, end: windowEnd });
    db.prepare("UPDATE calendar_sync SET window_end = ?").run(START + 2 * H);
    assert.deepEqual(ownFriendView(db, alex.user.id, START).calendar, [{ start: START + H, end: START + 2 * H }]);
    db.prepare("UPDATE calendar_sync SET window_end = NULL").run();
    assert.equal(ownFriendView(db, alex.user.id, START).stale, true);
  }, { calendarNet: fakeNet(FEED) });
});

test("only spans that end after now are returned", async () => {
  await withApp(async ({ port, advance }) => {
    const { alex } = await setup(port);
    advance(5 * H);
    const view = await api(port, "GET", PREVIEW, { token: alex.token, status: 200 });
    assert.deepEqual(view.calendar, blocks.slice(1));
    assert.equal(view.now, START + 5 * H);
  }, { calendarNet: fakeNet(FEED) });
});

test("weekly hours expand for the right weekdays in the schedule zone", async () => {
  // START is Monday 15:00 UTC, which is already Tuesday 00:00 in Tokyo.
  await withApp(async ({ port, advance }) => {
    const { alex } = await setup(port);
    const hours = { timezone: "Asia/Tokyo", blocks: [{ days: [2, 4], start: "09:00", end: "10:00" }] };
    await api(port, "PUT", "/api/me/busy-hours", { token: alex.token, body: hours, status: 200 });
    let view = await api(port, "GET", PREVIEW, { token: alex.token, status: 200 });
    // Tue 2026-06-02 09:00 JST = 00:00Z, Thu 2026-06-04 09:00 JST = 00:00Z. The next Tuesday is past 7 days.
    assert.deepEqual(view.weekly, [
      { start: Date.parse("2026-06-02T00:00:00Z"), end: Date.parse("2026-06-02T01:00:00Z") },
      { start: Date.parse("2026-06-04T00:00:00Z"), end: Date.parse("2026-06-04T01:00:00Z") },
    ]);
    // Ten hours later (Tue 10:00 JST) Tuesday's block has ended and is dropped.
    advance(10 * H);
    view = await api(port, "GET", PREVIEW, { token: alex.token, status: 200 });
    assert.deepEqual(view.weekly, [{ start: Date.parse("2026-06-04T00:00:00Z"), end: Date.parse("2026-06-04T01:00:00Z") }]);
  }, { calendarNet: fakeNet(FEED) });
});

test("expandBusyHours clips a running block to now, merges overlaps, and ignores bad zones", () => {
  const sched = (blocksIn: Array<{ days: number[]; start: string; end: string }>, timezone = "UTC") => ({ timezone, blocks: blocksIn, updatedAt: 0 });
  const monday = Date.parse("2026-06-01T09:30:00Z");
  const every = [1, 2, 3, 4, 5, 6, 7];
  assert.deepEqual(expandBusyHours(sched([{ days: [1], start: "09:00", end: "11:00" }]), monday), [
    { start: monday, end: Date.parse("2026-06-01T11:00:00Z") },
    { start: Date.parse("2026-06-08T09:00:00Z"), end: Date.parse("2026-06-08T11:00:00Z") },
  ].slice(0, 1));
  assert.deepEqual(
    expandBusyHours(sched([{ days: [1], start: "09:00", end: "11:00" }, { days: [1], start: "10:00", end: "12:00" }]), monday),
    [{ start: monday, end: Date.parse("2026-06-01T12:00:00Z") }],
  );
  assert.equal(expandBusyHours(sched([{ days: every, start: "09:00", end: "10:00" }]), monday).length, 7);
  assert.deepEqual(expandBusyHours(sched([{ days: every, start: "09:00", end: "10:00" }], "Mars/Base"), monday), []);
  assert.deepEqual(expandBusyHours(null, monday), []);
});

test("a manual status is reflected as friends see it", async () => {
  await withApp(async ({ port }) => {
    const { alex } = await setup(port);
    await api(port, "PUT", "/api/me/status", { token: alex.token, body: { type: "busy", text: "Heads down" }, status: 200 });
    const view = await api(port, "GET", PREVIEW, { token: alex.token, status: 200 });
    assert.deepEqual(view.status, { type: "busy", text: "Heads down", place: null, until: null });
  }, { calendarNet: fakeNet(FEED) });
});

test("the response never carries event titles, and only the owner's own data", async () => {
  await withApp(async ({ port, db }) => {
    const { alex, bea } = await setup(port);
    await api(port, "PUT", "/api/me/busy-hours", { token: alex.token, body: { timezone: "UTC", blocks: [{ days: [1, 2], start: "09:00", end: "10:00" }] }, status: 200 });
    assert.ok(db.prepare("SELECT COUNT(*) AS n FROM calendar_event").get()!.n);
    const raw = await fetch(`http://127.0.0.1:${port}${PREVIEW}`, { headers: { authorization: `Bearer ${alex.token}` } });
    assert.equal(raw.headers.get("cache-control"), "no-store");
    const text = await raw.text();
    for (const title of TITLES) assert.equal(text.includes(title), false, title);
    assert.equal(text.includes(LINK), false);
    assert.equal(text.includes("calendar.example.test"), false);

    // Bea reads her own (empty) view, never Alex's, whatever she sends.
    const beas = await api(port, "GET", `${PREVIEW}?user=${alex.user.id}&userId=${alex.user.id}`, { token: bea.token, status: 200 });
    assert.equal(beas.connected, false);
    assert.deepEqual(beas.calendar, []);
    assert.deepEqual(beas.weekly, []);
    assert.deepEqual(beas.sharedCircles, []);
  }, { calendarNet: fakeNet(FEED) });
});

test("unauthenticated is 401, and other methods are not served", async () => {
  await withApp(async ({ port }) => {
    await api(port, "GET", PREVIEW, { status: 401 });
    await api(port, "GET", PREVIEW, { token: "nope", status: 401 });
    const { alex } = await setup(port);
    await api(port, "POST", PREVIEW, { token: alex.token, status: 404 });
  }, { calendarNet: fakeNet(FEED) });
});
