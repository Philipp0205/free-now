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

const say = (port: number, person: Person, text: string, replyTo?: unknown, status = 201) =>
  api(port, "POST", "/api/circles/chat", { token: person.token, body: replyTo === undefined ? { text } : { text, replyTo }, status });

const pushesTo = (sent: SentPush[], person: Person, prefix: string) =>
  sent.filter((item) => item.endpoint.includes(person.user.id) && item.payload.tag.startsWith(prefix));

function alertsFor(db: DatabaseSync, person: Person, like: string) {
  return db.prepare("SELECT title, body, kind, ref_id FROM notifications WHERE user_id = ? AND body LIKE ?")
    .all(person.user.id, like) as Array<{ title: string; body: string; kind: string; ref_id: string }>;
}

function rowCount(db: DatabaseSync): number {
  return Number((db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n);
}

test("a reply carries a short quote of the message it answers", async () => {
  await withChat(async ({ port, db }) => {
    const [alex, ada] = await circleOf(port, ["Alex", "Ada"]);
    const first = await say(port, ada, "Ramen at 7?\n Bring  cash");
    const parent = first.chat.messages.at(-1);
    assert.equal(parent.replyTo, null);
    const posted = await say(port, alex, "Yes, see you there", parent.id);
    const reply = posted.chat.messages.at(-1);
    const { color, ...quote } = reply.replyTo;
    assert.deepEqual(quote, { id: parent.id, name: "Ada", text: "Ramen at 7? Bring cash", mine: false, deleted: false });
    assert.equal(color, parent.color, "the quote edge is in Ada's chat colour");
    const stored = db.prepare("SELECT reply_to FROM messages WHERE id = ?").get(reply.id) as { reply_to: string };
    assert.equal(stored.reply_to, parent.id);

    // Ada sees her own message quoted as hers. Quoting a reply quotes only that one message.
    const seen = await api(port, "GET", "/api/circles/chat", { token: ada.token });
    assert.equal(seen.chat.messages.find((item: { id: string }) => item.id === reply.id).replyTo.mine, true);
    const nested = await say(port, ada, "Great", reply.id);
    const { color: _alexColor, ...nestedQuote } = nested.chat.messages.at(-1).replyTo;
    assert.deepEqual(nestedQuote, { id: reply.id, name: "Alex", text: "Yes, see you there", mine: false, deleted: false });
  });
});

test("a reply to another chat, a missing message or a system line is refused and not saved", async () => {
  await withChat(async ({ port, db }) => {
    const [alex, ada] = await circleOf(port, ["Alex", "Ada"]);
    const other = await api(port, "POST", "/api/auth/start", { body: { name: "Out" }, status: 201 });
    await api(port, "POST", "/api/circles", { token: other.token, body: { name: "other" }, status: 201 });
    const elsewhere = (await api(port, "POST", "/api/circles/chat", { token: other.token, body: { text: "not yours" }, status: 201 })).chat.messages.at(-1);

    const social = await api(port, "POST", "/api/socials", { token: alex.token, body: { note: "Coffee" }, status: 201 });
    const sid = social.social.id;
    await api(port, "POST", `/api/socials/${sid}/reply`, { token: ada.token, body: { reply: "in" }, status: 200 });
    const event = await api(port, "POST", `/api/socials/${sid}/chat`, { token: ada.token, body: { text: "on my way" }, status: 201 });
    const system = event.chat.messages.find((item: { system: boolean }) => item.system);
    const eventText = event.chat.messages.find((item: { text: string }) => item.text === "on my way");
    const before = rowCount(db);

    await say(port, alex, "hi", elsewhere.id, 404);
    await say(port, alex, "hi", "no-such-message", 404);
    await say(port, alex, "hi", eventText.id, 404);
    await say(port, alex, "hi", 42, 400);
    await api(port, "POST", `/api/socials/${sid}/chat`, { token: alex.token, body: { text: "hi", replyTo: system.id }, status: 400 });
    await say(port, alex, "   ", undefined, 400);
    const parent = (await say(port, ada, "real one")).chat.messages.at(-1);
    await say(port, alex, "  ", parent.id, 400);
    assert.equal(rowCount(db), before + 1, "only Ada's own message was saved");
  });
});

test("after the original is deleted the reply stays, without its text, and it cannot get new replies", async () => {
  await withChat(async ({ port }) => {
    const [alex, ada] = await circleOf(port, ["Alex", "Ada"]);
    const parent = (await say(port, ada, "secret plan")).chat.messages.at(-1);
    const reply = (await say(port, alex, "love it", parent.id)).chat.messages.at(-1);
    await api(port, "DELETE", `/api/messages/${parent.id}`, { token: ada.token, status: 204 });

    const thread = await api(port, "GET", "/api/circles/chat", { token: alex.token });
    assert.equal(thread.chat.messages.some((item: { id: string }) => item.id === parent.id), false);
    const kept = thread.chat.messages.find((item: { id: string }) => item.id === reply.id);
    assert.equal(kept.text, "love it");
    assert.equal(kept.replyTo.id, parent.id);
    assert.equal(kept.replyTo.deleted, true);
    assert.equal(kept.replyTo.text, "");
    assert.equal(kept.replyTo.color, null);
    assert.ok(!JSON.stringify(thread).includes("secret plan"), "the deleted body never comes back");

    await say(port, alex, "and again", parent.id, 404);
  });
});

test("a reply pings the original author right away, not the sender, and the batch skips them", async () => {
  await withChat(async ({ port, db, sent }) => {
    const [alex, ada, nia] = await circleOf(port, ["Alex", "Ada", "Nia"]);
    const parent = (await say(port, ada, "Who is driving?")).chat.messages.at(-1);
    await flushChatNotices(true);
    sent.length = 0;
    const posted = await say(port, alex, "I can drive", parent.id);
    const id = posted.chat.messages.at(-1).id;

    const pinged = pushesTo(sent, ada, "chat-reply:");
    assert.equal(pinged.length, 1, "before any batch flush");
    assert.equal(pinged[0].payload.title, "Circle chat");
    assert.equal(pinged[0].payload.body, "Alex replied to you: I can drive");
    assert.equal(pinged[0].payload.tag, `chat-reply:${id}`);
    assert.equal(pinged[0].payload.url, "/?chat=circle");
    assert.deepEqual(alertsFor(db, ada, "% replied to you: %").map((row) => [row.kind, row.ref_id]), [["chat", "circle"]]);
    assert.deepEqual(pushesTo(sent, alex, "chat-reply:"), []);

    await flushChatNotices(true);
    assert.deepEqual(pushesTo(sent, ada, "chat:"), [], "no second ping for the same message");
    assert.deepEqual(pushesTo(sent, nia, "chat:").map((item) => item.payload.body), ["Alex: I can drive"]);

    // Replying to yourself pings nobody extra.
    sent.length = 0;
    const own = (await say(port, alex, "me first")).chat.messages.at(-1);
    await say(port, alex, "me again", own.id);
    assert.deepEqual(sent.filter((item) => item.payload.tag.startsWith("chat-reply:")), []);
    assert.deepEqual(alertsFor(db, alex, "% replied to you: %"), []);
  });
});

test("a muted author hears nothing, and push off still leaves an alert", async () => {
  await withChat(async ({ port, db, sent }) => {
    const [alex, ada, bea] = await circleOf(port, ["Alex", "Ada", "Bea"]);
    const thread = await api(port, "GET", "/api/circles/chat", { token: ada.token });
    await api(port, "POST", `/api/chats/${thread.chat.id}/mute`, { token: ada.token, body: { muted: true }, status: 204 });
    await api(port, "DELETE", "/api/push/subscribe", { token: bea.token, body: { endpoint: `https://push.example/${bea.user.id}` }, status: 204 });
    const fromAda = (await say(port, ada, "muted me")).chat.messages.at(-1);
    const fromBea = (await say(port, bea, "no phone")).chat.messages.at(-1);
    await flushChatNotices(true);
    sent.length = 0;

    await say(port, alex, "hi Ada", fromAda.id);
    await say(port, alex, "hi Bea", fromBea.id);
    await flushChatNotices(true);
    assert.deepEqual(sent.filter((item) => item.endpoint.includes(ada.user.id)), []);
    assert.deepEqual(alertsFor(db, ada, "% replied to you: %"), []);
    assert.deepEqual(sent.filter((item) => item.endpoint.includes(bea.user.id)), [], "no phone, no push");
    assert.deepEqual(alertsFor(db, bea, "% replied to you: %").map((row) => row.body), ["Alex replied to you: hi Bea"]);
  });
});

test("a reply that also @mentions the author pings once; a third person still gets the batch", async () => {
  await withChat(async ({ port, db, sent }) => {
    const [alex, ada, nia] = await circleOf(port, ["Alex", "Ada", "Nia"]);
    const parent = (await say(port, ada, "Tickets?")).chat.messages.at(-1);
    await flushChatNotices(true);
    sent.length = 0;
    await say(port, alex, "@Ada got two", parent.id);
    const forAda = sent.filter((item) => item.endpoint.includes(ada.user.id));
    assert.deepEqual(forAda.map((item) => item.payload.body), ["Alex mentioned you: @Ada got two"]);
    assert.equal(alertsFor(db, ada, "Alex %").length, 1);
    await flushChatNotices(true);
    assert.equal(sent.filter((item) => item.endpoint.includes(ada.user.id)).length, 1, "still one after the batch");
    assert.deepEqual(pushesTo(sent, nia, "chat:").map((item) => item.payload.body), ["Alex: @Ada got two"]);
    assert.deepEqual(pushesTo(sent, alex, ""), []);
  });
});

test("someone removed from an event is not pinged for a reply to their old message", async () => {
  await withChat(async ({ port, db, sent }) => {
    const [alex, ada] = await circleOf(port, ["Alex", "Ada"]);
    const social = await api(port, "POST", "/api/socials", { token: alex.token, body: { note: "Dinner" }, status: 201 });
    const sid = social.social.id;
    await api(port, "POST", `/api/socials/${sid}/reply`, { token: ada.token, body: { reply: "in" }, status: 200 });
    const parent = (await api(port, "POST", `/api/socials/${sid}/chat`, { token: ada.token, body: { text: "save me a seat" }, status: 201 })).chat.messages.at(-1);
    await api(port, "DELETE", `/api/socials/${sid}/people/${ada.user.id}`, { token: alex.token, status: 204 });
    await flushChatNotices(true);
    sent.length = 0;
    const posted = await api(port, "POST", `/api/socials/${sid}/chat`, { token: alex.token, body: { text: "sorry", replyTo: parent.id }, status: 201 });
    assert.equal(posted.chat.messages.at(-1).replyTo.name, "Ada");
    await flushChatNotices(true);
    assert.deepEqual(sent.filter((item) => item.endpoint.includes(ada.user.id)), []);
    assert.deepEqual(alertsFor(db, ada, "% replied to you: %"), []);
  });
});
