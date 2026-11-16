import assert from "node:assert/strict";
import test from "node:test";
import { insertPlan, listPastPlans, listVisiblePlans, sweep } from "../../src/db.js";
import { addDays, dayLabel, daysBetween, isCalendarDate, isoDate, noticeDay, shortDate } from "../../src/lib/time.js";
import { dayLabel as clientDayLabel, planDayChoice, planDayDate, planDayRange } from "../../public/js/when.js";
import { api, withApp, testEmail } from "../http.js";

const BERLIN = "Europe/Berlin";
// 2026-11-05 is a Thursday. 12:00 CET is 11:00Z.
const THU = Date.parse("2026-11-05T11:00:00.000Z");

test("day labels: today, tomorrow, weekday within 6 days, then a short date", () => {
  const today = isoDate(THU, BERLIN);
  assert.equal(today, "2026-11-05");
  const cases: Array<[string, string]> = [
    ["2026-11-05", "Today"],
    ["2026-11-06", "Tomorrow"],
    ["2026-11-07", "Saturday"],
    ["2026-11-11", "Wednesday"],
    // Seven days out is the same weekday as today, so it gets a date.
    ["2026-11-12", "Thu 12 Nov"],
    ["2026-11-14", "Sat 14 Nov"],
    ["2026-12-31", "Thu 31 Dec"],
    ["2027-01-01", "Fri 1 Jan 2027"],
    ["2027-03-28", "Sun 28 Mar 2027"],
  ];
  for (const [day, label] of cases) {
    assert.equal(dayLabel(day, today), label, day);
    assert.equal(clientDayLabel(day, today), label, `client ${day}`);
  }
});

test("pushes never use a bare weekday", () => {
  assert.equal(noticeDay("2026-11-05", "2026-11-05"), "Today");
  assert.equal(noticeDay("2026-11-06", "2026-11-05"), "Tomorrow");
  assert.equal(noticeDay("2026-11-07", "2026-11-05"), "Sat 7 Nov");
  assert.equal(noticeDay("2027-03-28", "2026-11-05"), "Sun 28 Mar 2027");
  assert.equal(shortDate("2027-03-28", "2027-01-02"), "Sun 28 Mar");
});

test("Berlin DST days count as one calendar day each", () => {
  // Spring forward: 2027-03-28 has 23 hours. Fall back: 2026-10-25 has 25 hours.
  assert.equal(daysBetween("2027-03-27", "2027-03-28"), 1);
  assert.equal(daysBetween("2027-03-28", "2027-03-29"), 1);
  assert.equal(daysBetween("2026-10-24", "2026-10-26"), 2);
  assert.equal(addDays("2027-03-27", 1), "2027-03-28");
  assert.equal(addDays("2026-10-25", 1), "2026-10-26");

  // 23:30 CET on the Saturday before spring forward.
  const beforeSpring = Date.parse("2027-03-27T22:30:00.000Z");
  const satToday = isoDate(beforeSpring, BERLIN);
  assert.equal(satToday, "2027-03-27");
  assert.equal(dayLabel("2027-03-28", satToday), "Tomorrow");
  assert.equal(dayLabel("2027-04-02", satToday), "Friday");
  // 03:30 CEST on the change day itself, an hour after the gap.
  const spring = Date.parse("2027-03-28T01:30:00.000Z");
  assert.equal(isoDate(spring, BERLIN), "2027-03-28");
  assert.equal(dayLabel("2027-03-28", isoDate(spring, BERLIN)), "Today");
  assert.equal(dayLabel("2027-03-29", isoDate(spring, BERLIN)), "Tomorrow");
  assert.equal(clientDayLabel("2027-03-29", planDayRange(spring, BERLIN).today), "Tomorrow");

  // 23:30 CET on the fall-back Sunday. 24 hours after 00:30 CEST is still the same day.
  const fallLate = Date.parse("2026-10-25T22:30:00.000Z");
  assert.equal(isoDate(fallLate, BERLIN), "2026-10-25");
  const fallEarly = Date.parse("2026-10-24T22:30:00.000Z"); // 00:30 CEST on the 25th
  assert.equal(isoDate(fallEarly, BERLIN), "2026-10-25");
  assert.equal(isoDate(fallEarly + 24 * 3600_000, BERLIN), "2026-10-25");
  assert.equal(dayLabel("2026-10-26", isoDate(fallLate, BERLIN)), "Tomorrow");
  assert.equal(dayLabel("2026-10-25", isoDate(fallEarly, BERLIN)), "Today");
  assert.equal(planDayRange(fallEarly, BERLIN).tomorrow, "2026-10-26");
});

test("just before and after Berlin midnight the labels move by one day", () => {
  const before = Date.parse("2026-11-05T22:59:30.000Z"); // 23:59:30 CET
  const after = Date.parse("2026-11-05T23:00:30.000Z"); // 00:00:30 CET
  assert.equal(dayLabel("2026-11-06", isoDate(before, BERLIN)), "Tomorrow");
  assert.equal(dayLabel("2026-11-06", isoDate(after, BERLIN)), "Today");
  assert.equal(dayLabel("2026-11-12", isoDate(before, BERLIN)), "Thu 12 Nov");
  assert.equal(dayLabel("2026-11-12", isoDate(after, BERLIN)), "Thursday");
  assert.equal(planDayChoice("2026-11-06", before, BERLIN), "tomorrow");
  assert.equal(planDayChoice("2026-11-06", after, BERLIN), "today");
  assert.equal(planDayRange(before, BERLIN).max, "2027-11-05");
  assert.equal(planDayRange(after, BERLIN).max, "2027-11-06");
});

test("the sheet choice maps to a calendar date", () => {
  assert.equal(planDayDate("today", "", THU, BERLIN), "2026-11-05");
  assert.equal(planDayDate("tomorrow", "2027-01-01", THU, BERLIN), "2026-11-06");
  assert.equal(planDayDate("pick", "2026-11-12", THU, BERLIN), "2026-11-12");
  assert.equal(planDayDate("pick", "", THU, BERLIN), "");
  assert.equal(planDayChoice("2026-11-12", THU, BERLIN), "pick");
});

test("calendar date check", () => {
  assert.equal(isCalendarDate("2028-02-29"), true);
  assert.equal(isCalendarDate("2027-02-29"), false);
  assert.equal(isCalendarDate("2027-02-30"), false);
  assert.equal(isCalendarDate("2027-13-01"), false);
  assert.equal(isCalendarDate("2027-1-01"), false);
  assert.equal(isCalendarDate("tomorrow"), false);
});

async function host(port: number) {
  const alex = await api(port, "POST", "/api/auth/start", { body: { email: testEmail(), name: "Alex" }, status: 201 });
  const created = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "friends" }, status: 201 });
  return { alex, created };
}

test("create validates the date and the time against today in Berlin", async () => {
  await withApp(async ({ port }) => {
    // START is 2026-06-01 17:00 CEST.
    const { alex } = await host(port);
    const post = (body: Record<string, unknown>, status: number) =>
      api(port, "POST", "/api/plans", { token: alex.token, body: { note: "Dinner", ...body }, status });

    assert.equal((await post({ date: "2026-05-31" }, 400)).error, "Pick a date from today on.");
    assert.equal((await post({ date: "2027-06-02" }, 400)).error, "Pick a date within a year.");
    assert.equal((await post({ date: "2027-02-30" }, 400)).error, "That date doesn't exist.");
    assert.equal((await post({ date: "next week" }, 400)).error, "That date doesn't exist.");
    assert.equal((await post({ date: 20270101 }, 400)).error, "That date doesn't exist.");
    assert.equal((await post({ date: "2026-06-08", time: "24:00" }, 400)).error, "Pick a valid time, like 19:30");
    assert.equal((await post({ date: "2026-06-08", time: "7pm" }, 400)).error, "Pick a valid time, like 19:30");
    assert.equal((await post({ date: "2026-06-01", time: "16:59" }, 400)).error, "Pick a time later today.");
    assert.equal((await post({ date: "2026-06-01", time: "17:00" }, 400)).error, "Pick a time later today.");

    const today = await post({ date: "2026-06-01", time: "17:01" }, 201);
    assert.equal(today.plan.forDate, "2026-06-01");
    assert.equal(today.plan.whenLabel, "Today");
    const untimed = await post({ date: "2026-06-01" }, 201);
    assert.equal(untimed.plan.time, null);
    const max = await post({ date: "2027-06-01", time: "08:00" }, 201);
    assert.equal(max.plan.whenLabel, "Tue 1 Jun 2027");
    // An earlier clock on a future day is fine.
    const early = await post({ date: "2026-06-02", time: "06:00" }, 201);
    assert.equal(early.plan.whenLabel, "Tomorrow");
    // The old request shape, with no date, still means tomorrow.
    const legacy = await post({ time: "19:00" }, 201);
    assert.equal(legacy.plan.forDate, "2026-06-02");
    const legacyNull = await post({ date: null }, 201);
    assert.equal(legacyNull.plan.forDate, "2026-06-02");
  }, { tz: "Europe/Berlin" });
});

test("a far-future plan pushes its date and lists sorted by day then time", async () => {
  await withApp(async ({ port, sent }) => {
    const { alex, created } = await host(port);
    const sam = await api(port, "POST", "/api/auth/start", { body: { email: testEmail(), name: "Sam", code: created.circle.inviteCode }, status: 201 });
    await api(port, "POST", "/api/push/subscribe", {
      token: sam.token,
      body: { endpoint: "https://push.example/sam", keys: { p256dh: "p", auth: "a" } },
      status: 204,
    });
    const make = (note: string, date: string, time?: string) =>
      api(port, "POST", "/api/plans", { token: alex.token, body: { note, date, ...(time ? { time } : {}) }, status: 201 });

    await make("Next year", "2027-03-28", "11:00");
    await make("Late next week", "2026-06-08", "21:00");
    await make("Untimed next week", "2026-06-08");
    await make("Early next week", "2026-06-08", "09:30");
    await make("Friday", "2026-06-05", "19:30");
    await make("Tomorrow", "2026-06-02");
    await make("Tonight", "2026-06-01", "20:00");
    await make("November", "2026-11-14", "19:30");

    const november = sent.find((push) => push.body.startsWith("Alex: November"));
    assert.equal(november?.title, "Sat 14 Nov");
    assert.equal(november?.body, "Alex: November · 19:30");
    assert.equal(sent.find((push) => push.body.startsWith("Alex: Friday"))?.title, "Fri 5 Jun");
    assert.equal(sent.find((push) => push.body.startsWith("Alex: Tonight"))?.title, "Today");
    assert.equal(sent.find((push) => push.body.startsWith("Alex: Next year"))?.title, "Sun 28 Mar 2027");

    const listed = await api(port, "GET", "/api/plans", { token: sam.token });
    assert.deepEqual(
      listed.plans.map((plan: { note: string; whenLabel: string }) => `${plan.note}|${plan.whenLabel}`),
      [
        "Tonight|Today",
        "Tomorrow|Tomorrow",
        "Friday|Friday",
        "Early next week|Mon 8 Jun",
        "Late next week|Mon 8 Jun",
        "Untimed next week|Mon 8 Jun",
        "November|Sat 14 Nov",
        "Next year|Sun 28 Mar 2027",
      ],
    );
    const far = listed.plans.at(-1);
    assert.equal(far.push, undefined, "only the host sees push status");
    const hostView = await api(port, "GET", "/api/plans", { token: alex.token });
    const farForHost = hostView.plans.find((plan: { id: string }) => plan.id === far.id);
    assert.equal(farForHost.push.total, 1);
    assert.equal(farForHost.push.people[0].name, "Sam");
    const chat = await api(port, "POST", `/api/plans/${far.id}/chat`, { token: sam.token, body: { text: "Count me in" }, status: 201 });
    assert.equal(chat.chat.closed, false);
    const reply = await api(port, "POST", `/api/plans/${far.id}/reply`, { token: sam.token, body: { reply: "in", arriveAt: "11:15" }, status: 200 });
    assert.equal(reply.plan.joined[0].reply, "coming");
    assert.equal(reply.plan.joined[0].arriveAt, Date.parse("2027-03-28T09:15:00.000Z"));
  }, { tz: "Europe/Berlin" });
});

test("host moves a plan tomorrow to next week and back, with a push to guests", async () => {
  await withApp(async ({ port, sent }) => {
    const { alex, created } = await host(port);
    const sam = await api(port, "POST", "/api/auth/start", { body: { email: testEmail(), name: "Sam", code: created.circle.inviteCode }, status: 201 });
    await api(port, "POST", "/api/push/subscribe", {
      token: sam.token,
      body: { endpoint: "https://push.example/sam", keys: { p256dh: "p", auth: "a" } },
      status: 204,
    });
    const plan = await api(port, "POST", "/api/plans", { token: alex.token, body: { note: "Dinner", time: "19:00" }, status: 201 });
    await api(port, "POST", `/api/plans/${plan.plan.id}/reply`, { token: sam.token, body: { reply: "in" }, status: 200 });
    const patch = (body: Record<string, unknown>, status: number) =>
      api(port, "PATCH", `/api/plans/${plan.plan.id}`, { token: alex.token, body, status });

    const moved = await patch({ date: "2026-06-08" }, 200);
    assert.equal(moved.plan.forDate, "2026-06-08");
    assert.equal(moved.plan.whenLabel, "Mon 8 Jun");
    assert.equal(moved.plan.time, "19:00");
    assert.equal(sent.at(-1)?.title, "Dinner moved to Mon 8 Jun · 19:00");
    assert.equal(sent.at(-1)?.body, "Tap to see the plan.");

    const back = await patch({ date: "2026-06-02", time: "18:00" }, 200);
    assert.equal(back.plan.whenLabel, "Tomorrow");
    assert.equal(sent.at(-1)?.title, "Dinner moved to Tue 2 Jun · 18:00");

    assert.equal((await patch({ date: "2026-05-31" }, 400)).error, "Pick a date from today on.");
    assert.equal((await patch({ date: "2027-06-02" }, 400)).error, "Pick a date within a year.");
    assert.equal((await patch({ date: "2026-02-30" }, 400)).error, "That date doesn't exist.");
    assert.equal((await patch({ date: "2026-06-01", time: "16:00" }, 400)).error, "Pick a time later today.");
    const unchanged = await api(port, "GET", "/api/plans", { token: alex.token });
    assert.equal(unchanged.plans[0].forDate, "2026-06-02");
    assert.equal(unchanged.plans[0].time, "18:00");

    // A note-only edit keeps the day and does not re-check the clock.
    const noted = await patch({ note: "Dinner at mine" }, 200);
    assert.equal(noted.plan.forDate, "2026-06-02");
    const sams = await api(port, "PATCH", `/api/plans/${plan.plan.id}`, { token: sam.token, body: { date: "2026-06-09" }, status: 403 });
    assert.equal(sams.error, "Only the host can do that.");
  }, { tz: "Europe/Berlin" });
});

test("a future plan stays upcoming through its day and moves to Past only after", async () => {
  await withApp(async ({ port, at }) => {
    const { alex } = await host(port);
    const plan = await api(port, "POST", "/api/plans", { token: alex.token, body: { note: "Picnic", date: "2026-06-10", time: "13:00" }, status: 201 });
    const id = plan.plan.id;
    const notesIn = (body: { plans: Array<{ id: string }> }) => body.plans.some((item) => item.id === id);
    const inPast = async () => {
      const past = await api(port, "GET", "/api/past", { token: alex.token });
      return past.days.flatMap((day: { events: Array<{ id: string }> }) => day.events).some((event: { id: string }) => event.id === id);
    };

    assert.equal(notesIn(await api(port, "GET", "/api/plans", { token: alex.token })), true);
    assert.equal(await inPast(), false);

    at(Date.parse("2026-06-10T21:59:00.000Z")); // 23:59 CEST on its day
    const lastMinute = await api(port, "GET", "/api/plans", { token: alex.token });
    assert.equal(notesIn(lastMinute), true);
    assert.equal(lastMinute.plans[0].whenLabel, "Today");
    assert.equal(await inPast(), false);

    at(Date.parse("2026-06-10T22:00:00.000Z")); // 00:00 CEST the next day
    assert.equal(notesIn(await api(port, "GET", "/api/plans", { token: alex.token })), false);
    assert.equal(await inPast(), true);
    const past = await api(port, "GET", "/api/past", { token: alex.token });
    assert.equal(past.days[0].day, "2026-06-10");
    assert.equal(past.days[0].label, "Yesterday");
    const ended = await api(port, "PATCH", `/api/plans/${id}`, { token: alex.token, body: { date: "2026-06-20" }, status: 410 });
    assert.equal(ended.error, "That plan has ended.");
  }, { tz: "Europe/Berlin" });
});

test("ending a far-future plan puts it in Past at once", async () => {
  await withApp(async ({ port }) => {
    const { alex } = await host(port);
    const plan = await api(port, "POST", "/api/plans", { token: alex.token, body: { note: "Trip", date: "2027-01-15" }, status: 201 });
    await api(port, "DELETE", `/api/plans/${plan.plan.id}`, { token: alex.token, status: 204 });
    assert.deepEqual((await api(port, "GET", "/api/plans", { token: alex.token })).plans, []);
    const past = await api(port, "GET", "/api/past", { token: alex.token });
    assert.equal(past.days[0].label, "Today");
    assert.equal(past.days[0].events[0].note, "Trip");
  }, { tz: "Europe/Berlin" });
});

test("sweep and location cleanup leave future plans whole", async () => {
  await withApp(async ({ port, db }) => {
    const { alex, created } = await host(port);
    const circleId = created.circle.id;
    const userId = alex.user.id;
    const row = (id: string, forDate: string) => insertPlan(db, {
      id, circleId, creatorId: userId, note: id, forDate, createdAt: Date.parse("2026-06-01T10:00:00Z"),
      lat: 48.77, lng: 9.17, place: "Park", atTime: "12:00",
    });
    row("tomorrow", "2026-06-02");
    row("next-week", "2026-06-08");
    row("next-year", "2027-05-30");
    row("yesterday", "2026-05-31");
    row("old", "2026-02-01");
    row("far", "2027-05-31");
    const now = Date.parse("2026-06-01T15:00:00Z");
    sweep(db, now, addDays("2026-06-01", -90), "2026-06-01");

    const visible = listVisiblePlans(db, circleId, "2026-06-01", "2027-06-01");
    assert.deepEqual(visible.map((plan) => plan.id), ["tomorrow", "next-week", "next-year", "far"]);
    for (const plan of visible) {
      assert.equal(plan.lat, 48.77, plan.id);
      assert.equal(plan.lng, 9.17, plan.id);
      assert.equal(plan.place, "Park", plan.id);
    }
    const yesterday = db.prepare("SELECT lat, place FROM plans WHERE id = 'yesterday'").get() as { lat: number | null; place: string };
    assert.equal(yesterday.lat, null);
    assert.equal(yesterday.place, "Park");
    assert.equal(db.prepare("SELECT 1 FROM plans WHERE id = 'old'").get(), undefined);
    assert.deepEqual(listPastPlans(db, circleId, "2026-06-01").map((plan) => plan.id), ["yesterday"]);

    // A year later the sweep still keeps a plan whose day has not come, and drops one ended long ago.
    db.prepare("UPDATE plans SET ended_at = ? WHERE id = 'next-year'").run(now);
    sweep(db, now + 100 * 86_400_000, "", "2026-09-09");
    assert.equal(db.prepare("SELECT 1 FROM plans WHERE id = 'next-year'").get(), undefined);
    assert.equal(db.prepare("SELECT 1 FROM plans WHERE id = 'next-week'").get(), undefined);
    const far = db.prepare("SELECT lat, lng, place FROM plans WHERE id = 'far'").get() as { lat: number | null; lng: number | null; place: string };
    assert.deepEqual({ ...far }, { lat: 48.77, lng: 9.17, place: "Park" });
  }, { tz: "Europe/Berlin" });
});

test("an ended far-future plan stays in Past for 90 days after it ended", async () => {
  await withApp(async ({ port, db }) => {
    const { alex, created } = await host(port);
    insertPlan(db, {
      id: "trip", circleId: created.circle.id, creatorId: alex.user.id, note: "Trip", forDate: "2027-05-01",
      createdAt: Date.parse("2026-06-01T10:00:00Z"), lat: null, lng: null, place: "", atTime: null,
    });
    const endedAt = Date.parse("2026-06-01T12:00:00Z");
    db.prepare("UPDATE plans SET ended_at = ? WHERE id = 'trip'").run(endedAt);
    sweep(db, endedAt + 89 * 86_400_000, "", "2026-08-29");
    assert.ok(db.prepare("SELECT 1 FROM plans WHERE id = 'trip'").get());
    sweep(db, endedAt + 91 * 86_400_000, "", "2026-08-31");
    assert.equal(db.prepare("SELECT 1 FROM plans WHERE id = 'trip'").get(), undefined);
  });
});
