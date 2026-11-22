import assert from "node:assert/strict";
import test from "node:test";
import { readEnd, resolveEnd, resolvePlanEnd, shiftPlanEnd } from "../src/lib/end-time.js";
import { api, START, testEmail, withApp } from "./http.js";

const HOUR = 3_600_000;
const at = (iso: string) => Date.parse(iso);

async function circleOfTwo(port: number) {
  const alex = await api(port, "POST", "/api/auth/start", { body: { email: testEmail(), name: "Alex" }, status: 201 });
  const created = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "friends" }, status: 201 });
  const bea = await api(port, "POST", "/api/auth/start", { body: { email: testEmail(), name: "Bea", code: created.circle.inviteCode }, status: 201 });
  return { alex, bea };
}

test("readEnd reads a clock, an instant, a duration, null, and nothing", () => {
  assert.equal(readEnd({}), undefined);
  assert.deepEqual(readEnd({ endsAt: "22:00" }), { clock: "22:00" });
  assert.deepEqual(readEnd({ endsAt: 1_700_000_000_000 }), { instant: 1_700_000_000_000 });
  assert.deepEqual(readEnd({ durationMin: 90 }), { minutes: 90 });
  assert.equal(readEnd({ endsAt: null }), null);
  assert.throws(() => readEnd({ endsAt: "25:00" }), /valid end time/);
  assert.throws(() => readEnd({ endsAt: "soon" }), /valid end time/);
  assert.throws(() => readEnd({ durationMin: 0 }), /between 1 minute and 24 hours/);
  assert.throws(() => readEnd({ durationMin: 1441 }), /between 1 minute and 24 hours/);
  assert.throws(() => readEnd({ endsAt: "22:00", durationMin: 60 }), /not both/);
});

test("resolveEnd rounds to the minute and refuses an end before the start, in the past, or past 24 hours", () => {
  const start = at("2026-06-01T15:00:00Z");
  assert.equal(resolveEnd({ minutes: 90 }, start, START, "UTC"), start + 1.5 * HOUR);
  assert.equal(resolveEnd({ clock: "17:30" }, start, START, "UTC"), at("2026-06-01T17:30:00Z"));
  assert.equal(resolveEnd({ instant: start + HOUR + 20_000 }, start, START, "UTC"), start + HOUR);
  assert.throws(() => resolveEnd({ clock: "14:00" }, start, START, "UTC"), /after the start/);
  assert.throws(() => resolveEnd({ minutes: 30 }, start - HOUR, START, "UTC"), /still ahead/);
  assert.throws(() => resolveEnd({ minutes: 1441 }, start, START, "UTC"), /at most 24 hours/);
});

test("resolvePlanEnd needs a start time and the same day, and shiftPlanEnd keeps the length", () => {
  const end = resolvePlanEnd({ clock: "21:00" }, "2026-06-02", "18:00", START, "UTC");
  assert.equal(end, at("2026-06-02T21:00:00Z"));
  assert.throws(() => resolvePlanEnd({ clock: "21:00" }, "2026-06-02", null, START, "UTC"), /Set a start time/);
  assert.throws(() => resolvePlanEnd({ minutes: 360 }, "2026-06-02", "20:00", START, "UTC"), /same day/);
  assert.equal(shiftPlanEnd(end, { forDate: "2026-06-02", atTime: "18:00" }, { forDate: "2026-06-03", atTime: "19:00" }, "UTC"), at("2026-06-03T22:00:00Z"));
  assert.equal(shiftPlanEnd(end, { forDate: "2026-06-02", atTime: "18:00" }, { forDate: "2026-06-02", atTime: null }, "UTC"), null);
  assert.equal(shiftPlanEnd(end, { forDate: "2026-06-02", atTime: "18:00" }, { forDate: "2026-06-02", atTime: "22:00" }, "UTC"), null);
});

test("a social with an end lasts until then, shows endsAt, and clearing it restores the default window", async () => {
  await withApp(async ({ port, advance }) => {
    const { alex } = await circleOfTwo(port);
    const made = await api(port, "POST", "/api/socials", { token: alex.token, body: { note: "Pizza", endsAt: "17:30" }, status: 201 });
    assert.equal(made.social.endsAt, at("2026-06-01T17:30:00Z"));
    assert.equal(made.social.expiresAt, made.social.endsAt);

    // Pressing again without an end keeps it.
    const again = await api(port, "POST", "/api/socials", { token: alex.token, body: { note: "Pizza" }, status: 200 });
    assert.equal(again.social.endsAt, made.social.endsAt);

    const edited = await api(port, "PATCH", `/api/socials/${made.social.id}`, { token: alex.token, body: { durationMin: 60 }, status: 200 });
    assert.equal(edited.social.endsAt, START + HOUR);
    assert.equal(edited.social.expiresAt, START + HOUR);

    const cleared = await api(port, "PATCH", `/api/socials/${made.social.id}`, { token: alex.token, body: { endsAt: null }, status: 200 });
    assert.equal(cleared.social.endsAt, null);
    assert.equal(cleared.social.expiresAt, START + 2 * HOUR);

    await api(port, "PATCH", `/api/socials/${made.social.id}`, { token: alex.token, body: { durationMin: 30 }, status: 200 });
    advance(31 * 60_000);
    const listed = await api(port, "GET", "/api/socials", { token: alex.token, status: 200 });
    assert.deepEqual(listed.socials, []);
  });
});

test("a social end is refused when it is before the start, already past, or sent with a duration", async () => {
  await withApp(async ({ port }) => {
    const { alex } = await circleOfTwo(port);
    const body = (extra: object) => ({ token: alex.token, body: { note: "Pizza", ...extra }, status: 400 });
    await api(port, "POST", "/api/socials", body({ endsAt: "14:00" }));
    await api(port, "POST", "/api/socials", body({ endsAt: "16:00", durationMin: 60 }));
    await api(port, "POST", "/api/socials", body({ startsAt: "18:00", endsAt: "17:00" }));
    const later = await api(port, "POST", "/api/socials", { token: alex.token, body: { note: "Pizza", startsAt: "18:00", durationMin: 120 }, status: 201 });
    assert.equal(later.social.endsAt, at("2026-06-01T20:00:00Z"));
    // Moving the start past the saved end is refused until the end is cleared.
    await api(port, "PATCH", `/api/socials/${later.social.id}`, { token: alex.token, body: { startsAt: "21:00" }, status: 400 });
    const moved = await api(port, "PATCH", `/api/socials/${later.social.id}`, { token: alex.token, body: { startsAt: "19:00" }, status: 200 });
    assert.equal(moved.social.endsAt, at("2026-06-01T20:00:00Z"));
  });
});

test("a plan with an end shows endsAt, moves it with the start, and falls off the list once it is over", async () => {
  await withApp(async ({ port, at: setNow }) => {
    const { alex, bea } = await circleOfTwo(port);
    const made = await api(port, "POST", "/api/plans", {
      token: alex.token,
      body: { note: "Bouldering", date: "2026-06-02", time: "18:00", endsAt: "21:00" },
      status: 201,
    });
    const id = made.plan.id;
    assert.equal(made.plan.endsAt, at("2026-06-02T21:00:00Z"));

    const moved = await api(port, "PATCH", `/api/plans/${id}`, { token: alex.token, body: { time: "19:00" }, status: 200 });
    assert.equal(moved.plan.endsAt, at("2026-06-02T22:00:00Z"));

    const longer = await api(port, "PATCH", `/api/plans/${id}`, { token: alex.token, body: { durationMin: 90 }, status: 200 });
    assert.equal(longer.plan.endsAt, at("2026-06-02T20:30:00Z"));
    await api(port, "PATCH", `/api/plans/${id}`, { token: alex.token, body: { time: null }, status: 400 });

    setNow(at("2026-06-02T20:00:00Z"));
    assert.equal((await api(port, "GET", "/api/plans", { token: bea.token, status: 200 })).plans.length, 1);
    await api(port, "POST", `/api/plans/${id}/reply`, { token: bea.token, body: { reply: "in" }, status: 200 });

    setNow(at("2026-06-02T20:31:00Z"));
    assert.equal((await api(port, "GET", "/api/plans", { token: bea.token, status: 200 })).plans.length, 0);
    await api(port, "POST", `/api/plans/${id}/reply`, { token: bea.token, body: { reply: "maybe" }, status: 410 });
    await api(port, "PATCH", `/api/plans/${id}`, { token: alex.token, body: { note: "Late" }, status: 410 });
  }, { tz: "UTC" });
});

test("a plan end needs a time, the same day, and a clear works", async () => {
  await withApp(async ({ port }) => {
    const { alex } = await circleOfTwo(port);
    const plan = (extra: object, status: number) =>
      api(port, "POST", "/api/plans", { token: alex.token, body: { note: "Dinner", date: "2026-06-02", ...extra }, status });
    await plan({ endsAt: "21:00" }, 400);
    await plan({ time: "20:00", endsAt: "19:00" }, 400);
    await plan({ time: "20:00", durationMin: 300 }, 400);
    const open = await plan({ time: "20:00" }, 201);
    assert.equal(open.plan.endsAt, null);
    const set = await api(port, "PATCH", `/api/plans/${open.plan.id}`, { token: alex.token, body: { endsAt: "22:30" }, status: 200 });
    assert.equal(set.plan.endsAt, at("2026-06-02T22:30:00Z"));
    const cleared = await api(port, "PATCH", `/api/plans/${open.plan.id}`, { token: alex.token, body: { endsAt: null }, status: 200 });
    assert.equal(cleared.plan.endsAt, null);
  });
});

test("the plan calendar file ends at the host's end and drops the two hour note", async () => {
  await withApp(async ({ port }) => {
    const { alex } = await circleOfTwo(port);
    const made = await api(port, "POST", "/api/plans", {
      token: alex.token,
      body: { note: "Dinner", date: "2026-06-02", time: "18:00", endsAt: "21:15" },
      status: 201,
    });
    const response = await fetch(`http://127.0.0.1:${port}/api/plans/${made.plan.id}/calendar.ics`, {
      headers: { authorization: `Bearer ${alex.token}` },
    });
    const text = await response.text();
    assert.ok(text.includes("DTEND:20260602T211500Z"));
    assert.ok(!text.includes("no end time"));
  });
});
