import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { mock } from "node:test";
import { api, withApp, type AppCtx, type WithAppOptions } from "../http.js";

const AMANDA_ID = "00000000-0000-4000-8000-00000000a111";
const CIRCLE = "Amanda & Philipp";
const NOTE = "Foot massage 💆";

type People = Awaited<ReturnType<typeof setup>>;

/** Amanda gets a known id (user ids are random, the env needs it before the app starts). */
async function setup(ctx: AppCtx, circleName: string) {
  const real = crypto.randomUUID.bind(crypto);
  let pin: string | null = AMANDA_ID;
  const stub = mock.method(crypto, "randomUUID", () => {
    const id = pin ?? real();
    pin = null;
    return id;
  });
  let amanda;
  try {
    amanda = (await api(ctx, "POST", "/api/auth/start", { body: { name: "Amanda" }, status: 201 })).json;
  } finally {
    stub.mock.restore();
  }
  assert.equal(amanda.user.id, AMANDA_ID);
  const pair = (await api(ctx, "POST", "/api/circles", { token: amanda.token, body: { name: circleName }, status: 201 })).json.circle;
  const other = (await api(ctx, "POST", "/api/circles", { token: amanda.token, body: { name: "Climbing" }, status: 201 })).json.circle;
  const philipp = (await api(ctx, "POST", "/api/auth/start", { body: { name: "Philipp", code: pair.inviteCode }, status: 201 })).json;
  // A hold posts a normal social in the pair circle, so "stays normal" is visible there.
  await api(ctx, "PUT", "/api/me/buzz-circles", { token: amanda.token, body: { hold: pair.id }, status: 200 });
  return { amanda, philipp, pair, other };
}

async function run(
  options: WithAppOptions & { circleName?: string },
  fn: (ctx: AppCtx, people: People) => Promise<void>,
) {
  const { circleName = CIRCLE, ...rest } = options;
  await withApp(async (ctx) => fn(ctx, await setup(ctx, circleName)), rest);
}

const on = { EASTER_EGG_FOOT_MASSAGE_USER_ID: AMANDA_ID };

async function plans(ctx: AppCtx, token: string, circleId: string): Promise<any[]> {
  return (await api(ctx, "GET", `/api/plans?circle=${circleId}`, { token, status: 200 })).json.plans;
}

async function socials(ctx: AppCtx, token: string, circleId: string): Promise<any[]> {
  return (await api(ctx, "GET", `/api/socials?circle=${circleId}`, { token, status: 200 })).json.socials;
}

test("env unset: a hold from Amanda posts the normal social and makes no plan", async () => {
  await run({}, async (ctx, { amanda, pair }) => {
    const res = await api(ctx, "POST", `/api/buzz/${amanda.buzzToken}?press=hold`, { status: 201 });
    assert.ok(res.json.social);
    assert.equal(res.json.plan, undefined);
    assert.equal((await socials(ctx, amanda.token, pair.id)).length, 1);
    assert.equal((await plans(ctx, amanda.token, pair.id)).length, 0);
  });
});

test("env blank counts as unset", async () => {
  await run({ env: { EASTER_EGG_FOOT_MASSAGE_USER_ID: "   " } }, async (ctx, { amanda, pair }) => {
    const res = await api(ctx, "POST", `/api/buzz/${amanda.buzzToken}?press=hold`, { status: 201 });
    assert.ok(res.json.social);
    assert.equal((await plans(ctx, amanda.token, pair.id)).length, 0);
  });
});

test("before 20:00 the foot massage is tonight, in the Amanda & Philipp circle only", async () => {
  // START is 15:00 UTC on 2026-06-01.
  await run({ env: on }, async (ctx, { amanda, philipp, pair, other }) => {
    const res = await api(ctx, "POST", `/api/buzz/${amanda.buzzToken}?press=hold`, { status: 201 });
    assert.equal(res.json.social, undefined);
    assert.equal(res.json.plan.note, NOTE);
    assert.equal(res.json.plan.time, "20:00");
    assert.equal(res.json.plan.forDate, "2026-06-01");
    assert.equal(res.json.plan.circleId, pair.id);
    const mine = await plans(ctx, amanda.token, pair.id);
    assert.deepEqual(mine.map((plan) => plan.id), [res.json.plan.id]);
    assert.equal((await plans(ctx, amanda.token, other.id)).length, 0);
    assert.equal((await socials(ctx, amanda.token, pair.id)).length, 0);
    // Philipp is in the circle and sees it.
    assert.equal((await plans(ctx, philipp.token, pair.id)).length, 1);
  });
});

test("after 20:00 the foot massage is tomorrow", async () => {
  await run({ env: on }, async (ctx, { amanda, pair }) => {
    ctx.at(Date.parse("2026-06-01T20:30:00.000Z"));
    const res = await api(ctx, "POST", `/api/buzz/${amanda.buzzToken}?press=hold`, { status: 201 });
    assert.equal(res.json.plan.forDate, "2026-06-02");
    assert.equal(res.json.plan.time, "20:00");
    assert.equal((await plans(ctx, amanda.token, pair.id)).length, 1);
  });
});

test("exactly 20:00 already counts as after", async () => {
  await run({ env: on }, async (ctx, { amanda }) => {
    ctx.at(Date.parse("2026-06-01T20:00:00.000Z"));
    const res = await api(ctx, "POST", `/api/buzz/${amanda.buzzToken}?press=hold`, { status: 201 });
    assert.equal(res.json.plan.forDate, "2026-06-02");
  });
});

test("the 20:00 cutoff follows APP_TZ", async () => {
  // Berlin is UTC+2 in June. 18:30 UTC is 20:30 there, 17:30 UTC is 19:30.
  await run({ env: on, tz: "Europe/Berlin" }, async (ctx, { amanda }) => {
    ctx.at(Date.parse("2026-06-01T17:30:00.000Z"));
    const before = await api(ctx, "POST", `/api/buzz/${amanda.buzzToken}?press=hold`, { status: 201 });
    assert.equal(before.json.plan.forDate, "2026-06-01");
  });
  await run({ env: on, tz: "Europe/Berlin" }, async (ctx, { amanda }) => {
    ctx.at(Date.parse("2026-06-01T18:30:00.000Z"));
    const after = await api(ctx, "POST", `/api/buzz/${amanda.buzzToken}?press=hold`, { status: 201 });
    assert.equal(after.json.plan.forDate, "2026-06-02");
  });
  // 22:30 UTC is already 00:30 on the 2nd in Berlin, so the next 20:00 is that evening.
  await run({ env: on, tz: "Europe/Berlin" }, async (ctx, { amanda }) => {
    ctx.at(Date.parse("2026-06-01T22:30:00.000Z"));
    const night = await api(ctx, "POST", `/api/buzz/${amanda.buzzToken}?press=hold`, { status: 201 });
    assert.equal(night.json.plan.forDate, "2026-06-02");
  });
});

test("the circle name matches trimmed and case-insensitive", async () => {
  await run({ env: on, circleName: "amanda & PHILIPP " }, async (ctx, { amanda, pair }) => {
    const res = await api(ctx, "POST", `/api/buzz/${amanda.buzzToken}?press=hold`, { status: 201 });
    assert.equal(res.json.plan.circleId, pair.id);
  });
});

test("a hold from another user stays normal", async () => {
  await run({ env: on }, async (ctx, { philipp, pair }) => {
    const res = await api(ctx, "POST", `/api/buzz/${philipp.buzzToken}?press=hold`, { status: 201 });
    assert.ok(res.json.social);
    assert.equal(res.json.plan, undefined);
    assert.equal((await plans(ctx, philipp.token, pair.id)).length, 0);
  });
});

test("single, double and a DELETE hold stay normal", async () => {
  await run({ env: on }, async (ctx, { amanda, pair, other }) => {
    const single = await api(ctx, "POST", `/api/buzz/${amanda.buzzToken}?press=single`, { status: 201 });
    assert.ok(single.json.social);
    assert.equal(single.json.plan, undefined);
    const double = await api(ctx, "POST", `/api/buzz/${amanda.buzzToken}?press=double`);
    assert.ok(double.json.social);
    assert.equal(double.json.plan, undefined);
    await api(ctx, "DELETE", `/api/buzz/${amanda.buzzToken}?press=hold`, { status: 204 });
    assert.equal((await plans(ctx, amanda.token, pair.id)).length, 0);
    assert.equal((await plans(ctx, amanda.token, other.id)).length, 0);
    assert.equal((await socials(ctx, amanda.token, other.id)).length, 1);
  });
});

test("without a circle named Amanda & Philipp a hold stays normal", async () => {
  await run({ env: on, circleName: "Home" }, async (ctx, { amanda, pair }) => {
    const res = await api(ctx, "POST", `/api/buzz/${amanda.buzzToken}?press=hold`, { status: 201 });
    assert.ok(res.json.social);
    assert.equal(res.json.plan, undefined);
    assert.equal((await plans(ctx, amanda.token, pair.id)).length, 0);
  });
});

test("a second hold the same day returns the same plan and makes no second one", async () => {
  await run({ env: on }, async (ctx, { amanda, pair }) => {
    const first = await api(ctx, "POST", `/api/buzz/${amanda.buzzToken}?press=hold`, { status: 201 });
    const second = await api(ctx, "POST", `/api/buzz/${amanda.buzzToken}?press=hold`, { status: 201 });
    assert.equal(second.json.plan.id, first.json.plan.id);
    assert.equal((await plans(ctx, amanda.token, pair.id)).length, 1);
    // After 20:00 the target day moves on, so that hold is a new plan.
    ctx.at(Date.parse("2026-06-01T21:00:00.000Z"));
    const next = await api(ctx, "POST", `/api/buzz/${amanda.buzzToken}?press=hold`, { status: 201 });
    assert.notEqual(next.json.plan.id, first.json.plan.id);
    assert.equal(next.json.plan.forDate, "2026-06-02");
    const again = await api(ctx, "POST", `/api/buzz/${amanda.buzzToken}?press=hold`, { status: 201 });
    assert.equal(again.json.plan.id, next.json.plan.id);
    assert.equal((await plans(ctx, amanda.token, pair.id)).length, 2);
  });
});

test("the plan carries a share id and links only the one circle", async () => {
  await run({ env: on }, async (ctx, { amanda, pair }) => {
    const res = await api(ctx, "POST", `/api/buzz/${amanda.buzzToken}?press=hold`, { status: 201 });
    assert.ok(res.json.plan.shareId);
    assert.equal(res.json.plan.circles.length, 1);
    assert.equal(res.json.plan.circles[0].id, pair.id);
  });
});
