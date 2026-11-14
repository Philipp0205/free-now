import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { api, withApp } from "./http.js";

function userCount(db: DatabaseSync): number {
  return Number((db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number | bigint }).n);
}

async function setup(ctx: { port: number }) {
  const host = (await api(ctx, "POST", "/api/auth/start", { body: { name: "Fake Host" }, status: 201 })).json;
  const created = (await api(ctx, "POST", "/api/circles", { token: host.token, body: { name: "Fake circle" }, status: 201 })).json;
  const guest = (await api(ctx, "POST", "/api/auth/start", { body: { name: "Fake Guest" }, status: 201 })).json;
  return { host, guest, circle: created.circle };
}

function memberIds(circle: { members: Array<{ id: string }> }): string[] {
  return circle.members.map((member) => member.id);
}

test("an existing session redeems an invite without creating a user", async () => {
  await withApp(async (ctx) => {
    const { guest, circle } = await setup(ctx);
    const before = userCount(ctx.db);
    const joined = await api(ctx, "POST", "/api/circles/join", { token: guest.token, body: { code: circle.inviteCode }, status: 200 });
    assert.equal(joined.json.circle.id, circle.id);
    assert.ok(memberIds(joined.json.circle).includes(guest.user.id));
    assert.equal(userCount(ctx.db), before);
    const again = await api(ctx, "POST", "/api/circles/join", { token: guest.token, body: { code: circle.inviteCode }, status: 200 });
    assert.equal(memberIds(again.json.circle).filter((id) => id === guest.user.id).length, 1, "joining twice is harmless");
  });
});

test("recovering on a fresh device then joining keeps the same account", async () => {
  await withApp(async (ctx) => {
    const { guest, circle } = await setup(ctx);
    const before = userCount(ctx.db);
    const recovered = (await api(ctx, "POST", "/api/auth/recover", { body: { token: guest.buzzToken }, status: 200 })).json;
    assert.notEqual(recovered.token, guest.token, "the new device gets its own token");
    assert.equal(recovered.user.id, guest.user.id);
    const joined = await api(ctx, "POST", "/api/circles/join", { token: recovered.token, body: { code: circle.inviteCode }, status: 200 });
    assert.ok(memberIds(joined.json.circle).includes(guest.user.id));
    const me = (await api(ctx, "GET", "/api/me", { token: recovered.token, status: 200 })).json;
    assert.equal(me.user.id, guest.user.id);
    assert.equal(userCount(ctx.db), before);
  });
});

test("a brand-new person starting with an invite still gets a new account and joins", async () => {
  await withApp(async (ctx) => {
    const { circle } = await setup(ctx);
    const before = userCount(ctx.db);
    const fresh = (await api(ctx, "POST", "/api/auth/start", { body: { name: "Fake Newcomer", code: circle.inviteCode }, status: 201 })).json;
    assert.equal(userCount(ctx.db), before + 1);
    assert.equal(fresh.circle.id, circle.id);
    assert.ok(memberIds(fresh.circle).includes(fresh.user.id));
  });
});
