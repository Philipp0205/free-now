import assert from "node:assert/strict";
import test from "node:test";
import { LIVE_TTL_MS, clearExpiredLocations } from "../../src/db.js";
import { ARRIVE_MAX_ACCURACY_M, ARRIVE_RADIUS_M } from "../../src/social/live.js";
import { api, withApp, type AppCtx, type SentPush, START, testEmail } from "../http.js";

type Person = { token: string; user: { id: string; name: string } };
type Kind = "social" | "plan";

const ENV = { sent: "envelope" as const, env: { SOCIAL_TTL_MS: "3600000" } };
const UNKNOWN = "00000000-0000-4000-8000-000000000000";
/** The pin every event uses, and readings around it. 0.0005 degrees of latitude is about 55 m. */
const PIN = { lat: 52.52, lng: 13.405 };
const NEAR = { lat: 52.5205, lng: 13.405, accuracy: 20 };
const FAR = { lat: 52.53, lng: 13.42, accuracy: 15 };

const to = (person: Person) => `https://push.example/${person.user.id}`;
const route = (kind: Kind) => (kind === "social" ? "socials" : "plans");

/** Alex (host), Bea, Cam and Dan in one circle, all with a push endpoint. */
async function seed(ctx: AppCtx<SentPush>) {
  const { port } = ctx;
  const start = (name: string, code?: string): Promise<Person> =>
    api(port, "POST", "/api/auth/start", { body: code ? { name, email: testEmail(), code } : { name, email: testEmail() }, status: 201 });
  const alex = await start("Alex");
  const circle = (await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Friends" }, status: 201 })).circle;
  const bea = await start("Bea", circle.inviteCode);
  const cam = await start("Cam", circle.inviteCode);
  const dan = await start("Dan", circle.inviteCode);
  for (const person of [alex, bea, cam, dan]) {
    await api(port, "POST", "/api/push/subscribe", { token: person.token, body: { endpoint: to(person), keys: { p256dh: "p", auth: "a" } }, status: 204 });
  }
  return { alex, bea, cam, dan, circleId: circle.id as string };
}

async function makeEvent(ctx: AppCtx<SentPush>, kind: Kind, host: Person, body: Record<string, unknown> = {}) {
  const base = kind === "social" ? { note: "Coffee", place: "Cafe Lina", ...PIN } : { note: "Dinner", place: "Cafe Lina", date: "2026-06-01", time: "16:00", endsAt: "23:00", ...PIN };
  const made = await api(ctx, "POST", `/api/${route(kind)}`, { token: host.token, body: { ...base, ...body }, status: 201 });
  return made.json[kind] as { id: string };
}

const join = (ctx: AppCtx<SentPush>, kind: Kind, id: string, person: Person) =>
  api(ctx, "POST", `/api/${route(kind)}/${id}/join`, { token: person.token, status: 200 });
const post = (ctx: AppCtx<SentPush>, kind: Kind, id: string, person: Person, body: unknown) =>
  api(ctx, "POST", `/api/${route(kind)}/${id}/live`, { token: person.token, body });
const read = (ctx: AppCtx<SentPush>, kind: Kind, id: string, person: Person) =>
  api(ctx, "GET", `/api/${route(kind)}/${id}/live`, { token: person.token });
const stop = (ctx: AppCtx<SentPush>, kind: Kind, id: string, person: Person) =>
  api(ctx, "DELETE", `/api/${route(kind)}/${id}/live`, { token: person.token });

/** The event as a viewer sees it in the list, so the payload field is what is tested. */
async function listed(ctx: AppCtx<SentPush>, kind: Kind, id: string, person: Person) {
  const out = await api(ctx, "GET", `/api/${route(kind)}?all=1`, { token: person.token, status: 200 });
  return (out.json[route(kind)] as Array<{ id: string; live?: Array<{ id: string; name: string }> }>).find((row) => row.id === id);
}

const rowCount = (ctx: AppCtx<SentPush>, id: string) =>
  Number((ctx.db.prepare("SELECT COUNT(*) AS n FROM event_live WHERE event_id = ?").get(id) as { n: number }).n);

for (const kind of ["social", "plan"] as const) {
  test(`${kind}: a post is stored, a second post replaces it, and the host and people in see it`, async () => {
    await withApp(async (ctx) => {
      const { alex, bea, cam } = await seed(ctx);
      const event = await makeEvent(ctx, kind, alex);
      await join(ctx, kind, event.id, bea);
      const first = await post(ctx, kind, event.id, bea, FAR);
      assert.equal(first.status, 200);
      assert.equal(first.json.arrived, false);
      await post(ctx, kind, event.id, bea, { lat: 52.531, lng: 13.421, accuracy: 10 });
      assert.equal(rowCount(ctx, event.id), 1, "one row per person, no history");

      for (const viewer of [alex, bea]) {
        const row = await listed(ctx, kind, event.id, viewer);
        assert.deepEqual(row?.live?.map((point) => point.name), ["Bea"]);
        assert.deepEqual((await read(ctx, kind, event.id, viewer)).json.live.map((point: { name: string }) => point.name), ["Bea"]);
      }
      const outsider = await listed(ctx, kind, event.id, cam);
      assert.equal(outsider !== undefined && "live" in outsider, false, "a circle member who is not in gets no live field");
      assert.deepEqual((await read(ctx, kind, event.id, cam)).json.live, []);

      assert.equal((await stop(ctx, kind, event.id, bea)).status, 204);
      assert.equal(rowCount(ctx, event.id), 0);
      assert.deepEqual((await listed(ctx, kind, event.id, alex))?.live, []);
    }, ENV);
  });

  test(`${kind}: a point older than the TTL is not returned and the sweeper removes it`, async () => {
    await withApp(async (ctx) => {
      const { alex, bea } = await seed(ctx);
      const event = await makeEvent(ctx, kind, alex);
      await join(ctx, kind, event.id, bea);
      await post(ctx, kind, event.id, bea, FAR);
      ctx.advance(LIVE_TTL_MS - 1000);
      assert.equal((await listed(ctx, kind, event.id, alex))?.live?.length, 1, "fresh just inside the TTL");
      ctx.advance(2000);
      assert.deepEqual((await listed(ctx, kind, event.id, alex))?.live, [], "gone once past the TTL");
      assert.deepEqual((await read(ctx, kind, event.id, alex)).json.live, []);
      assert.equal(rowCount(ctx, event.id), 1, "still stored until the sweeper runs");
      clearExpiredLocations(ctx.db, START + LIVE_TTL_MS + 1000, "2026-06-01");
      assert.equal(rowCount(ctx, event.id), 0);
      assert.equal((await post(ctx, kind, event.id, bea, FAR)).status, 200, "the sharer can resume while still in");
    }, ENV);
  });

  test(`${kind}: arriving stops the share, keeps no point and tells the others once, with no coordinates`, async () => {
    await withApp(async (ctx) => {
      const { alex, bea, cam, dan } = await seed(ctx);
      const event = await makeEvent(ctx, kind, alex);
      await join(ctx, kind, event.id, bea);
      await join(ctx, kind, event.id, dan);
      assert.equal((await post(ctx, kind, event.id, bea, FAR)).json.arrived, false);
      const before = ctx.sent.length;
      const arrived = await post(ctx, kind, event.id, bea, NEAR);
      assert.equal(arrived.json.arrived, true);
      assert.deepEqual((await read(ctx, kind, event.id, alex)).json.live, [], "no point is kept");

      const pushes = ctx.sent.slice(before);
      assert.deepEqual(pushes.map((item) => item.endpoint).sort(), [to(alex), to(dan)].sort(), "host and people in, not the arriver or someone who is not in");
      assert.ok(!pushes.some((item) => item.endpoint === to(cam)));
      for (const item of pushes) {
        assert.equal(item.payload.title, "Arrived");
        assert.equal(item.payload.body, "Bea arrived at Cafe Lina");
        assert.equal(/\d\d\.\d/.test(JSON.stringify(item.payload)), false, "no coordinates anywhere in the push");
      }
      await post(ctx, kind, event.id, bea, NEAR);
      await post(ctx, kind, event.id, bea, FAR);
      assert.equal(ctx.sent.length, before + 2, "one arrival push per share session");
    }, ENV);
  });

  test(`${kind}: the arrival rule needs a close, exact enough reading`, async () => {
    await withApp(async (ctx) => {
      const { alex, bea } = await seed(ctx);
      const event = await makeEvent(ctx, kind, alex);
      await join(ctx, kind, event.id, bea);
      const before = ctx.sent.length;
      assert.equal((await post(ctx, kind, event.id, bea, FAR)).json.arrived, false);
      const vague = await post(ctx, kind, event.id, bea, { ...NEAR, accuracy: ARRIVE_MAX_ACCURACY_M + 1 });
      assert.equal(vague.json.arrived, false, "a huge accuracy circle near the pin does not count");
      const edge = await post(ctx, kind, event.id, bea, { lat: PIN.lat + (ARRIVE_RADIUS_M + 60) / 111_320, lng: PIN.lng, accuracy: 10 });
      assert.equal(edge.json.arrived, false, "just outside the radius");
      assert.equal(ctx.sent.length, before);
      assert.equal(rowCount(ctx, event.id), 1);
      await stop(ctx, kind, event.id, bea);
      assert.equal((await post(ctx, kind, event.id, bea, { lat: PIN.lat, lng: PIN.lng })).json.arrived, true, "no accuracy given, on the pin");
    }, ENV);
  });

  test(`${kind}: going out, leaving or being removed stops the share`, async () => {
    await withApp(async (ctx) => {
      const { alex, bea, cam, dan } = await seed(ctx);
      const event = await makeEvent(ctx, kind, alex);
      for (const person of [bea, cam, dan]) {
        await join(ctx, kind, event.id, person);
        await post(ctx, kind, event.id, person, FAR);
      }
      assert.equal(rowCount(ctx, event.id), 3);
      await api(ctx, "POST", `/api/${route(kind)}/${event.id}/reply`, { token: bea.token, body: { reply: "declined" }, status: 200 });
      await api(ctx, "POST", `/api/${route(kind)}/${event.id}/leave`, { token: cam.token, status: 200 });
      await api(ctx, "DELETE", `/api/${route(kind)}/${event.id}/people/${dan.user.id}`, { token: alex.token, status: 204 });
      assert.equal(rowCount(ctx, event.id), 0);
      assert.equal((await post(ctx, kind, event.id, bea, FAR)).status, 403, "out means no more sharing");
    }, ENV);
  });

  test(`${kind}: ending the event, or reaching its end, stops every share`, async () => {
    await withApp(async (ctx) => {
      const { alex, bea } = await seed(ctx);
      const ended = await makeEvent(ctx, kind, alex);
      await join(ctx, kind, ended.id, bea);
      await post(ctx, kind, ended.id, bea, FAR);
      await api(ctx, "DELETE", `/api/${route(kind)}/${ended.id}`, { token: alex.token, status: 204 });
      assert.equal(rowCount(ctx, ended.id), 0);
      assert.equal((await post(ctx, kind, ended.id, bea, FAR)).status, 404);

      const timed = await makeEvent(ctx, kind, alex, kind === "social" ? { endsAt: "17:00" } : { time: "16:00", endsAt: "17:00" });
      await join(ctx, kind, timed.id, bea);
      await post(ctx, kind, timed.id, bea, FAR);
      ctx.advance(3 * 60 * 60 * 1000);
      assert.equal((await post(ctx, kind, timed.id, bea, FAR)).status, 404, "past its end time");
      assert.equal((await listed(ctx, kind, timed.id, alex))?.live, undefined, "no live field once it is over");
      clearExpiredLocations(ctx.db, START + 3 * 60 * 60 * 1000, "2026-06-01");
      assert.equal(rowCount(ctx, timed.id), 0);
    }, ENV);
  });

  test(`${kind}: no pin, no sharing, and a bad reading is refused`, async () => {
    await withApp(async (ctx) => {
      const { alex, bea, cam } = await seed(ctx);
      const bare = await makeEvent(ctx, kind, alex, { lat: null, lng: null });
      await join(ctx, kind, bare.id, bea);
      assert.equal((await post(ctx, kind, bare.id, bea, FAR)).status, 400);
      assert.equal((await post(ctx, kind, bare.id, alex, FAR)).status, 400);

      // A host has one active social at a time, so the pinned one is Cam's.
      const pinned = await makeEvent(ctx, kind, cam);
      await join(ctx, kind, pinned.id, bea);
      for (const bad of [{}, { lat: 91, lng: 1 }, { lat: 1, lng: 181 }, { lat: "x", lng: 1 }, { lat: 1 }, { ...FAR, accuracy: -1 }, { ...FAR, accuracy: "ok" }]) {
        assert.equal((await post(ctx, kind, pinned.id, bea, bad)).status, 400, JSON.stringify(bad));
      }
      assert.equal((await api(ctx, "POST", `/api/${route(kind)}/${pinned.id}/live`, { body: FAR })).status, 401, "sign in is required");
      assert.equal(rowCount(ctx, pinned.id), 0);
    }, ENV);
  });

  test(`${kind}: a private event is a 404 for anyone it is not for, and carries no live field`, async () => {
    await withApp(async (ctx) => {
      const { alex, bea, cam, dan } = await seed(ctx);
      const event = await makeEvent(ctx, kind, alex, { invitees: [bea.user.id, dan.user.id] });
      assert.equal((await listed(ctx, kind, event.id, bea))?.live, undefined, "invited but not in yet: no live field");
      await join(ctx, kind, event.id, bea);
      await post(ctx, kind, event.id, bea, FAR);
      assert.deepEqual((await listed(ctx, kind, event.id, bea))?.live?.map((point) => point.name), ["Bea"]);
      assert.equal((await listed(ctx, kind, event.id, dan))?.live, undefined, "invited but not in: still none");
      assert.equal(await listed(ctx, kind, event.id, cam), undefined, "the unpicked friend never sees the event");

      for (const [method, body] of [["POST", FAR], ["GET", undefined], ["DELETE", undefined]] as const) {
        const hidden = await api(ctx, method, `/api/${route(kind)}/${event.id}/live`, { token: cam.token, body });
        const absent = await api(ctx, method, `/api/${route(kind)}/${UNKNOWN}/live`, { token: cam.token, body });
        assert.equal(hidden.status, 404, method);
        assert.deepEqual(hidden, absent, `${method} reads the same as a missing event`);
      }
      assert.equal(rowCount(ctx, event.id), 1, "the hidden calls changed nothing");
    }, ENV);
  });
}

test("a post is rate limited per person", async () => {
  await withApp(async (ctx) => {
    const { alex, bea } = await seed(ctx);
    const event = await makeEvent(ctx, "social", alex);
    await join(ctx, "social", event.id, bea);
    let last = 200;
    for (let index = 0; index < 61; index += 1) last = (await post(ctx, "social", event.id, bea, FAR)).status;
    assert.equal(last, 429);
  }, ENV);
});

test("the live routes are not on the agent allow-list", async () => {
  const { isAgentAllowed } = await import("../../src/admin/openapi.js");
  assert.equal(isAgentAllowed("POST", `/api/socials/${UNKNOWN}/live`), false);
  assert.equal(isAgentAllowed("DELETE", `/api/plans/${UNKNOWN}/live`), false);
});
