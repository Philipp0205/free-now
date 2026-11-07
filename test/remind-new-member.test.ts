import assert from "node:assert/strict";
import test from "node:test";
import type { DatabaseSync } from "node:sqlite";
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
    const res = await api({ port }, "POST", `/api/plans/${plan.id}/remind`, { token: bea.token, body: {} });
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
    assert.ok(notes.notifications.some((row: { kind: string; refId?: string; ref_id?: string }) => row.kind === "plan-remind"));
    assert.ok((notes.unreadByCircle[circle.id] ?? 0) >= 1);

    // Nobody new: still 429 inside the hour, nothing sent.
    sent.length = 0;
    const again = await api({ port }, "POST", `/api/plans/${plan.id}/remind`, { token: alex.token, body: {} });
    assert.equal(again.status, 429);
    assert.equal(again.json.retryAt, START + REMIND_COOLDOWN_MS);
    assert.equal(sent.length, 0);
    assert.equal(remindAlerts(db, bea.user.id), 1);
    assert.equal(remindAlerts(db, kim.user.id), 1);
  }, { sent: "envelope" });
});
