import assert from "node:assert/strict";
import test from "node:test";
import { replyLogText } from "../src/chat.js";
import { planReplyBody, replyPushBody } from "../src/notify.js";
import { normalizeReply } from "../src/socials.js";
import { api, withApp } from "./http.js";

async function circleOfTwo(port: number) {
  const alex = await api(port, "POST", "/api/auth/start", { body: { name: "Alex" }, status: 201 });
  const created = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "friends" }, status: 201 });
  const veit = await api(port, "POST", "/api/auth/start", { body: { name: "Veit", code: created.circle.inviteCode }, status: 201 });
  await api(port, "POST", "/api/push/subscribe", {
    token: alex.token,
    body: { endpoint: "https://push.example/alex", keys: { p256dh: "p", auth: "a" } },
    status: 204,
  });
  return { alex, veit };
}

test("normalizeReply accepts maybe next to in and can't", () => {
  assert.equal(normalizeReply("maybe"), "maybe");
  for (const value of ["in", "join", "coming"]) assert.equal(normalizeReply(value), "coming");
  for (const value of ["cant", "can't", "declined"]) assert.equal(normalizeReply(value), "declined");
  assert.throws(() => normalizeReply("perhaps"), /reply must be in, maybe, or can't/);
  assert.throws(() => normalizeReply(undefined), /reply must be in, maybe, or can't/);
});

test("maybe has its own short copy for the log and pushes", () => {
  assert.equal(replyLogText("Alex", "maybe", null, "", false), "Alex is maybe");
  assert.equal(replyLogText("Alex", "maybe", 10, "18:00", true), "Alex is maybe");
  assert.equal(planReplyBody("Alex", "Bouldering", "maybe"), "Alex is maybe for Bouldering");
  assert.equal(planReplyBody("Alex", " ", "maybe"), "Alex is maybe for the plan");
  assert.equal(replyPushBody("Alex", "maybe", 10, "18:00"), "Alex is maybe");
});

test("a plan takes maybe, clears the arrival, notifies the host, and can go back to in", async () => {
  await withApp(async ({ port, sent }) => {
    const { alex, veit } = await circleOfTwo(port);
    const plan = await api(port, "POST", "/api/plans", { token: alex.token, body: { note: "Bouldering" }, status: 201 });
    const id = plan.plan.id;

    const coming = await api(port, "POST", `/api/plans/${id}/reply`, { token: veit.token, body: { reply: "in", arriveAt: "18:00" }, status: 200 });
    assert.equal(coming.plan.joined[0].reply, "coming");
    assert.ok(coming.plan.joined[0].arriveAt);

    const maybe = await api(port, "POST", `/api/plans/${id}/reply`, { token: veit.token, body: { reply: "maybe" }, status: 200 });
    assert.equal(maybe.plan.joined[0].reply, "maybe");
    assert.equal(maybe.plan.joined[0].arriveAt, null);
    assert.equal(sent.at(-1)?.title, "Reply");
    assert.equal(sent.at(-1)?.body, "Veit is maybe for Bouldering");

    // Saying maybe again changes nothing and stays quiet.
    const before = sent.length;
    await api(port, "POST", `/api/plans/${id}/reply`, { token: veit.token, body: { reply: "maybe", arriveAt: "19:00" }, status: 200 });
    assert.equal(sent.length, before);

    const chat = await api(port, "GET", `/api/plans/${id}/chat`, { token: alex.token });
    assert.equal(chat.chat.messages.at(-1).text, "Veit is maybe");

    const listed = await api(port, "GET", "/api/plans", { token: alex.token });
    assert.equal(listed.plans[0].joined[0].reply, "maybe");

    const declined = await api(port, "POST", `/api/plans/${id}/reply`, { token: veit.token, body: { reply: "can't" }, status: 200 });
    assert.equal(declined.plan.joined[0].reply, "declined");
    await api(port, "POST", `/api/plans/${id}/reply`, { token: veit.token, body: { reply: "maybe" }, status: 200 });

    const back = await api(port, "POST", `/api/plans/${id}/reply`, { token: veit.token, body: { reply: "in" }, status: 200 });
    assert.equal(back.plan.joined[0].reply, "coming");
    assert.equal(sent.at(-1)?.body, "Veit is in for Bouldering");

    await api(port, "POST", `/api/plans/${id}/reply`, { token: veit.token, body: { reply: "maybe" }, status: 200 });
    const left = await api(port, "POST", `/api/plans/${id}/leave`, { token: veit.token, body: {}, status: 200 });
    assert.deepEqual(left.plan.joined, []);
  });
});

test("plan maybe: bad reply is 400, the host cannot reply, ended plans are 410", async () => {
  await withApp(async ({ port }) => {
    const { alex, veit } = await circleOfTwo(port);
    const plan = await api(port, "POST", "/api/plans", { token: alex.token, body: { note: "Dinner" }, status: 201 });
    const id = plan.plan.id;
    const bad = await api(port, "POST", `/api/plans/${id}/reply`, { token: veit.token, body: { reply: "perhaps" }, status: 400 });
    assert.equal(bad.error, "reply must be in, maybe, or can't");
    const host = await api(port, "POST", `/api/plans/${id}/reply`, { token: alex.token, body: { reply: "maybe" }, status: 400 });
    assert.equal(host.error, "you made this plan");
    await api(port, "DELETE", `/api/plans/${id}`, { token: alex.token, status: 204 });
    const ended = await api(port, "POST", `/api/plans/${id}/reply`, { token: veit.token, body: { reply: "maybe" }, status: 410 });
    assert.equal(ended.error, "That plan has ended.");
  });
});

test("a free-now social takes maybe, clears the eta, and notifies the host", async () => {
  await withApp(async ({ port, sent }) => {
    const { alex, veit } = await circleOfTwo(port);
    const social = await api(port, "POST", "/api/socials", { token: alex.token, body: { note: "Coffee?" }, status: 201 });
    const id = social.social.id;

    const coming = await api(port, "POST", `/api/socials/${id}/reply`, { token: veit.token, body: { reply: "coming", eta: 10 }, status: 200 });
    assert.equal(coming.social.joined[0].etaMin, 10);

    const maybe = await api(port, "POST", `/api/socials/${id}/reply`, { token: veit.token, body: { reply: "maybe", eta: 10, arriveAt: "16:00" }, status: 200 });
    assert.equal(maybe.social.joined[0].reply, "maybe");
    assert.equal(maybe.social.joined[0].etaMin, null);
    assert.equal(maybe.social.joined[0].arriveAt, null);
    assert.equal(sent.at(-1)?.title, "Reply");
    assert.equal(sent.at(-1)?.body, "Veit is maybe");

    const chat = await api(port, "GET", `/api/socials/${id}/chat`, { token: alex.token });
    assert.equal(chat.chat.messages.at(-1).text, "Veit is maybe");

    const bad = await api(port, "POST", `/api/socials/${id}/reply`, { token: veit.token, body: { reply: "sure?" }, status: 400 });
    assert.equal(bad.error, "reply must be in, maybe, or can't");
    await api(port, "POST", `/api/socials/${id}/reply`, { token: alex.token, body: { reply: "maybe" }, status: 400 });

    const left = await api(port, "POST", `/api/socials/${id}/leave`, { token: veit.token, body: {}, status: 200 });
    assert.deepEqual(left.social.joined, []);
  });
});

test("a maybe is not in: no start reminder and no ended push", async () => {
  await withApp(async ({ port, sent }) => {
    const { alex, veit } = await circleOfTwo(port);
    await api(port, "POST", "/api/push/subscribe", {
      token: veit.token,
      body: { endpoint: "https://push.example/veit", keys: { p256dh: "p", auth: "a" } },
      status: 204,
    });
    const plan = await api(port, "POST", "/api/plans", { token: alex.token, body: { note: "Picnic" }, status: 201 });
    await api(port, "POST", `/api/plans/${plan.plan.id}/reply`, { token: veit.token, body: { reply: "maybe" }, status: 200 });
    const before = sent.length;
    await api(port, "DELETE", `/api/plans/${plan.plan.id}`, { token: alex.token, status: 204 });
    assert.equal(sent.slice(before).some((payload) => payload.title === "Ended"), false);
  });
});
