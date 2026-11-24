import assert from "node:assert/strict";
import test from "node:test";
import { api, withApp, type AppCtx, type SentPush, testEmail } from "../http.js";

type Person = { token: string; buzzToken: string; user: { id: string } };

const to = (person: Person) => `https://push.example/${person.user.id}`;
const ENV = { sent: "envelope" as const };

/** Alex (owns the button), Bea and Cam in one circle, everyone with a push endpoint. */
async function seed(ctx: AppCtx<SentPush>) {
  const start = (name: string, code?: string): Promise<Person> =>
    api(ctx, "POST", "/api/auth/start", { body: code ? { name, email: testEmail(), code } : { name, email: testEmail() }, status: 201 }).then((r) => r.json);
  const alex = await start("Alex");
  const circle = (await api(ctx, "POST", "/api/circles", { token: alex.token, body: { name: "Friends" }, status: 201 })).json.circle;
  const bea = await start("Bea", circle.inviteCode);
  const cam = await start("Cam", circle.inviteCode);
  for (const person of [alex, bea, cam]) {
    await api(ctx, "POST", "/api/push/subscribe", { token: person.token, body: { endpoint: to(person), keys: { p256dh: "p", auth: "a" } }, status: 204 });
  }
  return { alex, bea, cam, circle: circle as { id: string } };
}

const press = (ctx: AppCtx<SentPush>, who: Person, headers: Record<string, string> = {}, query = "") =>
  fetch(`http://127.0.0.1:${ctx.port}/api/buzz/${who.buzzToken}${query}`, { method: "POST", headers });

const pushes = (ctx: AppCtx<SentPush>) => ctx.sent.map((item) => `${item.endpoint.split("/").pop()}|${item.payload.title}|${item.payload.body}`).sort();
const row = (ctx: AppCtx<SentPush>) => ({ ...(ctx.db.prepare("SELECT lat, lng, place FROM socials").get() as { lat: number | null; lng: number | null; place: string }) });

test("a Flic press sends one Buzz push to each other member and a confirmation to the presser", async () => {
  await withApp(async (ctx) => {
    const { alex, bea, cam } = await seed(ctx);
    ctx.sent.length = 0;
    const first = await press(ctx, alex);
    assert.equal(first.status, 201, await first.text());
    assert.deepEqual(pushes(ctx), [
      `${bea.user.id}|Buzz|Alex pressed the button`,
      `${cam.user.id}|Buzz|Alex pressed the button`,
      `${alex.user.id}|Buzz|Your button press went out to Friends`,
    ].sort());
    const tags = ctx.sent.map((item) => item.payload.tag).sort();
    assert.ok(tags.includes(`social:${(ctx.db.prepare("SELECT id FROM socials").get() as { id: string }).id}`));
    const alerts = ctx.db.prepare("SELECT user_id, title, body FROM notifications WHERE title = 'Buzz'").all();
    assert.equal(alerts.length, 3, "an in-app notification for each push");
    assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE title = 'Free now'").get()?.n, 0);
  }, ENV);
});

test("a repeat press skips the renotify wait but a bounce inside 15 s sends nothing", async () => {
  await withApp(async (ctx) => {
    const { alex } = await seed(ctx);
    await press(ctx, alex);
    ctx.advance(5_000);
    ctx.sent.length = 0;
    assert.equal((await press(ctx, alex)).status, 200);
    assert.deepEqual(ctx.sent, [], "a bounce is quiet");
    ctx.advance(20_000);
    assert.equal((await press(ctx, alex)).status, 200);
    assert.equal(ctx.sent.length, 3, "a later press notifies again, long before renotifyMs");
  }, ENV);
});

test("a muted social skips the Buzz push for the muted member", async () => {
  await withApp(async (ctx) => {
    const { alex, bea, cam } = await seed(ctx);
    await press(ctx, alex);
    const id = (ctx.db.prepare("SELECT id FROM socials").get() as { id: string }).id;
    await api(ctx, "POST", `/api/socials/${id}/mute`, { token: bea.token, body: { muted: true }, status: 200 });
    ctx.advance(20_000);
    ctx.sent.length = 0;
    await press(ctx, alex);
    assert.deepEqual(ctx.sent.map((item) => item.endpoint).sort(), [to(alex), to(cam)].sort());
  }, ENV);
});

test("the app's own I'm free post keeps the Free now copy and sends nothing to the poster", async () => {
  await withApp(async (ctx) => {
    const { alex, bea, cam, circle } = await seed(ctx);
    ctx.sent.length = 0;
    await api(ctx, "POST", `/api/socials?circle=${circle.id}`, { token: alex.token, body: { note: "Coffee" }, status: 201 });
    assert.deepEqual(pushes(ctx), [`${bea.user.id}|Free now|Alex is free now – Coffee`, `${cam.user.id}|Free now|Alex is free now – Coffee`].sort());
  }, ENV);
});

test("ending with DELETE sends no Buzz push", async () => {
  await withApp(async (ctx) => {
    const { alex } = await seed(ctx);
    await press(ctx, alex);
    ctx.sent.length = 0;
    const res = await fetch(`http://127.0.0.1:${ctx.port}/api/buzz/${alex.buzzToken}`, { method: "DELETE" });
    assert.equal(res.status, 204);
    assert.ok(ctx.sent.every((item) => item.payload.title !== "Buzz"));
  }, ENV);
});

test("location from headers is stored on a new social and the place text stays", async () => {
  await withApp(async (ctx) => {
    const { alex } = await seed(ctx);
    assert.equal((await press(ctx, alex, { latitude: "48.1374", longitude: "11.5755" })).status, 201);
    assert.deepEqual(row(ctx), { lat: 48.137, lng: 11.576, place: "" });
  }, ENV);
});

test("location from the query or a location header updates a live social and keeps its place", async () => {
  await withApp(async (ctx) => {
    const { alex } = await seed(ctx);
    await fetch(`http://127.0.0.1:${ctx.port}/api/buzz/${alex.buzzToken}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ place: "Cafe Lina" }) });
    assert.equal(row(ctx).lat, null);
    ctx.advance(20_000);
    assert.equal((await press(ctx, alex, {}, "?lat=48.1&lng=11.5")).status, 200);
    assert.deepEqual(row(ctx), { lat: 48.1, lng: 11.5, place: "Cafe Lina" });
    ctx.advance(20_000);
    await press(ctx, alex, { "x-location": "50.5,8.25" });
    assert.deepEqual(row(ctx), { lat: 50.5, lng: 8.25, place: "Cafe Lina" });
    ctx.advance(20_000);
    await press(ctx, alex);
    assert.deepEqual(row(ctx), { lat: 50.5, lng: 8.25, place: "Cafe Lina" }, "a press without location keeps the saved one");
  }, ENV);
});

test("junk coordinates in a header do not fail the press and post without location", async () => {
  await withApp(async (ctx) => {
    const { alex } = await seed(ctx);
    assert.equal((await press(ctx, alex, { latitude: "abc", longitude: "999" })).status, 201);
    assert.equal(row(ctx).lat, null);
  }, ENV);
});

test("a press without coordinates logs header names and body keys, no values and no token", async () => {
  await withApp(async (ctx) => {
    const { alex } = await seed(ctx);
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
    try {
      await press(ctx, alex, { "button-name": "Kitchen button" });
    } finally {
      console.log = original;
    }
    const line = lines.find((text) => text.startsWith("flic press without location"));
    assert.ok(line, lines.join("\n"));
    assert.match(line, /button-name/);
    assert.ok(!line.includes("Kitchen") && !line.includes(alex.buzzToken));
  }, ENV);
});
