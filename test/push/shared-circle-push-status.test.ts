import assert from "node:assert/strict";
import test from "node:test";
import type { DatabaseSync } from "node:sqlite";
import {
  addMember,
  insertCircle,
  insertPlan,
  insertPushDelivery,
  insertUser,
  linkPlanCircle,
  markPushDelivered,
  markPushFailed,
  openDb,
  upsertPushSub,
} from "../../src/db.js";
import { pushSummaryForPlan } from "../../src/push/push-status.js";
import { api, withApp, type AppCtx, type SentPush } from "../http.js";

// The host's push roster for a plan shared to more circles. Family is home, Jumping Dinner is shared to later.

type Person = { token: string; user: { id: string; name: string } };
type Roster = { delivered: number; total: number; people: Array<{ id: string; name: string; status: string; circleIds: string[] }> };

const start = (port: number, name: string, code?: string): Promise<Person> =>
  api(port, "POST", "/api/auth/start", { body: code ? { name, code } : { name }, status: 201 });

const subscribe = (port: number, person: Person) =>
  api(port, "POST", "/api/push/subscribe", {
    token: person.token,
    body: { endpoint: to(person), keys: { p256dh: "p", auth: "a" } },
    status: 204,
  });

const to = (person: Person) => `https://push.example/${person.user.id}`;

/** Philipp hosts Family (Anna with push, Ben without) and Jumping Dinner (Mia with push). */
async function seed(port: number) {
  const philipp = await start(port, "Philipp");
  const family = (await api(port, "POST", "/api/circles", { token: philipp.token, body: { name: "Family" }, status: 201 })).circle;
  const anna = await start(port, "Anna", family.inviteCode);
  const ben = await start(port, "Ben", family.inviteCode);
  const dinner = (await api(port, "POST", "/api/circles", { token: philipp.token, body: { name: "Jumping Dinner" }, status: 201 })).circle;
  const mia = await start(port, "Mia", dinner.inviteCode);
  await subscribe(port, anna);
  await subscribe(port, mia);
  return { philipp, anna, ben, mia, family, dinner };
}

async function makePlan(port: number, host: Person, circleId: string) {
  return (await api(port, "POST", `/api/plans?circle=${circleId}`, {
    token: host.token,
    body: { note: "Kerzenschein", place: "Altstadt", date: "2026-06-03", time: "19:00" },
    status: 201,
  })).plan as { id: string };
}

const share = (port: number, host: Person, planId: string, home: string, circleIds: string[]) =>
  api(port, "PATCH", `/api/plans/${planId}?circle=${home}`, { token: host.token, body: { circleIds }, status: 200 });

async function rosterFor(port: number, person: Person, circleId: string, planId: string): Promise<Roster | undefined> {
  const { plans } = await api(port, "GET", `/api/plans?circle=${circleId}`, { token: person.token, status: 200 });
  const plan = (plans as Array<{ id: string; push?: Roster }>).find((item) => item.id === planId);
  assert.ok(plan, "plan visible");
  return plan.push;
}

const statusOf = (roster: Roster | undefined, name: string) => roster?.people.find((person) => person.name === name)?.status;
const names = (roster: Roster | undefined) => roster?.people.map((person) => person.name);

function rows(db: DatabaseSync, userId: string, planId: string) {
  return db.prepare("SELECT circle_id, kind, status FROM push_deliveries WHERE user_id = ? AND ref_id = ?").all(userId, planId)
    .map((row) => ({ ...(row as { circle_id: string; kind: string; status: string }) }));
}

async function ack(ctx: AppCtx<SentPush>, endpoint: string, tag: string) {
  const item = ctx.sent.find((entry) => entry.endpoint === endpoint && entry.payload.tag === tag);
  assert.ok(item?.payload.id, `tracked push for ${endpoint}`);
  await api(ctx, "POST", "/api/push/ack", { body: { id: item.payload.id }, status: 204 });
}

test("Jonas joins Jumping Dinner, the Family plan is shared there, and he shows in the host's roster", async () => {
  await withApp(async (ctx) => {
    const { port, db, sent } = ctx;
    const { philipp, anna, ben, mia, family, dinner } = await seed(port);
    const jonas = await start(port, "Jonas", dinner.inviteCode);
    await subscribe(port, jonas);
    const plan = await makePlan(port, philipp, family.id);

    sent.length = 0;
    const shared = await share(port, philipp, plan.id, family.id, [family.id, dinner.id]);

    // Sending works: an in-app Alert in Jumping Dinner, one push, one delivery row on that circle.
    const alerts = await api(port, "GET", `/api/notifications?circle=${dinner.id}`, { token: jonas.token, status: 200 });
    assert.equal(alerts.notifications.filter((note: { kind: string; refId: string }) => note.kind === "plan" && note.refId === plan.id).length, 1);
    assert.deepEqual(sent.map((item) => item.endpoint).sort(), [to(jonas), to(mia)].sort());
    assert.deepEqual(rows(db, jonas.user.id, plan.id), [{ circle_id: dinner.id, kind: "plan", status: "sent" }]);

    // The roster in the PATCH reply and on both circles' boards.
    assert.equal(statusOf(shared.plan.push, "Jonas"), "sent", "Jonas in the roster right after sharing");
    for (const circleId of [family.id, dinner.id]) {
      const roster = await rosterFor(port, philipp, circleId, plan.id);
      assert.deepEqual(names(roster), ["Anna", "Ben", "Jonas", "Mia"]);
      assert.equal(statusOf(roster, "Jonas"), "sent");
      assert.equal(statusOf(roster, "Ben"), "off");
      assert.equal(roster?.total, 4);
    }

    await ack(ctx, to(jonas), `plan:${plan.id}`);
    const after = await rosterFor(port, philipp, family.id, plan.id);
    assert.equal(statusOf(after, "Jonas"), "delivered");
    assert.equal(after?.delivered, 1);
    assert.deepEqual(after?.people.find((person) => person.name === "Jonas")?.circleIds, [dinner.id]);

    // Reading the roster sends nothing and writes no Alert or delivery row.
    const before = { notes: count(db, "notifications"), deliveries: count(db, "push_deliveries"), sent: sent.length };
    await rosterFor(port, philipp, dinner.id, plan.id);
    await rosterFor(port, mia, dinner.id, plan.id);
    assert.deepEqual({ notes: count(db, "notifications"), deliveries: count(db, "push_deliveries"), sent: sent.length }, before);
    void anna; void ben;
  }, { sent: "envelope" });
});

test("shared first, Jonas joins later: not sent, never delivered", async () => {
  await withApp(async ({ port, db }) => {
    const { philipp, family, dinner } = await seed(port);
    const plan = await makePlan(port, philipp, family.id);
    await share(port, philipp, plan.id, family.id, [family.id, dinner.id]);
    const jonas = await start(port, "Jonas", dinner.inviteCode);
    await subscribe(port, jonas);

    assert.deepEqual(rows(db, jonas.user.id, plan.id), [], "joining later sends nothing");
    const roster = await rosterFor(port, philipp, family.id, plan.id);
    assert.equal(statusOf(roster, "Jonas"), "not_sent");
    assert.equal(statusOf(roster, "Mia"), "sent");
  }, { sent: "envelope" });
});

test("Jonas without push is off or not installed, never delivered", async () => {
  await withApp(async ({ port, db }) => {
    const { philipp, family, dinner } = await seed(port);
    const jonas = await start(port, "Jonas", dinner.inviteCode);
    const plan = await makePlan(port, philipp, family.id);
    await share(port, philipp, plan.id, family.id, [family.id, dinner.id]);

    assert.deepEqual(rows(db, jonas.user.id, plan.id), []);
    const alerts = await api(port, "GET", `/api/notifications?circle=${dinner.id}`, { token: jonas.token, status: 200 });
    assert.equal(alerts.notifications.some((note: { refId: string }) => note.refId === plan.id), true, "still gets the Alert");
    assert.equal(statusOf(await rosterFor(port, philipp, family.id, plan.id), "Jonas"), "off");
    await api(port, "POST", "/api/me/display", { token: jonas.token, body: { standalone: false }, status: 204 });
    assert.equal(statusOf(await rosterFor(port, philipp, family.id, plan.id), "Jonas"), "not_installed");
  }, { sent: "envelope" });
});

test("a person in both circles shows once, and the home push counts for them", async () => {
  await withApp(async (ctx) => {
    const { port } = ctx;
    const { philipp, anna, family, dinner } = await seed(port);
    await api(port, "POST", "/api/circles/join", { token: anna.token, body: { code: dinner.inviteCode }, status: 200 });
    const plan = await makePlan(port, philipp, family.id);
    await ack(ctx, to(anna), `plan:${plan.id}`);
    await share(port, philipp, plan.id, family.id, [family.id, dinner.id]);

    const roster = await rosterFor(port, philipp, dinner.id, plan.id);
    assert.deepEqual(names(roster), ["Anna", "Ben", "Mia"]);
    assert.equal(statusOf(roster, "Anna"), "delivered");
    assert.deepEqual(roster?.people.find((person: { name: string }) => person.name === "Anna")?.circleIds, [family.id, dinner.id]);
    assert.equal(roster?.total, 3);
  }, { sent: "envelope" });
});

test("a non-host admin sees only circles they admin, plain members see nothing", async () => {
  await withApp(async ({ port }) => {
    const { philipp, anna, ben, mia, family, dinner } = await seed(port);
    const jonas = await start(port, "Jonas", dinner.inviteCode);
    const plan = await makePlan(port, philipp, family.id);
    await share(port, philipp, plan.id, family.id, [family.id, dinner.id]);
    await api(port, "POST", `/api/circles/members/${mia.user.id}?circle=${dinner.id}`, { token: philipp.token, body: { admin: true }, status: 200 });
    await api(port, "POST", `/api/circles/members/${ben.user.id}?circle=${family.id}`, { token: philipp.token, body: { admin: true }, status: 200 });

    assert.deepEqual(names(await rosterFor(port, mia, dinner.id, plan.id)), ["Jonas", "Mia"], "Jumping Dinner admin sees no Family member");
    assert.deepEqual(names(await rosterFor(port, ben, family.id, plan.id)), ["Anna", "Ben"], "Family admin sees no Jumping Dinner member");
    assert.equal(await rosterFor(port, anna, family.id, plan.id), undefined);
    assert.equal(await rosterFor(port, jonas, dinner.id, plan.id), undefined);
  }, { sent: "envelope" });
});

test("someone who left or was removed from the shared circle drops off the roster", async () => {
  await withApp(async ({ port }) => {
    const { philipp, mia, family, dinner } = await seed(port);
    const jonas = await start(port, "Jonas", dinner.inviteCode);
    await subscribe(port, jonas);
    const plan = await makePlan(port, philipp, family.id);
    await share(port, philipp, plan.id, family.id, [family.id, dinner.id]);
    assert.deepEqual(names(await rosterFor(port, philipp, family.id, plan.id)), ["Anna", "Ben", "Jonas", "Mia"]);

    await api(port, "POST", `/api/circles/leave?circle=${dinner.id}`, { token: jonas.token, status: 200 });
    await api(port, "DELETE", `/api/circles/members/${mia.user.id}?circle=${dinner.id}`, { token: philipp.token, status: 204 });
    assert.deepEqual(names(await rosterFor(port, philipp, family.id, plan.id)), ["Anna", "Ben"]);

    // Unsharing drops the circle too.
    const nina = await start(port, "Nina", dinner.inviteCode);
    assert.deepEqual(names(await rosterFor(port, philipp, family.id, plan.id)), ["Anna", "Ben", "Nina"]);
    await share(port, philipp, plan.id, family.id, [family.id]);
    assert.deepEqual(names(await rosterFor(port, philipp, family.id, plan.id)), ["Anna", "Ben"]);
    void nina;
  }, { sent: "envelope" });
});

test("status is the best row across the latest batch of each linked circle", () => {
  const db = openDb(":memory:");
  const now = 1_700_000_000_000;
  for (const [id, name] of [["host", "Philipp"], ["dan", "Dan"], ["eve", "Eve"]]) {
    insertUser(db, { id, name, token_hash: `h-${id}`, buzz_token: `b-${id}`, created_at: now });
  }
  insertCircle(db, { id: "fam", name: "Family", invite_code: "FAMI2345", created_by: "host", created_at: now }, "host", now);
  insertCircle(db, { id: "jd", name: "Jumping Dinner", invite_code: "JDJD2345", created_by: "host", created_at: now }, "host", now);
  addMember(db, "fam", "dan", now + 1);
  addMember(db, "jd", "dan", now + 1);
  addMember(db, "jd", "eve", now + 1);
  insertPlan(db, { id: "p", circleId: "fam", creatorId: "host", note: "Kerzenschein", forDate: "2026-06-03", createdAt: now, lat: null, lng: null, place: "" });
  linkPlanCircle(db, "p", "jd", now + 5);
  upsertPushSub(db, { id: "s-dan", userId: "dan", endpoint: "https://push.example/dan", p256dh: "p", auth: "a", createdAt: now });
  upsertPushSub(db, { id: "s-eve", userId: "eve", endpoint: "https://push.example/eve", p256dh: "p", auth: "a", createdAt: now });
  const row = (id: string, userId: string, circleId: string, batchId: string, at: number) =>
    insertPushDelivery(db, { id, userId, subId: `s-${userId}`, circleId, kind: "plan", refId: "p", batchId, createdAt: at });
  row("d-fam", "dan", "fam", "b-fam", now + 2);
  markPushFailed(db, "d-fam", 410);
  row("d-jd", "dan", "jd", "b-jd", now + 6);
  markPushDelivered(db, "d-jd");
  // Eve was delivered in an older Jumping Dinner batch; only the latest counts.
  row("e-old", "eve", "jd", "b-jd-old", now + 3);
  markPushDelivered(db, "e-old");
  row("e-new", "eve", "jd", "b-jd", now + 6);
  // A row for another kind or another plan never counts.
  row("e-chat", "eve", "jd", "b-chat", now + 9);
  db.prepare("UPDATE push_deliveries SET kind = 'chat', status = 'delivered' WHERE id = 'e-chat'").run();

  const roster = pushSummaryForPlan(db, "p", "host", "host");
  assert.deepEqual(roster?.people.map((person) => [person.name, person.status]), [["Dan", "delivered"], ["Eve", "sent"]]);
  assert.equal(roster?.delivered, 1);
  assert.equal(pushSummaryForPlan(db, "p", "host", "dan"), undefined);
  assert.equal(pushSummaryForPlan(db, "p", "host", null), undefined);
  db.close();
});

function count(db: DatabaseSync, table: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number | bigint }).n);
}
