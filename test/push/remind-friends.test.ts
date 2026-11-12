import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../../src/db.js";
import { planRemindTitle } from "../../src/push/notify.js";
import { REMIND_COOLDOWN_MS } from "../../src/social/plans.js";
import { api, START, withApp, type SentPush } from "../http.js";

type Person = { token: string; user: { id: string; name: string } };

const MINUTE = 60 * 1000;

/**
 * Friends (A): Alex, Bea, Dan, Kim. Climbing (B): Alex, Cam, Dan.
 * Dan is in both. Kim has notifications off (no push subscription).
 */
async function seed(port: number) {
  const start = (name: string, code?: string): Promise<Person> =>
    api(port, "POST", "/api/auth/start", { body: code ? { name, code } : { name }, status: 201 });
  const alex = await start("Alex");
  const a = (await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Friends" }, status: 201 })).circle;
  const bea = await start("Bea", a.inviteCode);
  const dan = await start("Dan", a.inviteCode);
  const kim = await start("Kim", a.inviteCode);
  const b = (await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Climbing" }, status: 201 })).circle;
  const cam = await start("Cam", b.inviteCode);
  await api(port, "POST", "/api/circles/join", { token: dan.token, body: { code: b.inviteCode }, status: 200 });
  const out = await start("Olli");
  await api(port, "POST", "/api/circles", { token: out.token, body: { name: "Elsewhere" }, status: 201 });
  for (const person of [alex, bea, cam, dan, out]) {
    await api(port, "POST", "/api/push/subscribe", {
      token: person.token,
      body: { endpoint: to(person), keys: { p256dh: "p", auth: "a" } },
      status: 204,
    });
  }
  return { alex, bea, cam, dan, kim, out, a, b };
}

const to = (person: Person) => `https://push.example/${person.user.id}`;
const endpoints = (sent: SentPush[]) => sent.map((item) => item.endpoint).sort();

async function makePlan(port: number, host: Person, circleId: string, body: Record<string, unknown> = {}) {
  return (await api(port, "POST", `/api/plans?circle=${circleId}`, {
    token: host.token,
    body: { note: "Bouldering", place: "Hall", date: "2026-06-02", time: "18:00", ...body },
    status: 201,
  })).plan;
}

function alerts(db: DatabaseSync, userId: string): Array<{ circle_id: string; title: string; body: string; ref_id: string }> {
  return (db.prepare(
    "SELECT circle_id, title, body, ref_id FROM notifications WHERE user_id = ? AND kind = 'plan-remind' ORDER BY rowid",
  ).all(userId) as Array<{ circle_id: string; title: string; body: string; ref_id: string }>).map((row) => ({ ...row }));
}

test("the reminder title reads like the app: sender, title, day and time", () => {
  assert.equal(planRemindTitle("Alex", "Board games", "Tomorrow", "19:00"), "Alex reminds you: Board games, Tomorrow · 19:00");
  assert.equal(planRemindTitle("Alex", "Picnic", "Sat 6 Jun", null), "Alex reminds you: Picnic, Sat 6 Jun");
  assert.equal(planRemindTitle("Alex", "  ", "Today", null), "Alex reminds you: the plan, Today");
});

test("POST /api/plans/:id/remind pushes only people who have not answered, once each, across circles", async () => {
  await withApp(async ({ port, sent, db }) => {
    const { alex, bea, cam, dan, kim, a, b } = await seed(port);
    const plan = await makePlan(port, alex, a.id);
    await api(port, "PATCH", `/api/plans/${plan.id}?circle=${a.id}`, { token: alex.token, body: { circleIds: [a.id, b.id] }, status: 200 });
    // Bea said in. Cam said can't. Dan and Kim never answered.
    await api(port, "POST", `/api/plans/${plan.id}/reply?circle=${a.id}`, { token: bea.token, body: { reply: "in" }, status: 200 });
    await api(port, "POST", `/api/plans/${plan.id}/reply?circle=${b.id}`, { token: cam.token, body: { reply: "cant" }, status: 200 });
    sent.length = 0;

    const res = await api(port, "POST", `/api/plans/${plan.id}/remind?circle=${a.id}`, { token: alex.token, body: {}, status: 200 });
    assert.equal(res.reminded, 2, "Dan and Kim");
    assert.equal(res.plan.id, plan.id);
    assert.equal(res.plan.remindedAt, START);
    assert.equal(res.plan.remindAgainAt, START + REMIND_COOLDOWN_MS);

    // Kim has notifications off, so only Dan's phone rings, and only once although he is in both circles.
    assert.deepEqual(endpoints(sent), [to(dan)]);
    const push = sent[0].payload;
    assert.equal(push.title, "Alex reminds you: Bouldering, Tomorrow · 18:00");
    assert.equal(push.body, "Hall · Friends", "Dan is in two circles, so the body names the circle like other pushes");
    assert.equal(push.tag, `plan-remind:${plan.id}`);
    assert.match(push.url, new RegExp(`^/\\?plan=${plan.id}&circle=${a.id}$`));

    // Alerts: Dan in both circles, Kim in Friends even without push. Nobody who answered, not the sender.
    assert.deepEqual(alerts(db, dan.user.id).map((row) => row.circle_id).sort(), [a.id, b.id].sort());
    assert.deepEqual(alerts(db, kim.user.id).map((row) => row.circle_id), [a.id]);
    assert.equal(alerts(db, kim.user.id)[0].title, "Alex reminds you: Bouldering, Tomorrow · 18:00");
    assert.equal(alerts(db, kim.user.id)[0].body, "Hall");
    assert.equal(alerts(db, kim.user.id)[0].ref_id, plan.id);
    for (const person of [alex, bea, cam]) assert.deepEqual(alerts(db, person.user.id), [], person.user.name);

    // The bell and the circle dot count it.
    const kimNotes = await api(port, "GET", `/api/notifications?circle=${a.id}`, { token: kim.token, status: 200 });
    assert.equal(kimNotes.notifications[0].kind, "plan-remind");
    assert.equal(kimNotes.unreadByCircle[a.id] >= 1, true);
    const danMe = await api(port, "GET", "/api/me", { token: dan.token, status: 200 });
    for (const circle of danMe.circles) assert.ok(circle.alertUnread >= 1, `dot in ${circle.name}`);
  }, { sent: "envelope" });
});

test("a guest can remind too, and the host (who is always in) is skipped", async () => {
  await withApp(async ({ port, sent, db }) => {
    const { alex, bea, dan, kim, a } = await seed(port);
    const plan = await makePlan(port, alex, a.id, { place: "" });
    sent.length = 0;
    const res = await api(port, "POST", `/api/plans/${plan.id}/remind?circle=${a.id}`, { token: bea.token, body: {}, status: 200 });
    assert.equal(res.reminded, 2, "Dan and Kim, not Alex the host, not Bea the sender");
    assert.deepEqual(endpoints(sent), [to(dan)]);
    assert.equal(sent[0].payload.title, "Bea reminds you: Bouldering, Tomorrow · 18:00");
    assert.equal(alerts(db, alex.user.id).length, 0);
    assert.equal(alerts(db, bea.user.id).length, 0);
    assert.equal(alerts(db, kim.user.id).length, 1);
    assert.equal(alerts(db, kim.user.id)[0].body, "Tap to see the plan.");
  }, { sent: "envelope" });
});

test("cooldown: a second reminder within the hour is 429 with retryAt, for any sender, and it opens after an hour", async () => {
  await withApp(async ({ port, sent, at }) => {
    const { alex, bea, dan, a } = await seed(port);
    const plan = await makePlan(port, alex, a.id);
    await api(port, "POST", `/api/plans/${plan.id}/remind?circle=${a.id}`, { token: alex.token, body: {}, status: 200 });

    at(START + 59 * MINUTE);
    sent.length = 0;
    for (const person of [alex, bea]) {
      const again = await api({ port }, "POST", `/api/plans/${plan.id}/remind?circle=${a.id}`, { token: person.token, body: {} });
      assert.equal(again.status, 429);
      assert.equal(again.json.retryAt, START + REMIND_COOLDOWN_MS);
      assert.ok(again.json.error);
    }
    assert.equal(sent.length, 0, "no push during cooldown");

    // The list shows the cooldown too, so the menu can grey out.
    const listed = (await api(port, "GET", `/api/plans?circle=${a.id}`, { token: bea.token, status: 200 })).plans
      .find((row: { id: string }) => row.id === plan.id);
    assert.equal(listed.remindAgainAt, START + REMIND_COOLDOWN_MS);

    at(START + REMIND_COOLDOWN_MS);
    const later = await api(port, "POST", `/api/plans/${plan.id}/remind?circle=${a.id}`, { token: bea.token, body: {}, status: 200 });
    assert.equal(later.plan.remindAgainAt, START + 2 * REMIND_COOLDOWN_MS);
    assert.deepEqual(endpoints(sent), [to(dan)]);
  }, { sent: "envelope" });
});

test("when everyone has answered: reminded 0, nothing sent, and the cooldown does not start", async () => {
  await withApp(async ({ port, sent, db }) => {
    const alex = await api(port, "POST", "/api/auth/start", { body: { name: "Alex" }, status: 201 });
    const circle = (await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Duo" }, status: 201 })).circle;
    const bea = await api(port, "POST", "/api/auth/start", { body: { name: "Bea", code: circle.inviteCode }, status: 201 });
    const cam = await api(port, "POST", "/api/auth/start", { body: { name: "Cam", code: circle.inviteCode }, status: 201 });
    const plan = (await api(port, "POST", "/api/plans", { token: alex.token, body: { note: "Lunch" }, status: 201 })).plan;
    await api(port, "POST", `/api/plans/${plan.id}/reply`, { token: bea.token, body: { reply: "in" }, status: 200 });
    await api(port, "POST", `/api/plans/${plan.id}/reply`, { token: cam.token, body: { reply: "declined" }, status: 200 });
    sent.length = 0;

    const res = await api(port, "POST", `/api/plans/${plan.id}/remind`, { token: alex.token, body: {}, status: 200 });
    assert.equal(res.reminded, 0);
    assert.equal(res.plan.remindAgainAt, null);
    assert.equal(sent.length, 0);
    const rows = db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'plan-remind'").get() as { n: number };
    assert.equal(Number(rows.n), 0);

    // Cam changes nothing, but a newcomer arrives: a reminder still works right away.
    const dee = await api(port, "POST", "/api/auth/start", { body: { name: "Dee", code: circle.inviteCode }, status: 201 });
    const next = await api(port, "POST", `/api/plans/${plan.id}/remind`, { token: bea.token, body: {}, status: 200 });
    assert.equal(next.reminded, 1);
    assert.equal(alerts(db, dee.user.id).length, 1);
  }, { sent: "envelope" });
});

test("Maybe is tentative: Maybe people get the reminder, In and Can't are skipped", async () => {
  await withApp(async ({ port, sent, db }) => {
    const { alex, bea, cam, dan, kim, a, b } = await seed(port);
    const plan = await makePlan(port, alex, a.id);
    await api(port, "PATCH", `/api/plans/${plan.id}?circle=${a.id}`, { token: alex.token, body: { circleIds: [a.id, b.id] }, status: 200 });
    // Bea said in, Cam said can't, Dan and Kim said maybe.
    await api(port, "POST", `/api/plans/${plan.id}/reply?circle=${a.id}`, { token: bea.token, body: { reply: "in" }, status: 200 });
    await api(port, "POST", `/api/plans/${plan.id}/reply?circle=${b.id}`, { token: cam.token, body: { reply: "cant" }, status: 200 });
    await api(port, "POST", `/api/plans/${plan.id}/reply?circle=${a.id}`, { token: dan.token, body: { reply: "maybe" }, status: 200 });
    await api(port, "POST", `/api/plans/${plan.id}/reply?circle=${a.id}`, { token: kim.token, body: { reply: "maybe" }, status: 200 });
    sent.length = 0;

    const res = await api(port, "POST", `/api/plans/${plan.id}/remind?circle=${a.id}`, { token: alex.token, body: {}, status: 200 });
    assert.equal(res.reminded, 2, "Dan and Kim, both maybe");
    assert.equal(res.plan.remindAgainAt, START + REMIND_COOLDOWN_MS);
    // Dan's phone rings once although he is in both circles. Kim has notifications off.
    assert.deepEqual(endpoints(sent), [to(dan)]);
    assert.deepEqual(alerts(db, dan.user.id).map((row) => row.circle_id).sort(), [a.id, b.id].sort());
    assert.equal(alerts(db, kim.user.id).length, 1);
    for (const person of [alex, bea, cam]) assert.deepEqual(alerts(db, person.user.id), [], person.user.name);
    // Their Maybe stays as it was.
    const joined = res.plan.joined as Array<{ id: string; reply: string }>;
    assert.equal(joined.find((row) => row.id === dan.user.id)?.reply, "maybe");
  }, { sent: "envelope" });
});

test("everyone In or Can't except one Maybe: that Maybe person is reminded", async () => {
  await withApp(async ({ port, sent, db }) => {
    const alex = await api(port, "POST", "/api/auth/start", { body: { name: "Alex" }, status: 201 });
    const circle = (await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Trio" }, status: 201 })).circle;
    const bea = await api(port, "POST", "/api/auth/start", { body: { name: "Bea", code: circle.inviteCode }, status: 201 });
    const cam = await api(port, "POST", "/api/auth/start", { body: { name: "Cam", code: circle.inviteCode }, status: 201 });
    const dee = await api(port, "POST", "/api/auth/start", { body: { name: "Dee", code: circle.inviteCode }, status: 201 });
    await api(port, "POST", "/api/push/subscribe", {
      token: dee.token,
      body: { endpoint: to(dee), keys: { p256dh: "p", auth: "a" } },
      status: 204,
    });
    const plan = (await api(port, "POST", "/api/plans", { token: alex.token, body: { note: "Lunch" }, status: 201 })).plan;
    await api(port, "POST", `/api/plans/${plan.id}/reply`, { token: bea.token, body: { reply: "in" }, status: 200 });
    await api(port, "POST", `/api/plans/${plan.id}/reply`, { token: cam.token, body: { reply: "declined" }, status: 200 });
    await api(port, "POST", `/api/plans/${plan.id}/reply`, { token: dee.token, body: { reply: "maybe" }, status: 200 });
    sent.length = 0;

    const res = await api(port, "POST", `/api/plans/${plan.id}/remind`, { token: bea.token, body: {}, status: 200 });
    assert.equal(res.reminded, 1, "not Everyone has already answered");
    assert.notEqual(res.plan.remindAgainAt, null, "a real reminder starts the cooldown");
    assert.deepEqual(endpoints(sent), [to(dee)]);
    assert.equal(sent[0].payload.title, "Bea reminds you: Lunch, Tomorrow");
    assert.equal(alerts(db, dee.user.id).length, 1);
    for (const person of [alex, bea, cam]) assert.equal(alerts(db, person.user.id).length, 0, person.user.name);

    // Dee moves to In: now everyone has answered, and the next window gives reminded 0.
    await api(port, "POST", `/api/plans/${plan.id}/reply`, { token: dee.token, body: { reply: "in" }, status: 200 });
    db.prepare("UPDATE plans SET reminded_at = NULL WHERE id = ?").run(plan.id);
    const none = await api(port, "POST", `/api/plans/${plan.id}/remind`, { token: alex.token, body: {}, status: 200 });
    assert.equal(none.reminded, 0);
    assert.equal(none.plan.remindAgainAt, null);
  }, { sent: "envelope" });
});

test("a removed guest is never reminded, even after picking Maybe", async () => {
  await withApp(async ({ port, sent, db }) => {
    const { alex, bea, dan, kim, a } = await seed(port);
    const plan = await makePlan(port, alex, a.id);
    await api(port, "DELETE", `/api/plans/${plan.id}/people/${bea.user.id}?circle=${a.id}`, { token: alex.token, status: 204 });
    // The server still takes a Maybe from a removed guest; the row stays blocked.
    await api({ port }, "POST", `/api/plans/${plan.id}/reply?circle=${a.id}`, { token: bea.token, body: { reply: "maybe" } });
    sent.length = 0;
    const res = await api(port, "POST", `/api/plans/${plan.id}/remind?circle=${a.id}`, { token: alex.token, body: {}, status: 200 });
    assert.equal(res.reminded, 2, "Dan and Kim");
    assert.deepEqual(endpoints(sent), [to(dan)]);
    assert.equal(alerts(db, bea.user.id).length, 0);
    assert.equal(alerts(db, kim.user.id).length, 1);
  }, { sent: "envelope" });
});

test("ended and past plans cannot be reminded", async () => {
  await withApp(async ({ port, sent, at }) => {
    const { alex, bea, a } = await seed(port);
    const ended = await makePlan(port, alex, a.id, { note: "Ended" });
    await api(port, "DELETE", `/api/plans/${ended.id}?circle=${a.id}`, { token: alex.token, status: 204 });
    const gone = await api({ port }, "POST", `/api/plans/${ended.id}/remind?circle=${a.id}`, { token: bea.token, body: {} });
    assert.equal(gone.status, 410);

    const past = await makePlan(port, alex, a.id, { note: "Past", date: "2026-06-01", time: "20:00" });
    at(START + 2 * 24 * 60 * MINUTE);
    sent.length = 0;
    const old = await api({ port }, "POST", `/api/plans/${past.id}/remind?circle=${a.id}`, { token: bea.token, body: {} });
    assert.equal(old.status, 410);
    assert.equal(sent.length, 0);
  }, { sent: "envelope" });
});

test("someone outside the plan's circles gets 404, and a removed guest gets 403", async () => {
  await withApp(async ({ port, sent, db }) => {
    const { alex, bea, cam, out, a, b } = await seed(port);
    const plan = await makePlan(port, alex, a.id);
    // Olli is in no circle the plan is shared with.
    const stranger = await api({ port }, "POST", `/api/plans/${plan.id}/remind`, { token: out.token, body: {} });
    assert.equal(stranger.status, 404);
    // Cam is a member of Climbing, but the plan is not shared there.
    const notShared = await api({ port }, "POST", `/api/plans/${plan.id}/remind?circle=${b.id}`, { token: cam.token, body: {} });
    assert.equal(notShared.status, 404);
    const noAuth = await api({ port }, "POST", `/api/plans/${plan.id}/remind`, { body: {} });
    assert.equal(noAuth.status, 401);
    const badId = await api({ port }, "POST", `/api/plans/not-a-plan/remind?circle=${a.id}`, { token: bea.token, body: {} });
    assert.equal(badId.status, 404);

    await api(port, "DELETE", `/api/plans/${plan.id}/people/${bea.user.id}?circle=${a.id}`, { token: alex.token, status: 204 });
    sent.length = 0;
    const removed = await api({ port }, "POST", `/api/plans/${plan.id}/remind?circle=${a.id}`, { token: bea.token, body: {} });
    assert.equal(removed.status, 403);
    assert.equal(sent.length, 0);
    const reminded = db.prepare("SELECT reminded_at FROM plans WHERE id = ?").get(plan.id) as { reminded_at: number | null };
    assert.equal(reminded.reminded_at, null, "no failed call starts the cooldown");
  }, { sent: "envelope" });
});

test("two reminders at the same moment send one", async () => {
  await withApp(async ({ port, sent }) => {
    const { alex, bea, dan, a } = await seed(port);
    const plan = await makePlan(port, alex, a.id);
    sent.length = 0;
    const results = await Promise.all([alex, bea].map((person) =>
      api({ port }, "POST", `/api/plans/${plan.id}/remind?circle=${a.id}`, { token: person.token, body: {} })));
    assert.deepEqual(results.map((item) => item.status).sort(), [200, 429]);
    assert.equal(sent.filter((item) => item.endpoint === to(dan)).length, 1);
  }, { sent: "envelope" });
});

test("an old database gains plans.reminded_at on boot and keeps its plans", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hangry-remind-"));
  const file = path.join(dir, "old.db");
  try {
    const first = openDb(file);
    first.exec(`
      INSERT INTO users (id, name, token_hash, buzz_token, created_at) VALUES ('u', 'A', 'h', 'b', 0);
      INSERT INTO circles (id, name, invite_code, created_by, created_at) VALUES ('c', 'One', 'CODE1111', 'u', 0);
      INSERT INTO plans (id, circle_id, creator_id, note, for_date, created_at) VALUES ('p', 'c', 'u', 'x', '2026-06-02', 5);
      ALTER TABLE plans DROP COLUMN reminded_at;
    `);
    first.close();
    const second = openDb(file);
    const cols = (second.prepare("PRAGMA table_info(plans)").all() as Array<{ name: string }>).map((col) => col.name);
    assert.ok(cols.includes("reminded_at"));
    const row = second.prepare("SELECT note, reminded_at FROM plans WHERE id = 'p'").get() as { note: string; reminded_at: number | null };
    assert.deepEqual({ ...row }, { note: "x", reminded_at: null });
    second.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
