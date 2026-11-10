import assert from "node:assert/strict";
import test from "node:test";
import { api, START, withApp, type SentPush } from "./http.js";

const DAY = 24 * 60 * 60 * 1000;

async function circle(port: number) {
  const alex = await api(port, "POST", "/api/auth/start", { body: { name: "Alex" }, status: 201 });
  const created = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "friends" }, status: 201 });
  const join = (name: string) =>
    api(port, "POST", "/api/auth/start", { body: { name, code: created.circle.inviteCode }, status: 201 });
  const bea = await join("Bea");
  const sam = await join("Sam");
  const kim = await join("Kim");
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

async function plan(port: number, token: string, body: Record<string, unknown> = {}) {
  const made = await api(port, "POST", "/api/plans", {
    token,
    body: { note: "Board games", date: "2026-06-02", time: "19:00", ...body },
    status: 201,
  });
  return made.plan.id as string;
}

test("a member proposes a date: the host gets one push and the plan lists it", async () => {
  await withApp(async ({ port, sent }) => {
    const { alex, bea } = await circle(port);
    const id = await plan(port, alex.token);
    sent.length = 0;
    const res = await api(port, "POST", `/api/plans/${id}/proposals`, {
      token: bea.token,
      body: { date: "2026-06-05", time: "20:00", note: " Friday works better " },
      status: 201,
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].endpoint, to(alex));
    assert.equal(sent[0].payload.title, "New date proposed");
    assert.equal(sent[0].payload.body, "Bea proposed Fri 5 Jun · 20:00 for Board games");
    assert.equal(sent[0].payload.url, `/?plan=${id}`);
    assert.equal(sent[0].payload.tag, `plan-proposal:${id}:${bea.user.id}`);
    assert.equal(res.plan.proposals.length, 1);
    const [proposal] = res.plan.proposals;
    assert.equal(proposal.userId, bea.user.id);
    assert.equal(proposal.name, "Bea");
    assert.equal(proposal.forDate, "2026-06-05");
    assert.equal(proposal.time, "20:00");
    assert.equal(proposal.note, "Friday works better");
    const seen = await api(port, "GET", "/api/plans", { token: bea.token, status: 200 });
    assert.equal(seen.plans[0].proposals.length, 1);
  }, { sent: "envelope" });
});

test("the host cannot propose a date for their own plan", async () => {
  await withApp(async ({ port }) => {
    const { alex } = await circle(port);
    const id = await plan(port, alex.token);
    await api(port, "POST", `/api/plans/${id}/proposals`, { token: alex.token, body: { date: "2026-06-05" }, status: 400 });
  }, { sent: "envelope" });
});

test("proposing again replaces the earlier proposal", async () => {
  await withApp(async ({ port, db }) => {
    const { alex, bea } = await circle(port);
    const id = await plan(port, alex.token);
    await api(port, "POST", `/api/plans/${id}/proposals`, { token: bea.token, body: { date: "2026-06-05" }, status: 201 });
    const res = await api(port, "POST", `/api/plans/${id}/proposals`, { token: bea.token, body: { date: "2026-06-06", note: "or Saturday" }, status: 201 });
    assert.equal(res.plan.proposals.length, 1);
    assert.equal(res.plan.proposals[0].forDate, "2026-06-06");
    const rows = db.prepare("SELECT COUNT(*) AS n FROM plan_proposals WHERE plan_id = ?").get(id) as { n: number | bigint };
    assert.equal(Number(rows.n), 1);
  }, { sent: "envelope" });
});

test("a past date, a missing date, a long note, and the current plan are refused", async () => {
  await withApp(async ({ port }) => {
    const { alex, bea } = await circle(port);
    const id = await plan(port, alex.token);
    const propose = (body: Record<string, unknown>) =>
      api(port, "POST", `/api/plans/${id}/proposals`, { token: bea.token, body, status: 400 });
    await propose({ date: "2026-05-30" });
    await propose({});
    await propose({ date: "2026-06-05", note: "x".repeat(141) });
    await propose({ date: "2026-06-02" });
    await propose({ date: "2026-06-02", time: "19:00" });
    await api(port, "POST", `/api/plans/${id}/proposals`, { token: bea.token, body: { date: "2026-06-02", time: "20:00" }, status: 201 });
  }, { sent: "envelope" });
});

test("only the host or an admin can accept or dismiss", async () => {
  await withApp(async ({ port }) => {
    const { alex, bea, sam } = await circle(port);
    const id = await plan(port, alex.token);
    await api(port, "POST", `/api/plans/${id}/proposals`, { token: bea.token, body: { date: "2026-06-05" }, status: 201 });
    for (const action of ["accept", "dismiss"]) {
      await api(port, "POST", `/api/plans/${id}/proposals/${bea.user.id}/${action}`, { token: sam.token, status: 403 });
      await api(port, "POST", `/api/plans/${id}/proposals/${bea.user.id}/${action}`, { token: bea.token, status: 403 });
    }
    await api(port, "POST", `/api/plans/${id}/proposals/${sam.user.id}/accept`, { token: alex.token, status: 404 });
  }, { sent: "envelope" });
});

test("accepting moves the plan, tells the audience, and clears every proposal", async () => {
  await withApp(async ({ port, sent }) => {
    const { alex, bea, sam, kim } = await circle(port);
    const id = await plan(port, alex.token);
    await api(port, "POST", `/api/plans/${id}/proposals`, { token: bea.token, body: { date: "2026-06-05", time: "20:00" }, status: 201 });
    await api(port, "POST", `/api/plans/${id}/proposals`, { token: sam.token, body: { date: "2026-06-06" }, status: 201 });
    sent.length = 0;
    const res = await api(port, "POST", `/api/plans/${id}/proposals/${bea.user.id}/accept`, { token: alex.token, status: 200 });
    assert.equal(res.plan.forDate, "2026-06-05");
    assert.equal(res.plan.time, "20:00");
    assert.deepEqual(res.plan.proposals, []);
    assert.deepEqual(endpoints(sent), [to(bea), to(sam), to(kim)].sort());
    for (const item of sent) assert.equal(item.payload.title, "Board games moved to Fri 5 Jun · 20:00");
    const seen = await api(port, "GET", "/api/plans", { token: sam.token, status: 200 });
    assert.deepEqual(seen.plans[0].proposals, []);
  }, { sent: "envelope" });
});

test("accepting a date-only proposal keeps the plan's time", async () => {
  await withApp(async ({ port }) => {
    const { alex, bea } = await circle(port);
    const id = await plan(port, alex.token);
    await api(port, "POST", `/api/plans/${id}/proposals`, { token: bea.token, body: { date: "2026-06-05" }, status: 201 });
    const res = await api(port, "POST", `/api/plans/${id}/proposals/${bea.user.id}/accept`, { token: alex.token, status: 200 });
    assert.equal(res.plan.forDate, "2026-06-05");
    assert.equal(res.plan.time, "19:00");
  }, { sent: "envelope" });
});

test("dismissing removes one proposal, tells the proposer, and leaves the date", async () => {
  await withApp(async ({ port, sent }) => {
    const { alex, bea, sam } = await circle(port);
    const id = await plan(port, alex.token);
    await api(port, "POST", `/api/plans/${id}/proposals`, { token: bea.token, body: { date: "2026-06-05" }, status: 201 });
    await api(port, "POST", `/api/plans/${id}/proposals`, { token: sam.token, body: { date: "2026-06-06" }, status: 201 });
    sent.length = 0;
    const res = await api(port, "POST", `/api/plans/${id}/proposals/${bea.user.id}/dismiss`, { token: alex.token, status: 200 });
    assert.equal(res.plan.forDate, "2026-06-02");
    assert.deepEqual(res.plan.proposals.map((p: { userId: string }) => p.userId), [sam.user.id]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].endpoint, to(bea));
    assert.equal(sent[0].payload.title, "Date kept");
    assert.equal(sent[0].payload.body, "Alex kept Board games on Tue 2 Jun · 19:00");
    assert.equal(sent[0].payload.tag, `plan-proposal:${id}:${bea.user.id}`);
    await api(port, "POST", `/api/plans/${id}/proposals/${bea.user.id}/dismiss`, { token: alex.token, status: 404 });
  }, { sent: "envelope" });
});

test("a removed guest cannot propose", async () => {
  await withApp(async ({ port }) => {
    const { alex, bea } = await circle(port);
    const id = await plan(port, alex.token);
    await api(port, "DELETE", `/api/plans/${id}/people/${bea.user.id}`, { token: alex.token, status: 204 });
    await api(port, "POST", `/api/plans/${id}/proposals`, { token: bea.token, body: { date: "2026-06-05" }, status: 403 });
  }, { sent: "envelope" });
});

test("a member who leaves the circle takes their proposal off the host's plan", async () => {
  await withApp(async ({ port }) => {
    const { alex, bea } = await circle(port);
    const id = await plan(port, alex.token);
    await api(port, "POST", `/api/plans/${id}/proposals`, { token: bea.token, body: { date: "2026-06-05" }, status: 201 });
    await api(port, "POST", "/api/circles/leave", { token: bea.token, body: {}, status: 200 });
    const seen = await api(port, "GET", "/api/plans", { token: alex.token, status: 200 });
    assert.deepEqual(seen.plans[0].proposals, []);
  }, { sent: "envelope" });
});

test("a plan that has ended takes no proposals", async () => {
  await withApp(async ({ port, at }) => {
    const { alex, bea } = await circle(port);
    const id = await plan(port, alex.token);
    at(START + 3 * DAY);
    await api(port, "POST", `/api/plans/${id}/proposals`, { token: bea.token, body: { date: "2026-06-10" }, status: 410 });
  }, { sent: "envelope" });
});
