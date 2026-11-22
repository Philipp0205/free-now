import assert from "node:assert/strict";
import test from "node:test";
import { sendStartReminders } from "../../src/push/remind.js";
import { api, withApp, type AppCtx, type SentPush, testEmail } from "../http.js";

type Person = { token: string; user: { id: string; name: string } };

const ENV = { sent: "envelope" as const };
const UNKNOWN = "00000000-0000-4000-8000-000000000000";

/** Friends: Alex (host), Bea, Cam, Dan. Olli has his own circle. Everyone gets a push endpoint. */
async function seed(port: number) {
  const start = (name: string, code?: string): Promise<Person> =>
    api(port, "POST", "/api/auth/start", { body: code ? { name, email: testEmail(), code } : { name, email: testEmail() }, status: 201 });
  const alex = await start("Alex");
  const a = (await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Friends" }, status: 201 })).circle;
  const bea = await start("Bea", a.inviteCode);
  const cam = await start("Cam", a.inviteCode);
  const dan = await start("Dan", a.inviteCode);
  const olli = await start("Olli");
  await api(port, "POST", "/api/circles", { token: olli.token, body: { name: "Elsewhere" }, status: 201 });
  for (const person of [alex, bea, cam, dan]) {
    await api(port, "POST", "/api/push/subscribe", {
      token: person.token,
      body: { endpoint: to(person), keys: { p256dh: "p", auth: "a" } },
      status: 204,
    });
  }
  return { alex, bea, cam, dan, olli, a };
}

const to = (person: Person) => `https://push.example/${person.user.id}`;
const endpoints = (sent: SentPush[]) => sent.map((item) => item.endpoint).sort();
const ids = (...people: Person[]) => people.map((person) => person.user.id);

async function makePlan(port: number, host: Person, circleId: string, body: Record<string, unknown> = {}) {
  return (await api(port, "POST", `/api/plans?circle=${circleId}`, {
    token: host.token,
    body: { note: "Secret supper", place: "Hall", date: "2026-06-03", time: "18:00", ...body },
    status: 201,
  })).plan;
}

async function makeSocial(port: number, host: Person, circleId: string, body: Record<string, unknown> = {}) {
  return (await api(port, "POST", `/api/socials?circle=${circleId}`, { token: host.token, body: { note: "Quiet walk", ...body }, status: 201 })).social;
}

/** What the app says to someone who asks about an event that does not exist. */
async function missing(ctx: AppCtx<SentPush>, person: Person, method: string, path: (id: string) => string, body?: unknown) {
  return api(ctx, method, path(UNKNOWN), { token: person.token, body });
}

test("a private social is only for the picked friends and the host", async () => {
  await withApp(async (ctx) => {
    const { alex, bea, cam, a } = await seed(ctx.port);
    const social = await makeSocial(ctx.port, alex, a.id, { invitees: ids(bea) });
    assert.equal(social.private, true);
    assert.deepEqual(social.invitees.map((person: { id: string }) => person.id), ids(alex, bea));
    assert.deepEqual(endpoints(ctx.sent), [to(bea)], "only Bea hears about it");

    const bealist = await api(ctx, "GET", `/api/socials?circle=${a.id}`, { token: bea.token, status: 200 });
    assert.deepEqual(bealist.json.socials.map((row: { id: string }) => row.id), [social.id]);
    for (const path of [`/api/socials?circle=${a.id}`, "/api/socials?all=1"]) {
      assert.deepEqual((await api(ctx, "GET", path, { token: cam.token, status: 200 })).json.socials, [], path);
    }

    const join = (person: Person, id: string) => api(ctx, "POST", `/api/socials/${id}/join?circle=${a.id}`, { token: person.token });
    const hidden = await join(cam, social.id);
    const absent = await join(cam, UNKNOWN);
    assert.equal(hidden.status, 404);
    assert.deepEqual(hidden, absent, "an unpicked friend sees the same answer as for a missing event");
    assert.equal((await join(bea, social.id)).status, 200);

    const reply = await api(ctx, "POST", `/api/socials/${social.id}/reply?circle=${a.id}`, { token: cam.token, body: { reply: "coming" } });
    assert.deepEqual(reply, await missing(ctx, cam, "POST", (id) => `/api/socials/${id}/reply?circle=${a.id}`, { reply: "coming" }));
    assert.equal(reply.status, 404);
  }, ENV);
});

test("a private plan is hidden from lists, the calendar, the feed and its chat", async () => {
  await withApp(async (ctx) => {
    const { alex, bea, cam, a } = await seed(ctx.port);
    const plan = await makePlan(ctx.port, alex, a.id, { invitees: ids(bea) });
    assert.equal(plan.private, true);
    assert.deepEqual(endpoints(ctx.sent), [to(bea)]);
    await api(ctx, "POST", `/api/plans/${plan.id}/reply?circle=${a.id}`, { token: bea.token, body: { reply: "coming" }, status: 200 });

    for (const path of [`/api/plans?circle=${a.id}`, "/api/plans?all=1"]) {
      assert.deepEqual((await api(ctx, "GET", path, { token: bea.token, status: 200 })).json.plans.map((row: { id: string }) => row.id), [plan.id], path);
      assert.deepEqual((await api(ctx, "GET", path, { token: cam.token, status: 200 })).json.plans, [], path);
    }
    const month = `/api/calendar-month?from=2026-06-01&to=2026-06-30&circle=${a.id}`;
    assert.equal((await api(ctx, "GET", month, { token: bea.token, status: 200 })).json.plans.length, 1);
    assert.deepEqual((await api(ctx, "GET", month, { token: cam.token, status: 200 })).json.plans, []);

    assert.equal(await fetchStatus(ctx, `/api/plans/${plan.id}/calendar.ics`, cam), 404);
    assert.equal(await fetchStatus(ctx, `/api/plans/${plan.id}/calendar.ics`, bea), 200);

    const chat = `/api/plans/${plan.id}/chat?circle=${a.id}`;
    const hidden = await api(ctx, "GET", chat, { token: cam.token });
    assert.equal(hidden.status, 404);
    assert.deepEqual(hidden, await missing(ctx, cam, "GET", (id) => `/api/plans/${id}/chat?circle=${a.id}`));
    assert.equal((await api(ctx, "POST", chat, { token: bea.token, body: { text: "hi" }, status: 201 })).status, 201);
    assert.equal((await api(ctx, "POST", chat, { token: cam.token, body: { text: "hi" } })).status, 404);
    assert.deepEqual((await api(ctx, "GET", `/api/chats?circle=${a.id}`, { token: cam.token, status: 200 })).json.events, []);
    assert.equal((await api(ctx, "GET", `/api/chats?circle=${a.id}`, { token: bea.token, status: 200 })).json.events.length, 1);
  }, ENV);
});

/** HTTP status of a raw GET, without the JSON parsing api() does. */
async function fetchStatus(ctx: AppCtx<SentPush>, path: string, person: Person): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${ctx.port}${path}`, { headers: { authorization: `Bearer ${person.token}` } });
  await response.text();
  return response.status;
}

test("the calendar feed leaves out a private plan for people who are not on it", async () => {
  await withApp(async (ctx) => {
    const { alex, bea, cam, a } = await seed(ctx.port);
    const plan = await makePlan(ctx.port, alex, a.id, { invitees: ids(bea) });
    await api(ctx, "POST", `/api/plans/${plan.id}/reply?circle=${a.id}`, { token: bea.token, body: { reply: "coming" }, status: 200 });
    const feed = async (person: Person) => {
      const made = await fetch(`http://127.0.0.1:${ctx.port}/api/me/calendar-feed`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${person.token}` },
        body: "{}",
      });
      const url = new URL(((await made.json()) as { url: string }).url);
      return (await (await fetch(`http://127.0.0.1:${ctx.port}${url.pathname}`)).text());
    };
    assert.equal((await feed(bea)).includes(`${plan.id}@hangry`), true);
    assert.equal((await feed(cam)).includes(`${plan.id}@hangry`), false);
  }, ENV);
});

test("a private plan link only previews for the people it is for", async () => {
  await withApp(async (ctx) => {
    const { alex, bea, cam, a } = await seed(ctx.port);
    const plan = await makePlan(ctx.port, alex, a.id, { invitees: ids(bea) });
    const { shareId } = (await api(ctx, "POST", `/api/plans/${plan.id}/share?circle=${a.id}`, { token: alex.token, status: 200 })).json;
    assert.ok(shareId, "the host can still make a link");
    const preview = (person?: Person) => api(ctx, "GET", `/api/plans/share/${shareId}`, { token: person?.token, status: 200 }).then((r) => r.json);

    assert.equal((await preview(alex)).ended, false);
    assert.equal((await preview(bea)).ended, false);
    assert.deepEqual(await preview(cam), { ended: true });
    assert.deepEqual(await preview(), { ended: true }, "a stranger gets the ended copy");
    assert.equal((await api(ctx, "POST", `/api/plans/${plan.id}/share?circle=${a.id}`, { token: cam.token })).status, 404);
  }, ENV);
});

test("reminders and the start nudge only reach the invitees", async () => {
  await withApp(async (ctx) => {
    const { alex, bea, cam, dan, a } = await seed(ctx.port);
    const plan = await makePlan(ctx.port, alex, a.id, { invitees: ids(bea, dan) });
    ctx.sent.length = 0;
    await api(ctx, "POST", `/api/plans/${plan.id}/remind?circle=${a.id}`, { token: alex.token, status: 200 });
    assert.ok(!endpoints(ctx.sent).includes(to(cam)), "Cam is never pinged");

    ctx.sent.length = 0;
    const social = await makeSocial(ctx.port, alex, a.id, { startsAt: "18:00", invitees: ids(bea) });
    assert.deepEqual(endpoints(ctx.sent), [to(bea)]);
    await api(ctx, "POST", `/api/socials/${social.id}/reply?circle=${a.id}`, { token: bea.token, body: { reply: "coming" }, status: 200 });
    ctx.sent.length = 0;
    const sender = { async send(subscription: { endpoint: string }) { ctx.sent.push({ endpoint: subscription.endpoint, payload: {} as never }); } };
    await sendStartReminders(ctx.db, sender as never, social.startsAt);
    assert.deepEqual(endpoints(ctx.sent), [to(bea)]);
  }, ENV);
});

test("only the host changes who an event is for, and only to people in the circle", async () => {
  await withApp(async (ctx) => {
    const { alex, bea, cam, dan, olli, a } = await seed(ctx.port);
    const plan = await makePlan(ctx.port, alex, a.id, { invitees: ids(bea) });
    const edit = (person: Person, invitees: unknown) =>
      api(ctx, "PATCH", `/api/plans/${plan.id}?circle=${a.id}`, { token: person.token, body: { invitees } });

    assert.equal((await edit(bea, ids(bea, cam))).status, 403);
    assert.equal((await edit(alex, ids(olli))).status, 400, "someone outside the circle");
    assert.equal((await edit(alex, "everyone")).status, 400, "not a list");

    const widened = await edit(alex, ids(bea, cam));
    assert.equal(widened.status, 200);
    assert.deepEqual(widened.json.plan.invitees.map((person: { id: string }) => person.id), ids(alex, bea, cam));
    assert.equal((await api(ctx, "GET", `/api/plans?circle=${a.id}`, { token: dan.token, status: 200 })).json.plans.length, 0);

    const open = await edit(alex, []);
    assert.equal(open.status, 200);
    assert.equal(open.json.plan.private, undefined, "clearing the list makes it public again");
    assert.equal((await api(ctx, "GET", `/api/plans?circle=${a.id}`, { token: dan.token, status: 200 })).json.plans.length, 1);
  }, ENV);
});

test("without invitees an event stays open to the circle", async () => {
  await withApp(async (ctx) => {
    const { alex, cam, a } = await seed(ctx.port);
    const plan = await makePlan(ctx.port, alex, a.id);
    const social = await makeSocial(ctx.port, alex, a.id, { invitees: [] });
    assert.equal(plan.private, undefined);
    assert.equal(social.private, undefined);
    assert.equal((ctx.db.prepare("SELECT COUNT(*) AS n FROM event_invitees").get() as { n: number }).n, 0);
    assert.equal((await api(ctx, "GET", `/api/plans?circle=${a.id}`, { token: cam.token, status: 200 })).json.plans.length, 1);
    assert.equal((await api(ctx, "GET", `/api/socials?circle=${a.id}`, { token: cam.token, status: 200 })).json.socials.length, 1);
  }, ENV);
});

test("a private I'm free only hides the host's busy hours from the people it is for", async () => {
  await withApp(async (ctx) => {
    const wedMorning = Date.parse("2026-11-11T09:00:00Z");
    ctx.at(wedMorning);
    const { alex, bea, cam, a } = await seed(ctx.port);
    await api(ctx.port, "PUT", "/api/me/busy-hours", {
      token: alex.token,
      body: { timezone: "Europe/Berlin", blocks: [{ days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" }] },
      status: 200,
    });
    const seen = async (viewer: Person) => {
      const got = await api(ctx.port, "GET", `/api/me?circle=${a.id}`, { token: viewer.token, status: 200 });
      return (got.circle.members as Array<{ id: string; status: { source?: string } | null }>).find((member) => member.id === alex.user.id)?.status ?? null;
    };
    assert.equal((await seen(cam))?.source, "schedule", "Cam sees Alex as busy before the post");
    await makeSocial(ctx.port, alex, a.id, { invitees: ids(bea) });
    assert.equal((await api(ctx.port, "GET", "/api/me", { token: alex.token, status: 200 })).user.status, null, "Alex is free to himself");
    assert.equal(await seen(bea), null, "Bea, who was picked, sees Alex as free");
    assert.equal((await seen(cam))?.source, "schedule", "Cam, who was not picked, still sees the busy hours");
  }, { ...ENV, tz: "Europe/Berlin" });
});

test("making a public plan private drops leftover alerts for people who are no longer on it", async () => {
  await withApp(async (ctx) => {
    const { alex, bea, cam, a } = await seed(ctx.port);
    const plan = await makePlan(ctx.port, alex, a.id);
    const alerts = async (person: Person) =>
      (await api(ctx.port, "GET", `/api/notifications?circle=${a.id}`, { token: person.token, status: 200 })).notifications as Array<{ refId: string }>;
    assert.ok((await alerts(cam)).some((row) => row.refId === plan.id), "Cam heard about the public plan");
    await api(ctx.port, "PATCH", `/api/plans/${plan.id}?circle=${a.id}`, { token: alex.token, body: { invitees: ids(bea) }, status: 200 });
    assert.ok((await alerts(bea)).some((row) => row.refId === plan.id), "Bea keeps the alert");
    assert.ok((await alerts(cam)).every((row) => row.refId !== plan.id), "Cam's leftover alert is gone");
  }, ENV);
});
