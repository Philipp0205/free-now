import assert from "node:assert/strict";
import test from "node:test";
import { api, START, withApp, type SentPush } from "../http.js";

const HOUR = 60 * 60 * 1000;

async function circle(port: number) {
  const alex = await api(port, "POST", "/api/auth/start", { body: { name: "Alex" }, status: 201 });
  const created = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "friends" }, status: 201 });
  const join = (name: string) =>
    api(port, "POST", "/api/auth/start", { body: { name, code: created.circle.inviteCode }, status: 201 });
  const bea = await join("Bea");
  const sam = await join("Sam");
  const kim = await join("Kim");
  await api(port, "POST", `/api/circles/members/${bea.user.id}`, { token: alex.token, body: { admin: true }, status: 200 });
  for (const person of [alex, bea, sam, kim]) {
    await api(port, "POST", "/api/push/subscribe", {
      token: person.token,
      body: { endpoint: `https://push.example/${person.user.id}`, keys: { p256dh: "p", auth: "a" } },
      status: 204,
    });
  }
  return { alex, bea, sam, kim };
}

const to = (person: { user: { id: string } }) => `https://push.example/${person.user.id}`;
const endpoints = (sent: SentPush[]) => sent.map((item) => item.endpoint).sort();

test("a time change pushes every member but the editor with an absolute date", async () => {
  await withApp(async ({ port, sent }) => {
    const { alex, bea, sam, kim } = await circle(port);
    const made = await api(port, "POST", "/api/plans", {
      token: alex.token,
      body: { note: "Board games", place: "Near you", date: "2026-06-02", time: "19:00" },
      status: 201,
    });
    sent.length = 0;
    await api(port, "PATCH", `/api/plans/${made.plan.id}`, { token: alex.token, body: { time: "20:00" }, status: 200 });
    assert.deepEqual(endpoints(sent), [to(bea), to(sam), to(kim)].sort());
    for (const item of sent) {
      assert.equal(item.payload.title, "Board games moved to Tue 2 Jun · 20:00");
      assert.equal(item.payload.body, "nearby");
      assert.equal(item.payload.url, `/?plan=${made.plan.id}`);
      assert.equal(item.payload.tag, `plan-change:${made.plan.id}`);
    }
  }, { sent: "envelope" });
});

test("a day change pushes, and an untimed plan has no clock in the title", async () => {
  await withApp(async ({ port, sent }) => {
    const { alex, bea, sam, kim } = await circle(port);
    const made = await api(port, "POST", "/api/plans", { token: alex.token, body: { note: "Picnic" }, status: 201 });
    sent.length = 0;
    await api(port, "PATCH", `/api/plans/${made.plan.id}`, { token: alex.token, body: { date: "2026-06-05" }, status: 200 });
    assert.deepEqual(endpoints(sent), [to(bea), to(sam), to(kim)].sort());
    assert.equal(sent[0].payload.title, "Picnic moved to Fri 5 Jun");
    assert.equal(sent[0].payload.body, "Tap to see the plan.");
  }, { sent: "envelope" });
});

test("a place change pushes, and clearing the place says so", async () => {
  await withApp(async ({ port, sent }) => {
    const { alex, bea, sam, kim } = await circle(port);
    const made = await api(port, "POST", "/api/plans", { token: alex.token, body: { note: "Dinner", place: "Cafe" }, status: 201 });
    sent.length = 0;
    await api(port, "PATCH", `/api/plans/${made.plan.id}`, { token: alex.token, body: { place: "Bar" }, status: 200 });
    assert.deepEqual(endpoints(sent), [to(bea), to(sam), to(kim)].sort());
    assert.equal(sent[0].payload.title, "Dinner moved to Bar");
    assert.equal(sent[0].payload.body, "Tap to see the plan.");

    sent.length = 0;
    await api(port, "PATCH", `/api/plans/${made.plan.id}`, { token: alex.token, body: { place: "" }, status: 200 });
    assert.equal(sent.length, 3);
    assert.equal(sent[0].payload.title, "Dinner: place removed");
    assert.equal(sent[0].payload.body, "Tap to see the plan.");
  }, { sent: "envelope" });
});

test("note-only and description-only edits push nothing", async () => {
  await withApp(async ({ port, sent }) => {
    const { alex, bea } = await circle(port);
    const made = await api(port, "POST", "/api/plans", { token: alex.token, body: { note: "Dinner", place: "Cafe", time: "19:00" }, status: 201 });
    sent.length = 0;
    await api(port, "PATCH", `/api/plans/${made.plan.id}`, { token: alex.token, body: { note: "Dinner at mine" }, status: 200 });
    await api(port, "PATCH", `/api/plans/${made.plan.id}`, { token: alex.token, body: { description: "Bring snacks" }, status: 200 });
    await api(port, "PATCH", `/api/plans/${made.plan.id}`, { token: bea.token, body: { note: "Dinner at Bea's" }, status: 200 });
    await api(port, "PATCH", `/api/plans/${made.plan.id}`, {
      token: alex.token,
      body: { note: "Dinner", place: "Cafe", time: "19:00", description: "" },
      status: 200,
    });
    assert.equal(sent.length, 0, JSON.stringify(sent));
  }, { sent: "envelope" });
});

test("the editor never gets their own push, even with a joined reply", async () => {
  await withApp(async ({ port, sent }) => {
    const { alex, sam } = await circle(port);
    const made = await api(port, "POST", "/api/plans", { token: alex.token, body: { note: "Run" }, status: 201 });
    await api(port, "POST", `/api/plans/${made.plan.id}/reply`, { token: sam.token, body: { reply: "in" }, status: 200 });
    sent.length = 0;
    await api(port, "PATCH", `/api/plans/${made.plan.id}`, { token: alex.token, body: { time: "08:00" }, status: 200 });
    assert.equal(sent.some((item) => item.endpoint === to(alex)), false);
    assert.equal(sent.filter((item) => item.endpoint === to(sam)).length, 1, "one push per person");
    assert.equal(sent.length, 3);
  }, { sent: "envelope" });
});

test("an admin who is not the creator: the creator gets it once, the admin does not", async () => {
  await withApp(async ({ port, sent }) => {
    const { alex, bea, sam, kim } = await circle(port);
    const made = await api(port, "POST", "/api/plans", { token: alex.token, body: { note: "Climb", time: "18:00" }, status: 201 });
    sent.length = 0;
    await api(port, "PATCH", `/api/plans/${made.plan.id}`, { token: bea.token, body: { time: "18:30" }, status: 200 });
    assert.deepEqual(endpoints(sent), [to(alex), to(sam), to(kim)].sort());
    const host = sent.filter((item) => item.endpoint === to(alex));
    assert.equal(host.length, 1);
    assert.equal(host[0].payload.title, "Climb moved to Tue 2 Jun · 18:30");
    assert.equal(sent.some((item) => item.payload.title.includes("edited your")), false);
  }, { sent: "envelope" });
});

test("a plan whose time has passed today still pushes when moved to a future day", async () => {
  await withApp(async ({ port, sent, at }) => {
    const { alex, bea, sam, kim } = await circle(port);
    const made = await api(port, "POST", "/api/plans", {
      token: alex.token,
      body: { note: "Board games", place: "Kim's", date: "2026-06-01", time: "16:00" },
      status: 201,
    });
    at(START + 2 * HOUR);
    sent.length = 0;
    await api(port, "PATCH", `/api/plans/${made.plan.id}`, { token: alex.token, body: { date: "2026-06-05", time: "20:00" }, status: 200 });
    assert.deepEqual(endpoints(sent), [to(bea), to(sam), to(kim)].sort());
    assert.equal(sent[0].payload.title, "Board games moved to Fri 5 Jun · 20:00");
    assert.equal(sent[0].payload.body, "Kim's");
  }, { sent: "envelope" });
});

test("people who said they can't come are left out; 'in' and no answer still get it, and changing back to 'in' brings them back", async () => {
  await withApp(async ({ port, sent }) => {
    const { alex, bea, sam, kim } = await circle(port);
    const made = await api(port, "POST", "/api/plans", { token: alex.token, body: { note: "Picnic", time: "12:00" }, status: 201 });
    await api(port, "POST", `/api/plans/${made.plan.id}/reply`, { token: sam.token, body: { reply: "cant" }, status: 200 });
    await api(port, "POST", `/api/plans/${made.plan.id}/reply`, { token: bea.token, body: { reply: "in" }, status: 200 });
    sent.length = 0;
    await api(port, "PATCH", `/api/plans/${made.plan.id}`, { token: alex.token, body: { time: "13:00" }, status: 200 });
    // Bea said in, Kim never answered, Sam declined, Alex edited.
    assert.deepEqual(endpoints(sent), [to(bea), to(kim)].sort());

    await api(port, "POST", `/api/plans/${made.plan.id}/reply`, { token: sam.token, body: { reply: "in" }, status: 200 });
    sent.length = 0;
    await api(port, "PATCH", `/api/plans/${made.plan.id}`, { token: alex.token, body: { time: "14:00" }, status: 200 });
    assert.ok(endpoints(sent).includes(to(sam)), "back in, so pushed again");
  }, { sent: "envelope" });
});

test("an admin edit still reaches the creator, but not a creator-side decliner or the admin", async () => {
  await withApp(async ({ port, sent }) => {
    const { alex, bea, sam, kim } = await circle(port);
    const made = await api(port, "POST", "/api/plans", { token: alex.token, body: { note: "Swim", time: "09:00" }, status: 201 });
    await api(port, "POST", `/api/plans/${made.plan.id}/reply`, { token: kim.token, body: { reply: "declined" }, status: 200 });
    sent.length = 0;
    await api(port, "PATCH", `/api/plans/${made.plan.id}`, { token: bea.token, body: { place: "Lake" }, status: 200 });
    assert.deepEqual(endpoints(sent), [to(alex), to(sam)].sort());
  }, { sent: "envelope" });
});
