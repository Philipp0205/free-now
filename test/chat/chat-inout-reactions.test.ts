import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { flushChatNotices } from "../../src/chat/chat.js";
import { api, withApp, testEmail } from "../http.js";

// Fake people only. The db is in memory.

type Person = { token: string; user: { id: string; name: string } };
type Line = { id: string; text: string; system: boolean; goblin: boolean; reactions: Array<{ emoji: string; count: number; mine: boolean; names: string[] }> };

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

const lines = async (port: number, person: Person, path: string): Promise<Line[]> =>
  (await api(port, "GET", path, { token: person.token })).chat.messages;

const systemLine = (list: Line[], text: string) => list.find((item) => item.system && item.text === text)!;

type Kind = "socials" | "plans";

/** Alex hosts an event and the guest answers it ("in" or "cant"). Returns the chat path for that kind. */
async function eventWithReply(port: number, kind: Kind, host: Person, guest: Person, reply: "in" | "cant" | "maybe", more: Person[] = []) {
  const made = await api(port, "POST", `/api/${kind}`, { token: host.token, body: { note: "Dinner" }, status: 201 });
  const id = kind === "socials" ? made.social.id : made.plan.id;
  for (const person of more) await api(port, "POST", `/api/${kind}/${id}/reply`, { token: person.token, body: { reply: "in" }, status: 200 });
  await api(port, "POST", `/api/${kind}/${id}/reply`, { token: guest.token, body: { reply }, status: 200 });
  return `/api/${kind}/${id}/chat`;
}

for (const kind of ["socials", "plans"] as const) {
  test(`${kind}: a participant reacts to the in line, and the other person sees it as not theirs`, async () => {
    await withChat(async ({ port }) => {
      const [alex, ada] = await circleOf(port, ["Alex", "Ada"]);
      const path = await eventWithReply(port, kind, alex, ada, "in");
      const line = systemLine(await lines(port, alex, path), "Ada is in");
      assert.equal(typeof line.id, "string");
      assert.deepEqual(line.reactions, []);

      const done = await react(port, alex, line.id, "🎉");
      assert.deepEqual(done.reactions, [{ emoji: "🎉", count: 1, mine: true, names: ["Alex"] }]);

      const seen = systemLine(await lines(port, ada, path), "Ada is in");
      assert.deepEqual(seen.reactions, [{ emoji: "🎉", count: 1, mine: false, names: ["Alex"] }]);
    });
  });

  test(`${kind}: the out line takes a reaction, and a person can change and remove theirs`, async () => {
    await withChat(async ({ port, advance }) => {
      const [alex, ada, nia] = await circleOf(port, ["Alex", "Ada", "Nia"]);
      const path = await eventWithReply(port, kind, alex, ada, "cant", [nia]);
      const line = systemLine(await lines(port, alex, path), "Ada can't make it");

      await react(port, alex, line.id, "😢");
      advance(1000);
      await react(port, nia, line.id, "😢");
      const both = systemLine(await lines(port, nia, path), "Ada can't make it");
      assert.deepEqual(both.reactions, [{ emoji: "😢", count: 2, mine: true, names: ["Alex", "Nia"] }]);

      // Change: take one emoji off and put another on.
      await react(port, alex, line.id, "😢");
      const changed = await react(port, alex, line.id, "❤️");
      assert.deepEqual(changed.reactions.map((item: { emoji: string }) => item.emoji), ["❤️", "😢"]);
      const after = systemLine(await lines(port, nia, path), "Ada can't make it");
      assert.deepEqual(after.reactions, [
        { emoji: "❤️", count: 1, mine: false, names: ["Alex"] },
        { emoji: "😢", count: 1, mine: true, names: ["Nia"] },
      ]);

      // Remove: both gone, and the payload is empty again.
      await react(port, alex, line.id, "❤️");
      await react(port, nia, line.id, "😢", 200, false);
      assert.deepEqual(systemLine(await lines(port, alex, path), "Ada can't make it").reactions, []);
    });
  });
}

for (const kind of ["socials", "plans"] as const) {
  test(`${kind}: the maybe line takes a reaction, and nothing else`, async () => {
    await withChat(async ({ port }) => {
      const [alex, ada] = await circleOf(port, ["Alex", "Ada"]);
      const path = await eventWithReply(port, kind, alex, ada, "maybe");
      const line = systemLine(await lines(port, alex, path), "Ada is maybe");
      assert.equal(typeof line.id, "string");
      assert.deepEqual(line.reactions, []);

      const done = await react(port, alex, line.id, "🤞");
      assert.deepEqual(done.reactions, [{ emoji: "🤞", count: 1, mine: true, names: ["Alex"] }]);
      const seen = systemLine(await lines(port, ada, path), "Ada is maybe");
      assert.deepEqual(seen.reactions, [{ emoji: "🤞", count: 1, mine: false, names: ["Alex"] }]);

      await api(port, "POST", path, { token: alex.token, body: { text: "hi", replyTo: line.id }, status: 400 });
      await api(port, "PATCH", `/api/messages/${line.id}`, { token: alex.token, body: { text: "x" }, status: 403 });
      await api(port, "DELETE", `/api/messages/${line.id}`, { token: alex.token, status: 403 });
    });
  });
}

test("a circle member who is not in the event cannot react to its maybe line", async () => {
  await withChat(async ({ port, db }) => {
    const [alex, ada, sam] = await circleOf(port, ["Alex", "Ada", "Sam"]);
    const path = await eventWithReply(port, "plans", alex, ada, "maybe");
    const line = systemLine(await lines(port, alex, path), "Ada is maybe");
    await react(port, sam, line.id, "👍", 403);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM message_reactions").get() as { n: number }).n, 0);
  });
});

test("a circle member who is not in the event cannot react to its in line, and nothing is stored", async () => {
  await withChat(async ({ port, db }) => {
    const [alex, ada, sam] = await circleOf(port, ["Alex", "Ada", "Sam"]);
    const path = await eventWithReply(port, "socials", alex, ada, "in");
    const line = systemLine(await lines(port, alex, path), "Ada is in");
    await react(port, sam, line.id, "👍", 403);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM message_reactions").get() as { n: number }).n, 0);

    const planPath = await eventWithReply(port, "plans", alex, ada, "in");
    const planLine = systemLine(await lines(port, alex, planPath), "Ada is in");
    await react(port, sam, planLine.id, "👍", 403);
  });
});

test("someone in no shared circle cannot see the event, so the line is a 404", async () => {
  await withChat(async ({ port }) => {
    const [alex, ada] = await circleOf(port, ["Alex", "Ada"]);
    const outsider: Person = await api(port, "POST", "/api/auth/start", { body: { email: testEmail(), name: "Out" }, status: 201 });
    await api(port, "POST", "/api/circles", { token: outsider.token, body: { name: "other" }, status: 201 });
    const path = await eventWithReply(port, "socials", alex, ada, "in");
    const line = systemLine(await lines(port, alex, path), "Ada is in");
    await react(port, outsider, line.id, "👍", 404);
  });
});

test("system lines take reactions only: no reply, edit or delete, and the Goblin still rejects them", async () => {
  await withChat(async ({ port }) => {
    const [alex, ada] = await circleOf(port, ["Alex", "Ada"]);
    const path = await eventWithReply(port, "socials", alex, ada, "in");
    const line = systemLine(await lines(port, alex, path), "Ada is in");
    await api(port, "POST", path, { token: alex.token, body: { text: "hi", replyTo: line.id }, status: 400 });
    await api(port, "PATCH", `/api/messages/${line.id}`, { token: alex.token, body: { text: "x" }, status: 403 });
    await api(port, "DELETE", `/api/messages/${line.id}`, { token: alex.token, status: 403 });

    await api(port, "POST", path, { token: ada.token, body: { text: "@Goblin the tabs flicker" }, status: 201 });
    const goblin = (await lines(port, ada, path)).find((item) => item.goblin)!;
    await react(port, ada, goblin.id, "👍", 400);
  });
});

test("a closed event chat still takes reactions on an in line, like any other message", async () => {
  await withChat(async ({ port, advance }) => {
    const [alex, ada] = await circleOf(port, ["Alex", "Ada"]);
    const path = await eventWithReply(port, "plans", alex, ada, "in");
    const line = systemLine(await lines(port, alex, path), "Ada is in");
    advance(3 * 24 * 60 * 60 * 1000);
    const closed = await api(port, "GET", path, { token: ada.token });
    assert.equal(closed.chat.closed, true);
    const done = await react(port, alex, line.id, "❤️");
    assert.deepEqual(done.reactions, [{ emoji: "❤️", count: 1, mine: true, names: ["Alex"] }]);
    assert.deepEqual(systemLine(await lines(port, ada, path), "Ada is in").reactions, [{ emoji: "❤️", count: 1, mine: false, names: ["Alex"] }]);
  });
});
