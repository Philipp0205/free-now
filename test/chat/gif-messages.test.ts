import assert from "node:assert/strict";
import test from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { flushChatNotices } from "../../src/chat/chat.js";
import { api, testEmail, withApp, type AppCtx, type SentPush } from "../http.js";

// Fake people, a fake key and a fake Giphy that is never called: sending a GIF only stores what the client picked.

type Person = { token: string; user: { id: string; name: string } };

const GIF = { id: "abc123", title: "Happy dog", width: 200, height: 150, url: "https://media2.giphy.com/media/abc123/200w.gif" };

function withChat(fn: (ctx: AppCtx<SentPush>) => Promise<void>) {
  return withApp(async (ctx) => {
    try {
      await fn(ctx);
    } finally {
      await flushChatNotices(true);
    }
  }, {
    sent: "envelope",
    env: { GIPHY_API_KEY: "test-giphy-key" },
    giphyFetch: async () => { throw new Error("no Giphy call is expected here"); },
  });
}

async function circleOf(port: number, names: string[]) {
  const [first, ...rest] = names;
  const host: Person = await api(port, "POST", "/api/auth/start", { body: { email: testEmail(), name: first }, status: 201 });
  const created = await api(port, "POST", "/api/circles", { token: host.token, body: { name: "friends" }, status: 201 });
  const people: Person[] = [host];
  for (const name of rest) {
    people.push(await api(port, "POST", "/api/auth/start", { body: { email: testEmail(), name, code: created.circle.inviteCode }, status: 201 }));
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

const send = (port: number, person: Person, gif: unknown, extra: Record<string, unknown> = {}, status = 201) =>
  api(port, "POST", "/api/circles/chat", { token: person.token, body: { gif, ...extra }, status });
const say = (port: number, person: Person, text: string, status = 201) =>
  api(port, "POST", "/api/circles/chat", { token: person.token, body: { text }, status });

function rowCount(db: DatabaseSync): number {
  return Number((db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n);
}

test("a GIF is stored as id, title, size and one Giphy URL, and comes back as a gif message", async () => {
  await withChat(async ({ port, db }) => {
    const [alex, ada] = await circleOf(port, ["Alex", "Ada"]);
    const posted = await send(port, alex, { ...GIF, preview: "https://media2.giphy.com/x.gif", extra: "ignored", api_key: "nope" });
    const message = posted.chat.messages.at(-1);
    assert.equal(message.text, "GIF");
    assert.deepEqual(message.gif, GIF);
    assert.equal(message.mine, true);
    assert.equal(message.canDelete, true);
    assert.equal(message.system, false);
    const stored = db.prepare("SELECT body, kind FROM messages WHERE id = ?").get(message.id) as { body: string; kind: string };
    assert.equal(stored.kind, "gif");
    assert.deepEqual(JSON.parse(stored.body), GIF, "only the five fields are kept");

    const seen = await api(port, "GET", "/api/circles/chat", { token: ada.token });
    const theirs = seen.chat.messages.at(-1);
    assert.deepEqual(theirs.gif, GIF);
    assert.equal(theirs.mine, false);
    assert.equal(theirs.name, "Alex");

    const plain = (await say(port, ada, "nice")).chat.messages.at(-1);
    assert.equal(plain.gif, null, "a text message has no gif");
  });
});

test("a Giphy URL is accepted from media hosts only, over https, with no credentials, port or query", async () => {
  await withChat(async ({ port, db }) => {
    const [alex] = await circleOf(port, ["Alex"]);
    for (const url of [
      "https://media.giphy.com/media/abc123/giphy.gif",
      "https://media0.giphy.com/media/abc123/giphy.gif",
      "https://media12.giphy.com/media/abc123/giphy.gif",
      "https://i.giphy.com/abc123.gif",
    ]) {
      const posted = await send(port, alex, { ...GIF, url });
      assert.equal(posted.chat.messages.at(-1).gif.url, url);
    }
    const kept = await send(port, alex, { ...GIF, url: "https://media2.giphy.com/media/abc123/200w.gif?cid=1&ep=v1#frag" });
    assert.equal(kept.chat.messages.at(-1).gif.url, "https://media2.giphy.com/media/abc123/200w.gif", "the query and hash are dropped");

    const before = rowCount(db);
    for (const url of [
      "http://media2.giphy.com/media/abc123/200w.gif",
      "https://giphy.com/gifs/abc123",
      "https://api.giphy.com/v1/gifs/abc123",
      "https://media2.giphy.com.evil.example/x.gif",
      "https://evilgiphy.com/x.gif",
      "https://evil.example/media2.giphy.com/x.gif",
      "https://user:pass@media2.giphy.com/x.gif",
      "https://media2.giphy.com:8443/x.gif",
      "https://media2.giphy.com/",
      "javascript:alert(1)",
      "data:image/gif;base64,R0lGODlh",
      "//media2.giphy.com/x.gif",
      "",
      42,
      null,
    ]) {
      await send(port, alex, { ...GIF, url }, {}, 400);
    }
    assert.equal(rowCount(db), before, "nothing refused was stored");
  });
});

test("a GIF with a bad id, size or shape is refused and a body with text and a GIF is a GIF", async () => {
  await withChat(async ({ port, db }) => {
    const [alex] = await circleOf(port, ["Alex"]);
    const before = rowCount(db);
    for (const gif of [
      { ...GIF, id: "" },
      { ...GIF, id: "has space" },
      { ...GIF, id: "x".repeat(41) },
      { ...GIF, id: 7 },
      { ...GIF, width: 0 },
      { ...GIF, width: 5000 },
      { ...GIF, height: -1 },
      { ...GIF, height: 1.5 },
      { ...GIF, width: "wide" },
      { id: GIF.id, url: GIF.url },
      "https://media2.giphy.com/media/abc123/200w.gif",
      [GIF],
      {},
    ]) {
      await send(port, alex, gif, {}, 400);
    }
    assert.equal(rowCount(db), before);

    const both = await send(port, alex, GIF, { text: "@Alex look at this" });
    const message = both.chat.messages.at(-1);
    assert.equal(message.text, "GIF", "the text is ignored, so a GIF never carries a mention or a gripe");
    assert.deepEqual(message.gif, GIF);

    const long = await send(port, alex, { ...GIF, title: `  ${"t".repeat(300)}\n\tend ` });
    assert.equal(long.chat.messages.at(-1).gif.title.length, 120);
    const blank = await send(port, alex, { ...GIF, title: 5 });
    assert.equal(blank.chat.messages.at(-1).gif.title, "");
  });
});

test("a GIF works in event chats too, and someone outside the event cannot post one", async () => {
  await withChat(async ({ port, db }) => {
    const [alex, ada] = await circleOf(port, ["Alex", "Ada"]);
    const social = await api(port, "POST", "/api/socials", { token: alex.token, body: { note: "Coffee" }, status: 201 });
    const sid = social.social.id;
    await api(port, "POST", `/api/socials/${sid}/reply`, { token: ada.token, body: { reply: "in" }, status: 200 });
    const posted = await api(port, "POST", `/api/socials/${sid}/chat`, { token: ada.token, body: { gif: GIF }, status: 201 });
    assert.deepEqual(posted.chat.messages.at(-1).gif, GIF);

    const outsider = await api(port, "POST", "/api/auth/start", { body: { email: testEmail(), name: "Out" }, status: 201 });
    await api(port, "POST", "/api/circles", { token: outsider.token, body: { name: "other" }, status: 201 });
    const before = rowCount(db);
    const refused = await api(port, "POST", `/api/socials/${sid}/chat`, { token: outsider.token, body: { gif: GIF } });
    assert.ok(refused?.error, "someone outside the event cannot post");
    assert.equal(rowCount(db), before);
  });
});

test("a GIF can be the reply to a message, the reply pings its author, and the quote and notice say GIF", async () => {
  await withChat(async ({ port, sent }) => {
    const [alex, ada, nia] = await circleOf(port, ["Alex", "Ada", "Nia"]);
    const parent = (await say(port, ada, "Who is driving?")).chat.messages.at(-1);
    await flushChatNotices(true);
    sent.length = 0;

    const reply = (await send(port, alex, GIF, { replyTo: parent.id })).chat.messages.at(-1);
    assert.equal(reply.replyTo.id, parent.id);
    assert.equal(reply.replyTo.text, "Who is driving?");
    assert.deepEqual(reply.gif, GIF);

    const pinged = sent.filter((item) => item.endpoint.includes(ada.user.id) && item.payload.tag.startsWith("chat-reply:"));
    assert.equal(pinged.length, 1);
    assert.equal(pinged[0].payload.body, "Alex replied to you: sent a GIF");
    assert.ok(!pinged[0].payload.body.includes("giphy.com"), "the notice never has the URL");
    await flushChatNotices(true);
    const batch = sent.filter((item) => item.endpoint.includes(nia.user.id) && item.payload.tag.startsWith("chat:"));
    assert.deepEqual(batch.map((item) => item.payload.body), ["Alex: sent a GIF"]);

    // A GIF can be replied to as well, and its quote reads GIF, not JSON.
    const back = (await api(port, "POST", "/api/circles/chat", { token: ada.token, body: { text: "ha", replyTo: reply.id }, status: 201 })).chat.messages.at(-1);
    assert.equal(back.replyTo.text, "GIF");
    assert.ok(!JSON.stringify(back.replyTo).includes("giphy.com"));
    const gifOnGif = (await send(port, ada, { ...GIF, id: "other9", url: "https://media3.giphy.com/media/other9/200w.gif" }, { replyTo: reply.id })).chat.messages.at(-1);
    assert.equal(gifOnGif.replyTo.text, "GIF");
    assert.equal(gifOnGif.gif.id, "other9");

    // A reply to a message in another chat is still refused.
    await send(port, alex, GIF, { replyTo: "no-such-message" }, 404);
  });
});

test("emoji reactions are unchanged: one emoji only, never a GIF or a Giphy id, and a GIF can be reacted to", async () => {
  await withChat(async ({ port, db }) => {
    const [alex, ada] = await circleOf(port, ["Alex", "Ada"]);
    const message = (await send(port, alex, GIF)).chat.messages.at(-1);

    const reacted = await api(port, "POST", `/api/messages/${message.id}/reactions`, { token: ada.token, body: { emoji: "🔥" }, status: 200 });
    assert.equal(reacted.messageId, message.id);
    assert.deepEqual(reacted.reactions.map((item: { emoji: string; count: number }) => [item.emoji, item.count]), [["🔥", 1]]);
    const thread = await api(port, "GET", "/api/circles/chat", { token: alex.token });
    const row = thread.chat.messages.find((item: { id: string }) => item.id === message.id);
    assert.deepEqual(row.reactions.map((item: { emoji: string }) => item.emoji), ["🔥"]);
    assert.deepEqual(row.gif, GIF);

    for (const emoji of [GIF.id, GIF.url, "🔥🔥", "🔥 x", "GIF", "https://media2.giphy.com/media/abc123/200w.gif", "", 5]) {
      await api(port, "POST", `/api/messages/${message.id}/reactions`, { token: ada.token, body: { emoji }, status: 400 });
    }
    const stored = (db.prepare("SELECT emoji FROM message_reactions").all() as Array<{ emoji: string }>).map((item) => item.emoji);
    assert.deepEqual(stored, ["🔥"], "only the one emoji is stored");
  });
});

test("a GIF can be deleted by its sender, and the quote of it then reads as deleted", async () => {
  await withChat(async ({ port, db }) => {
    const [alex, ada] = await circleOf(port, ["Alex", "Ada"]);
    const message = (await send(port, alex, GIF)).chat.messages.at(-1);
    const quoted = (await api(port, "POST", "/api/circles/chat", { token: ada.token, body: { text: "ha", replyTo: message.id }, status: 201 })).chat.messages.at(-1);

    await api(port, "DELETE", `/api/messages/${message.id}`, { token: ada.token, status: 403 });
    await api(port, "DELETE", `/api/messages/${message.id}`, { token: alex.token, status: 204 });
    const thread = await api(port, "GET", "/api/circles/chat", { token: ada.token });
    assert.equal(thread.chat.messages.some((item: { id: string }) => item.id === message.id), false);
    const kept = thread.chat.messages.find((item: { id: string }) => item.id === quoted.id);
    assert.equal(kept.replyTo.deleted, true);
    assert.equal(kept.replyTo.text, "");
    assert.ok(!JSON.stringify(thread).includes("giphy.com"), "the deleted GIF's URL never comes back");
    const gone = db.prepare("SELECT deleted_at FROM messages WHERE id = ?").get(message.id) as { deleted_at: number | null };
    assert.ok(gone.deleted_at != null);
  });
});

test("the chat summary previews a GIF as GIF, never its JSON", async () => {
  await withChat(async ({ port }) => {
    const [alex, ada] = await circleOf(port, ["Alex", "Ada"]);
    const social = await api(port, "POST", "/api/socials", { token: alex.token, body: { note: "Coffee" }, status: 201 });
    const sid = social.social.id;
    await api(port, "POST", `/api/socials/${sid}/reply`, { token: ada.token, body: { reply: "in" }, status: 200 });
    await api(port, "POST", `/api/socials/${sid}/chat`, { token: alex.token, body: { gif: GIF }, status: 201 });
    const summary = await api(port, "GET", "/api/chats", { token: ada.token, status: 200 });
    const event = summary.events.find((item: { id: string }) => item.id === sid);
    assert.ok(event, "the event chat is in the summary");
    assert.equal(event.preview, "GIF");
    assert.equal(event.previewBy, "Alex");
    assert.equal(event.unread, 1);
    assert.ok(!JSON.stringify(summary).includes("giphy.com"));
  });
});
