import assert from "node:assert/strict";
import test from "node:test";
import { flushChatNotices } from "../src/chat.js";
import { api, withApp as withHttpApp, type AppCtx } from "./http.js";

/** Drains pending chat batches before the db closes, so one test never leaves a timer for the next. */
const withApp: typeof withHttpApp = (fn: (ctx: any) => Promise<void>, options?: any) =>
  withHttpApp(async (ctx) => {
    try {
      await fn(ctx);
    } finally {
      await flushChatNotices(true);
    }
  }, options);

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

/** This person's chat alerts as [ref_id, circle_id, unread], oldest first. */
function chatAlerts(ctx: AppCtx, userId: string): Array<[string, string, boolean]> {
  const rows = ctx.db.prepare(
    "SELECT ref_id, circle_id, read_at FROM notifications WHERE user_id = ? AND kind = 'chat' ORDER BY rowid",
  ).all(userId) as Array<{ ref_id: string; circle_id: string; read_at: number | null }>;
  return rows.map((row) => [row.ref_id, row.circle_id, row.read_at == null]);
}

function unreadOf(ctx: AppCtx, userId: string, circleId: string, kind: string): number {
  return Number((ctx.db.prepare(
    "SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND circle_id = ? AND kind = ? AND read_at IS NULL",
  ).get(userId, circleId, kind) as { n: number }).n);
}

/** Alex and Bea share Home and Uni. Join alerts are cleared so each test counts its own. */
async function twoCircles(ctx: AppCtx) {
  const alex = await signUp(ctx, "Alex");
  const a = await newCircle(ctx, alex.token, "Home");
  const b = await newCircle(ctx, alex.token, "Uni");
  const bea = await signUp(ctx, "Bea", a.inviteCode);
  await api(ctx, "POST", "/api/circles/join", { token: bea.token, body: { code: b.inviteCode }, status: 200 });
  for (const person of [alex, bea]) {
    for (const circle of [a, b]) await api(ctx, "POST", `/api/notifications/read?circle=${circle.id}`, { token: person.token, status: 204 });
  }
  return { alex, bea, a, b };
}

type Kind = "plan" | "social";

async function newEvent(ctx: AppCtx, kind: Kind, token: string, circleId: string, note: string): Promise<string> {
  const { json } = await api(ctx, "POST", `/api/${kind}s?circle=${circleId}`, { token, body: { note }, status: 201 });
  return json[kind].id as string;
}

const chatPath = (kind: Kind, id: string, circleId: string) => `/api/${kind}s/${id}/chat?circle=${circleId}`;

/**
 * Bea writes (which reads the chat), then Alex sends a plain message, a mention, a reply and a reaction.
 * Returns once Bea has four unread chat alerts for this chat.
 */
async function pingBea(ctx: AppCtx, kind: Kind, id: string, circleId: string, alex: Person, bea: Person) {
  const path = chatPath(kind, id, circleId);
  const first = await api(ctx, "POST", path, { token: bea.token, body: { text: "who is coming?" }, status: 201 });
  const beaMessage = first.json.chat.messages.find((message: { mine: boolean }) => message.mine).id as string;
  await flushChatNotices(true);

  await api(ctx, "POST", path, { token: alex.token, body: { text: "I am" }, status: 201 });
  await flushChatNotices(true);
  await api(ctx, "POST", path, { token: alex.token, body: { text: "@Bea bring snacks" }, status: 201 });
  await api(ctx, "POST", path, { token: alex.token, body: { text: "see you there", replyTo: beaMessage }, status: 201 });
  await api(ctx, "POST", `/api/messages/${beaMessage}/reactions`, { token: alex.token, body: { emoji: "❤️" }, status: 200 });
  await flushChatNotices(true);
}

for (const kind of ["plan", "social"] as const) {
  test(`reading a ${kind} chat marks its message, mention, reply and reaction alerts read and leaves other alerts alone`, async () => {
    await withApp(async (ctx) => {
      const { alex, bea, a } = await twoCircles(ctx);
      const id = await newEvent(ctx, kind, alex.token, a.id, "Pizza");
      // Bea clears the new-post alert; the second event's alert below stays unread.
      await api(ctx, "POST", `/api/notifications/read?circle=${a.id}`, { token: bea.token, status: 204 });

      await pingBea(ctx, kind, id, a.id, alex, bea);
      // A different new post in the same circle (always a plan: a person has one free post at a time).
      await newEvent(ctx, "plan", alex.token, a.id, "Kino");

      assert.deepEqual(chatAlerts(ctx, bea.user.id), [
        [`${kind}:${id}`, a.id, true],
        [`${kind}:${id}`, a.id, true],
        [`${kind}:${id}`, a.id, true],
        [`${kind}:${id}`, a.id, true],
      ]);
      assert.equal(unreadOf(ctx, bea.user.id, a.id, "plan"), 1, "the new plan alert");
      assert.equal((await alertUnread(ctx, bea.token))[a.id], 5);

      const read = await api(ctx, "GET", chatPath(kind, id, a.id), { token: bea.token, status: 200 });
      assert.ok(read.json.chat.messages.length >= 4);
      assert.ok(chatAlerts(ctx, bea.user.id).every(([, , unread]) => !unread));
      assert.equal((await alertUnread(ctx, bea.token))[a.id], 1);
      assert.equal(unreadOf(ctx, bea.user.id, a.id, "plan"), 1, "the new plan alert stays unread");

      // It is saved: a later list and /api/me agree.
      const listed = await api(ctx, "GET", `/api/notifications?circle=${a.id}`, { token: bea.token, status: 200 });
      const chats = listed.json.notifications.filter((note: { kind: string }) => note.kind === "chat");
      assert.equal(chats.length, 4);
      assert.ok(chats.every((note: { readAt: number | null }) => note.readAt != null));
      assert.deepEqual(listed.json.unreadByCircle, { [a.id]: 1 });
      assert.equal((await alertUnread(ctx, bea.token))[a.id], 1);
    });
  });

  test(`posting in a ${kind} chat also marks its alerts read`, async () => {
    await withApp(async (ctx) => {
      const { alex, bea, a } = await twoCircles(ctx);
      const id = await newEvent(ctx, kind, alex.token, a.id, "Pizza");
      await api(ctx, "POST", `/api/notifications/read?circle=${a.id}`, { token: bea.token, status: 204 });
      await pingBea(ctx, kind, id, a.id, alex, bea);
      assert.equal((await alertUnread(ctx, bea.token))[a.id], 4);

      await api(ctx, "POST", chatPath(kind, id, a.id), { token: bea.token, body: { text: "on my way" }, status: 201 });
      assert.ok(chatAlerts(ctx, bea.user.id).every(([, , unread]) => !unread));
      assert.equal((await alertUnread(ctx, bea.token))[a.id], 0);
    });
  });
}

test("reading chat A does not mark chat B's alerts", async () => {
  await withApp(async (ctx) => {
    const { alex, bea, a } = await twoCircles(ctx);
    const planA = await newEvent(ctx, "plan", alex.token, a.id, "Pizza");
    const planB = await newEvent(ctx, "plan", alex.token, a.id, "Kino");
    const social = await newEvent(ctx, "social", alex.token, a.id, "Coffee");
    await api(ctx, "POST", `/api/notifications/read?circle=${a.id}`, { token: bea.token, status: 204 });
    await pingBea(ctx, "plan", planA, a.id, alex, bea);
    await pingBea(ctx, "plan", planB, a.id, alex, bea);
    await pingBea(ctx, "social", social, a.id, alex, bea);
    assert.equal((await alertUnread(ctx, bea.token))[a.id], 12);

    await api(ctx, "GET", chatPath("plan", planA, a.id), { token: bea.token, status: 200 });
    const left = chatAlerts(ctx, bea.user.id).filter(([, , unread]) => unread).map(([ref]) => ref);
    assert.equal(left.length, 8);
    assert.ok(!left.includes(`plan:${planA}`));
    assert.equal(left.filter((ref) => ref === `plan:${planB}`).length, 4);
    assert.equal(left.filter((ref) => ref === `social:${social}`).length, 4);
    assert.equal((await alertUnread(ctx, bea.token))[a.id], 8);
  });
});

test("circle chat alerts clear in that circle only, even though both circles share the ref", async () => {
  await withApp(async (ctx) => {
    const { alex, bea, a, b } = await twoCircles(ctx);
    for (const circle of [a, b]) {
      const mine = await api(ctx, "POST", `/api/circles/chat?circle=${circle.id}`, { token: bea.token, body: { text: "hi" }, status: 201 });
      const id = mine.json.chat.messages.find((message: { mine: boolean }) => message.mine).id as string;
      await api(ctx, "POST", `/api/circles/chat?circle=${circle.id}`, { token: alex.token, body: { text: "@Bea hello" }, status: 201 });
      await api(ctx, "POST", `/api/circles/chat?circle=${circle.id}`, { token: alex.token, body: { text: "reply", replyTo: id }, status: 201 });
      await api(ctx, "POST", `/api/messages/${id}/reactions`, { token: alex.token, body: { emoji: "👍" }, status: 200 });
    }
    assert.deepEqual(await alertUnread(ctx, bea.token), { [a.id]: 3, [b.id]: 3 });
    assert.ok(chatAlerts(ctx, bea.user.id).every(([ref]) => ref === "circle"));

    await api(ctx, "GET", `/api/circles/chat?circle=${a.id}`, { token: bea.token, status: 200 });
    assert.deepEqual(await alertUnread(ctx, bea.token), { [a.id]: 0, [b.id]: 3 });
    const rows = chatAlerts(ctx, bea.user.id);
    assert.ok(rows.filter(([, circle]) => circle === a.id).every(([, , unread]) => !unread));
    assert.ok(rows.filter(([, circle]) => circle === b.id).every(([, , unread]) => unread));

    const listed = await api(ctx, "GET", `/api/notifications?circle=${a.id}`, { token: bea.token, status: 200 });
    assert.deepEqual(listed.json.unreadByCircle, { [b.id]: 3 });

    await api(ctx, "GET", `/api/circles/chat?circle=${b.id}`, { token: bea.token, status: 200 });
    assert.deepEqual(await alertUnread(ctx, bea.token), { [a.id]: 0, [b.id]: 0 });
  });
});

test("reading a chat never touches another person's alerts or non-chat alerts", async () => {
  await withApp(async (ctx) => {
    const { alex, bea, a } = await twoCircles(ctx);
    const id = await newEvent(ctx, "plan", alex.token, a.id, "Pizza");
    await api(ctx, "POST", `/api/notifications/read?circle=${a.id}`, { token: bea.token, status: 204 });
    await api(ctx, "POST", `/api/notifications/read?circle=${a.id}`, { token: alex.token, status: 204 });
    await pingBea(ctx, "plan", id, a.id, alex, bea);
    // Bea says she is in, so Alex gets a plan-reply alert. Her next message gives Alex an unread chat alert too.
    await api(ctx, "POST", chatPath("plan", id, a.id), { token: bea.token, body: { text: "@Alex save me a seat" }, status: 201 });
    await api(ctx, "POST", `/api/plans/${id}/reply?circle=${a.id}`, { token: bea.token, body: { reply: "in" }, status: 200 });
    const alexBefore = await alertUnread(ctx, alex.token);
    const chatBefore = chatAlerts(ctx, alex.user.id);
    assert.equal(unreadOf(ctx, alex.user.id, a.id, "plan-reply"), 1);
    assert.ok(chatBefore.some(([, , unread]) => unread));

    await api(ctx, "GET", chatPath("plan", id, a.id), { token: bea.token, status: 200 });
    assert.equal(unreadOf(ctx, alex.user.id, a.id, "plan-reply"), 1);
    assert.deepEqual(chatAlerts(ctx, alex.user.id), chatBefore);
    assert.deepEqual(await alertUnread(ctx, alex.token), alexBefore);
  });
});
