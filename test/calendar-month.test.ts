import assert from "node:assert/strict";
import test from "node:test";
import { api, START, withApp } from "./http.js";

// START is 2026-06-01 15:00 UTC, which is 17:00 in Berlin.
const DAY = 86_400_000;
const JUNE = "from=2026-06-01&to=2026-06-30";

type Row = { id: string; note: string; circleId: string; circleName: string; forDate?: string; day?: string; endedAt?: number | null };
type Month = { plans: Row[]; socials: Row[] };

const ctxOpts = { tz: "Europe/Berlin" } as const;

async function month(port: number, token: string, query: string, circle?: string): Promise<Month> {
  const response = await fetch(`http://127.0.0.1:${port}/api/calendar-month?${query}`, {
    headers: { authorization: `Bearer ${token}`, ...(circle ? { "x-circle": circle } : {}) },
  });
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()) as Month;
}

async function setup(port: number) {
  const alex = await api(port, "POST", "/api/auth/start", { body: { name: "Alex" }, status: 201 });
  const uni = (await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Uni friends" }, status: 201 })).circle;
  const home = (await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Home" }, status: 201 })).circle;
  const bea = await api(port, "POST", "/api/auth/start", { body: { name: "Bea" }, status: 201 });
  const work = (await api(port, "POST", "/api/circles", { token: bea.token, body: { name: "Work" }, status: 201 })).circle;
  const early = (await api(port, "POST", `/api/plans?circle=${uni.id}`, { token: alex.token, body: { note: "Uni early", date: "2026-06-02" }, status: 201 })).plan;
  const late = (await api(port, "POST", `/api/plans?circle=${home.id}`, { token: alex.token, body: { note: "Home late", date: "2026-06-20" }, status: 201 })).plan;
  await api(port, "POST", `/api/plans?circle=${home.id}`, { token: alex.token, body: { note: "Home july", date: "2026-07-03" }, status: 201 });
  await api(port, "POST", `/api/socials?circle=${uni.id}`, { token: alex.token, body: { note: "Uni soup" }, status: 201 });
  await api(port, "POST", `/api/plans?circle=${work.id}`, { token: bea.token, body: { note: "Work lunch", date: "2026-06-05" }, status: 201 });
  await api(port, "POST", `/api/socials?circle=${work.id}`, { token: bea.token, body: { note: "Work coffee" }, status: 201 });
  return { alex, bea, uni, home, work, early, late };
}

test("all=1 lists every circle's plans and socials in the range, past and future, with the home circle", async () => {
  await withApp(async ({ port, advance }) => {
    const { alex, uni, home } = await setup(port);
    // Ten days on: Uni early (2 Jun) is past and the soup has long expired, Home late is still ahead.
    advance(10 * DAY);
    const all = await month(port, alex.token, `${JUNE}&all=1`);
    assert.deepEqual(all.plans.map((row) => row.note), ["Uni early", "Home late"]);
    assert.deepEqual(all.socials.map((row) => row.note), ["Uni soup"]);
    const early = all.plans[0];
    assert.equal(early.circleId, uni.id);
    assert.equal(early.circleName, "Uni friends");
    assert.equal(early.forDate, "2026-06-02");
    const late = all.plans[1];
    assert.equal(late.circleId, home.id);
    assert.equal(late.circleName, "Home");
    assert.equal(all.socials[0].circleId, uni.id);
    assert.equal(all.socials[0].circleName, "Uni friends");
    assert.equal(all.socials[0].day, "2026-06-01");

    const single = await month(port, alex.token, JUNE, home.id);
    assert.deepEqual(single.plans.map((row) => row.note), ["Home late"]);
    assert.deepEqual(single.socials, []);
    const viaQuery = await month(port, alex.token, `${JUNE}&circle=${uni.id}`);
    assert.deepEqual(viaQuery.plans.map((row) => row.note), ["Uni early"]);
    assert.deepEqual(viaQuery.socials.map((row) => row.note), ["Uni soup"]);
  }, ctxOpts);
});

test("all=1 never shows a circle the caller is not in, and a requested circle cannot widen it", async () => {
  await withApp(async ({ port }) => {
    const { alex, bea, work } = await setup(port);
    const all = await month(port, alex.token, `${JUNE}&all=1`, work.id);
    assert.equal([...all.plans, ...all.socials].some((row) => row.circleId === work.id), false);
    assert.equal([...all.plans, ...all.socials].some((row) => /Work/.test(row.note)), false);
    // Without all=1 a circle you are not in is not found.
    const response = await fetch(`http://127.0.0.1:${port}/api/calendar-month?${JUNE}`, {
      headers: { authorization: `Bearer ${alex.token}`, "x-circle": work.id },
    });
    assert.equal(response.status, 404);
    const beas = await month(port, bea.token, `${JUNE}&all=1`);
    assert.deepEqual(beas.plans.map((row) => row.note), ["Work lunch"]);
    assert.deepEqual(beas.socials.map((row) => row.note), ["Work coffee"]);
  }, ctxOpts);
});

test("leaving a circle drops its events from the All month", async () => {
  await withApp(async ({ port }) => {
    const { uni, home } = await setup(port);
    const ana = await api(port, "POST", "/api/auth/start", { body: { name: "Ana", code: uni.inviteCode }, status: 201 });
    await api(port, "POST", "/api/circles/join", { token: ana.token, body: { code: home.inviteCode }, status: 200 });
    const before = await month(port, ana.token, `${JUNE}&all=1`);
    assert.deepEqual(before.plans.map((row) => row.note), ["Uni early", "Home late"]);
    await api(port, "POST", `/api/circles/leave?circle=${uni.id}`, { token: ana.token, status: 200 });
    const after = await month(port, ana.token, `${JUNE}&all=1`);
    assert.deepEqual(after.plans.map((row) => row.note), ["Home late"]);
    assert.deepEqual(after.socials, []);
  }, ctxOpts);
});

test("a plan shared into two circles shows up once, under its home circle", async () => {
  await withApp(async ({ port }) => {
    const { alex, uni, home, early } = await setup(port);
    await api(port, "PATCH", `/api/plans/${early.id}?circle=${uni.id}`, { token: alex.token, body: { circleIds: [uni.id, home.id] }, status: 200 });
    const all = await month(port, alex.token, `${JUNE}&all=1`);
    const copies = all.plans.filter((row) => row.id === early.id);
    assert.equal(copies.length, 1);
    assert.equal(copies[0].circleId, uni.id);
    assert.equal(copies[0].circleName, "Uni friends");
    // It is in Home now too, so Home alone lists it.
    const homeOnly = await month(port, alex.token, JUNE, home.id);
    assert.deepEqual(homeOnly.plans.map((row) => row.note).sort(), ["Home late", "Uni early"]);
  }, ctxOpts);
});

test("the range is inclusive and leaves out plans outside it", async () => {
  await withApp(async ({ port }) => {
    const { alex } = await setup(port);
    const edge = await month(port, alex.token, "from=2026-06-02&to=2026-06-20&all=1");
    assert.deepEqual(edge.plans.map((row) => row.note), ["Uni early", "Home late"]);
    const inner = await month(port, alex.token, "from=2026-06-03&to=2026-06-19&all=1");
    assert.deepEqual(inner.plans, []);
    const july = await month(port, alex.token, "from=2026-06-29&to=2026-08-08&all=1");
    assert.deepEqual(july.plans.map((row) => row.note), ["Home july"]);
  }, ctxOpts);
});

test("socials land on the Berlin day they started, not the UTC day", async () => {
  await withApp(async ({ port, at }) => {
    const alex = await api(port, "POST", "/api/auth/start", { body: { name: "Alex" }, status: 201 });
    const circle = (await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Night" }, status: 201 })).circle;
    // 22:30 UTC on 9 Jun is 00:30 on 10 Jun in Berlin.
    at(Date.parse("2026-06-09T22:30:00.000Z"));
    await api(port, "POST", "/api/socials", { token: alex.token, body: { note: "After midnight" }, status: 201 });
    // 21:30 UTC on 14 Jun is 23:30 on 14 Jun in Berlin: still the same day there.
    at(Date.parse("2026-06-14T21:30:00.000Z"));
    await api(port, "POST", "/api/socials", { token: alex.token, body: { note: "Before midnight" }, status: 201 });
    at(Date.parse("2026-06-20T10:00:00.000Z"));
    const tenth = await month(port, alex.token, "from=2026-06-10&to=2026-06-10", circle.id);
    assert.deepEqual(tenth.socials.map((row) => [row.note, row.day]), [["After midnight", "2026-06-10"]]);
    const ninth = await month(port, alex.token, "from=2026-06-09&to=2026-06-09", circle.id);
    assert.deepEqual(ninth.socials, []);
    const fourteenth = await month(port, alex.token, "from=2026-06-14&to=2026-06-14", circle.id);
    assert.deepEqual(fourteenth.socials.map((row) => [row.note, row.day]), [["Before midnight", "2026-06-14"]]);
    const fifteenth = await month(port, alex.token, "from=2026-06-15&to=2026-06-15", circle.id);
    assert.deepEqual(fifteenth.socials, []);
  }, ctxOpts);
});

test("a later-today social lands on the day it starts", async () => {
  await withApp(async ({ port }) => {
    const alex = await api(port, "POST", "/api/auth/start", { body: { name: "Alex" }, status: 201 });
    const circle = (await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Later" }, status: 201 })).circle;
    const made = (await api(port, "POST", "/api/socials", { token: alex.token, body: { note: "Late snack", startsAt: "23:30" }, status: 201 })).social;
    assert.ok(made.startsAt > START);
    const june1 = await month(port, alex.token, "from=2026-06-01&to=2026-06-01", circle.id);
    assert.deepEqual(june1.socials.map((row) => row.note), ["Late snack"]);
  }, ctxOpts);
});

test("an ended plan in range stays on its day", async () => {
  await withApp(async ({ port }) => {
    const { alex, home, late } = await setup(port);
    await api(port, "DELETE", `/api/plans/${late.id}?circle=${home.id}`, { token: alex.token, status: 204 });
    const plans = (await api(port, "GET", "/api/plans?all=1", { token: alex.token, status: 200 })).plans as Row[];
    assert.equal(plans.some((row) => row.id === late.id), false, "the Home feed drops it");
    const all = await month(port, alex.token, `${JUNE}&all=1`);
    const ended = all.plans.find((row) => row.id === late.id);
    assert.ok(ended, "still on the calendar");
    assert.equal(ended.forDate, "2026-06-20");
    assert.equal(typeof ended.endedAt, "number");
  }, ctxOpts);
});

test("a bad range is a 400, no session is a 401, and all=1 needs no circle", async () => {
  await withApp(async ({ port }) => {
    const { alex } = await setup(port);
    for (const query of [
      "",
      "from=2026-06-01",
      "to=2026-06-30",
      "from=2026-06-30&to=2026-06-01",
      "from=2026-02-30&to=2026-03-02",
      "from=June&to=July",
      "from=2026-06-01&to=2026-09-01",
    ]) {
      await api(port, "GET", `/api/calendar-month?${query}&all=1`, { token: alex.token, status: 400 });
    }
    // 62 days is the cap; 6 weeks fits.
    await api(port, "GET", "/api/calendar-month?from=2026-06-01&to=2026-08-01&all=1", { token: alex.token, status: 200 });
    await api(port, "GET", "/api/calendar-month?from=2026-06-01&to=2026-08-02&all=1", { token: alex.token, status: 400 });
    await api(port, "GET", `/api/calendar-month?${JUNE}&all=1`, { status: 401 });
    await api(port, "GET", `/api/calendar-month?${JUNE}`, { status: 401 });
    // Two circles and no circle named: the single-circle month asks which one.
    await api(port, "GET", `/api/calendar-month?${JUNE}`, { token: alex.token, status: 400 });
    const all = await api(port, "GET", `/api/calendar-month?${JUNE}&all=1`, { token: alex.token, status: 200 });
    assert.equal(all.plans.length, 2);
    assert.equal(all.from, "2026-06-01");
    assert.equal(all.to, "2026-06-30");
  }, ctxOpts);
});

test("the Home and Map lists keep their windows: a past plan does not come back", async () => {
  await withApp(async ({ port, advance }) => {
    const { alex } = await setup(port);
    advance(10 * DAY);
    const plans = (await api(port, "GET", "/api/plans?all=1", { token: alex.token, status: 200 })).plans as Row[];
    assert.deepEqual(plans.map((row) => row.note).sort(), ["Home july", "Home late"]);
    const socials = (await api(port, "GET", "/api/socials?all=1", { token: alex.token, status: 200 })).socials as Row[];
    assert.deepEqual(socials, []);
  }, ctxOpts);
});
