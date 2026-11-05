import assert from "node:assert/strict";
import test from "node:test";
import { flushChatNotices } from "../src/chat.js";
import { countUnreadNotifications, openDb, unreadNotificationsByCircle } from "../src/db.js";
import { api, withApp, type AppCtx } from "./http.js";

type Person = { token: string; user: { id: string; name: string } };

async function signUp(ctx: AppCtx, name: string, code?: string): Promise<Person> {
  const { json } = await api(ctx, "POST", "/api/auth/start", { body: code ? { name, code } : { name }, status: 201 });
  return json;
}

async function newCircle(ctx: AppCtx, token: string, name: string) {
  const { json } = await api(ctx, "POST", "/api/circles", { token, body: { name }, status: 201 });
  return json.circle as { id: string; inviteCode: string };
}

async function alertUnread(ctx: AppCtx, token: string): Promise<Record<string, number>> {
  const { json } = await api(ctx, "GET", "/api/me", { token });
  return Object.fromEntries(json.circles.map((circle: { id: string; alertUnread: number }) => [circle.id, circle.alertUnread]));
}

function kindsFor(ctx: AppCtx, userId: string, circleId: string): string[] {
  const rows = ctx.db.prepare(
    "SELECT kind FROM notifications WHERE user_id = ? AND circle_id = ? ORDER BY rowid",
  ).all(userId, circleId) as Array<{ kind: string }>;
  return rows.map((row) => row.kind);
}

/** Alex and Bea share circles A and B. */
async function twoCircles(ctx: AppCtx) {
  const alex = await signUp(ctx, "Alex");
  const a = await newCircle(ctx, alex.token, "Home");
  const b = await newCircle(ctx, alex.token, "Uni");
  const bea = await signUp(ctx, "Bea", a.inviteCode);
  await api(ctx, "POST", "/api/circles/join", { token: bea.token, body: { code: b.inviteCode }, status: 200 });
  // Joining told Alex. Start clean so each test counts only its own activity.
  await api(ctx, "POST", `/api/notifications/read?circle=${a.id}`, { token: alex.token, status: 204 });
  await api(ctx, "POST", `/api/notifications/read?circle=${b.id}`, { token: alex.token, status: 204 });
  return { alex, bea, a, b };
}

test("an alert in one circle shows unread on that circle only, and reading clears just that one", async () => {
  await withApp(async (ctx) => {
    const { alex, bea, a, b } = await twoCircles(ctx);
    assert.deepEqual(await alertUnread(ctx, bea.token), { [a.id]: 0, [b.id]: 0 });

    await api(ctx, "POST", `/api/plans?circle=${a.id}`, { token: alex.token, body: { note: "Pizza" }, status: 201 });
    await api(ctx, "POST", `/api/plans?circle=${b.id}`, { token: alex.token, body: { note: "Study" }, status: 201 });
    await api(ctx, "POST", `/api/notifications/read?circle=${b.id}`, { token: bea.token, status: 204 });
    assert.deepEqual(await alertUnread(ctx, bea.token), { [a.id]: 1, [b.id]: 0 });

    const listed = await api(ctx, "GET", `/api/notifications?circle=${b.id}`, { token: bea.token });
    assert.deepEqual(listed.json.unreadByCircle, { [a.id]: 1 });

    await api(ctx, "POST", `/api/notifications/read?circle=${a.id}`, { token: bea.token, status: 204 });
    assert.deepEqual(await alertUnread(ctx, bea.token), { [a.id]: 0, [b.id]: 0 });

    await api(ctx, "POST", `/api/plans?circle=${a.id}`, { token: alex.token, body: { note: "Kino" }, status: 201 });
    assert.deepEqual(await alertUnread(ctx, bea.token), { [a.id]: 1, [b.id]: 0 });
    assert.equal(countUnreadNotifications(ctx.db, bea.user.id, a.id), 1);
    assert.equal(countUnreadNotifications(ctx.db, bea.user.id, b.id), 0);
  });
});

test("a circle you left drops out of the unread totals", async () => {
  await withApp(async (ctx) => {
    const { alex, bea, a, b } = await twoCircles(ctx);
    await api(ctx, "POST", `/api/plans?circle=${b.id}`, { token: alex.token, body: { note: "Study" }, status: 201 });
    assert.equal(unreadNotificationsByCircle(ctx.db, bea.user.id)[b.id], 1);
    await api(ctx, "POST", `/api/circles/leave?circle=${b.id}`, { token: bea.token, status: 200 });
    assert.deepEqual(unreadNotificationsByCircle(ctx.db, bea.user.id), {});
    assert.deepEqual(await alertUnread(ctx, bea.token), { [a.id]: 0 });
  });
});

test("important events land in the right circle's Alerts", async () => {
  await withApp(async (ctx) => {
    const { alex, bea, a, b } = await twoCircles(ctx);
    const q = `?circle=${a.id}`;

    // New plan, reply in, reply can't, reschedule.
    const plan = await api(ctx, "POST", `/api/plans${q}`, { token: alex.token, body: { note: "Pizza" }, status: 201 });
    const planId = plan.json.plan.id as string;
    await api(ctx, "POST", `/api/plans/${planId}/reply${q}`, { token: bea.token, body: { reply: "in" }, status: 200 });
    await api(ctx, "POST", `/api/plans/${planId}/reply${q}`, { token: bea.token, body: { reply: "can't" }, status: 200 });
    await api(ctx, "POST", `/api/plans/${planId}/reply${q}`, { token: bea.token, body: { reply: "in" }, status: 200 });
    await api(ctx, "PATCH", `/api/plans/${planId}${q}`, { token: alex.token, body: { time: "20:00" }, status: 200 });

    // Free now.
    const social = await api(ctx, "POST", `/api/socials${q}`, { token: alex.token, body: { note: "Coffee" }, status: 201 });
    const socialId = social.json.social.id as string;
    await api(ctx, "POST", `/api/socials/${socialId}/reply${q}`, { token: bea.token, body: { reply: "in", eta: 5 }, status: 200 });

    // Plan chat lands in Alerts. Circle chat does not.
    await api(ctx, "POST", `/api/plans/${planId}/chat${q}`, { token: alex.token, body: { text: "Table at 8" }, status: 201 });
    await api(ctx, "POST", `/api/socials/${socialId}/chat${q}`, { token: alex.token, body: { text: "Here now" }, status: 201 });
    await api(ctx, "POST", `/api/circles/chat${q}`, { token: alex.token, body: { text: "Hi all" }, status: 201 });
    await flushChatNotices(true);

    // Someone new joins.
    const cleo = await signUp(ctx, "Cleo", a.inviteCode);

    // Host ends both. Bea said she's in, so she hears it.
    await api(ctx, "DELETE", `/api/plans/${planId}${q}`, { token: alex.token, status: 204 });
    await api(ctx, "DELETE", `/api/socials/${socialId}${q}`, { token: alex.token, status: 204 });

    assert.deepEqual(kindsFor(ctx, bea.user.id, a.id), [
      "plan", "plan-change", "social", "chat", "chat", "member-join", "ended", "ended",
    ]);
    // The first member-join is Bea joining during setup (already read).
    assert.deepEqual(kindsFor(ctx, alex.user.id, a.id), [
      "member-join", "plan-reply", "plan-reply", "plan-reply", "reply", "member-join",
    ]);
    // Cleo never replied, so the endings stay off her list.
    assert.deepEqual(kindsFor(ctx, cleo.user.id, a.id), []);
    // Nothing leaked into circle B.
    assert.deepEqual(kindsFor(ctx, bea.user.id, b.id), []);

    const chats = ctx.db.prepare(
      "SELECT ref_id FROM notifications WHERE user_id = ? AND kind = 'chat' ORDER BY rowid",
    ).all(bea.user.id) as Array<{ ref_id: string }>;
    assert.deepEqual(chats.map((row) => row.ref_id), [`plan:${planId}`, `social:${socialId}`]);

    const join = ctx.db.prepare(
      "SELECT title, body, ref_id FROM notifications WHERE user_id = ? AND kind = 'member-join'",
    ).get(bea.user.id) as { title: string; body: string; ref_id: string };
    assert.deepEqual({ ...join }, { title: "New member", body: "Cleo joined Home", ref_id: cleo.user.id });
  });
});

test("ending a plan tells people who are in, not people who said no or never replied", async () => {
  await withApp(async (ctx) => {
    const alex = await signUp(ctx, "Alex");
    const home = await newCircle(ctx, alex.token, "Home");
    const bea = await signUp(ctx, "Bea", home.inviteCode);
    const cleo = await signUp(ctx, "Cleo", home.inviteCode);
    const dan = await signUp(ctx, "Dan", home.inviteCode);
    await api(ctx, "POST", `/api/circles/members/${bea.user.id}`, { token: alex.token, body: { admin: true }, status: 200 });
    const plan = await api(ctx, "POST", "/api/plans", { token: alex.token, body: { note: "Pizza" }, status: 201 });
    const id = plan.json.plan.id as string;
    await api(ctx, "POST", `/api/plans/${id}/reply`, { token: cleo.token, body: { reply: "in" }, status: 200 });
    await api(ctx, "POST", `/api/plans/${id}/reply`, { token: dan.token, body: { reply: "can't" }, status: 200 });
    // An admin ends it: the host and Cleo hear. Bea did it herself; Dan said no.
    await api(ctx, "DELETE", `/api/plans/${id}`, { token: bea.token, status: 204 });
    const ended = ctx.db.prepare("SELECT user_id, body FROM notifications WHERE kind = 'ended' ORDER BY rowid").all() as Array<{ user_id: string; body: string }>;
    assert.deepEqual(ended.map((row) => [row.user_id, row.body]), [
      [alex.user.id, "Bea ended Pizza"],
      [cleo.user.id, "Bea ended Pizza"],
    ]);
  });
});

test("joining a circle you are already in tells nobody", async () => {
  await withApp(async (ctx) => {
    const alex = await signUp(ctx, "Alex");
    const home = await newCircle(ctx, alex.token, "Home");
    const bea = await signUp(ctx, "Bea", home.inviteCode);
    await api(ctx, "POST", "/api/circles/join", { token: bea.token, body: { code: home.inviteCode }, status: 200 });
    const joins = ctx.db.prepare("SELECT user_id, body FROM notifications WHERE kind = 'member-join'").all() as Array<{ user_id: string; body: string }>;
    assert.deepEqual(joins.map((row) => [row.user_id, row.body]), [[alex.user.id, "Bea joined Home"]]);
  });
});

test("a fresh database needs no new columns and the unread helpers are safe when empty", () => {
  const db = openDb(":memory:");
  try {
    const cols = (db.prepare("PRAGMA table_info(notifications)").all() as Array<{ name: string }>).map((col) => col.name);
    assert.deepEqual(cols.sort(), ["body", "circle_id", "created_at", "id", "kind", "read_at", "ref_id", "title", "user_id"]);
    assert.deepEqual(unreadNotificationsByCircle(db, "nobody"), {});
    assert.equal(countUnreadNotifications(db, "nobody", "nowhere"), 0);
  } finally {
    db.close();
  }
});

test("sharing a plan into another circle creates its new-plan alert there and lights that circle's dot", async () => {
  await withApp(async (ctx) => {
    const { alex, bea, a, b } = await twoCircles(ctx);
    // Cam is only in Uni (B). Bea is in both.
    const cam = await signUp(ctx, "Cam", b.inviteCode);
    // Cam joining Uni told Alex and Bea. Clear so this test only counts the share.
    await api(ctx, "POST", `/api/notifications/read?circle=${b.id}`, { token: alex.token, status: 204 });
    await api(ctx, "POST", `/api/notifications/read?circle=${b.id}`, { token: bea.token, status: 204 });

    const plan = await api(ctx, "POST", `/api/plans?circle=${a.id}`, {
      token: alex.token,
      body: { note: "Bouldering" },
      status: 201,
    });
    const planId = plan.json.plan.id as string;
    // Bea already got Home's new-plan alert; clear so we only count the share.
    await api(ctx, "POST", `/api/notifications/read?circle=${a.id}`, { token: bea.token, status: 204 });
    assert.deepEqual(await alertUnread(ctx, bea.token), { [a.id]: 0, [b.id]: 0 });
    assert.deepEqual(await alertUnread(ctx, cam.token), { [b.id]: 0 });

    await api(ctx, "PATCH", `/api/plans/${planId}?circle=${a.id}`, {
      token: alex.token,
      body: { circleIds: [a.id, b.id] },
      status: 200,
    });

    // Cam (new to the plan) gets a new-plan alert on Uni and its dot lights.
    assert.deepEqual(kindsFor(ctx, cam.user.id, b.id), ["plan"]);
    assert.deepEqual(await alertUnread(ctx, cam.token), { [b.id]: 1 });
    // Bea already saw the plan in Home, so the share stays quiet for her (no new-plan on Uni).
    assert.equal(kindsFor(ctx, bea.user.id, b.id).includes("plan"), false);
    assert.deepEqual(await alertUnread(ctx, bea.token), { [a.id]: 0, [b.id]: 0 });
    // Home is unchanged by the share.
    assert.equal(
      (ctx.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND circle_id = ? AND kind = 'plan' AND read_at IS NULL")
        .get(bea.user.id, a.id) as { n: number }).n,
      0,
    );

    await api(ctx, "POST", `/api/notifications/read?circle=${b.id}`, { token: cam.token, status: 204 });
    assert.deepEqual(await alertUnread(ctx, cam.token), { [b.id]: 0 });
  });
});
