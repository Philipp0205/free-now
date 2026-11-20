import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { api, withApp, type AppCtx, testEmail } from "../http.js";

const ADMIN = "a".repeat(32);
const ENV = { env: { ADMIN_TOKEN: ADMIN } };

type Person = { token: string; buzzToken: string; user: { id: string } };

async function signUp(ctx: AppCtx, name: string, code?: string): Promise<Person> {
  const { json } = await api(ctx, "POST", "/api/auth/start", { body: { email: testEmail(), name, ...(code ? { code } : {}) }, status: 201 });
  return json;
}

/** Mia and Noa share a circle; Mia's buzz is the one that may be flagged. Fake people only. */
async function pair(ctx: AppCtx) {
  const mia = await signUp(ctx, "Mia");
  const circle = await api(ctx, "POST", "/api/circles", { token: mia.token, body: { name: "friends" }, status: 201 });
  const noa = await signUp(ctx, "Noa", circle.json.circle.inviteCode);
  return { mia, noa };
}

const flag = (ctx: AppCtx, userId: string, body: unknown, status: number, token = ADMIN) =>
  api(ctx, "POST", `/api/admin/users/${userId}/buzz-animation`, { token, body, status });

const column = (ctx: AppCtx, userId: string) =>
  (ctx.db.prepare("SELECT buzz_animation AS v FROM users WHERE id = ?").get(userId) as { v: string | null }).v;

test("an operator sets and clears the buzz animation", async () => {
  await withApp(async (ctx) => {
    const { mia } = await pair(ctx);
    assert.equal(column(ctx, mia.user.id), null);
    const set = await flag(ctx, mia.user.id, { buzzAnimation: "birthday" }, 200);
    assert.deepEqual(set.json, { ok: true, user: { id: mia.user.id, name: "Mia" }, buzzAnimation: "birthday" });
    assert.equal(column(ctx, mia.user.id), "birthday");
    const cleared = await flag(ctx, mia.user.id, { buzzAnimation: null }, 200);
    assert.equal(cleared.json.buzzAnimation, null);
    assert.equal(column(ctx, mia.user.id), null);
  }, ENV);
});

test("a bad value is 400 and an unknown user is 404", async () => {
  await withApp(async (ctx) => {
    const { mia } = await pair(ctx);
    await flag(ctx, mia.user.id, { buzzAnimation: "birthday" }, 200);
    for (const body of [{ buzzAnimation: "bell" }, { buzzAnimation: "" }, { buzzAnimation: "Birthday" }, { buzzAnimation: 1 }, { buzzAnimation: true }, {}]) {
      await flag(ctx, mia.user.id, body, 400);
      assert.equal(column(ctx, mia.user.id), "birthday", `unchanged after ${JSON.stringify(body)}`);
    }
    await flag(ctx, crypto.randomUUID(), { buzzAnimation: "birthday" }, 404);
    await flag(ctx, "not-an-id", { buzzAnimation: "birthday" }, 404);
  }, ENV);
});

test("the route stays hidden without a good operator token", async () => {
  await withApp(async (ctx) => {
    const { mia } = await pair(ctx);
    await flag(ctx, mia.user.id, { buzzAnimation: "birthday" }, 404, "b".repeat(32));
    await flag(ctx, mia.user.id, { buzzAnimation: "birthday" }, 404, "");
    assert.equal(column(ctx, mia.user.id), null);
  }, ENV);
  await withApp(async (ctx) => {
    const { mia } = await pair(ctx);
    await flag(ctx, mia.user.id, { buzzAnimation: "birthday" }, 404, ADMIN);
    assert.equal(column(ctx, mia.user.id), null);
  });
  await withApp(async (ctx) => {
    const { mia } = await pair(ctx);
    await flag(ctx, mia.user.id, { buzzAnimation: "birthday" }, 404, "short");
  }, { env: { ADMIN_TOKEN: "short" } });
});

test("a flagged buzz carries buzzAnimation to members and a normal buzz does not", async () => {
  await withApp(async (ctx) => {
    const { mia, noa } = await pair(ctx);
    const plain = await api(ctx, "POST", `/api/buzz/${noa.buzzToken}`, { body: { note: "tea" }, status: 201 });
    assert.equal("buzzAnimation" in plain.json.social.creator, false);
    await api(ctx, "POST", `/api/buzz/${noa.buzzToken}`, { status: 200 });

    await flag(ctx, mia.user.id, { buzzAnimation: "birthday" }, 200);
    const pressed = await api(ctx, "POST", `/api/buzz/${mia.buzzToken}`, { body: { note: "cake" }, status: 201 });
    assert.equal(pressed.json.social.creator.buzzAnimation, "birthday");
    const list = await api(ctx, "GET", "/api/socials", { token: noa.token, status: 200 });
    const byName = new Map(list.json.socials.map((s: any) => [s.creator.name, s.creator]));
    assert.equal((byName.get("Mia") as any).buzzAnimation, "birthday");
    assert.equal("buzzAnimation" in (byName.get("Noa") as any), false);

    await flag(ctx, mia.user.id, { buzzAnimation: null }, 200);
    const after = await api(ctx, "GET", "/api/socials", { token: noa.token, status: 200 });
    const mine = after.json.socials.find((s: any) => s.creator.name === "Mia");
    assert.equal("buzzAnimation" in mine.creator, false);
  }, ENV);
});
