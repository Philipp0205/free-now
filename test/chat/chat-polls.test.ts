import assert from "node:assert/strict";
import test from "node:test";
import { flushChatNotices } from "../../src/chat/chat.js";
import { api, withApp, type AppCtx, type SentPush, testEmail } from "../http.js";

// Fake people only. Push goes to a recorder, the db is in memory.

type Person = { token: string; user: { id: string; name: string } };
type PollOption = { index: number; text: string; count: number; names: string[]; mine: boolean };
type Line = { id: string; text: string; poll: { question: string; options: PollOption[]; total: number; mine: number | null } | null };

const POLL = { question: "Where to?", options: ["Ramen", "Tacos", "Pizza"] };

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

/** A social hosted by the first person, with the second one marked as coming. Returns the chat path. */
async function socialChat(port: number, host: Person, guests: Person[]): Promise<string> {
  const social = await api(port, "POST", "/api/socials", { token: host.token, body: { note: "Dinner" }, status: 201 });
  for (const guest of guests) await api(port, "POST", `/api/socials/${social.social.id}/reply`, { token: guest.token, body: { reply: "in" }, status: 200 });
  return `/api/socials/${social.social.id}/chat`;
}

async function planChat(port: number, host: Person, guests: Person[]): Promise<string> {
  const plan = await api(port, "POST", "/api/plans", { token: host.token, body: { note: "Dinner" }, status: 201 });
  for (const guest of guests) await api(port, "POST", `/api/plans/${plan.plan.id}/reply`, { token: guest.token, body: { reply: "in" }, status: 200 });
  return `/api/plans/${plan.plan.id}/chat`;
}

const startPoll = async (port: number, person: Person, path: string, poll: unknown = POLL, status = 201): Promise<any> =>
  api(port, "POST", path, { token: person.token, body: { poll }, status });

const pollOf = async (port: number, person: Person, path: string): Promise<NonNullable<Line["poll"]> & { id: string }> => {
  const lines: Line[] = (await api(port, "GET", path, { token: person.token })).chat.messages;
  const line = lines.find((item) => item.poll)!;
  return { ...line.poll!, id: line.id };
};

const vote = (port: number, person: Person, id: string, choice: unknown, status = 200) =>
  api(port, "POST", `/api/messages/${id}/vote`, { token: person.token, body: { choice }, status });

const counts = (poll: { options: PollOption[] }) => poll.options.map((option) => option.count);

for (const [label, make] of [["social", socialChat], ["plan", planChat]] as const) {
  test(`a participant creates a poll in a ${label} chat and the thread shows it with zero counts`, async () => {
    await withChat(async ({ port }) => {
      const [alex, ada] = await circleOf(port, ["Alex", "Ada"]);
      const path = await make(port, alex, [ada]);
      const made = await startPoll(port, ada, path, { question: "  Where   to?  ", options: ["Ramen ", " Tacos", "Pizza"] });
      const line: Line = made.chat.messages.at(-1);
      assert.equal(line.poll?.question, "Where to?");
      assert.deepEqual(line.poll?.options.map((option) => option.text), ["Ramen", "Tacos", "Pizza"]);
      assert.deepEqual(counts(line.poll!), [0, 0, 0]);
      assert.deepEqual(line.poll?.options.map((option) => option.names), [[], [], []]);
      assert.equal(line.poll?.total, 0);
      assert.equal(line.poll?.mine, null);
      assert.equal(line.text, "Poll: Where to?");

      const seen = await pollOf(port, alex, path);
      assert.deepEqual(counts(seen), [0, 0, 0]);
      assert.equal(seen.mine, null);
    });
  });
}

test("a second participant votes and a later GET by either person shows counts and names", async () => {
  await withChat(async ({ port }) => {
    const [alex, ada, nia] = await circleOf(port, ["Alex", "Ada", "Nia"]);
    const path = await socialChat(port, alex, [ada, nia]);
    await startPoll(port, alex, path);
    const { id } = await pollOf(port, alex, path);

    const first = await vote(port, ada, id, 1);
    assert.equal(first.messageId, id);
    assert.deepEqual(counts(first.poll), [0, 1, 0]);
    assert.equal(first.poll.mine, 1);
    await vote(port, nia, id, 1);
    await vote(port, alex, id, 0);

    const forAda = await pollOf(port, ada, path);
    assert.deepEqual(counts(forAda), [1, 2, 0]);
    assert.deepEqual(forAda.options[1].names, ["Ada", "Nia"]);
    assert.deepEqual(forAda.options[0].names, ["Alex"]);
    assert.equal(forAda.mine, 1);
    assert.equal(forAda.options[1].mine, true);
    assert.equal(forAda.options[0].mine, false);
    assert.equal(forAda.total, 3);

    const forAlex = await pollOf(port, alex, path);
    assert.deepEqual(counts(forAlex), [1, 2, 0]);
    assert.equal(forAlex.mine, 0);
  });
});

test("the same voter changes their vote: the old option loses a count and the new one gains it", async () => {
  await withChat(async ({ port, db }) => {
    const [alex, ada] = await circleOf(port, ["Alex", "Ada"]);
    const path = await planChat(port, alex, [ada]);
    await startPoll(port, alex, path);
    const { id } = await pollOf(port, alex, path);

    await vote(port, ada, id, 0);
    const moved = await vote(port, ada, id, 2);
    assert.deepEqual(counts(moved.poll), [0, 0, 1]);
    assert.equal(moved.poll.mine, 2);
    const again = await vote(port, ada, id, 2);
    assert.deepEqual(counts(again.poll), [0, 0, 1]);

    const seen = await pollOf(port, alex, path);
    assert.deepEqual(counts(seen), [0, 0, 1]);
    assert.deepEqual(seen.options[2].names, ["Ada"]);
    assert.deepEqual(seen.options[0].names, []);
    const rows = db.prepare("SELECT choice FROM poll_votes WHERE message_id = ?").all(id) as Array<{ choice: number }>;
    assert.equal(rows.length, 1, "one row per voter");
  });
});

test("a circle member who is not in the event cannot vote or start a poll", async () => {
  await withChat(async ({ port }) => {
    const [alex, ada, bea] = await circleOf(port, ["Alex", "Ada", "Bea"]);
    const path = await socialChat(port, alex, [ada]);
    await startPoll(port, alex, path);
    const { id } = await pollOf(port, alex, path);

    const denied = await vote(port, bea, id, 0, 403);
    assert.equal(denied.error, "You can't vote in this chat.");
    await startPoll(port, bea, path, POLL, 403);
    const seen = await pollOf(port, alex, path);
    assert.deepEqual(counts(seen), [0, 0, 0]);
  });
});

test("someone outside the circle gets a 404 for a poll, and a bad choice or a text message is a 400", async () => {
  await withChat(async ({ port }) => {
    const [alex, ada] = await circleOf(port, ["Alex", "Ada"]);
    const outsider: Person = await api(port, "POST", "/api/auth/start", { body: { email: testEmail(), name: "Out" }, status: 201 });
    await api(port, "POST", "/api/circles", { token: outsider.token, body: { name: "other" }, status: 201 });
    const path = await socialChat(port, alex, [ada]);
    await startPoll(port, alex, path);
    const { id } = await pollOf(port, alex, path);
    await vote(port, outsider, id, 0, 404);
    await vote(port, ada, "no-such-message", 0, 404);

    for (const bad of [3, -1, 1.5, "1", null, undefined]) await vote(port, ada, id, bad, 400);
    const text = await api(port, "POST", path, { token: ada.token, body: { text: "hello" }, status: 201 });
    await vote(port, ada, text.chat.messages.at(-1).id, 0, 400);
    assert.deepEqual(counts(await pollOf(port, alex, path)), [0, 0, 0]);
  });
});

test("the circle chat takes no polls", async () => {
  await withChat(async ({ port }) => {
    const [alex] = await circleOf(port, ["Alex"]);
    const refused = await startPoll(port, alex, "/api/circles/chat", POLL, 400);
    assert.equal(refused.error, "Polls are for event chats.");
    const thread = await api(port, "GET", "/api/circles/chat", { token: alex.token });
    assert.deepEqual(thread.chat.messages, []);
  });
});

test("a poll needs a question and 2 to 6 non-blank options", async () => {
  await withChat(async ({ port }) => {
    const [alex] = await circleOf(port, ["Alex"]);
    const path = await socialChat(port, alex, []);
    const six = ["a", "b", "c", "d", "e", "f"];
    const bad: unknown[] = [
      { question: "Q?", options: ["only one"] },
      { question: "Q?", options: [] },
      { question: "Q?", options: [...six, "g"] },
      { question: "", options: ["a", "b"] },
      { question: "   ", options: ["a", "b"] },
      { options: ["a", "b"] },
      { question: "Q?", options: ["a", "  "] },
      { question: "Q?", options: ["a", 7] },
      { question: "Q?", options: "a,b" },
      { question: "x".repeat(201), options: ["a", "b"] },
      { question: "Q?", options: ["a", "x".repeat(81)] },
      "Q?",
      ["a", "b"],
    ];
    for (const poll of bad) await startPoll(port, alex, path, poll, 400);
    const empty = (await api(port, "GET", path, { token: alex.token })).chat.messages.filter((item: Line) => item.poll);
    assert.equal(empty.length, 0, "nothing was stored");

    const two = await startPoll(port, alex, path, { question: "Q?", options: ["a", "b"] });
    assert.equal(two.chat.messages.at(-1).poll.options.length, 2);
    const max = await startPoll(port, alex, path, { question: "Q?", options: six });
    assert.equal(max.chat.messages.at(-1).poll.options.length, 6);
  });
});

test("a closed event chat takes no new poll", async () => {
  await withChat(async ({ port }) => {
    const [alex, ada] = await circleOf(port, ["Alex", "Ada"]);
    const social = await api(port, "POST", "/api/socials", { token: alex.token, body: { note: "Dinner" }, status: 201 });
    const path = `/api/socials/${social.social.id}/chat`;
    await api(port, "POST", `/api/socials/${social.social.id}/reply`, { token: ada.token, body: { reply: "in" }, status: 200 });
    await startPoll(port, alex, path);
    await api(port, "DELETE", `/api/socials/${social.social.id}`, { token: alex.token, status: 204 });
    const denied = await startPoll(port, ada, path, POLL, 403);
    assert.equal(denied.error, "This chat is closed.");
  });
});

test("a poll shows in the chat summary as its question, and a deleted poll leaves the thread", async () => {
  await withChat(async ({ port }) => {
    const [alex, ada] = await circleOf(port, ["Alex", "Ada"]);
    const path = await socialChat(port, alex, [ada]);
    await startPoll(port, ada, path);
    const summary = await api(port, "GET", "/api/chats", { token: alex.token });
    assert.equal(summary.events[0].preview, "Poll: Where to?");
    assert.equal(summary.events[0].previewBy, "Ada");
    const { id } = await pollOf(port, alex, path);
    await api(port, "DELETE", `/api/messages/${id}`, { token: ada.token, status: 204 });
    const after = (await api(port, "GET", path, { token: alex.token })).chat.messages.filter((item: Line) => item.poll);
    assert.equal(after.length, 0);
    await vote(port, ada, id, 0, 404);
  });
});
