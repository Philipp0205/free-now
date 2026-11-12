import assert from "node:assert/strict";
import test from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { findMentions as serverFind, flushChatNotices } from "../../src/chat/chat.js";
import { findMentions as clientFind, insertMention, mentionAt, mentionMatches } from "../../public/js/mentions.js";
import { api, withApp, type AppCtx, type SentPush } from "../http.js";

// Fake people only. Push goes to a recorder, the db is in memory.

/** withApp, and every chat batch still waiting is sent before its db closes. */
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
  return { people, circleId: created.circle.id as string };
}

const mentionPushes = (sent: SentPush[], person: Person) =>
  sent.filter((item) => item.endpoint.includes(person.user.id) && item.payload.tag.startsWith("chat-mention:"));

function mentionAlerts(db: DatabaseSync, person: Person) {
  return db.prepare("SELECT title, body, kind, ref_id FROM notifications WHERE user_id = ? AND body LIKE '% mentioned you: %'")
    .all(person.user.id) as Array<{ title: string; body: string; kind: string; ref_id: string }>;
}

test("@Ada pings Ada right away with an alert, and not the sender", async () => {
  await withChat(async ({ port, db, sent }) => {
    const { people: [alex, ada, nia] } = await circleOf(port, ["Alex", "Ada", "Nia"]);
    sent.length = 0;
    const posted = await api(port, "POST", "/api/circles/chat", { token: alex.token, body: { text: "@ada hello" }, status: 201 });
    const messageId = posted.chat.messages.at(-1).id;
    // Before any batch flush: the mention is not held back by the chat window.
    const pinged = mentionPushes(sent, ada);
    assert.equal(pinged.length, 1);
    assert.equal(pinged[0].payload.title, "Circle chat");
    assert.equal(pinged[0].payload.body, "Alex mentioned you: @ada hello");
    assert.equal(pinged[0].payload.tag, `chat-mention:${messageId}`);
    assert.equal(pinged[0].payload.url, "/?chat=circle");
    assert.deepEqual(mentionPushes(sent, alex), []);
    assert.deepEqual(mentionPushes(sent, nia), []);
    assert.deepEqual(mentionAlerts(db, ada).map((row) => [row.kind, row.ref_id]), [["chat", "circle"]]);
    assert.deepEqual(mentionAlerts(db, alex), []);

    await flushChatNotices(true);
    const batched = (person: Person) => sent.filter((item) => item.endpoint.includes(person.user.id) && item.payload.tag.startsWith("chat:"));
    assert.equal(batched(ada).length, 0, "Ada is not pinged twice for the same message");
    assert.deepEqual(batched(nia).map((item) => item.payload.body), ["Alex: @ada hello"]);
  });
});

test("a muted chat gets no mention ping, and an unknown @Nobody pings nobody", async () => {
  await withChat(async ({ port, db, sent }) => {
    const { people: [alex, ada, nia] } = await circleOf(port, ["Alex", "Ada", "Nia"]);
    const thread = await api(port, "GET", "/api/circles/chat", { token: ada.token });
    await api(port, "POST", `/api/chats/${thread.chat.id}/mute`, { token: ada.token, body: { muted: true }, status: 204 });
    sent.length = 0;
    await api(port, "POST", "/api/circles/chat", { token: alex.token, body: { text: "@Ada you there?" }, status: 201 });
    await api(port, "POST", "/api/circles/chat", { token: alex.token, body: { text: "@Nobody hi, mail@Nia.test" }, status: 201 });
    await flushChatNotices(true);
    assert.deepEqual(sent.filter((item) => item.endpoint.includes(ada.user.id)), []);
    assert.deepEqual(mentionAlerts(db, ada), []);
    assert.deepEqual(mentionPushes(sent, nia), []);
    assert.deepEqual(mentionAlerts(db, nia), []);
  });
});

test("push off still leaves an alert, and the longest name wins", async () => {
  await withChat(async ({ port, db, sent }) => {
    const { people: [alex, alexandra, bea] } = await circleOf(port, ["Alex", "Alexandra", "Bea"]);
    await api(port, "DELETE", "/api/push/subscribe", { token: bea.token, body: { endpoint: `https://push.example/${bea.user.id}` }, status: 204 });
    sent.length = 0;
    await api(port, "POST", "/api/circles/chat", { token: alexandra.token, body: { text: "@Alexandra is me, @BEA come too" }, status: 201 });
    assert.deepEqual(mentionPushes(sent, alex), [], "@Alexandra is not @Alex");
    assert.deepEqual(mentionPushes(sent, bea), [], "no phone, no push");
    assert.equal(mentionAlerts(db, bea).length, 1, "the alert still says Bea was tagged");
    assert.deepEqual(mentionAlerts(db, alexandra), [], "tagging yourself does nothing");
  });
});

test("in an event chat only its people are pinged, never someone removed", async () => {
  await withChat(async ({ port, db, sent }) => {
    const { people: [alex, ada, nia, sam] } = await circleOf(port, ["Alex", "Ada", "Nia", "Sam"]);
    const social = await api(port, "POST", "/api/socials", { token: alex.token, body: { note: "Dinner" }, status: 201 });
    const id = social.social.id;
    await api(port, "POST", `/api/socials/${id}/reply`, { token: ada.token, body: { reply: "in" }, status: 200 });
    await api(port, "POST", `/api/socials/${id}/reply`, { token: nia.token, body: { reply: "in" }, status: 200 });
    await api(port, "DELETE", `/api/socials/${id}/people/${nia.user.id}`, { token: alex.token, status: 204 });
    await flushChatNotices(true);
    sent.length = 0;
    const posted = await api(port, "POST", `/api/socials/${id}/chat`, { token: alex.token, body: { text: "@Ada @Nia @Sam table for 3?" }, status: 201 });
    const ada1 = mentionPushes(sent, ada);
    assert.equal(ada1.length, 1);
    assert.equal(ada1[0].payload.title, "Dinner");
    assert.equal(ada1[0].payload.url, `/?chat=${encodeURIComponent(`social:${id}`)}`);
    assert.deepEqual(mentionPushes(sent, nia), [], "removed");
    assert.deepEqual(mentionPushes(sent, sam), [], "not coming, so not in this chat");
    assert.deepEqual(mentionAlerts(db, sam), []);
    const names = posted.chat.participants.map((person: { name: string }) => person.name).sort();
    assert.deepEqual(names, ["Ada", "Alex"]);
  });
});

test("mention parsing matches on client and server", () => {
  const names = ["Alex", "Alexandra", "Ada Lovelace", "Bea"];
  const cases = [
    "@Alexandra and @alex",
    "hi @Ada Lovelace!",
    "mail@bea.test @Bea, @Bea2 @bea",
    "@@Alex @",
    "(@Alexandra) @Alexander",
  ];
  for (const text of cases) assert.deepEqual(clientFind(text, names), serverFind(text, names), text);
  assert.deepEqual(serverFind("@Alexandra and @alex", names).map((hit) => hit.name), ["Alexandra", "Alex"]);
  assert.deepEqual(serverFind("mail@bea.test @Bea2", names), []);
});

test("the composer finds the @ being typed and fills in the name", () => {
  assert.deepEqual(mentionAt("hey @al", 7), { start: 4, query: "al" });
  assert.deepEqual(mentionAt("@", 1), { start: 0, query: "" });
  assert.equal(mentionAt("mail@al", 7), null);
  assert.equal(mentionAt("hey @ al", 8), null);
  assert.equal(mentionAt("hey", 3), null);
  const people = [{ id: "1", name: "Alex" }, { id: "2", name: "Ada Lovelace" }, { id: "3", name: "Bea" }];
  assert.deepEqual(mentionMatches(people, "a", "1").map((person: { name: string }) => person.name), ["Ada Lovelace"]);
  assert.deepEqual(mentionMatches(people, "love", "").map((person: { name: string }) => person.name), ["Ada Lovelace"]);
  assert.deepEqual(insertMention("hey @al", 4, 7, "Alex"), { text: "hey @Alex ", caret: 10 });
  assert.deepEqual(insertMention("@b see you", 0, 2, "Bea"), { text: "@Bea see you", caret: 5 });
});
