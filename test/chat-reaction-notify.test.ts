import assert from "node:assert/strict";
import test from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { flushChatNotices } from "../src/chat.js";
import { api, withApp, type AppCtx, type SentPush } from "./http.js";

// Fake people only. Push goes to a recorder, the db is in memory.

function withChat(fn: (ctx: AppCtx<SentPush>) => Promise<void>) {
  return withApp(async (ctx) => {
    try {
      await fn(ctx);
    } finally {
      await flushChatNotices(true);
    }
  }, { sent: "envelope" });
}

type Person = { token: string; user: { id: string; name: string } };

async function circleOf(port: number, names: string[]) {
  const [first, ...rest] = names;
  const host: Person = await api(port, "POST", "/api/auth/start", { body: { name: first }, status: 201 });
  const created = await api(port, "POST", "/api/circles", { token: host.token, body: { name: "friends" }, status: 201 });
  const people: Person[] = [host];
  for (const name of rest) {
    people.push(await api(port, "POST", "/api/auth/start", { body: { name, code: created.circle.inviteCode }, status: 201 }));
  }
  for (const person of people) {
    await api(port, "POST", "/api/push/subscribe", {
      token: person.token,
      body: { endpoint: `https://push.example/${person.user.id}`, keys: { p256dh: "p", auth: "a" } },
      status: 204,
    });
  }
  return people;
}

const say = async (port: number, person: Person, text: string): Promise<string> =>
  (await api(port, "POST", "/api/circles/chat", { token: person.token, body: { text }, status: 201 })).chat.messages.at(-1).id;

const react = (port: number, person: Person, id: string, emoji: string, on?: boolean) =>
  api(port, "POST", `/api/messages/${id}/reactions`, { token: person.token, body: on === undefined ? { emoji } : { emoji, on }, status: 200 });

const reactionPushes = (sent: SentPush[], person: Person) =>
  sent.filter((item) => item.endpoint.includes(person.user.id) && item.payload.tag.startsWith("chat-reaction:"));

function alertsFor(db: DatabaseSync, person: Person) {
  return db.prepare("SELECT title, body, kind, ref_id FROM notifications WHERE user_id = ? AND body LIKE '% reacted % to: %'")
    .all(person.user.id) as Array<{ title: string; body: string; kind: string; ref_id: string }>;
}

/** Posts as Alex, drains the chat batch, and clears the recorder so only reaction pings remain. */
async function settled(port: number, sent: SentPush[], author: Person, text: string): Promise<string> {
  const id = await say(port, author, text);
  await flushChatNotices(true);
  sent.length = 0;
  return id;
}

test("a new reaction pings the author with an alert and a push, not the reactor", async () => {
  await withChat(async ({ port, db, sent }) => {
    const [alex, sam, nia] = await circleOf(port, ["Alex", "Sam", "Nia"]);
    const id = await settled(port, sent, alex, "Pizza\n  tonight?");
    const result = await react(port, sam, id, "❤️");
    assert.deepEqual(Object.keys(result).sort(), ["messageId", "reactions"]);
    assert.deepEqual(result.reactions, [{ emoji: "❤️", count: 1, mine: true, names: ["Sam"] }]);

    const pushes = reactionPushes(sent, alex);
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].payload.title, "Circle chat");
    assert.equal(pushes[0].payload.body, "Sam reacted ❤️ to: \u201cPizza tonight?\u201d");
    assert.equal(pushes[0].payload.tag, `chat-reaction:${id}:${sam.user.id}`);
    assert.equal(pushes[0].payload.url, "/?chat=circle");
    assert.deepEqual(alertsFor(db, alex).map((row) => [row.title, row.body, row.kind, row.ref_id]), [
      ["Circle chat", "Sam reacted ❤️ to: \u201cPizza tonight?\u201d", "chat", "circle"],
    ]);
    assert.deepEqual(sent.filter((item) => !item.endpoint.includes(alex.user.id)), [], "nobody else is pinged");
    assert.deepEqual(alertsFor(db, sam), []);
    assert.deepEqual(alertsFor(db, nia), []);
  });
});

test("a long message is shortened with an ellipsis and the body stays within 140", async () => {
  await withChat(async ({ port, db, sent }) => {
    const [alex, sam] = await circleOf(port, ["Alex", "Sam"]);
    const id = await settled(port, sent, alex, `${"word ".repeat(60)}end`);
    await react(port, sam, id, "🔥");
    const body = reactionPushes(sent, alex)[0].payload.body;
    assert.ok(body.length <= 140, String(body.length));
    assert.ok(body.startsWith("Sam reacted 🔥 to: \u201cword word"), body);
    assert.ok(body.endsWith("\u2026\u201d"), body);
    assert.ok(!body.includes("\u2014"));
    assert.equal(alertsFor(db, alex)[0].body, body);
  });
});

test("reacting to your own message sends nothing", async () => {
  await withChat(async ({ port, db, sent }) => {
    const [alex] = await circleOf(port, ["Alex", "Sam"]);
    const id = await settled(port, sent, alex, "note to self");
    await react(port, alex, id, "👍");
    assert.deepEqual(sent, []);
    assert.deepEqual(alertsFor(db, alex), []);
  });
});

test("a muted author gets no alert and no push", async () => {
  await withChat(async ({ port, db, sent }) => {
    const [alex, sam] = await circleOf(port, ["Alex", "Sam"]);
    const thread = await api(port, "GET", "/api/circles/chat", { token: alex.token });
    await api(port, "POST", `/api/chats/${thread.chat.id}/mute`, { token: alex.token, body: { muted: true }, status: 204 });
    const id = await settled(port, sent, alex, "shh");
    await react(port, sam, id, "😂");
    assert.deepEqual(sent.filter((item) => item.endpoint.includes(alex.user.id)), []);
    assert.deepEqual(alertsFor(db, alex), []);
  });
});

test("taking a reaction back is silent", async () => {
  await withChat(async ({ port, db, sent }) => {
    const [alex, sam] = await circleOf(port, ["Alex", "Sam"]);
    const id = await settled(port, sent, alex, "ramen?");
    await react(port, sam, id, "👍");
    assert.equal(reactionPushes(sent, alex).length, 1);
    await react(port, sam, id, "👍");
    await react(port, sam, id, "👍", false);
    assert.equal(reactionPushes(sent, alex).length, 1, "removing sends nothing");
    assert.equal(alertsFor(db, alex).length, 1);
  });
});

test("one alert per reactor per message, however they switch or re-add", async () => {
  await withChat(async ({ port, db, sent }) => {
    const [alex, sam, nia] = await circleOf(port, ["Alex", "Sam", "Nia"]);
    const id = await settled(port, sent, alex, "game night?");
    await react(port, sam, id, "👍");
    await react(port, sam, id, "🔥");
    await react(port, sam, id, "👍", false);
    await react(port, sam, id, "👍");
    await react(port, sam, id, "👍", true);
    assert.equal(reactionPushes(sent, alex).length, 1, "same reactor, one push");
    assert.equal(alertsFor(db, alex).length, 1, "same reactor, one alert");

    await react(port, nia, id, "❤️");
    const pushes = reactionPushes(sent, alex);
    assert.deepEqual(pushes.map((item) => item.payload.tag).sort(), [`chat-reaction:${id}:${nia.user.id}`, `chat-reaction:${id}:${sam.user.id}`].sort());
    assert.equal(alertsFor(db, alex).length, 2);
    assert.ok(alertsFor(db, alex).some((row) => row.body === "Nia reacted ❤️ to: \u201cgame night?\u201d"));

    // Another message from the same author notifies again.
    const next = await say(port, alex, "and snacks");
    await flushChatNotices(true);
    await react(port, sam, next, "👍");
    assert.equal(reactionPushes(sent, alex).length, 3);
  });
});

test("an author who left the event audience is not pinged", async () => {
  await withChat(async ({ port, db, sent }) => {
    const [alex, sam] = await circleOf(port, ["Alex", "Sam"]);
    const social = await api(port, "POST", "/api/socials", { token: alex.token, body: { note: "Dinner" }, status: 201 });
    const sid = social.social.id;
    await api(port, "POST", `/api/socials/${sid}/reply`, { token: sam.token, body: { reply: "in" }, status: 200 });
    const posted = await api(port, "POST", `/api/socials/${sid}/chat`, { token: sam.token, body: { text: "save me a seat" }, status: 201 });
    const id = posted.chat.messages.find((item: { text: string }) => item.text === "save me a seat").id;
    await api(port, "DELETE", `/api/socials/${sid}/people/${sam.user.id}`, { token: alex.token, status: 204 });
    await flushChatNotices(true);
    sent.length = 0;
    await react(port, alex, id, "👍");
    assert.deepEqual(sent.filter((item) => item.endpoint.includes(sam.user.id)), []);
    assert.deepEqual(alertsFor(db, sam), []);
  });
});

test("push off still leaves the alert", async () => {
  await withChat(async ({ port, db, sent }) => {
    const [alex, sam] = await circleOf(port, ["Alex", "Sam"]);
    await api(port, "DELETE", "/api/push/subscribe", { token: alex.token, body: { endpoint: `https://push.example/${alex.user.id}` }, status: 204 });
    const id = await settled(port, sent, alex, "no phone");
    await react(port, sam, id, "😮");
    assert.deepEqual(sent.filter((item) => item.endpoint.includes(alex.user.id)), []);
    assert.deepEqual(alertsFor(db, alex).map((row) => row.body), ["Sam reacted 😮 to: \u201cno phone\u201d"]);
  });
});
