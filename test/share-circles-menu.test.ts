import assert from "node:assert/strict";
import test from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { listPlanCircleIds } from "../src/db.js";
import { api, withApp, type SentPush, testEmail } from "./http.js";

// The ⋯ menu's "Share with other circles" sheet sends PATCH /api/plans/:id with circleIds and nothing else.

type Person = { token: string; user: { id: string; name: string } };

/** Friends: Alex, Bea, Dan. Climbing: Alex, Cam, Dan. Dan is in both. Everyone has push on. */
async function seed(port: number) {
  const start = (name: string, code?: string): Promise<Person> =>
    api(port, "POST", "/api/auth/start", { body: code ? { name, email: testEmail(), code } : { name, email: testEmail() }, status: 201 });
  const alex = await start("Alex");
  const a = (await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Friends" }, status: 201 })).circle;
  const bea = await start("Bea", a.inviteCode);
  const dan = await start("Dan", a.inviteCode);
  const b = (await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Climbing" }, status: 201 })).circle;
  const cam = await start("Cam", b.inviteCode);
  await api(port, "POST", "/api/circles/join", { token: dan.token, body: { code: b.inviteCode }, status: 200 });
  const fay = await start("Fay");
  const f = (await api(port, "POST", "/api/circles", { token: fay.token, body: { name: "Fay's" }, status: 201 })).circle;
  for (const person of [alex, bea, cam, dan]) {
    await api(port, "POST", "/api/push/subscribe", {
      token: person.token,
      body: { endpoint: to(person), keys: { p256dh: "p", auth: "a" } },
      status: 204,
    });
  }
  return { alex, bea, cam, dan, a, b, f };
}

const to = (person: Person) => `https://push.example/${person.user.id}`;
const endpoints = (sent: SentPush[]) => sent.map((item) => item.endpoint).sort();

async function makePlan(port: number, alex: Person, circleId: string) {
  const plan = (await api(port, "POST", `/api/plans?circle=${circleId}`, {
    token: alex.token,
    body: { note: "Bouldering", place: "Hall", date: "2026-06-03", time: "18:00" },
    status: 201,
  })).plan;
  // Create ignores a description, so set one to prove a circles-only save keeps it.
  await api(port, "PATCH", `/api/plans/${plan.id}?circle=${circleId}`, { token: alex.token, body: { description: "Bring shoes" }, status: 200 });
  return plan;
}

const share = (port: number, person: Person, planId: string, circleId: string, circleIds: unknown, status = 200) =>
  api(port, "PATCH", `/api/plans/${planId}?circle=${circleId}`, { token: person.token, body: { circleIds }, status });

const plansIn = async (port: number, person: Person, circleId: string) =>
  (await api(port, "GET", `/api/plans?circle=${circleId}`, { token: person.token, status: 200 })).plans as Array<any>;

function row(db: DatabaseSync, id: string) {
  assert.equal((db.prepare("SELECT description FROM plans WHERE id = ?").get(id) as { description: string }).description, "Bring shoes");
  return { ...(db.prepare("SELECT note, place, lat, lng, at_time, for_date, description, updated_at FROM plans WHERE id = ?").get(id) as object) };
}

test("a circles-only PATCH links, keeps the plan's fields, and only the new circle hears about it, once", async () => {
  await withApp(async ({ port, db, sent }) => {
    const { alex, bea, cam, dan, a, b } = await seed(port);
    const plan = await makePlan(port, alex, a.id);
    const before = row(db, plan.id);

    sent.length = 0;
    const linked = await share(port, alex, plan.id, a.id, [a.id, b.id]);
    assert.equal(linked.plan.id, plan.id);
    assert.deepEqual(linked.plan.circles, [{ id: a.id, name: "Friends" }, { id: b.id, name: "Climbing" }]);
    assert.deepEqual(row(db, plan.id), before, "no field changed, not even updated_at");
    // Cam is new. Dan is in both circles and already had it. Bea is home. Alex is the host.
    assert.deepEqual(endpoints(sent), [to(cam)]);
    assert.equal(sent[0].payload.tag, `plan:${plan.id}`);
    assert.equal(sent.some((item) => /moved|place removed/.test(item.payload.title)), false, "never a move push");

    // Same plan, same chat and guest list from both circles.
    await api(port, "POST", `/api/plans/${plan.id}/join?circle=${b.id}`, { token: cam.token, status: 200 });
    await api(port, "POST", `/api/plans/${plan.id}/chat?circle=${b.id}`, { token: cam.token, body: { text: "in!" }, status: 201 });
    const fromA = (await plansIn(port, bea, a.id)).find((item) => item.id === plan.id);
    const fromB = (await plansIn(port, cam, b.id)).find((item) => item.id === plan.id);
    assert.ok(fromA && fromB);
    assert.deepEqual(fromA.joined.map((person: { name: string }) => person.name), ["Cam"]);
    assert.deepEqual(fromB.joined.map((person: { name: string }) => person.name), ["Cam"]);
    const chatA = await api(port, "GET", `/api/plans/${plan.id}/chat?circle=${a.id}`, { token: bea.token, status: 200 });
    const chatB = await api(port, "GET", `/api/plans/${plan.id}/chat?circle=${b.id}`, { token: dan.token, status: 200 });
    assert.equal(chatA.chat.id, chatB.chat.id);
    assert.ok(chatA.chat.messages.some((message: { text: string }) => message.text === "in!"));

    // Saving the same set again pings nobody.
    sent.length = 0;
    await share(port, alex, plan.id, a.id, [a.id, b.id]);
    assert.equal(sent.length, 0);
  }, { sent: "envelope" });
});

test("unsharing is quiet, keeps the home circle, and leaves the plan's fields alone", async () => {
  await withApp(async ({ port, db, sent }) => {
    const { alex, cam, a, b } = await seed(port);
    const plan = await makePlan(port, alex, a.id);
    await share(port, alex, plan.id, a.id, [a.id, b.id]);
    const before = row(db, plan.id);

    sent.length = 0;
    const only = await share(port, alex, plan.id, a.id, [a.id]);
    assert.deepEqual(only.plan.circles, [{ id: a.id, name: "Friends" }]);
    assert.equal(sent.length, 0, "unlinking pings nobody");
    assert.deepEqual(row(db, plan.id), before);
    assert.equal((await plansIn(port, cam, b.id)).length, 0);

    // The home circle stays even when the sheet sends an empty set or forgets it.
    await share(port, alex, plan.id, a.id, []);
    assert.deepEqual(listPlanCircleIds(db, plan.id), [a.id]);
    sent.length = 0;
    await share(port, alex, plan.id, a.id, [b.id]);
    assert.deepEqual(listPlanCircleIds(db, plan.id), [a.id, b.id]);
    assert.deepEqual(endpoints(sent), [to(cam)], "re-adding tells the new circle again, once");
  }, { sent: "envelope" });
});

test("non-host 403, foreign circle 400, free post 400, ended or past plan 410", async () => {
  await withApp(async ({ port, db, sent, advance }) => {
    const { alex, bea, dan, a, b, f } = await seed(port);
    await api(port, "POST", `/api/circles/members/${bea.user.id}?circle=${a.id}`, { token: alex.token, body: { admin: true }, status: 200 });
    const plan = await makePlan(port, alex, a.id);

    await share(port, bea, plan.id, a.id, [a.id], 403);
    await share(port, dan, plan.id, a.id, [a.id, b.id], 403);
    await share(port, alex, plan.id, a.id, [a.id, f.id], 400);
    await share(port, alex, plan.id, a.id, "nope", 400);
    assert.deepEqual(listPlanCircleIds(db, plan.id), [a.id]);

    const social = (await api(port, "POST", `/api/socials?circle=${a.id}`, { token: alex.token, body: { note: "Coffee" }, status: 201 })).social;
    const refused = await api(port, "PATCH", `/api/socials/${social.id}?circle=${a.id}`, {
      token: alex.token,
      body: { circleIds: [a.id, b.id] },
      status: 400,
    });
    assert.match(refused.error, /Only plans/);
    assert.equal((await api(port, "GET", `/api/socials?circle=${b.id}`, { token: alex.token, status: 200 })).socials.length, 0);

    sent.length = 0;
    const ended = await makePlan(port, alex, a.id);
    await api(port, "DELETE", `/api/plans/${ended.id}?circle=${a.id}`, { token: alex.token, status: 204 });
    sent.length = 0;
    await share(port, alex, ended.id, a.id, [a.id, b.id], 410);
    assert.deepEqual(listPlanCircleIds(db, ended.id), [a.id]);

    advance(3 * 24 * 60 * 60 * 1000);
    await share(port, alex, plan.id, a.id, [a.id, b.id], 410);
    assert.deepEqual(listPlanCircleIds(db, plan.id), [a.id]);
    assert.equal(sent.length, 0);
  }, { sent: "envelope" });
});
