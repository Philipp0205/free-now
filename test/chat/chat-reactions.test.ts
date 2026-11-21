import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { flushChatNotices } from "../../src/chat/chat.js";
import { api, withApp, testEmail } from "../http.js";

// Fake people only. The db is in memory.

type Person = { token: string; user: { id: string; name: string } };

async function circleOf(port: number, names: string[]) {
  const [first, ...rest] = names;
  const host: Person = await api(port, "POST", "/api/auth/start", { body: { email: testEmail(), name: first }, status: 201 });
  const created = await api(port, "POST", "/api/circles", { token: host.token, body: { name: "friends" }, status: 201 });
  const people: Person[] = [host];
  for (const name of rest) {
    people.push(await api(port, "POST", "/api/auth/start", { body: { email: testEmail(), name, code: created.circle.inviteCode }, status: 201 }));
  }
  return people;
}

async function withChat(fn: (ctx: { port: number; db: DatabaseSync; advance: (ms: number) => void }) => Promise<void>) {
  await withApp(async (ctx) => {
    try {
      await fn(ctx);
    } finally {
      await flushChatNotices(true);
    }
  });
}

const react = (port: number, person: Person, id: string, emoji: unknown, status = 200, on?: boolean) =>
  api(port, "POST", `/api/messages/${id}/reactions`, { token: person.token, body: on === undefined ? { emoji } : { emoji, on }, status });

test("a reaction toggles on and off, a second person adds to the count, and a repeat add is a no-op", async () => {
  await withChat(async ({ port }) => {
    const [alex, ada, nia] = await circleOf(port, ["Alex", "Ada", "Nia"]);
    const posted = await api(port, "POST", "/api/circles/chat", { token: alex.token, body: { text: "Pizza tonight?" }, status: 201 });
    const id = posted.chat.messages.at(-1).id;

    const first = await react(port, ada, id, "👍");
    assert.equal(first.messageId, id);
    assert.deepEqual(first.reactions, [{ emoji: "👍", count: 1, mine: true, names: ["Ada"] }]);

    const again = await react(port, ada, id, "👍", 200, true);
    assert.deepEqual(again.reactions, first.reactions, "on: true twice keeps one reaction");

    const second = await react(port, nia, id, "👍");
    assert.deepEqual(second.reactions, [{ emoji: "👍", count: 2, mine: true, names: ["Ada", "Nia"] }]);
    await react(port, nia, id, "🔥");
    const heart = await react(port, alex, id, "❤️");
    assert.deepEqual(heart.reactions.map((item: { emoji: string }) => item.emoji), ["👍", "❤️", "🔥"], "allowlist order");

    const thread = await api(port, "GET", "/api/circles/chat", { token: ada.token });
    const message = thread.chat.messages.find((item: { id: string }) => item.id === id);
    assert.deepEqual(message.reactions, [
      { emoji: "👍", count: 2, mine: true, names: ["Ada", "Nia"] },
      { emoji: "❤️", count: 1, mine: false, names: ["Alex"] },
      { emoji: "🔥", count: 1, mine: false, names: ["Nia"] },
    ]);

    const off = await react(port, ada, id, "👍");
    assert.deepEqual(off.reactions[0], { emoji: "👍", count: 1, mine: false, names: ["Nia"] });
    const offAgain = await react(port, ada, id, "👍", 200, false);
    assert.deepEqual(offAgain.reactions, off.reactions, "on: false when already off changes nothing");
    await react(port, nia, id, "👍");
    const left = await api(port, "GET", "/api/circles/chat", { token: nia.token });
    assert.deepEqual(left.chat.messages.find((item: { id: string }) => item.id === id).reactions.map((item: { emoji: string }) => item.emoji), ["❤️", "🔥"]);
  });
});

test("only one emoji, only real messages, and only the chat's people may react", async () => {
  await withChat(async ({ port }) => {
    const [alex, ada, sam] = await circleOf(port, ["Alex", "Ada", "Sam"]);
    const outsider: Person = await api(port, "POST", "/api/auth/start", { body: { email: testEmail(), name: "Out" }, status: 201 });
    await api(port, "POST", "/api/circles", { token: outsider.token, body: { name: "other" }, status: 201 });
    const posted = await api(port, "POST", "/api/circles/chat", { token: alex.token, body: { text: "hi" }, status: 201 });
    const id = posted.chat.messages.at(-1).id;

    for (const bad of ["", 7, null, "x", "thumbs up", "👍👍", 0, 1, "1"]) await react(port, ada, id, bad, 400);
    await react(port, outsider, id, "👍", 404);
    await react(port, ada, "no-such-message", "👍", 404);

    const social = await api(port, "POST", "/api/socials", { token: alex.token, body: { note: "Coffee" }, status: 201 });
    const sid = social.social.id;
    await api(port, "POST", `/api/socials/${sid}/reply`, { token: ada.token, body: { reply: "in" }, status: 200 });
    const chat = await api(port, "POST", `/api/socials/${sid}/chat`, { token: ada.token, body: { text: "on my way" }, status: 201 });
    const text = chat.chat.messages.find((item: { text: string }) => item.text === "on my way");
    const system = chat.chat.messages.find((item: { system: boolean }) => item.system);
    assert.deepEqual(system.reactions, []);
    await react(port, ada, system.id, "👍");
    await react(port, sam, text.id, "👍", 403);
    await react(port, alex, text.id, "😂");

    await api(port, "DELETE", `/api/socials/${sid}/people/${ada.user.id}`, { token: alex.token, status: 204 });
    await react(port, ada, text.id, "👍", 403);

    await api(port, "DELETE", `/api/messages/${text.id}`, { token: alex.token, status: 204 });
    await react(port, alex, text.id, "👍", 404);
  });
});

test("the thread carries reactions and the chat's people with their colour", async () => {
  await withChat(async ({ port }) => {
    const [alex, ada, sam] = await circleOf(port, ["Alex", "Ada", "Sam"]);
    const circle = await api(port, "GET", "/api/circles/chat", { token: alex.token });
    assert.deepEqual(circle.chat.participants.map((person: { name: string }) => person.name).sort(), ["Ada", "Alex", "Sam"]);
    for (const person of circle.chat.participants) {
      assert.match(person.color, /^#[0-9a-f]{6}$/);
      assert.equal(typeof person.id, "string");
    }
    const social = await api(port, "POST", "/api/socials", { token: alex.token, body: { note: "Ramen" }, status: 201 });
    await api(port, "POST", `/api/socials/${social.social.id}/reply`, { token: ada.token, body: { reply: "in" }, status: 200 });
    const thread = await api(port, "GET", `/api/socials/${social.social.id}/chat`, { token: sam.token });
    assert.deepEqual(thread.chat.participants.map((person: { name: string }) => person.name).sort(), ["Ada", "Alex"]);
    const posted = await api(port, "POST", `/api/socials/${social.social.id}/chat`, { token: ada.token, body: { text: "yum" }, status: 201 });
    assert.deepEqual(posted.chat.messages.at(-1).reactions, []);

  });
});

test("a closed chat still takes reactions on its messages", async () => {
  await withChat(async ({ port, advance }) => {
    const [alex, ada] = await circleOf(port, ["Alex", "Ada"]);
    const plan = await api(port, "POST", "/api/plans", { token: alex.token, body: { note: "Dinner" }, status: 201 });
    await api(port, "POST", `/api/plans/${plan.plan.id}/reply`, { token: ada.token, body: { reply: "in" }, status: 200 });
    const posted = await api(port, "POST", `/api/plans/${plan.plan.id}/chat`, { token: alex.token, body: { text: "see you at 8" }, status: 201 });
    const id = posted.chat.messages.at(-1).id;
    advance(3 * 24 * 60 * 60 * 1000);
    const closed = await api(port, "GET", `/api/plans/${plan.plan.id}/chat`, { token: ada.token });
    assert.equal(closed.chat.closed, true);
    const done = await react(port, ada, id, "❤️");
    assert.deepEqual(done.reactions, [{ emoji: "❤️", count: 1, mine: true, names: ["Ada"] }]);
  });
});

const emojiOf = (list: Array<{ emoji: string }>) => list.map((item) => item.emoji);

test("any emoji can react: it is stored as the character, counted, shared, toggled off, and sorted after the quick six", async () => {
  await withChat(async ({ port, advance, db }) => {
    const [alex, ada, nia] = await circleOf(port, ["Alex", "Ada", "Nia"]);
    const posted = await api(port, "POST", "/api/circles/chat", { token: alex.token, body: { text: "Party?" }, status: 201 });
    const id = posted.chat.messages.at(-1).id;

    const first = await react(port, ada, id, "🎉");
    assert.deepEqual(first.reactions, [{ emoji: "🎉", count: 1, mine: true, names: ["Ada"] }]);
    advance(1000);
    // Two people can use the same custom emoji.
    const shared = await react(port, nia, id, "🎉");
    assert.deepEqual(shared.reactions, [{ emoji: "🎉", count: 2, mine: true, names: ["Ada", "Nia"] }]);
    advance(1000);
    await react(port, ada, id, "👋");
    advance(1000);
    // Quick ones come first in allowlist order, then the others by first use, whatever the order they arrived in.
    await react(port, alex, id, "🔥");
    advance(1000);
    await react(port, alex, id, "👍");
    const mixed = await react(port, nia, id, "👨‍👩‍👧‍👦");
    assert.deepEqual(emojiOf(mixed.reactions), ["👍", "🔥", "🎉", "👋", "👨‍👩‍👧‍👦"]);
    assert.deepEqual(mixed.reactions[2], { emoji: "🎉", count: 2, mine: true, names: ["Ada", "Nia"] });

    const thread = await api(port, "GET", "/api/circles/chat", { token: ada.token });
    const message = thread.chat.messages.find((item: { id: string }) => item.id === id);
    assert.deepEqual(emojiOf(message.reactions), ["👍", "🔥", "🎉", "👋", "👨‍👩‍👧‍👦"]);
    assert.equal(message.reactions[2].mine, true);
    assert.equal(message.reactions[4].mine, false);

    // The row holds the character itself, not an index into the quick list.
    const rows = db.prepare("SELECT emoji FROM message_reactions WHERE message_id = ? ORDER BY created_at, rowid").all(id) as Array<{ emoji: string }>;
    assert.deepEqual(rows.map((row) => row.emoji), ["🎉", "🎉", "👋", "🔥", "👍", "👨‍👩‍👧‍👦"]);
    assert.ok(rows.every((row) => typeof row.emoji === "string" && !/^\d+$/.test(row.emoji)));
    const off = await react(port, ada, id, "🎉");
    assert.deepEqual(off.reactions.find((item: { emoji: string }) => item.emoji === "🎉"), { emoji: "🎉", count: 1, mine: false, names: ["Nia"] });
    await react(port, nia, id, "🎉");
    const gone = await api(port, "GET", "/api/circles/chat", { token: ada.token });
    assert.deepEqual(emojiOf(gone.chat.messages.find((item: { id: string }) => item.id === id).reactions), ["👍", "🔥", "👋", "👨‍👩‍👧‍👦"]);

    // Skin tones and flags are one emoji too.
    for (const ok of ["👍🏽", "🇩🇪", "1️⃣", "🏳️‍🌈"]) {
      const added = await react(port, ada, id, ok);
      assert.ok(emojiOf(added.reactions).includes(ok), ok);
    }
  });
});

test("a bad reaction value is a 400 with a plain error and stores nothing", async () => {
  await withChat(async ({ port }) => {
    const [alex, ada] = await circleOf(port, ["Alex", "Ada"]);
    const posted = await api(port, "POST", "/api/circles/chat", { token: alex.token, body: { text: "hi" }, status: 201 });
    const id = posted.chat.messages.at(-1).id;
    const tooLong = "👍".repeat(40);
    const zwjSoup = Array.from({ length: 20 }, () => "👩").join("\u200d");
    for (const bad of ["hello", "a", "👍👎", "🎉🎉", "", " ", "👍 ", tooLong, zwjSoup, 0, 3, "3", true, null, ["👍"], { emoji: "👍" }, "\u200d", "\u{1F3FD}x"]) {
      const result = await react(port, ada, id, bad, 400);
      assert.equal(typeof result.error, "string");
      assert.ok(!("reactions" in result));
    }
    const thread = await api(port, "GET", "/api/circles/chat", { token: ada.token });
    assert.deepEqual(thread.chat.messages.find((item: { id: string }) => item.id === id).reactions, []);
  });
});
