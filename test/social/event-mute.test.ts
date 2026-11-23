import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../../src/config.js";
import { type Notice, notifyUsers } from "../../src/push/notify.js";
import { sendStartReminders } from "../../src/push/remind.js";
import type { PushPayload, PushSender } from "../../src/push/push.js";
import { materializeRecurringPlans } from "../../src/social/recurring-plans.js";
import { api, withApp, type AppCtx, type SentPush, START, testEmail } from "../http.js";

type Person = { token: string; user: { id: string; name: string } };

const ENV = { sent: "envelope" as const, tz: "Europe/Berlin" };
const TZ = "Europe/Berlin";
const config = loadConfig({ PORT: "3000", DB_PATH: ":memory:", APP_TZ: TZ });
const PIN = { lat: 52.52, lng: 13.405 };
const UNKNOWN = "00000000-0000-4000-8000-000000000000";
const MUTED_KINDS = ["plan-reply", "reply", "join", "plan-change", "social-start", "arrived", "ended", "plan-remind", "social", "plan"];

const to = (person: Person) => `https://push.example/${person.user.id}`;
const endpoints = (sent: SentPush[]) => sent.map((item) => item.endpoint).sort();

/** Alex (host), Bea and Cam in one circle. Everyone has a push endpoint. */
async function seed(port: number) {
  const start = (name: string, code?: string): Promise<Person> =>
    api(port, "POST", "/api/auth/start", { body: code ? { name, email: testEmail(), code } : { name, email: testEmail() }, status: 201 });
  const alex = await start("Alex");
  const circle = (await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Friends" }, status: 201 })).circle;
  const bea = await start("Bea", circle.inviteCode);
  const cam = await start("Cam", circle.inviteCode);
  const outsider = await start("Olli");
  await api(port, "POST", "/api/circles", { token: outsider.token, body: { name: "Elsewhere" }, status: 201 });
  for (const person of [alex, bea, cam]) {
    await api(port, "POST", "/api/push/subscribe", { token: person.token, body: { endpoint: to(person), keys: { p256dh: "p", auth: "a" } }, status: 204 });
  }
  return { alex, bea, cam, outsider, circle: circle as { id: string; name: string } };
}

async function makePlan(ctx: AppCtx<SentPush>, host: Person, circleId: string, body: Record<string, unknown> = {}) {
  const plan = { note: "Supper", place: "Hall", date: "2026-06-03", time: "18:00", durationMin: 120, ...body };
  return (await api(ctx, "POST", `/api/plans?circle=${circleId}`, { token: host.token, body: plan, status: 201 })).json.plan;
}

async function makeSocial(ctx: AppCtx<SentPush>, host: Person, circleId: string, body: Record<string, unknown> = {}, status = 201) {
  return (await api(ctx, "POST", `/api/socials?circle=${circleId}`, { token: host.token, body: { note: "Coffee", ...body }, status })).json.social;
}

const mute = (ctx: AppCtx<SentPush>, kind: "plan" | "social", id: string, person: Person, muted = true) =>
  api(ctx, "POST", `/api/${kind}s/${id}/mute`, { token: person.token, body: { muted } });

const reply = (ctx: AppCtx<SentPush>, kind: "plan" | "social", id: string, person: Person, body: Record<string, unknown> = { reply: "coming" }) =>
  api(ctx, "POST", `/api/${kind}s/${id}/reply`, { token: person.token, body, status: 200 });

const alerts = (ctx: AppCtx<SentPush>, person: Person, kind: string) =>
  Number((ctx.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = ?").get(person.user.id, kind) as { n: number }).n);

const muteRows = (ctx: AppCtx<SentPush>) =>
  (ctx.db.prepare("SELECT m.user_id, c.kind, c.ref_id FROM chat_mutes m JOIN chats c ON c.id = m.chat_id ORDER BY m.user_id").all() as Array<{ user_id: string; kind: string; ref_id: string }>)
    .map((row) => ({ ...row }));

const clearAlerts = (ctx: AppCtx<SentPush>) => ctx.db.exec("DELETE FROM notifications");

test("the event mute route writes the chat_mutes row the chat header uses, and both stay in sync", async () => {
  await withApp(async (ctx) => {
    const { alex, bea, circle } = await seed(ctx.port);
    const plan = await makePlan(ctx, alex, circle.id);
    assert.equal(plan.muted, false);
    assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM chats WHERE ref_id = ?").get(plan.id)?.n, 0, "no chat yet");

    const muted = await mute(ctx, "plan", plan.id, bea);
    assert.equal(muted.status, 200);
    assert.equal(muted.json.plan.muted, true);
    assert.deepEqual(muteRows(ctx), [{ user_id: bea.user.id, kind: "plan", ref_id: plan.id }], "the chat was made and muted");
    assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM chat_reads").get()?.n, 0, "muting does not mark the chat read");

    const list = (await api(ctx, "GET", `/api/plans?circle=${circle.id}`, { token: bea.token, status: 200 })).json.plans;
    assert.equal(list[0].muted, true);
    const hostList = (await api(ctx, "GET", `/api/plans?circle=${circle.id}`, { token: alex.token, status: 200 })).json.plans;
    assert.equal(hostList[0].muted, false, "the flag is per viewer");

    const thread = (await api(ctx, "GET", `/api/plans/${plan.id}/chat?circle=${circle.id}`, { token: bea.token, status: 200 })).json.chat;
    assert.equal(thread.muted, true, "the chat header reads the same row");

    await api(ctx, "POST", `/api/chats/${thread.id}/mute`, { token: bea.token, body: { muted: false }, status: 204 });
    assert.equal((await api(ctx, "GET", `/api/plans?circle=${circle.id}`, { token: bea.token, status: 200 })).json.plans[0].muted, false);

    await api(ctx, "POST", `/api/chats/${thread.id}/mute`, { token: bea.token, body: { muted: true }, status: 204 });
    assert.equal(muteRows(ctx).length, 1, "one row, not two");
    const back = await mute(ctx, "plan", plan.id, bea, false);
    assert.equal(back.json.plan.muted, false);
    assert.deepEqual(muteRows(ctx), []);
  }, ENV);
});

test("a social can be muted before anyone chats, the host can mute too, and outsiders get a 404", async () => {
  await withApp(async (ctx) => {
    const { alex, bea, outsider, circle } = await seed(ctx.port);
    const social = await makeSocial(ctx, alex, circle.id);
    assert.equal(social.muted, false);
    assert.equal((await mute(ctx, "social", social.id, alex)).json.social.muted, true, "the host can mute their own");
    assert.equal((await mute(ctx, "social", social.id, bea)).json.social.muted, true);
    const thread = (await api(ctx, "GET", `/api/socials/${social.id}/chat?circle=${circle.id}`, { token: bea.token, status: 200 })).json.chat;
    assert.equal(thread.muted, true);

    const hidden = await mute(ctx, "social", social.id, outsider);
    const absent = await mute(ctx, "social", UNKNOWN, outsider);
    assert.equal(hidden.status, 404);
    assert.deepEqual(hidden, absent, "an outsider cannot tell a hidden event from a missing one");
    assert.equal((await mute(ctx, "plan", UNKNOWN, bea)).status, 404);
    assert.equal((await api(ctx, "POST", `/api/socials/${social.id}/mute`, { body: { muted: true } })).status, 401);
  }, ENV);
});

test("a private event can only be muted by the people who can see it", async () => {
  await withApp(async (ctx) => {
    const { alex, bea, cam, circle } = await seed(ctx.port);
    const plan = await makePlan(ctx, alex, circle.id, { invitees: [bea.user.id] });
    assert.equal((await mute(ctx, "plan", plan.id, bea)).status, 200);
    assert.equal((await mute(ctx, "plan", plan.id, cam)).status, 404);
    assert.equal(muteRows(ctx).length, 1);
  }, ENV);
});

test("a muted person gets no push and no alert for any event update kind, but a removal still gets through", async () => {
  await withApp(async (ctx) => {
    const { alex, bea, cam, circle } = await seed(ctx.port);
    const plan = await makePlan(ctx, alex, circle.id);
    const social = await makeSocial(ctx, alex, circle.id);
    for (const [kind, id] of [["plan", plan.id], ["social", social.id]] as const) await mute(ctx, kind, id, bea);
    const sender: PushSender = { async send(sub, payload: PushPayload) { ctx.sent.push({ endpoint: sub.endpoint, payload }); } };
    const notice = (person: Person, kind: string, refId: string | null): Notice => ({ userId: person.user.id, title: "T", body: "B", kind, refId, tag: `${kind}:${refId}` });

    for (const refId of [plan.id, social.id]) {
      clearAlerts(ctx);
      for (const kind of MUTED_KINDS) {
        ctx.sent.length = 0;
        await notifyUsers(ctx.db, sender, START, [notice(bea, kind, refId), notice(cam, kind, refId)]);
        assert.deepEqual(endpoints(ctx.sent), [to(cam)], `${kind}: only Cam is told`);
        assert.equal(alerts(ctx, bea, kind), 0, `${kind}: no alert for Bea`);
        assert.equal(alerts(ctx, cam, kind) > 0, true, `${kind}: Cam gets an alert`);
      }
      ctx.sent.length = 0;
      await notifyUsers(ctx.db, sender, START, [notice(bea, "removed", refId)]);
      assert.deepEqual(endpoints(ctx.sent), [to(bea)], "removed is always heard");
    }
    assert.equal(alerts(ctx, bea, "removed"), 1, "the removal alert of the last event is there");

    ctx.sent.length = 0;
    await notifyUsers(ctx.db, sender, START, [notice(bea, "member-join", plan.id), notice(bea, "circle-deleted", plan.id), notice(bea, "test", null)]);
    assert.deepEqual(ctx.sent.map((item) => item.endpoint), [to(bea), to(bea), to(bea)], "circle level notices and the test push stay audible");
  }, ENV);
});

test("a muted plan stays quiet for plan changes, reminders, replies and ends, and the host can mute too", async () => {
  await withApp(async (ctx) => {
    const { alex, bea, cam, circle } = await seed(ctx.port);
    const plan = await makePlan(ctx, alex, circle.id);
    await reply(ctx, "plan", plan.id, cam);
    await mute(ctx, "plan", plan.id, bea);
    await mute(ctx, "plan", plan.id, cam);

    ctx.sent.length = 0;
    await api(ctx, "PATCH", `/api/plans/${plan.id}?circle=${circle.id}`, { token: alex.token, body: { time: "19:00" }, status: 200 });
    assert.deepEqual(endpoints(ctx.sent), [], "plan-change skips both muted people");
    await api(ctx, "POST", `/api/plans/${plan.id}/remind?circle=${circle.id}`, { token: alex.token, status: 200 });
    assert.deepEqual(endpoints(ctx.sent), [], "plan-remind skips Bea, who has not answered");

    await mute(ctx, "plan", plan.id, bea, false);
    ctx.sent.length = 0;
    await api(ctx, "PATCH", `/api/plans/${plan.id}?circle=${circle.id}`, { token: alex.token, body: { time: "20:00" }, status: 200 });
    assert.deepEqual(endpoints(ctx.sent), [to(bea)], "an unmuted member is told again");

    await mute(ctx, "plan", plan.id, alex);
    ctx.sent.length = 0;
    await reply(ctx, "plan", plan.id, bea);
    assert.deepEqual(endpoints(ctx.sent), [], "plan-reply skips a muted host");
    await mute(ctx, "plan", plan.id, alex, false);
    await reply(ctx, "plan", plan.id, bea, { reply: "maybe" });
    assert.deepEqual(endpoints(ctx.sent), [to(alex)], "and tells the host again after Unmute");

    await mute(ctx, "plan", plan.id, bea);
    ctx.sent.length = 0;
    await api(ctx, "DELETE", `/api/plans/${plan.id}?circle=${circle.id}`, { token: alex.token, status: 204 });
    assert.equal(ctx.sent.some((item) => item.endpoint === to(bea)), false, "ended skips a muted person");
  }, ENV);
});

test("a muted person who is removed is still told", async () => {
  await withApp(async (ctx) => {
    const { alex, bea, circle } = await seed(ctx.port);
    const plan = await makePlan(ctx, alex, circle.id);
    await mute(ctx, "plan", plan.id, bea);
    ctx.sent.length = 0;
    await api(ctx, "DELETE", `/api/plans/${plan.id}/people/${bea.user.id}?circle=${circle.id}`, { token: alex.token, status: 204 });
    assert.deepEqual(endpoints(ctx.sent), [to(bea)]);
    assert.equal(ctx.sent[0].payload.title, "Removed");
  }, ENV);
});

test("a muted social stays quiet for joins, replies, arrivals, the start nudge and a renotify", async () => {
  await withApp(async (ctx) => {
    const { alex, bea, cam, circle } = await seed(ctx.port);
    const social = await makeSocial(ctx, alex, circle.id, { place: "Cafe Lina", ...PIN });
    await mute(ctx, "social", social.id, alex);

    ctx.sent.length = 0;
    await api(ctx, "POST", `/api/socials/${social.id}/join?circle=${circle.id}`, { token: bea.token, status: 200 });
    await reply(ctx, "social", social.id, cam, { reply: "coming", eta: 5 });
    assert.deepEqual(endpoints(ctx.sent), [], "join and reply skip a muted host");

    await mute(ctx, "social", social.id, cam);
    ctx.sent.length = 0;
    await api(ctx, "POST", `/api/socials/${social.id}/live?circle=${circle.id}`, { token: bea.token, body: { ...PIN, accuracy: 10 }, status: 200 });
    assert.deepEqual(endpoints(ctx.sent), [], "arrived skips the muted host and the muted guest");

    ctx.advance(20_000);
    ctx.sent.length = 0;
    await makeSocial(ctx, alex, circle.id, { note: "Coffee, now with cake" }, 200);
    assert.deepEqual(endpoints(ctx.sent), [to(bea)], "a social update reaches only the unmuted member");
    await mute(ctx, "social", social.id, bea);
    ctx.advance(20_000);
    ctx.sent.length = 0;
    await makeSocial(ctx, alex, circle.id, { note: "Coffee, and tea" }, 200);
    assert.deepEqual(endpoints(ctx.sent), [], "and nobody once Bea mutes too");
  }, ENV);
});

test("the start nudge skips a muted person and still reaches the others", async () => {
  await withApp(async (ctx) => {
    const { alex, bea, cam, circle } = await seed(ctx.port);
    const social = await makeSocial(ctx, alex, circle.id, { startsAt: "18:00" });
    await reply(ctx, "social", social.id, bea);
    await reply(ctx, "social", social.id, cam);
    await mute(ctx, "social", social.id, bea);
    clearAlerts(ctx);
    ctx.sent.length = 0;
    const sender: PushSender = { async send(sub, payload: PushPayload) { ctx.sent.push({ endpoint: sub.endpoint, payload }); } };
    await sendStartReminders(ctx.db, sender, social.startsAt);
    assert.deepEqual(endpoints(ctx.sent), [to(cam)]);
    assert.equal(alerts(ctx, bea, "social-start"), 0);
    assert.equal(alerts(ctx, cam, "social-start"), 1);
  }, ENV);
});

test("a mute carries to the next occurrence of a repeating plan, so the muted person gets no new plan push", async () => {
  await withApp(async (ctx) => {
    const { alex, bea, cam, circle } = await seed(ctx.port);
    const plan = await makePlan(ctx, alex, circle.id, { recurrence: "weekly" });
    await mute(ctx, "plan", plan.id, bea);
    clearAlerts(ctx);

    const sent: string[] = [];
    const push: PushSender = { async send(sub) { sent.push(sub.endpoint); } };
    const after = Date.parse("2026-06-03T19:00:00Z");
    ctx.at(after);
    await materializeRecurringPlans({ db: ctx.db, push, config, now: () => after });

    assert.deepEqual(sent, [to(cam)], "only the unmuted friend hears about the next one");
    assert.equal(alerts(ctx, bea, "plan"), 0);
    assert.equal(alerts(ctx, cam, "plan"), 1);
    const next = ctx.db.prepare("SELECT id FROM plans WHERE for_date = '2026-06-10'").get() as { id: string };
    assert.deepEqual(muteRows(ctx).filter((row) => row.ref_id === next.id), [{ user_id: bea.user.id, kind: "plan", ref_id: next.id }], "the new chat is muted for Bea only");
    const seen = (await api(ctx, "GET", `/api/plans?circle=${circle.id}`, { token: bea.token, status: 200 })).json.plans as Array<{ id: string; muted: boolean }>;
    assert.equal(seen.find((row) => row.id === next.id)?.muted, true);
    const camSees = (await api(ctx, "GET", `/api/plans?circle=${circle.id}`, { token: cam.token, status: 200 })).json.plans as Array<{ id: string; muted: boolean }>;
    assert.equal(camSees.find((row) => row.id === next.id)?.muted, false);
  }, ENV);
});
