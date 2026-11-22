import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../../src/config.js";
import { addMonths, nextEndsAt, nextOccurrenceDate, readRecurrence } from "../../src/lib/recurrence.js";
import { clockLabel, zonedDateTime } from "../../src/lib/time.js";
import type { PushPayload, PushSender } from "../../src/push/push.js";
import { materializeRecurringPlans } from "../../src/social/recurring-plans.js";
import { api, testEmail, withApp, type AppCtx } from "../http.js";

type Person = { token: string; user: { id: string; name: string } };

const TZ = "Europe/Berlin";
const UNKNOWN = "00000000-0000-4000-8000-000000000000";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
const config = loadConfig({ PORT: "3000", DB_PATH: ":memory:", APP_TZ: TZ });
const to = (person: Person) => `https://push.example/${person.user.id}`;

type PlanRow = { id: string; for_date: string; at_time: string | null; ends_at: number | null; recurrence: string | null; series_id: string | null; series_day: number | null; photo_rev: number | null; lat: number | null };

/** Alex hosts. Bea, Cam and Dan share his circle. Olli has his own. Everyone in Friends has a push endpoint. */
async function seed(port: number) {
  const start = (name: string, code?: string): Promise<Person> =>
    api(port, "POST", "/api/auth/start", { body: code ? { name, email: testEmail(), code } : { name, email: testEmail() }, status: 201 });
  const alex = await start("Alex");
  const circle = (await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Friends" }, status: 201 })).circle;
  const bea = await start("Bea", circle.inviteCode);
  const cam = await start("Cam", circle.inviteCode);
  const olli = await start("Olli");
  await api(port, "POST", "/api/circles", { token: olli.token, body: { name: "Elsewhere" }, status: 201 });
  for (const person of [alex, bea, cam]) {
    await api(port, "POST", "/api/push/subscribe", { token: person.token, body: { endpoint: to(person), keys: { p256dh: "p", auth: "a" } }, status: 204 });
  }
  return { alex, bea, cam, olli, circle };
}

function makePlan(ctx: AppCtx, host: Person, circleId: string, body: Record<string, unknown> = {}) {
  const plan = { note: "Supper", place: "Hall", date: "2026-06-03", time: "18:00", durationMin: 120, ...body };
  return api(ctx, "POST", `/api/plans?circle=${circleId}`, { token: host.token, body: plan });
}

/** Moves both clocks and runs the sweep once. Returns the endpoints of the pushes it sent. */
async function sweepAt(ctx: AppCtx, ms: number): Promise<string[]> {
  ctx.at(ms);
  const sent: string[] = [];
  const push: PushSender = {
    async send(subscription: { endpoint: string }, _payload: PushPayload) {
      sent.push(subscription.endpoint);
    },
  };
  await materializeRecurringPlans({ db: ctx.db, push, config, now: () => ms });
  return sent.sort();
}

function rows(ctx: AppCtx, seriesId: string): PlanRow[] {
  return ctx.db.prepare("SELECT id, for_date, at_time, ends_at, recurrence, series_id, series_day, photo_rev, lat FROM plans WHERE series_id = ? ORDER BY for_date").all(seriesId) as PlanRow[];
}

function seriesOf(ctx: AppCtx, planId: string): string {
  return (ctx.db.prepare("SELECT series_id FROM plans WHERE id = ?").get(planId) as { series_id: string }).series_id;
}

/** After the 3 June plan has ended (21:00 in Berlin). */
const AFTER = Date.parse("2026-06-03T19:00:00Z");

test("date math: weekly, biweekly, monthly clamp, leap year", () => {
  assert.equal(nextOccurrenceDate("2026-06-03", "weekly"), "2026-06-10");
  assert.equal(nextOccurrenceDate("2026-12-28", "weekly"), "2027-01-04");
  assert.equal(nextOccurrenceDate("2026-06-03", "biweekly"), "2026-06-17");
  assert.equal(nextOccurrenceDate("2026-06-03", "monthly"), "2026-07-03");
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(addMonths("2028-01-31", 1), "2028-02-29");
  assert.equal(addMonths("2026-12-15", 1), "2027-01-15");
  // The anchor day stops a clamp from drifting: 31 Jan, 28 Feb, 31 Mar.
  const feb = nextOccurrenceDate("2026-01-31", "monthly", 31);
  assert.equal(feb, "2026-02-28");
  assert.equal(nextOccurrenceDate(feb, "monthly", 31), "2026-03-31");
});

test("date math: the end keeps its local clock across a DST change", () => {
  const spring = nextEndsAt(zonedDateTime("2026-03-22", "17:00", TZ), "2026-03-22", "2026-03-29", "15:00", TZ);
  assert.equal(clockLabel(spring as number, TZ), "17:00");
  assert.equal(spring, zonedDateTime("2026-03-29", "17:00", TZ));
  const autumn = nextEndsAt(zonedDateTime("2026-10-18", "17:00", TZ), "2026-10-18", "2026-10-25", "15:00", TZ);
  assert.equal(clockLabel(autumn as number, TZ), "17:00");
  assert.equal(nextEndsAt(null, "2026-10-18", "2026-10-25", "15:00", TZ), null);
});

test("repeat tokens: weekly, biweekly, monthly, never and null. Anything else is a 400", () => {
  assert.equal(readRecurrence(undefined), undefined);
  assert.equal(readRecurrence(null), null);
  assert.equal(readRecurrence("never"), null);
  assert.equal(readRecurrence("weekly"), "weekly");
  assert.throws(() => readRecurrence("daily"), /Repeats must be/);
  assert.throws(() => readRecurrence(7), /Repeats must be/);
});

test("a weekly plan gets its next one once it ends, with the same fields", async () => {
  await withApp(async (ctx) => {
    const { alex, bea, cam, circle } = await seed(ctx.port);
    const made = (await makePlan(ctx, alex, circle.id, { recurrence: "weekly", description: "Bring snacks", cardColor: 4, lat: 52.5, lng: 13.4 })).json.plan;
    assert.equal(made.recurrence, "weekly");
    const seriesId = seriesOf(ctx, made.id);

    assert.deepEqual(await sweepAt(ctx, Date.parse("2026-06-03T15:00:00Z")), [], "not over yet, nothing happens");
    assert.equal(rows(ctx, seriesId).length, 1);

    assert.deepEqual(await sweepAt(ctx, AFTER), [to(bea), to(cam)].sort(), "friends hear about it, the host does not");
    const [first, next] = rows(ctx, seriesId);
    assert.equal(rows(ctx, seriesId).length, 2);
    assert.equal(first.recurrence, null, "the old one stops carrying the rule");
    assert.equal(next.for_date, "2026-06-10");
    assert.equal(next.recurrence, "weekly");
    assert.equal(next.at_time, "18:00");
    assert.equal(next.ends_at, zonedDateTime("2026-06-10", "20:00", TZ));
    assert.notEqual(next.id, made.id);

    const list = (await api(ctx, "GET", `/api/plans?circle=${circle.id}`, { token: bea.token, status: 200 })).json.plans as Array<Record<string, any>>;
    const copy = list.find((plan) => plan.id === next.id);
    assert.ok(copy, "Bea sees the new plan");
    assert.equal(copy.note, "Supper");
    assert.equal(copy.description, "Bring snacks");
    assert.equal(copy.cardColor, 4);
    assert.equal(copy.recurrence, "weekly");
    assert.deepEqual(copy.joined, []);
    assert.ok(copy.shareId && copy.shareId !== made.shareId, "its own share link");
  }, { tz: TZ });
});

test("a second sweep makes no second row and sends no second push", async () => {
  await withApp(async (ctx) => {
    const { alex, circle } = await seed(ctx.port);
    const made = (await makePlan(ctx, alex, circle.id, { recurrence: "weekly" })).json.plan;
    const seriesId = seriesOf(ctx, made.id);
    assert.equal((await sweepAt(ctx, AFTER)).length, 2);
    assert.deepEqual(await sweepAt(ctx, AFTER + 60_000), []);
    assert.equal(rows(ctx, seriesId).length, 2);
    const plans = ctx.db.prepare("SELECT COUNT(*) AS n FROM plans").get() as { n: number };
    assert.equal(Number(plans.n), 2);
  }, { tz: TZ });
});

test("biweekly and monthly pick the right day", async () => {
  await withApp(async (ctx) => {
    const { alex, circle } = await seed(ctx.port);
    const two = (await makePlan(ctx, alex, circle.id, { recurrence: "biweekly" })).json.plan;
    const month = (await makePlan(ctx, alex, circle.id, { recurrence: "monthly", note: "Brunch" })).json.plan;
    await sweepAt(ctx, AFTER);
    assert.deepEqual(rows(ctx, seriesOf(ctx, two.id)).map((row) => row.for_date), ["2026-06-03", "2026-06-17"]);
    assert.deepEqual(rows(ctx, seriesOf(ctx, month.id)).map((row) => row.for_date), ["2026-06-03", "2026-07-03"]);
  }, { tz: TZ });
});

test("ending a repeating plan by hand makes the next one right away", async () => {
  await withApp(async (ctx) => {
    const { alex, circle } = await seed(ctx.port);
    const made = (await makePlan(ctx, alex, circle.id, { recurrence: "weekly" })).json.plan;
    await api(ctx, "DELETE", `/api/plans/${made.id}?circle=${circle.id}`, { token: alex.token, status: 204 });
    assert.deepEqual(rows(ctx, seriesOf(ctx, made.id)).map((row) => row.for_date), ["2026-06-03", "2026-06-10"]);
    assert.equal(ctx.sent.filter((item) => item.tag.startsWith("plan:")).length >= 2, true, "creating it and its next one both pushed");
  }, { tz: TZ });
});

test("a host who is behind a missed sweep skips to the next day still ahead", async () => {
  await withApp(async (ctx) => {
    const { alex, circle } = await seed(ctx.port);
    const made = (await makePlan(ctx, alex, circle.id, { recurrence: "weekly" })).json.plan;
    await sweepAt(ctx, Date.parse("2026-06-20T10:00:00Z"));
    assert.deepEqual(rows(ctx, seriesOf(ctx, made.id)).map((row) => row.for_date), ["2026-06-03", "2026-06-24"]);
  }, { tz: TZ });
});

test("Stop repeating: only the host, and no next one after it ends", async () => {
  await withApp(async (ctx) => {
    const { alex, bea, olli, circle } = await seed(ctx.port);
    const made = (await makePlan(ctx, alex, circle.id, { recurrence: "weekly" })).json.plan;
    const patch = (person: Person, recurrence: unknown) =>
      api(ctx, "PATCH", `/api/plans/${made.id}?circle=${circle.id}`, { token: person.token, body: { recurrence } });

    assert.equal((await patch(bea, null)).status, 403, "a friend cannot stop it");
    assert.notEqual((await patch(olli, null)).status, 200, "an outsider cannot either");
    assert.equal(rows(ctx, seriesOf(ctx, made.id))[0].recurrence, "weekly");

    const stopped = await patch(alex, null);
    assert.equal(stopped.status, 200);
    assert.equal(stopped.json.plan.recurrence, null);
    assert.equal((await patch(alex, "never")).status, 200, "never means the same");

    assert.deepEqual(await sweepAt(ctx, AFTER), []);
    assert.equal(rows(ctx, seriesOf(ctx, made.id)).length, 1);
  }, { tz: TZ });
});

test("changing the rule updates the current plan only, and a bad token is a 400", async () => {
  await withApp(async (ctx) => {
    const { alex, circle } = await seed(ctx.port);
    const made = (await makePlan(ctx, alex, circle.id, { recurrence: "weekly" })).json.plan;
    const patch = (recurrence: unknown) =>
      api(ctx, "PATCH", `/api/plans/${made.id}?circle=${circle.id}`, { token: alex.token, body: { recurrence } });
    assert.equal((await patch("daily")).status, 400);
    assert.equal((await patch("monthly")).json.plan.recurrence, "monthly");
    await sweepAt(ctx, AFTER);
    assert.deepEqual(rows(ctx, seriesOf(ctx, made.id)).map((row) => row.for_date), ["2026-06-03", "2026-07-03"]);
    const bad = await api(ctx, "POST", `/api/plans?circle=${circle.id}`, { token: alex.token, body: { note: "Nope", recurrence: "daily" } });
    assert.equal(bad.status, 400);
  }, { tz: TZ });
});

test("a private plan keeps its guest list, and hidden friends get nothing", async () => {
  await withApp(async (ctx) => {
    const { alex, bea, cam, circle } = await seed(ctx.port);
    const made = (await makePlan(ctx, alex, circle.id, { recurrence: "weekly", invitees: [bea.user.id] })).json.plan;
    assert.deepEqual(await sweepAt(ctx, AFTER), [to(bea)], "only Bea is told");
    const next = rows(ctx, seriesOf(ctx, made.id))[1];
    const join = (person: Person, id: string) => api(ctx, "POST", `/api/plans/${id}/join?circle=${circle.id}`, { token: person.token });
    assert.equal((await join(cam, next.id)).status, 404, "Cam sees the same 404 as a missing plan");
    assert.equal((await join(cam, UNKNOWN)).status, 404);
    assert.equal((await join(bea, next.id)).status, 200);
    const camList = (await api(ctx, "GET", `/api/plans?circle=${circle.id}`, { token: cam.token, status: 200 })).json.plans;
    assert.deepEqual(camList, []);
  }, { tz: TZ });
});

test("who joined or replied does not carry over", async () => {
  await withApp(async (ctx) => {
    const { alex, bea, cam, circle } = await seed(ctx.port);
    const made = (await makePlan(ctx, alex, circle.id, { recurrence: "weekly" })).json.plan;
    await api(ctx, "POST", `/api/plans/${made.id}/join?circle=${circle.id}`, { token: bea.token, status: 200 });
    await api(ctx, "POST", `/api/plans/${made.id}/reply?circle=${circle.id}`, { token: cam.token, body: { reply: "maybe" }, status: 200 });
    await sweepAt(ctx, AFTER);
    const next = rows(ctx, seriesOf(ctx, made.id))[1];
    const joins = ctx.db.prepare("SELECT COUNT(*) AS n FROM plan_joins WHERE plan_id = ?").get(next.id) as { n: number };
    assert.equal(Number(joins.n), 0);
    const paid = ctx.db.prepare("SELECT COUNT(*) AS n FROM event_payments WHERE event_id = ?").get(next.id) as { n: number };
    assert.equal(Number(paid.n), 0);
  }, { tz: TZ });
});

test("the cover photo is copied to its own file", async () => {
  await withApp(async (ctx) => {
    const { alex, circle } = await seed(ctx.port);
    const made = (await makePlan(ctx, alex, circle.id, { recurrence: "weekly" })).json.plan;
    const put = await fetch(`http://127.0.0.1:${ctx.port}/api/plans/${made.id}/photo`, {
      method: "PUT",
      headers: { authorization: `Bearer ${alex.token}`, "content-type": "application/octet-stream" },
      body: new Uint8Array(JPEG),
    });
    assert.equal(put.status, 200);
    await sweepAt(ctx, AFTER);
    const next = rows(ctx, seriesOf(ctx, made.id))[1];
    assert.ok(next.photo_rev, "the new plan has a photo revision");
    const dir = config.eventPhotosDir;
    const oldFile = path.join(dir, `plan-${made.id}.jpg`);
    const newFile = path.join(dir, `plan-${next.id}.jpg`);
    assert.ok(fs.existsSync(oldFile), "the old file stays");
    assert.deepEqual(fs.readFileSync(newFile), JPEG);
    assert.notEqual(oldFile, newFile);
  }, { tz: TZ });
});

test("the pin is kept for the next one and the old one lets go of it", async () => {
  await withApp(async (ctx) => {
    const { alex, circle } = await seed(ctx.port);
    const made = (await makePlan(ctx, alex, circle.id, { recurrence: "weekly", lat: 52.5, lng: 13.4 })).json.plan;
    await sweepAt(ctx, AFTER);
    const [first, next] = rows(ctx, seriesOf(ctx, made.id));
    assert.equal(first.lat, null);
    assert.equal(next.lat, 52.5);
  }, { tz: TZ });
});

test("socials never repeat", async () => {
  await withApp(async (ctx) => {
    const { alex, circle } = await seed(ctx.port);
    const bad = await api(ctx, "POST", `/api/socials?circle=${circle.id}`, { token: alex.token, body: { note: "Walk", recurrence: "weekly" } });
    assert.equal(bad.status, 400);
    const social = (await api(ctx, "POST", `/api/socials?circle=${circle.id}`, { token: alex.token, body: { note: "Walk", recurrence: "never" }, status: 201 })).json.social;
    assert.equal(social.recurrence, undefined, "no recurrence field on a social");
    const edit = await api(ctx, "PATCH", `/api/socials/${social.id}?circle=${circle.id}`, { token: alex.token, body: { recurrence: "monthly" } });
    assert.equal(edit.status, 400);
    const cols = (ctx.db.prepare("PRAGMA table_info(socials)").all() as Array<{ name: string }>).map((col) => col.name);
    assert.ok(!cols.includes("recurrence") && !cols.includes("series_id"));
  }, { tz: TZ });
});

test("a repeat across a DST change keeps the local end time", async () => {
  await withApp(async (ctx) => {
    const { alex, circle } = await seed(ctx.port);
    ctx.at(Date.parse("2026-03-20T10:00:00Z"));
    const made = (await makePlan(ctx, alex, circle.id, { recurrence: "weekly", date: "2026-03-22", time: "15:00", durationMin: 120 })).json.plan;
    await sweepAt(ctx, Date.parse("2026-03-22T20:00:00Z"));
    const next = rows(ctx, seriesOf(ctx, made.id))[1];
    assert.equal(next.for_date, "2026-03-29");
    assert.equal(clockLabel(next.ends_at as number, TZ), "17:00");
    assert.equal(next.ends_at, zonedDateTime("2026-03-29", "17:00", TZ));
  }, { tz: TZ });
});
