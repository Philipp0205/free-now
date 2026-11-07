import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { openDb, sweep } from "../src/db.js";
import { REMIND_COOLDOWN_MS } from "../src/plans.js";
import { api, START, withApp, type SentPush } from "./http.js";

type Person = { token: string; user: { id: string; name: string } };

const MINUTE = 60 * 1000;
const to = (person: Person) => `https://push.example/${person.user.id}`;
const endpoints = (sent: SentPush[]) => sent.map((item) => item.endpoint).sort();

function remindAlerts(db: DatabaseSync, userId: string): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = 'plan-remind'").get(userId) as { n: number };
  return Number(row.n);
}

function remindCircles(db: DatabaseSync, userId: string): string[] {
  return (db.prepare("SELECT circle_id FROM notifications WHERE user_id = ? AND kind = 'plan-remind'").all(userId) as Array<{ circle_id: string }>)
    .map((row) => row.circle_id)
    .sort();
}

async function subscribe(port: number, person: Person) {
  await api(port, "POST", "/api/push/subscribe", {
    token: person.token,
    body: { endpoint: to(person), keys: { p256dh: "p", auth: "a" } },
    status: 204,
  });
}

/** Alex hosts "Lunch" in Duo. Bea is an old member with push. */
async function seed(port: number) {
  const alex: Person = await api(port, "POST", "/api/auth/start", { body: { name: "Alex" }, status: 201 });
  const circle = (await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Duo" }, status: 201 })).circle;
  const bea: Person = await api(port, "POST", "/api/auth/start", { body: { name: "Bea", code: circle.inviteCode }, status: 201 });
  await subscribe(port, alex);
  await subscribe(port, bea);
  const plan = (await api(port, "POST", "/api/plans", { token: alex.token, body: { note: "Lunch" }, status: 201 })).plan;
  return { alex, bea, circle, plan };
}

const join = (port: number, name: string, code: string): Promise<Person> =>
  api(port, "POST", "/api/auth/start", { body: { name, code }, status: 201 });

const remind = (port: number, person: Person, planId: string, circleId?: string) =>
  api({ port }, "POST", `/api/plans/${planId}/remind${circleId ? `?circle=${circleId}` : ""}`, { token: person.token, body: {} });

async function listed(port: number, person: Person, planId: string, circleId?: string) {
  const plans = (await api(port, "GET", `/api/plans${circleId ? `?circle=${circleId}` : ""}`, { token: person.token, status: 200 })).plans;
  return plans.find((row: { id: string }) => row.id === planId);
}

test("plan predates join: the newcomer gets the reminder Alert without push, and a push with one", async () => {
  await withApp(async ({ port, sent, db, advance }) => {
    const { alex, circle, plan } = await seed(port);
    advance(10 * MINUTE);
    const kim = await join(port, "Kim", circle.inviteCode);
    const dee = await join(port, "Dee", circle.inviteCode);
    await subscribe(port, dee);
    sent.length = 0;
    const res = await api(port, "POST", `/api/plans/${plan.id}/remind`, { token: alex.token, body: {}, status: 200 });
    assert.equal(res.reminded, 3, "Bea, Kim, Dee");
    assert.equal(remindAlerts(db, kim.user.id), 1, "Kim has no push, still an Alert");
    assert.equal(remindAlerts(db, dee.user.id), 1);
    assert.ok(endpoints(sent).includes(to(dee)), "Dee's phone rings");
    assert.ok(!endpoints(sent).includes(to(alex)), "not the sender");
  }, { sent: "envelope" });
});

test("reminder before the join, then after it: the newcomer is reminded, old members are not reminded twice", async () => {
  await withApp(async ({ port, sent, db, advance }) => {
    const { alex, bea, circle, plan } = await seed(port);
    const first = await api(port, "POST", `/api/plans/${plan.id}/remind`, { token: alex.token, body: {}, status: 200 });
    assert.equal(first.reminded, 1, "Bea");
    assert.equal(remindAlerts(db, bea.user.id), 1);

    advance(10 * MINUTE);
    const kim = await join(port, "Kim", circle.inviteCode);
    await subscribe(port, kim);
    sent.length = 0;
    const res = await remind(port, bea, plan.id);
    assert.equal(res.status, 200, `newcomer reminder blocked: ${res.status} ${JSON.stringify(res.json)}`);
    assert.equal(res.json.reminded, 1, "only Kim");
    assert.deepEqual(endpoints(sent), [to(kim)]);
    assert.equal(remindAlerts(db, kim.user.id), 1);
    assert.equal(remindAlerts(db, bea.user.id), 1, "Bea not spammed within the hour");
    assert.equal(remindAlerts(db, alex.user.id), 0);
    // The hour still runs from the first reminder.
    assert.equal(res.json.plan.remindAgainAt, START + REMIND_COOLDOWN_MS);

    // Kim sees it in her Alerts list and the bell counts it.
    const notes = await api(port, "GET", `/api/notifications?circle=${circle.id}`, { token: kim.token, status: 200 });
    assert.ok(notes.notifications.some((row: { kind: string }) => row.kind === "plan-remind"));
    assert.ok((notes.unreadByCircle[circle.id] ?? 0) >= 1);

    // Nobody new: still 429 inside the hour, nothing sent.
    sent.length = 0;
    const again = await remind(port, alex, plan.id);
    assert.equal(again.status, 429);
    assert.equal(again.json.retryAt, START + REMIND_COOLDOWN_MS);
    assert.equal(sent.length, 0);
    assert.equal(remindAlerts(db, bea.user.id), 1);
    assert.equal(remindAlerts(db, kim.user.id), 1);
  }, { sent: "envelope" });
});

test("Alerts gone (cleared or pruned) inside the hour: old members are still not reminded again", async () => {
  await withApp(async ({ port, sent, db, advance }) => {
    const { alex, bea, circle, plan } = await seed(port);
    await api(port, "POST", `/api/plans/${plan.id}/remind`, { token: alex.token, body: {}, status: 200 });
    // Bea's Alert disappears, the way a cleared list or the monthly prune would drop it.
    db.prepare("DELETE FROM notifications WHERE user_id = ?").run(bea.user.id);
    advance(5 * MINUTE);
    const kim = await join(port, "Kim", circle.inviteCode);
    await subscribe(port, kim);
    sent.length = 0;
    const res = await remind(port, alex, plan.id);
    assert.equal(res.status, 200);
    assert.equal(res.json.reminded, 1, "only Kim");
    assert.deepEqual(endpoints(sent), [to(kim)]);
    assert.equal(remindAlerts(db, bea.user.id), 0, "Bea is not re-notified");

    // Every reminder Alert gone, then the sweep runs too: still nobody to remind.
    db.prepare("DELETE FROM notifications").run();
    sweep(db, START + 10 * MINUTE, "2026-01-01", "2026-06-01");
    sent.length = 0;
    const again = await remind(port, bea, plan.id);
    assert.equal(again.status, 429);
    assert.equal(again.json.retryAt, START + REMIND_COOLDOWN_MS);
    assert.equal(sent.length, 0);
    assert.equal(remindAlerts(db, alex.user.id) + remindAlerts(db, kim.user.id), 0);
    assert.equal((await listed(port, bea, plan.id)).remindAgainAt, START + REMIND_COOLDOWN_MS, "menu stays grey");
  }, { sent: "envelope" });
});

test("a linked circle is deleted inside the hour: someone reminded there is not reminded again in another circle", async () => {
  await withApp(async ({ port, sent, db, advance }) => {
    const { alex, bea, circle, plan } = await seed(port);
    // Climbing: Alex and Dan. Dan is not in Duo yet.
    const climbing = (await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Climbing" }, status: 201 })).circle;
    const dan = await join(port, "Dan", climbing.inviteCode);
    await subscribe(port, dan);
    await api(port, "PATCH", `/api/plans/${plan.id}?circle=${circle.id}`, { token: alex.token, body: { circleIds: [circle.id, climbing.id] }, status: 200 });
    sent.length = 0;
    const first = await api(port, "POST", `/api/plans/${plan.id}/remind?circle=${circle.id}`, { token: alex.token, body: {}, status: 200 });
    assert.equal(first.reminded, 2, "Bea and Dan");
    assert.deepEqual(remindCircles(db, dan.user.id), [climbing.id]);

    // Deleting Climbing removes its Alerts (by circle_id), Dan's reminder with them. Dan then joins Duo.
    await api(port, "DELETE", `/api/circles?circle=${climbing.id}`, { token: alex.token, status: 200 });
    assert.equal(remindAlerts(db, dan.user.id), 0);
    advance(5 * MINUTE);
    await api(port, "POST", "/api/circles/join", { token: dan.token, body: { code: circle.inviteCode }, status: 200 });
    assert.equal((await listed(port, bea, plan.id, circle.id)).remindAgainAt, START + REMIND_COOLDOWN_MS, "nobody new for Bea");
    sent.length = 0;
    const blocked = await remind(port, bea, plan.id, circle.id);
    assert.equal(blocked.status, 429);
    assert.equal(sent.length, 0);

    // A real newcomer still gets it, and only them.
    const kim = await join(port, "Kim", circle.inviteCode);
    await subscribe(port, kim);
    sent.length = 0;
    const res = await remind(port, bea, plan.id, circle.id);
    assert.equal(res.status, 200);
    assert.equal(res.json.reminded, 1, "only Kim");
    assert.deepEqual(endpoints(sent), [to(kim)]);
    assert.equal(remindAlerts(db, dan.user.id), 0, "Dan is not re-notified");
  }, { sent: "envelope" });
});

test("after the hour, everyone who still has not answered is reminded again", async () => {
  await withApp(async ({ port, sent, at }) => {
    const { alex, bea, circle, plan } = await seed(port);
    await api(port, "POST", `/api/plans/${plan.id}/remind`, { token: alex.token, body: {}, status: 200 });
    at(START + 30 * MINUTE);
    const kim = await join(port, "Kim", circle.inviteCode);
    await subscribe(port, kim);
    await api(port, "POST", `/api/plans/${plan.id}/remind`, { token: bea.token, body: {}, status: 200 });
    at(START + REMIND_COOLDOWN_MS);
    sent.length = 0;
    const next = await api(port, "POST", `/api/plans/${plan.id}/remind`, { token: alex.token, body: {}, status: 200 });
    assert.equal(next.reminded, 2, "Bea and Kim");
    assert.deepEqual(endpoints(sent), [to(bea), to(kim)].sort());
    assert.equal(next.plan.remindAgainAt, START + 2 * REMIND_COOLDOWN_MS);
  }, { sent: "envelope" });
});

test("leaving the circle or losing access: never notified, also a newcomer who leaves before the reminder", async () => {
  await withApp(async ({ port, sent, db, advance }) => {
    const { alex, bea, circle, plan } = await seed(port);
    const cam = await join(port, "Cam", circle.inviteCode);
    await subscribe(port, cam);
    const out = await join(port, "Olli", circle.inviteCode);
    await subscribe(port, out);
    // Cam leaves, Olli is kicked by the admin. Neither can see the plan now.
    await api(port, "POST", `/api/circles/leave?circle=${circle.id}`, { token: cam.token, body: {}, status: 200 });
    await api(port, "DELETE", `/api/circles/members/${out.user.id}?circle=${circle.id}`, { token: alex.token, status: 204 });
    sent.length = 0;
    const first = await api(port, "POST", `/api/plans/${plan.id}/remind`, { token: alex.token, body: {}, status: 200 });
    assert.equal(first.reminded, 1, "Bea");
    assert.deepEqual(endpoints(sent), [to(bea)]);

    // A newcomer joins inside the hour, then leaves again before anyone reminds.
    advance(5 * MINUTE);
    const kim = await join(port, "Kim", circle.inviteCode);
    await subscribe(port, kim);
    assert.equal((await listed(port, bea, plan.id)).remindAgainAt, null, "Kim to remind");
    await api(port, "POST", `/api/circles/leave?circle=${circle.id}`, { token: kim.token, body: {}, status: 200 });
    assert.equal((await listed(port, bea, plan.id)).remindAgainAt, START + REMIND_COOLDOWN_MS, "nobody new now");
    sent.length = 0;
    const res = await remind(port, bea, plan.id);
    assert.equal(res.status, 429);
    assert.equal(sent.length, 0);
    for (const person of [cam, out, kim]) assert.equal(remindAlerts(db, person.user.id), 0, person.user.name);
  }, { sent: "envelope" });
});

test("inside the hour: sender, host, In, Can't and removed are left out, Maybe newcomers are reminded", async () => {
  await withApp(async ({ port, sent, db, advance }) => {
    const { alex, bea, circle, plan } = await seed(port);
    await api(port, "POST", `/api/plans/${plan.id}/remind`, { token: alex.token, body: {}, status: 200 });
    advance(5 * MINUTE);
    const names = ["Ina", "Cat", "Rex", "May", "Sam"];
    const [ina, cat, rex, may, sam] = await Promise.all(names.map((name) => join(port, name, circle.inviteCode)));
    for (const person of [ina, cat, rex, may, sam]) await subscribe(port, person);
    await api(port, "POST", `/api/plans/${plan.id}/reply`, { token: ina.token, body: { reply: "in" }, status: 200 });
    await api(port, "POST", `/api/plans/${plan.id}/reply`, { token: cat.token, body: { reply: "cant" }, status: 200 });
    await api(port, "POST", `/api/plans/${plan.id}/reply`, { token: may.token, body: { reply: "maybe" }, status: 200 });
    await api(port, "DELETE", `/api/plans/${plan.id}/people/${rex.user.id}`, { token: alex.token, status: 204 });
    sent.length = 0;

    // Sam is a newcomer too and sends it. Alex is the host, Bea was reminded already.
    const res = await remind(port, sam, plan.id);
    assert.equal(res.status, 200);
    assert.equal(res.json.reminded, 1, "May");
    assert.deepEqual(endpoints(sent), [to(may)]);
    for (const person of [alex, bea, ina, cat, rex, sam]) {
      assert.equal(remindAlerts(db, person.user.id), person === bea ? 1 : 0, person.user.name);
    }
    assert.equal(remindAlerts(db, may.user.id), 1);
  }, { sent: "envelope" });
});

test("inside the hour: whoever sent the first reminder is not reminded by a later newcomer reminder", async () => {
  await withApp(async ({ port, sent, db, advance }) => {
    const { alex, bea, circle, plan } = await seed(port);
    const cam = await join(port, "Cam", circle.inviteCode);
    await subscribe(port, cam);
    // Bea, a guest who has not answered, sends the first one. It reaches Cam.
    const first = await api(port, "POST", `/api/plans/${plan.id}/remind`, { token: bea.token, body: {}, status: 200 });
    assert.equal(first.reminded, 1, "Cam");
    advance(5 * MINUTE);
    const kim = await join(port, "Kim", circle.inviteCode);
    await subscribe(port, kim);
    sent.length = 0;
    const res = await remind(port, cam, plan.id);
    assert.equal(res.status, 200);
    assert.equal(res.json.reminded, 1, "only Kim, not Bea");
    assert.deepEqual(endpoints(sent), [to(kim)]);
    assert.equal(remindAlerts(db, bea.user.id), 0);
    assert.equal(remindAlerts(db, alex.user.id), 0);
  }, { sent: "envelope" });
});

test("remindAgainAt per viewer: null with a newcomer to remind, set when none, set when the only one left is the viewer", async () => {
  await withApp(async ({ port, advance }) => {
    const { alex, bea, circle, plan } = await seed(port);
    await api(port, "POST", `/api/plans/${plan.id}/remind`, { token: alex.token, body: {}, status: 200 });
    const hour = START + REMIND_COOLDOWN_MS;
    assert.equal((await listed(port, alex, plan.id)).remindAgainAt, hour);
    assert.equal((await listed(port, bea, plan.id)).remindAgainAt, hour);

    advance(5 * MINUTE);
    const kim = await join(port, "Kim", circle.inviteCode);
    assert.equal((await listed(port, alex, plan.id)).remindAgainAt, null, "Alex can remind Kim");
    assert.equal((await listed(port, bea, plan.id)).remindAgainAt, null, "Bea can remind Kim");
    // Kim's only extra target would be Kim herself, so her menu stays grey.
    assert.equal((await listed(port, kim, plan.id)).remindAgainAt, hour);
    // remindedAt stays the hour's start for everyone.
    assert.equal((await listed(port, alex, plan.id)).remindedAt, START);

    await api(port, "POST", `/api/plans/${plan.id}/remind`, { token: bea.token, body: {}, status: 200 });
    for (const person of [alex, bea, kim]) assert.equal((await listed(port, person, plan.id)).remindAgainAt, hour, person.user.name);
  }, { sent: "envelope" });
});

test("linked circles: one push per person, an Alert per circle, a newcomer in two linked circles too", async () => {
  await withApp(async ({ port, sent, db, advance }) => {
    const { alex, bea, circle, plan } = await seed(port);
    const climbing = (await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Climbing" }, status: 201 })).circle;
    const dan = await join(port, "Dan", climbing.inviteCode);
    await api(port, "POST", "/api/circles/join", { token: dan.token, body: { code: circle.inviteCode }, status: 200 });
    await subscribe(port, dan);
    await api(port, "PATCH", `/api/plans/${plan.id}?circle=${circle.id}`, { token: alex.token, body: { circleIds: [circle.id, climbing.id] }, status: 200 });
    sent.length = 0;
    const first = await api(port, "POST", `/api/plans/${plan.id}/remind?circle=${circle.id}`, { token: alex.token, body: {}, status: 200 });
    assert.equal(first.reminded, 2, "Bea and Dan");
    assert.deepEqual(endpoints(sent), [to(bea), to(dan)].sort());
    assert.deepEqual(remindCircles(db, dan.user.id), [circle.id, climbing.id].sort());

    // Nia joins both linked circles inside the hour.
    advance(5 * MINUTE);
    const nia = await join(port, "Nia", circle.inviteCode);
    await api(port, "POST", "/api/circles/join", { token: nia.token, body: { code: climbing.inviteCode }, status: 200 });
    await subscribe(port, nia);
    sent.length = 0;
    const res = await remind(port, dan, plan.id, climbing.id);
    assert.equal(res.status, 200);
    assert.equal(res.json.reminded, 1, "Nia, once");
    assert.deepEqual(endpoints(sent), [to(nia)]);
    assert.deepEqual(remindCircles(db, nia.user.id), [circle.id, climbing.id].sort());
    assert.deepEqual(remindCircles(db, dan.user.id), [circle.id, climbing.id].sort(), "Dan not again");
    assert.equal(remindAlerts(db, bea.user.id), 1);
  }, { sent: "envelope" });
});

test("double tap and two senders at once inside the hour: the newcomer is reminded once", async () => {
  await withApp(async ({ port, sent, db, advance }) => {
    const { alex, bea, circle, plan } = await seed(port);
    await api(port, "POST", `/api/plans/${plan.id}/remind`, { token: alex.token, body: {}, status: 200 });
    advance(5 * MINUTE);
    const kim = await join(port, "Kim", circle.inviteCode);
    await subscribe(port, kim);
    sent.length = 0;
    const results = await Promise.all([alex, alex, bea].map((person) => remind(port, person, plan.id)));
    assert.deepEqual(results.map((item) => item.status).sort(), [200, 429, 429]);
    for (const item of results.filter((row) => row.status === 429)) assert.equal(item.json.retryAt, START + REMIND_COOLDOWN_MS);
    assert.deepEqual(endpoints(sent), [to(kim)]);
    assert.equal(remindAlerts(db, kim.user.id), 1);
    assert.equal(remindAlerts(db, bea.user.id), 1);
  }, { sent: "envelope" });
});

test("a newcomer without a push subscription still gets the in-app Alert", async () => {
  await withApp(async ({ port, sent, db, advance }) => {
    const { alex, bea, circle, plan } = await seed(port);
    await api(port, "POST", `/api/plans/${plan.id}/remind`, { token: alex.token, body: {}, status: 200 });
    advance(5 * MINUTE);
    const kim = await join(port, "Kim", circle.inviteCode);
    sent.length = 0;
    const res = await remind(port, bea, plan.id);
    assert.equal(res.status, 200);
    assert.equal(res.json.reminded, 1);
    assert.equal(sent.length, 0, "no phone to ring");
    assert.equal(remindAlerts(db, kim.user.id), 1);
    const notes = await api(port, "GET", `/api/notifications?circle=${circle.id}`, { token: kim.token, status: 200 });
    assert.ok(notes.notifications.some((row: { kind: string }) => row.kind === "plan-remind"));
  }, { sent: "envelope" });
});

test("the hour is not reset by a newcomer-only reminder", async () => {
  await withApp(async ({ port, sent, db, at }) => {
    const { alex, bea, circle, plan } = await seed(port);
    await api(port, "POST", `/api/plans/${plan.id}/remind`, { token: alex.token, body: {}, status: 200 });
    at(START + 50 * MINUTE);
    await join(port, "Kim", circle.inviteCode);
    const late = await api(port, "POST", `/api/plans/${plan.id}/remind`, { token: bea.token, body: {}, status: 200 });
    assert.equal(late.plan.remindedAt, START);
    assert.equal(late.plan.remindAgainAt, START + REMIND_COOLDOWN_MS);
    const row = db.prepare("SELECT reminded_at FROM plans WHERE id = ?").get(plan.id) as { reminded_at: number };
    assert.equal(row.reminded_at, START);

    // Nobody new at minute 59: 429. At the hour it opens for everyone.
    at(START + 59 * MINUTE);
    assert.equal((await remind(port, alex, plan.id)).status, 429);
    at(START + REMIND_COOLDOWN_MS);
    sent.length = 0;
    const open = await api(port, "POST", `/api/plans/${plan.id}/remind`, { token: alex.token, body: {}, status: 200 });
    assert.equal(open.reminded, 2, "Bea and Kim");
  }, { sent: "envelope" });
});

test("a deleted plan takes its reminder records with it", async () => {
  await withApp(async ({ port, db }) => {
    const { alex, plan } = await seed(port);
    await api(port, "POST", `/api/plans/${plan.id}/remind`, { token: alex.token, body: {}, status: 200 });
    const count = () => Number((db.prepare("SELECT COUNT(*) AS n FROM plan_reminders WHERE plan_id = ?").get(plan.id) as { n: number }).n);
    assert.equal(count(), 2, "Bea and the sender");
    db.prepare("UPDATE plans SET for_date = '2026-01-01' WHERE id = ?").run(plan.id);
    sweep(db, START, "2026-05-01", "2026-06-01");
    assert.equal(count(), 0);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  });
});

test("an old database gains plan_reminders on boot, seeded from its reminder Alerts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hangry-plan-reminders-"));
  const file = path.join(dir, "old.db");
  try {
    const first = openDb(file);
    first.exec(`
      INSERT INTO users (id, name, token_hash, buzz_token, created_at) VALUES ('u', 'A', 'h', 'b', 0);
      INSERT INTO users (id, name, token_hash, buzz_token, created_at) VALUES ('v', 'B', 'h2', 'b2', 0);
      INSERT INTO circles (id, name, invite_code, created_by, created_at) VALUES ('c', 'One', 'CODE1111', 'u', 0);
      INSERT INTO plans (id, circle_id, creator_id, note, for_date, created_at, reminded_at) VALUES ('p', 'c', 'u', 'x', '2026-06-02', 5, 100);
      INSERT INTO notifications (id, user_id, title, body, kind, ref_id, circle_id, created_at) VALUES ('n1', 'v', 't', 'b', 'plan-remind', 'p', 'c', 100);
      INSERT INTO notifications (id, user_id, title, body, kind, ref_id, circle_id, created_at) VALUES ('n2', 'v', 't', 'b', 'plan-remind', 'p', 'c', 90);
      INSERT INTO notifications (id, user_id, title, body, kind, ref_id, circle_id, created_at) VALUES ('n3', 'v', 't', 'b', 'plan-remind', 'gone', 'c', 100);
      INSERT INTO notifications (id, user_id, title, body, kind, ref_id, circle_id, created_at) VALUES ('n4', 'u', 't', 'b', 'plan-new', 'p', 'c', 100);
      DROP TABLE plan_reminders;
    `);
    first.close();
    const second = openDb(file);
    const rows = second.prepare("SELECT plan_id, user_id, reminded_at FROM plan_reminders").all().map((row) => ({ ...row }));
    assert.deepEqual(rows, [{ plan_id: "p", user_id: "v", reminded_at: 90 }]);
    const plan = second.prepare("SELECT note, reminded_at FROM plans WHERE id = 'p'").get() as { note: string; reminded_at: number };
    assert.deepEqual({ ...plan }, { note: "x", reminded_at: 100 });
    second.close();
    // Booting again keeps the table as it is.
    const third = openDb(file);
    assert.equal(third.prepare("SELECT COUNT(*) AS n FROM plan_reminders").get()?.n, 1);
    third.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
