import assert from "node:assert/strict";
import test from "node:test";
import { flushChatNotices } from "../../src/chat/chat.js";
import { api, withApp, type AppCtx, type SentPush, testEmail } from "../http.js";

// Fake people only. Push goes to a recorder, the db is in memory.

type Person = { token: string; user: { id: string; name: string } };
type Line = { id: string; text: string; editedAt: number | null; canEdit: boolean; canDelete: boolean; system: boolean; goblin: boolean };

function withChat(fn: (ctx: AppCtx<SentPush>) => Promise<void>) {
  return withApp(async (ctx) => {
    try {
      await fn(ctx);
    } finally {
      await flushChatNotices(true);
    }
  }, { sent: "envelope" });
}

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

const say = async (port: number, person: Person, text: string, path = "/api/circles/chat"): Promise<Line> =>
  (await api(port, "POST", path, { token: person.token, body: { text }, status: 201 })).chat.messages.at(-1);

const edit = (port: number, person: Person, id: string, text: unknown, status: number) =>
  api(port, "PATCH", `/api/messages/${id}`, { token: person.token, body: { text }, status });

const lines = async (port: number, person: Person, path = "/api/circles/chat"): Promise<Line[]> =>
  (await api(port, "GET", path, { token: person.token })).chat.messages;

test("the author edits their own text message and the thread shows the new words with an edited mark", async () => {
  await withChat(async ({ port, db }) => {
    const [alex, ada] = await circleOf(port, ["Alex", "Ada"]);
    const sent = await say(port, ada, "Ramen at 7?");
    assert.equal(sent.editedAt, null);
    assert.equal(sent.canEdit, true);

    const done = await edit(port, ada, sent.id, "  Ramen at 8?  ", 200);
    assert.equal(done.message.id, sent.id);
    assert.equal(done.message.text, "Ramen at 8?");
    assert.equal(typeof done.message.editedAt, "number");
    const stored = db.prepare("SELECT body, edited_at FROM messages WHERE id = ?").get(sent.id) as { body: string; edited_at: number };
    assert.equal(stored.body, "Ramen at 8?");
    assert.equal(stored.edited_at, done.message.editedAt);

    const mine = (await lines(port, ada)).find((item) => item.id === sent.id)!;
    assert.equal(mine.text, "Ramen at 8?");
    assert.equal(mine.editedAt, done.message.editedAt);
    const theirs = (await lines(port, alex)).find((item) => item.id === sent.id)!;
    assert.equal(theirs.canEdit, false, "Alex cannot edit Ada's message");
  });
});

test("a second member sees the new text and the edited mark on the next fetch, and a plain message has no mark", async () => {
  await withChat(async ({ port }) => {
    const [alex, ada] = await circleOf(port, ["Alex", "Ada"]);
    const first = await say(port, ada, "Coffee soon");
    const other = await say(port, ada, "Untouched");
    await edit(port, ada, first.id, "Coffee at noon", 200);
    const seen = await lines(port, alex);
    const changed = seen.find((item) => item.id === first.id)!;
    assert.equal(changed.text, "Coffee at noon");
    assert.equal(typeof changed.editedAt, "number");
    assert.equal(seen.find((item) => item.id === other.id)!.editedAt, null);
  });
});

test("editing works in an event chat too", async () => {
  await withChat(async ({ port }) => {
    const [alex, ada] = await circleOf(port, ["Alex", "Ada"]);
    const social = await api(port, "POST", "/api/socials", { token: alex.token, body: { note: "Coffee" }, status: 201 });
    const path = `/api/socials/${social.social.id}/chat`;
    await api(port, "POST", `/api/socials/${social.social.id}/reply`, { token: ada.token, body: { reply: "in" }, status: 200 });
    const sent = await say(port, ada, "on my way", path);
    await edit(port, ada, sent.id, "running late", 200);
    const seen = (await lines(port, alex, path)).find((item) => item.id === sent.id)!;
    assert.equal(seen.text, "running late");
    assert.equal(typeof seen.editedAt, "number");
  });
});

test("another member, an event host and a circle admin all get 403 and the body stays", async () => {
  await withChat(async ({ port, db }) => {
    const [alex, ada, bea] = await circleOf(port, ["Alex", "Ada", "Bea"]);
    // Alex created the circle, so Alex is its admin and can delete Ada's circle messages.
    const inCircle = await say(port, ada, "circle words");
    assert.equal((await lines(port, alex)).find((item) => item.id === inCircle.id)!.canDelete, true);
    await edit(port, alex, inCircle.id, "hijacked", 403);
    await edit(port, bea, inCircle.id, "hijacked", 403);

    // Alex hosts the event, so Alex can delete Ada's message there too.
    const social = await api(port, "POST", "/api/socials", { token: alex.token, body: { note: "Coffee" }, status: 201 });
    const path = `/api/socials/${social.social.id}/chat`;
    await api(port, "POST", `/api/socials/${social.social.id}/reply`, { token: ada.token, body: { reply: "in" }, status: 200 });
    const inEvent = await say(port, ada, "event words", path);
    assert.equal((await lines(port, alex, path)).find((item) => item.id === inEvent.id)!.canDelete, true);
    const denied = await edit(port, alex, inEvent.id, "hijacked", 403);
    assert.equal(denied.error, "You can't edit that.");

    for (const [id, body] of [[inCircle.id, "circle words"], [inEvent.id, "event words"]]) {
      const row = db.prepare("SELECT body, edited_at FROM messages WHERE id = ?").get(id) as { body: string; edited_at: number | null };
      assert.equal(row.body, body);
      assert.equal(row.edited_at, null);
    }
  });
});

test("a missing, deleted or unseen message is a 404", async () => {
  await withChat(async ({ port }) => {
    const [, ada] = await circleOf(port, ["Alex", "Ada"]);
    const outsider: Person = await api(port, "POST", "/api/auth/start", { body: { email: testEmail(), name: "Out" }, status: 201 });
    await api(port, "POST", "/api/circles", { token: outsider.token, body: { name: "other" }, status: 201 });
    const sent = await say(port, ada, "to be removed");
    await edit(port, ada, "no-such-message", "x", 404);
    await edit(port, outsider, sent.id, "x", 404);
    await api(port, "DELETE", `/api/messages/${sent.id}`, { token: ada.token, status: 204 });
    await edit(port, ada, sent.id, "back again", 404);
  });
});

test("system lines, Goblin replies and GIFs cannot be edited", async () => {
  await withChat(async ({ port, db }) => {
    const [alex, ada] = await circleOf(port, ["Alex", "Ada"]);
    const social = await api(port, "POST", "/api/socials", { token: alex.token, body: { note: "Coffee" }, status: 201 });
    const path = `/api/socials/${social.social.id}/chat`;
    await api(port, "POST", `/api/socials/${social.social.id}/reply`, { token: ada.token, body: { reply: "in" }, status: 200 });
    await say(port, ada, "@Goblin the tabs flicker", path);
    const seen = await lines(port, ada, path);
    const system = seen.find((item) => item.system)!;
    const goblin = seen.find((item) => item.goblin)!;
    assert.equal(system.canEdit, false);
    assert.equal(goblin.canEdit, false);
    await edit(port, ada, system.id, "x", 403);
    await edit(port, ada, goblin.id, "x", 403);
    await edit(port, alex, system.id, "x", 403);

    db.prepare("UPDATE messages SET kind = 'gif' WHERE id = ?").run((seen.find((item) => item.text === "@Goblin the tabs flicker")!).id);
    await edit(port, ada, (seen.find((item) => item.text === "@Goblin the tabs flicker")!).id, "x", 403);
  });
});

test("an empty, blank, too long or non-text edit is a 400 and the message is left alone", async () => {
  await withChat(async ({ port, db }) => {
    const [, ada] = await circleOf(port, ["Alex", "Ada"]);
    const sent = await say(port, ada, "keep me");
    const blank = await edit(port, ada, sent.id, "   ", 400);
    assert.equal(blank.error, "Write a message.");
    await edit(port, ada, sent.id, 42, 400);
    await edit(port, ada, sent.id, undefined, 400);
    const long = await edit(port, ada, sent.id, "a".repeat(1001), 400);
    assert.equal(long.error, "Keep it under 1000 characters.");
    const row = db.prepare("SELECT body, edited_at FROM messages WHERE id = ?").get(sent.id) as { body: string; edited_at: number | null };
    assert.deepEqual({ ...row }, { body: "keep me", edited_at: null });
  });
});
