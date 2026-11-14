import assert from "node:assert/strict";
import test from "node:test";
import { api, withApp, type AppCtx } from "../http.js";

async function setup(ctx: AppCtx) {
  const alex = (await api(ctx, "POST", "/api/auth/start", { body: { name: "Alex" }, status: 201 })).json;
  const home = (await api(ctx, "POST", "/api/circles", { token: alex.token, body: { name: "Home" }, status: 201 })).json.circle;
  const uni = (await api(ctx, "POST", "/api/circles", { token: alex.token, body: { name: "Uni" }, status: 201 })).json.circle;
  const work = (await api(ctx, "POST", "/api/circles", { token: alex.token, body: { name: "Work" }, status: 201 })).json.circle;
  return { alex, home, uni, work };
}

async function count(ctx: AppCtx, token: string, circleId: string): Promise<number> {
  const { json } = await api(ctx, "GET", `/api/socials?circle=${circleId}`, { token, status: 200 });
  return json.socials.length;
}

test("no mapping and no press posts in the default circle", async () => {
  await withApp(async (ctx) => {
    const { alex, home, uni, work } = await setup(ctx);
    await api(ctx, "POST", `/api/buzz/${alex.buzzToken}`, { status: 201 });
    assert.equal(await count(ctx, alex.token, work.id), 1);
    assert.equal(await count(ctx, alex.token, home.id), 0);
    assert.equal(await count(ctx, alex.token, uni.id), 0);
    await api(ctx, "POST", `/api/buzz/${alex.buzzToken}?press=hold`, { status: 200 });
  });
});

test("each press posts in the circle it is mapped to", async () => {
  await withApp(async (ctx) => {
    const { alex, home, uni, work } = await setup(ctx);
    const put = await api(ctx, "PUT", "/api/me/buzz-circles", {
      token: alex.token,
      body: { single: home.id, double: uni.id },
      status: 200,
    });
    assert.deepEqual(put.json, { buzzCircles: { single: home.id, double: uni.id, hold: null } });

    await api(ctx, "POST", `/api/buzz/${alex.buzzToken}?press=single`, { status: 201 });
    assert.equal(await count(ctx, alex.token, home.id), 1);
    assert.equal(await count(ctx, alex.token, uni.id), 0);

    await api(ctx, "POST", `/api/buzz/${alex.buzzToken}?press=double`, { status: 201 });
    assert.equal(await count(ctx, alex.token, uni.id), 1);

    // No press means single, and an unmapped press stays on the default circle.
    await api(ctx, "POST", `/api/buzz/${alex.buzzToken}`, { status: 200 });
    await api(ctx, "POST", `/api/buzz/${alex.buzzToken}?press=hold`, { status: 201 });
    assert.equal(await count(ctx, alex.token, work.id), 1);
    assert.equal(await count(ctx, alex.token, home.id), 1);
  });
});

test("clearing a press goes back to the default circle", async () => {
  await withApp(async (ctx) => {
    const { alex, home, work } = await setup(ctx);
    await api(ctx, "PUT", "/api/me/buzz-circles", { token: alex.token, body: { single: home.id }, status: 200 });
    const cleared = await api(ctx, "PUT", "/api/me/buzz-circles", { token: alex.token, body: { single: null }, status: 200 });
    assert.deepEqual(cleared.json.buzzCircles, { single: null, double: null, hold: null });
    await api(ctx, "POST", `/api/buzz/${alex.buzzToken}`, { status: 201 });
    assert.equal(await count(ctx, alex.token, work.id), 1);
  });
});

test("a hold with DELETE ends the social in the hold circle", async () => {
  await withApp(async (ctx) => {
    const { alex, home, uni } = await setup(ctx);
    await api(ctx, "PUT", "/api/me/buzz-circles", { token: alex.token, body: { single: home.id, hold: home.id, double: uni.id }, status: 200 });
    await api(ctx, "POST", `/api/buzz/${alex.buzzToken}?press=single`, { status: 201 });
    await api(ctx, "POST", `/api/buzz/${alex.buzzToken}?press=double`, { status: 201 });
    await api(ctx, "DELETE", `/api/buzz/${alex.buzzToken}?press=hold`, { status: 204 });
    assert.equal(await count(ctx, alex.token, home.id), 0);
    assert.equal(await count(ctx, alex.token, uni.id), 1);
  });
});

test("saving a circle the user is not in is 404 and changes nothing", async () => {
  await withApp(async (ctx) => {
    const { alex, home } = await setup(ctx);
    const bea = (await api(ctx, "POST", "/api/auth/start", { body: { name: "Bea" }, status: 201 })).json;
    const other = (await api(ctx, "POST", "/api/circles", { token: bea.token, body: { name: "Bea only" }, status: 201 })).json.circle;
    await api(ctx, "PUT", "/api/me/buzz-circles", { token: alex.token, body: { hold: home.id }, status: 200 });

    await api(ctx, "PUT", "/api/me/buzz-circles", { token: alex.token, body: { single: home.id, double: other.id }, status: 404 });
    const me = await api(ctx, "GET", "/api/me", { token: alex.token, status: 200 });
    assert.deepEqual(me.json.user.buzzCircles, { single: null, double: null, hold: home.id });
  });
});

test("a press mapped to a circle the user left is 404 and posts nowhere", async () => {
  await withApp(async (ctx) => {
    const { alex, home, uni, work } = await setup(ctx);
    // Someone else stays in Home, so the circle (and the mapping) outlives Alex leaving it.
    await api(ctx, "POST", "/api/auth/start", { body: { name: "Bea", code: home.inviteCode }, status: 201 });
    await api(ctx, "PUT", "/api/me/buzz-circles", { token: alex.token, body: { single: home.id, hold: home.id }, status: 200 });
    await api(ctx, "POST", `/api/circles/leave?circle=${home.id}`, { token: alex.token, status: 200 });
    await api(ctx, "POST", `/api/buzz/${alex.buzzToken}`, { status: 404 });
    await api(ctx, "DELETE", `/api/buzz/${alex.buzzToken}?press=hold`, { status: 404 });
    assert.equal(await count(ctx, alex.token, uni.id), 0);
    assert.equal(await count(ctx, alex.token, work.id), 0);
  });
});

test("an explicit circle beats the mapping and a non-member circle is 404", async () => {
  await withApp(async (ctx) => {
    const { alex, home, uni } = await setup(ctx);
    const bea = (await api(ctx, "POST", "/api/auth/start", { body: { name: "Bea" }, status: 201 })).json;
    const other = (await api(ctx, "POST", "/api/circles", { token: bea.token, body: { name: "Bea only" }, status: 201 })).json.circle;
    await api(ctx, "PUT", "/api/me/buzz-circles", { token: alex.token, body: { single: home.id }, status: 200 });
    await api(ctx, "POST", `/api/buzz/${alex.buzzToken}?press=single&circle=${uni.id}`, { status: 201 });
    assert.equal(await count(ctx, alex.token, uni.id), 1);
    assert.equal(await count(ctx, alex.token, home.id), 0);
    await api(ctx, "POST", `/api/buzz/${alex.buzzToken}?circle=${other.id}`, { status: 404 });
  });
});

test("an unknown press is 400", async () => {
  await withApp(async (ctx) => {
    const { alex, work } = await setup(ctx);
    await api(ctx, "POST", `/api/buzz/${alex.buzzToken}?press=triple`, { status: 400 });
    await api(ctx, "DELETE", `/api/buzz/${alex.buzzToken}?press=`, { status: 400 });
    assert.equal(await count(ctx, alex.token, work.id), 0);
  });
});

test("GET /api/me carries buzzCircles, empty by default", async () => {
  await withApp(async (ctx) => {
    const { alex, home } = await setup(ctx);
    const first = await api(ctx, "GET", "/api/me", { token: alex.token, status: 200 });
    assert.deepEqual(first.json.user.buzzCircles, { single: null, double: null, hold: null });
    await api(ctx, "PUT", "/api/me/buzz-circles", { token: alex.token, body: { double: home.id }, status: 200 });
    const after = await api(ctx, "GET", "/api/me", { token: alex.token, status: 200 });
    assert.deepEqual(after.json.user.buzzCircles, { single: null, double: home.id, hold: null });
  });
});
