import assert from "node:assert/strict";
import test from "node:test";
import { flushChatNotices } from "../../src/chat/chat.js";
import { api, withApp } from "../http.js";

// Fake people only. The db is in memory.

type Person = { token: string; user: { id: string; name: string } };

async function circleOf(port: number, names: string[]) {
  const [first, ...rest] = names;
  const host: Person = await api(port, "POST", "/api/auth/start", { body: { name: first }, status: 201 });
  const created = await api(port, "POST", "/api/circles", { token: host.token, body: { name: "friends" }, status: 201 });
  const people: Person[] = [host];
  for (const name of rest) {
    people.push(await api(port, "POST", "/api/auth/start", { body: { name, code: created.circle.inviteCode }, status: 201 }));
  }
  return people;
}

async function withChat(fn: (ctx: { port: number; advance: (ms: number) => void }) => Promise<void>) {
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

test("only the quick emoji, only text messages, and only the chat's people may react", async () => {
  await withChat(async ({ port }) => {
    const [alex, ada, sam] = await circleOf(port, ["Alex", "Ada", "Sam"]);
    const outsider: Person = await api(port, "POST", "/api/auth/start", { body: { name: "Out" }, status: 201 });
    await api(port, "POST", "/api/circles", { token: outsider.token, body: { name: "other" }, status: 201 });
    const posted = await api(port, "POST", "/api/circles/chat", { token: alex.token, body: { text: "hi" }, status: 201 });
    const id = posted.chat.messages.at(-1).id;

    for (const bad of ["🍕", "👍🏽", "", 7, null]) await react(port, ada, id, bad, 400);
    await react(port, outsider, id, "👍", 404);
    await react(port, ada, "no-such-message", "👍", 404);

    const social = await api(port, "POST", "/api/socials", { token: alex.token, body: { note: "Coffee" }, status: 201 });
    const sid = social.social.id;
    await api(port, "POST", `/api/socials/${sid}/reply`, { token: ada.token, body: { reply: "in" }, status: 200 });
    const chat = await api(port, "POST", `/api/socials/${sid}/chat`, { token: ada.token, body: { text: "on my way" }, status: 201 });
    const text = chat.chat.messages.find((item: { text: string }) => item.text === "on my way");
    const system = chat.chat.messages.find((item: { system: boolean }) => item.system);
    assert.deepEqual(system.reactions, []);
    await react(port, ada, system.id, "👍", 400);
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
