import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { flushChatNotices } from "../../src/chat/chat.js";
import { listPlanCircleIds, openDb } from "../../src/db.js";
import { api, withApp, type SentPush, testEmail } from "../http.js";

type Person = { token: string; user: { id: string; name: string } };

/**
 * Friends (A): Alex, Bea, Dan. Climbing (B): Alex, Cam, Dan, Ed.
 * Ed also has his own circle, so his pushes carry a circle name. Dan is in both A and B.
 */
async function seed(port: number) {
  const start = (name: string, code?: string): Promise<Person> =>
    api(port, "POST", "/api/auth/start", { body: code ? { name, email: testEmail(), code } : { name, email: testEmail() }, status: 201 });
  const alex = await start("Alex");
  const a = (await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Friends" }, status: 201 })).circle;
  const bea = await start("Bea", a.inviteCode);
  const dan = await start("Dan", a.inviteCode);
  const b = (await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Climbing" }, status: 201 })).circle;
  const cam = await start("Cam", b.inviteCode);
  const ed = await start("Ed", b.inviteCode);
  await api(port, "POST", "/api/circles/join", { token: dan.token, body: { code: b.inviteCode }, status: 200 });
  const eds = (await api(port, "POST", "/api/circles", { token: ed.token, body: { name: "Ed's" }, status: 201 })).circle;
  for (const person of [alex, bea, cam, dan, ed]) {
    await api(port, "POST", "/api/push/subscribe", {
      token: person.token,
      body: { endpoint: to(person), keys: { p256dh: "p", auth: "a" } },
      status: 204,
    });
  }
  return { alex, bea, cam, dan, ed, a, b, eds };
}

const to = (person: Person) => `https://push.example/${person.user.id}`;
const endpoints = (sent: SentPush[]) => sent.map((item) => item.endpoint).sort();

async function makePlan(port: number, alex: Person, circleId: string, body: Record<string, unknown> = {}) {
  return (await api(port, "POST", `/api/plans?circle=${circleId}`, {
    token: alex.token,
    body: { note: "Bouldering", place: "Hall", date: "2026-06-03", time: "18:00", ...body },
    status: 201,
  })).plan;
}

const plansIn = async (port: number, person: Person, circleId: string) =>
  (await api(port, "GET", `/api/plans?circle=${circleId}`, { token: person.token, status: 200 })).plans as Array<any>;

function count(db: DatabaseSync, sql: string, ...params: string[]): number {
  return Number((db.prepare(sql).get(...params) as { n: number | bigint }).n);
}

test("an old database without plan_circles gets one home link per plan, and booting twice is fine", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hangry-plan-circles-"));
  const file = path.join(dir, "old.db");
  try {
    const first = openDb(file);
    first.exec(`
      INSERT INTO users (id, name, token_hash, buzz_token, created_at) VALUES ('u', 'A', 'h', 'b', 0);
      INSERT INTO circles (id, name, invite_code, created_by, created_at) VALUES ('c1', 'One', 'CODE1111', 'u', 0);
      INSERT INTO circles (id, name, invite_code, created_by, created_at) VALUES ('c2', 'Two', 'CODE2222', 'u', 0);
      INSERT INTO plans (id, circle_id, creator_id, note, for_date, created_at) VALUES ('p1', 'c1', 'u', 'x', '2026-06-02', 5);
      INSERT INTO plans (id, circle_id, creator_id, note, for_date, created_at) VALUES ('p2', 'c2', 'u', 'y', '2026-06-02', 6);
      DROP TABLE plan_circles;
    `);
    first.close();

    const second = openDb(file);
    const rows = second.prepare("SELECT plan_id, circle_id, added_at FROM plan_circles ORDER BY plan_id").all()
      .map((row) => ({ ...row }));
    assert.deepEqual(rows, [
      { plan_id: "p1", circle_id: "c1", added_at: 5 },
      { plan_id: "p2", circle_id: "c2", added_at: 6 },
    ]);
    const cols = (second.prepare("PRAGMA table_info(plans)").all() as Array<{ name: string }>).map((col) => col.name);
    assert.ok(cols.includes("circle_id"), "plans.circle_id stays");
    second.close();

    const third = openDb(file);
    assert.equal(count(third, "SELECT COUNT(*) AS n FROM plan_circles"), 2);
    assert.deepEqual(listPlanCircleIds(third, "p1"), ["c1"]);
    third.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a linked circle sees the plan, joins the same list, and loses it on unlink", async () => {
  await withApp(async ({ port, db, sent }) => {
    const { alex, cam, a, b } = await seed(port);
    const plan = await makePlan(port, alex, a.id);
    assert.deepEqual(plan.circles, [{ id: a.id, name: "Friends" }]);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM plan_circles WHERE plan_id = ?", plan.id), 1);
    assert.equal((await plansIn(port, cam, b.id)).length, 0);
    await api(port, "POST", `/api/plans/${plan.id}/join?circle=${b.id}`, { token: cam.token, status: 404 });

    const linked = await api(port, "PATCH", `/api/plans/${plan.id}?circle=${a.id}`, {
      token: alex.token,
      body: { circleIds: [a.id, b.id] },
      status: 200,
    });
    assert.deepEqual(linked.plan.circles, [{ id: a.id, name: "Friends" }, { id: b.id, name: "Climbing" }]);
    const camView = await plansIn(port, cam, b.id);
    assert.deepEqual(camView.map((item) => item.id), [plan.id]);

    await api(port, "POST", `/api/plans/${plan.id}/join?circle=${b.id}`, { token: cam.token, status: 200 });
    const alexView = await plansIn(port, alex, a.id);
    assert.deepEqual(alexView[0].joined.map((person: { name: string }) => person.name), ["Cam"]);
    assert.deepEqual((await plansIn(port, alex, b.id))[0].joined.map((person: { name: string }) => person.name), ["Cam"]);

    sent.length = 0;
    const unlinked = await api(port, "PATCH", `/api/plans/${plan.id}?circle=${a.id}`, {
      token: alex.token,
      body: { circleIds: [a.id] },
      status: 200,
    });
    assert.deepEqual(unlinked.plan.circles, [{ id: a.id, name: "Friends" }]);
    assert.equal(sent.length, 0, "no push on unlink");
    assert.equal((await plansIn(port, cam, b.id)).length, 0);
    await api(port, "GET", `/api/plans/${plan.id}/chat?circle=${b.id}`, { token: cam.token, status: 404 });
    await api(port, "POST", `/api/plans/${plan.id}/reply?circle=${b.id}`, { token: cam.token, body: { reply: "declined" }, status: 404 });
  }, { sent: "envelope" });
});

test("one shared chat: a message from either circle shows in both", async () => {
  await withApp(async ({ port, db, sent }) => {
    const { alex, bea, cam, dan, ed, a, b } = await seed(port);
    const plan = await makePlan(port, alex, a.id);
    await api(port, "PATCH", `/api/plans/${plan.id}?circle=${a.id}`, { token: alex.token, body: { circleIds: [a.id, b.id] }, status: 200 });

    await api(port, "POST", `/api/plans/${plan.id}/chat?circle=${b.id}`, { token: cam.token, body: { text: "from B" }, status: 201 });
    await api(port, "POST", `/api/plans/${plan.id}/chat?circle=${a.id}`, { token: bea.token, body: { text: "from A" }, status: 201 });
    const inA = await api(port, "GET", `/api/plans/${plan.id}/chat?circle=${a.id}`, { token: alex.token, status: 200 });
    const inB = await api(port, "GET", `/api/plans/${plan.id}/chat?circle=${b.id}`, { token: cam.token, status: 200 });
    const texts = (chat: any) => chat.chat.messages.filter((m: { system: boolean }) => !m.system).map((m: { text: string }) => m.text);
    assert.deepEqual(texts(inA), ["from B", "from A"]);
    assert.deepEqual(texts(inB), ["from B", "from A"]);
    assert.equal(inA.chat.id, inB.chat.id);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM chats WHERE kind = 'plan' AND ref_id = ?", plan.id), 1);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM chats WHERE kind = 'plan' AND ref_id = ? AND circle_id = ?", plan.id, a.id), 1);

    const summary = await api(port, "GET", `/api/chats?circle=${b.id}`, { token: cam.token, status: 200 });
    assert.ok(summary.events.some((event: { kind: string; id: string }) => event.kind === "plan" && event.id === plan.id));

    // Chat pushes: host and writers from both circles, once each. Readers who never wrote get none.
    await flushChatNotices(true);
    const chatPushes = sent.filter((item) => item.payload.tag === `chat:${inA.chat.id}`);
    assert.ok(chatPushes.some((item) => item.endpoint === to(alex)));
    assert.ok(chatPushes.some((item) => item.endpoint === to(cam)), "B writer hears A's message");
    assert.equal(chatPushes.some((item) => item.endpoint === to(dan) || item.endpoint === to(ed)), false);
    sent.length = 0;
    await api(port, "POST", `/api/plans/${plan.id}/chat?circle=${b.id}`, { token: cam.token, body: { text: "again" }, status: 201 });
    await flushChatNotices(true);
    const second = sent.filter((item) => item.payload.tag === `chat:${inA.chat.id}`);
    assert.deepEqual(endpoints(second), [to(alex), to(bea)].sort(), "A writer hears B's message, once");
  }, { sent: "envelope" });
});

test("only the creator may change circleIds, only to their own circles, and the home circle stays", async () => {
  await withApp(async ({ port, db }) => {
    const { alex, bea, dan, a, b, eds } = await seed(port);
    await api(port, "POST", `/api/circles/members/${bea.user.id}?circle=${a.id}`, { token: alex.token, body: { admin: true }, status: 200 });
    const plan = await makePlan(port, alex, a.id);

    const notHost = await api(port, "PATCH", `/api/plans/${plan.id}?circle=${a.id}`, { token: bea.token, body: { circleIds: [a.id] }, status: 403 });
    assert.ok(notHost.error);
    await api(port, "PATCH", `/api/plans/${plan.id}?circle=${a.id}`, { token: dan.token, body: { circleIds: [a.id, b.id] }, status: 403 });
    await api(port, "PATCH", `/api/plans/${plan.id}?circle=${a.id}`, { token: alex.token, body: { circleIds: [a.id, eds.id] }, status: 400 });
    await api(port, "PATCH", `/api/plans/${plan.id}?circle=${a.id}`, { token: alex.token, body: { circleIds: "nope" }, status: 400 });
    assert.deepEqual(listPlanCircleIds(db, plan.id), [a.id]);

    const moved = await api(port, "PATCH", `/api/plans/${plan.id}?circle=${a.id}`, { token: alex.token, body: { circleIds: [b.id] }, status: 200 });
    assert.deepEqual(moved.plan.circles.map((circle: { id: string }) => circle.id), [a.id, b.id]);
    const emptied = await api(port, "PATCH", `/api/plans/${plan.id}?circle=${a.id}`, { token: alex.token, body: { circleIds: [] }, status: 200 });
    assert.deepEqual(emptied.plan.circles.map((circle: { id: string }) => circle.id), [a.id]);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM plans WHERE id = ? AND circle_id = ?", plan.id, a.id), 1);
  });
});

test("adding a circle pushes its new people once, tagged with that circle, and never re-pushes the home circle", async () => {
  await withApp(async ({ port, sent }) => {
    const { alex, bea, cam, dan, ed, a, b } = await seed(port);
    sent.length = 0;
    const plan = await makePlan(port, alex, a.id);
    assert.deepEqual(endpoints(sent), [to(bea), to(dan)].sort());
    const original = sent[0].payload;

    sent.length = 0;
    await api(port, "PATCH", `/api/plans/${plan.id}?circle=${a.id}`, { token: alex.token, body: { circleIds: [a.id, b.id] }, status: 200 });
    assert.deepEqual(endpoints(sent), [to(cam), to(ed)].sort(), "B only, minus Dan who already had it, minus Alex");
    for (const item of sent) {
      assert.equal(item.payload.title, original.title);
      assert.equal(item.payload.tag, `plan:${plan.id}`);
    }
    const camPush = sent.find((item) => item.endpoint === to(cam))!;
    assert.equal(camPush.payload.body, "Alex: Bouldering · 18:00 · Hall");
    const edPush = sent.find((item) => item.endpoint === to(ed))!;
    assert.equal(edPush.payload.body, "Alex: Bouldering · 18:00 · Hall · Climbing");
    assert.equal(edPush.payload.url, `/?plan=${plan.id}&circle=${b.id}`);

    sent.length = 0;
    await api(port, "PATCH", `/api/plans/${plan.id}?circle=${a.id}`, { token: alex.token, body: { circleIds: [a.id, b.id], note: "Bouldering!" }, status: 200 });
    assert.equal(sent.length, 0, "saving the same set pushes nobody");
  }, { sent: "envelope" });
});

test("reschedule push reaches every linked circle once, minus the editor and people who declined", async () => {
  await withApp(async ({ port, sent }) => {
    const { alex, bea, cam, dan, ed, a, b } = await seed(port);
    const plan = await makePlan(port, alex, a.id);
    await api(port, "PATCH", `/api/plans/${plan.id}?circle=${a.id}`, { token: alex.token, body: { circleIds: [a.id, b.id] }, status: 200 });
    await api(port, "POST", `/api/plans/${plan.id}/reply?circle=${b.id}`, { token: ed.token, body: { reply: "declined" }, status: 200 });

    sent.length = 0;
    await api(port, "PATCH", `/api/plans/${plan.id}?circle=${a.id}`, { token: alex.token, body: { time: "19:00" }, status: 200 });
    assert.deepEqual(endpoints(sent), [to(bea), to(cam), to(dan)].sort());
    assert.equal(sent.filter((item) => item.endpoint === to(dan)).length, 1, "Dan is in both circles but gets one push");
    assert.ok(sent.every((item) => item.payload.title === "Bouldering moved to Wed 3 Jun · 19:00"));
  }, { sent: "envelope" });
});

test("the share link treats a linked circle's member as a friend, in their own circle", async () => {
  await withApp(async ({ port }) => {
    const { alex, cam, a, b, eds, ed } = await seed(port);
    const plan = await makePlan(port, alex, a.id);
    const share = plan.shareId as string;
    const before = await api(port, "GET", `/api/plans/share/${share}`, { token: cam.token, status: 200 });
    assert.equal(before.member, false);

    await api(port, "PATCH", `/api/plans/${plan.id}?circle=${a.id}`, { token: alex.token, body: { circleIds: [a.id, b.id] }, status: 200 });
    const after = await api(port, "GET", `/api/plans/share/${share}`, { token: cam.token, status: 200 });
    assert.equal(after.member, true);
    assert.equal(after.circleId, b.id);
    assert.equal(after.circleName, "Climbing");
    const host = await api(port, "GET", `/api/plans/share/${share}`, { token: alex.token, status: 200 });
    assert.equal(host.circleId, a.id, "home first when the viewer is in it");
    const edView = await api(port, "GET", `/api/plans/share/${share}`, { token: ed.token, status: 200 });
    assert.equal(edView.circleId, b.id);
    assert.notEqual(edView.circleId, eds.id);
  });
});

test("a linked circle's member sees circle names only, never the home circle's members or invite", async () => {
  await withApp(async ({ port }) => {
    const { alex, bea, cam, a, b } = await seed(port);
    const plan = await makePlan(port, alex, a.id);
    await api(port, "PATCH", `/api/plans/${plan.id}?circle=${a.id}`, { token: alex.token, body: { circleIds: [a.id, b.id] }, status: 200 });
    const seen = (await plansIn(port, cam, b.id))[0];
    assert.deepEqual(seen.circles, [{ id: a.id, name: "Friends" }, { id: b.id, name: "Climbing" }]);
    for (const circle of seen.circles) assert.deepEqual(Object.keys(circle).sort(), ["id", "name"]);
    const raw = JSON.stringify(seen);
    assert.equal(raw.includes(a.inviteCode), false);
    assert.equal(raw.includes(bea.user.id), false);
    assert.equal(raw.includes("Bea"), false);
    assert.equal(raw.includes("members"), false);
    assert.equal("push" in seen, false);
  });
});

test("deleting a linked circle drops its links and keeps the plan home", async () => {
  await withApp(async ({ port, db }) => {
    const { alex, a, b } = await seed(port);
    const plan = await makePlan(port, alex, a.id);
    await api(port, "PATCH", `/api/plans/${plan.id}?circle=${a.id}`, { token: alex.token, body: { circleIds: [a.id, b.id] }, status: 200 });
    await api(port, "DELETE", `/api/circles?circle=${b.id}`, { token: alex.token, status: 200 });
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM plan_circles WHERE circle_id = ?", b.id), 0);
    assert.deepEqual(listPlanCircleIds(db, plan.id), [a.id]);
    assert.equal((await plansIn(port, alex, a.id)).length, 1);
  });
});

test("a host who leaves a linked circle takes their shared plan out of it", async () => {
  await withApp(async ({ port, db }) => {
    const { alex, cam, a, b } = await seed(port);
    const plan = await makePlan(port, alex, a.id);
    await api(port, "PATCH", `/api/plans/${plan.id}?circle=${a.id}`, { token: alex.token, body: { circleIds: [a.id, b.id] }, status: 200 });
    await api(port, "POST", `/api/circles/members/${cam.user.id}?circle=${b.id}`, { token: alex.token, body: { admin: true }, status: 200 });
    await api(port, "POST", `/api/circles/leave?circle=${b.id}`, { token: alex.token, status: 200 });
    assert.equal((await plansIn(port, cam, b.id)).length, 0);
    assert.deepEqual(listPlanCircleIds(db, plan.id), [a.id]);
  });
});
