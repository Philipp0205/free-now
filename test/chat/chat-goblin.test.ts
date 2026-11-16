import assert from "node:assert/strict";
import test from "node:test";
import { flushChatNotices } from "../../src/chat/chat.js";
import { FEEDBACK_LIMIT } from "../../src/admin/feedback.js";
import { GOBLIN_LINES, gripeText } from "../../src/chat/goblin.js";
import { api, withApp, type AppCtx, type SentPush, testEmail } from "../http.js";

// Fake people only. Push goes to a recorder, the db is in memory.
// The Goblin's lines are random, so these tests check a reply against its list, never one line.

const ADMIN = "a".repeat(32);

function withChat(fn: (ctx: AppCtx<SentPush>) => Promise<void>) {
  return withApp(async (ctx) => {
    try {
      await fn(ctx);
    } finally {
      await flushChatNotices(true);
    }
  }, { sent: "envelope", env: { ADMIN_TOKEN: ADMIN } });
}

type Person = { token: string; user: { id: string; name: string } };
type Message = { id: string; name: string; text: string; goblin: boolean; mine: boolean; system: boolean; color: string | null; canDelete: boolean };

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
  return { people, circleId: created.circle.id as string };
}

const say = (port: number, person: Person, text: string, extra: Record<string, unknown> = {}, path = "/api/circles/chat") =>
  api(port, "POST", path, { token: person.token, body: { text, ...extra }, status: 201 });

const feedbackList = async (port: number) => (await api(port, "GET", "/api/admin/feedback", { token: ADMIN, status: 200 })).feedback as Array<{
  userName: string; circleName: string | null; circleId: string | null; appVersion: string | null; text: string; userId: string;
}>;

const goblinReplies = (chat: { messages: Message[] }) => chat.messages.filter((message) => message.goblin);

test("@Goblin and @goblin file the gripe as feedback and the Goblin answers in the thread", async () => {
  await withChat(async ({ port }) => {
    const { people: [alex], circleId } = await circleOf(port, ["Alex"]);
    const first = await say(port, alex, "@Goblin the map pins overlap", { appVersion: "hangry-v103" });
    const second = await say(port, alex, "the keyboard hides the send button @goblin", { appVersion: "hangry-v103" });

    const list = await feedbackList(port);
    assert.deepEqual(
      list.map((row) => [row.userName, row.circleName, row.circleId, row.appVersion, row.text, row.userId]).reverse(),
      [
        ["Alex", "friends", circleId, "hangry-v103", "the map pins overlap", alex.user.id],
        ["Alex", "friends", circleId, "hangry-v103", "the keyboard hides the send button", alex.user.id],
      ],
    );

    for (const chat of [first.chat, second.chat]) {
      const replies = goblinReplies(chat);
      assert.equal(replies.length, chat === first.chat ? 1 : 2);
      const last = chat.messages.at(-1) as Message;
      assert.equal(last.goblin, true);
      assert.equal(last.name, "Goblin");
      assert.equal(last.mine, false, "never the sender's");
      assert.equal(last.system, false);
      assert.equal(last.canDelete, false);
      assert.ok((GOBLIN_LINES.received as readonly string[]).includes(last.text), last.text);
      assert.ok(last.color);
    }
    // The sender's own message stays, as written, and comes first.
    const texts = second.chat.messages.map((message: Message) => [message.name, message.goblin]);
    assert.deepEqual(texts.slice(0, 2), [["Alex", false], ["Goblin", true]]);
    assert.equal(second.chat.messages[0].text, "@Goblin the map pins overlap");
    // A later read shows the same thread.
    const again = await api(port, "GET", "/api/circles/chat", { token: alex.token, status: 200 });
    assert.deepEqual(goblinReplies(again.chat).map((m) => m.name), ["Goblin", "Goblin"]);
  });
});

test("the Goblin works in event chats too, filed under the sender's circle", async () => {
  await withChat(async ({ port }) => {
    const { people: [alex] , circleId } = await circleOf(port, ["Alex"]);
    const social = await api(port, "POST", "/api/socials", { token: alex.token, body: { note: "Dinner" }, status: 201 });
    const posted = await say(port, alex, "@Goblin dinner card is cramped", { appVersion: "hangry-v103" }, `/api/socials/${social.social.id}/chat`);
    const last = posted.chat.messages.at(-1) as Message;
    assert.equal(last.goblin, true);
    assert.ok((GOBLIN_LINES.received as readonly string[]).includes(last.text));
    const [row] = await feedbackList(port);
    assert.equal(row.text, "dinner card is cramped");
    assert.equal(row.circleId, circleId);
  });
});

test("no push or alert goes to anyone for a Goblin mention, even with a normal mention beside it", async () => {
  await withChat(async ({ port, db, sent }) => {
    const { people: [alex, ada, nia] } = await circleOf(port, ["Alex", "Ada", "Nia"]);
    sent.length = 0;
    await say(port, alex, "@Goblin the tabs flicker");
    await flushChatNotices(true);
    assert.deepEqual(sent, [], "no push for anyone");
    const alerts = db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'chat'").get() as { n: number };
    assert.equal(Number(alerts.n), 0);

    // Naming the Goblin and Ada: Ada still gets her mention ping, nothing else is sent.
    await say(port, alex, "@Goblin and @Ada the tabs flicker");
    await flushChatNotices(true);
    const tags = sent.map((item) => `${item.endpoint.includes(ada.user.id) ? "ada" : item.endpoint.includes(nia.user.id) ? "nia" : "other"}:${item.payload.tag.split(":")[0]}`);
    assert.deepEqual(tags, ["ada:chat-mention"]);
    assert.equal(sent.some((item) => item.endpoint.includes(alex.user.id)), false);
  });
});

test("a normal @Member mention still pings as before", async () => {
  await withChat(async ({ port, sent }) => {
    const { people: [alex, ada, nia] } = await circleOf(port, ["Alex", "Ada", "Nia"]);
    sent.length = 0;
    await say(port, alex, "@Ada hello");
    const pinged = sent.filter((item) => item.endpoint.includes(ada.user.id) && item.payload.tag.startsWith("chat-mention:"));
    assert.equal(pinged.length, 1);
    await flushChatNotices(true);
    assert.deepEqual(
      sent.filter((item) => item.endpoint.includes(nia.user.id)).map((item) => item.payload.body),
      ["Alex: @Ada hello"],
      "the batched notice for everyone else is unchanged",
    );
  });
});

test("an empty mention stores nothing and the Goblin asks what is wrong", async () => {
  await withChat(async ({ port }) => {
    const { people: [alex] } = await circleOf(port, ["Alex"]);
    for (const text of ["@Goblin", "  @goblin  ", "@Goblin @goblin"]) {
      const posted = await say(port, alex, text);
      const last = posted.chat.messages.at(-1) as Message;
      assert.equal(last.goblin, true, text);
      assert.ok((GOBLIN_LINES.empty as readonly string[]).includes(last.text), last.text);
    }
    assert.deepEqual(await feedbackList(port), []);
  });
});

test("the Goblin is full once the feedback limit is hit, and stores nothing more", async () => {
  await withChat(async ({ port }) => {
    const { people: [alex] } = await circleOf(port, ["Alex"]);
    for (let i = 0; i < FEEDBACK_LIMIT.limit; i += 1) {
      const posted = await say(port, alex, `@Goblin gripe ${i}`);
      assert.ok((GOBLIN_LINES.received as readonly string[]).includes((posted.chat.messages.at(-1) as Message).text));
    }
    const over = await say(port, alex, "@Goblin one gripe too many");
    const last = over.chat.messages.at(-1) as Message;
    assert.equal(last.goblin, true);
    assert.ok((GOBLIN_LINES.full as readonly string[]).includes(last.text), last.text);
    const list = await feedbackList(port);
    assert.equal(list.length, FEEDBACK_LIMIT.limit);
    assert.ok(!list.some((row) => row.text.includes("too many")));
    // The form shares the limiter, so it is full as well.
    await api(port, "POST", "/api/feedback", { token: alex.token, body: { text: "form gripe" }, status: 429 });
  });
});

test("an empty mention does not use up the limiter", async () => {
  await withChat(async ({ port }) => {
    const { people: [alex] } = await circleOf(port, ["Alex"]);
    for (let i = 0; i < FEEDBACK_LIMIT.limit + 2; i += 1) await say(port, alex, "@Goblin");
    const posted = await say(port, alex, "@Goblin still hungry");
    assert.ok((GOBLIN_LINES.received as readonly string[]).includes((posted.chat.messages.at(-1) as Message).text));
  });
});

test("the Goblin is not a participant, a member, or an unread message", async () => {
  await withChat(async ({ port, db }) => {
    const { people: [alex, ada], circleId } = await circleOf(port, ["Alex", "Ada"]);
    const posted = await say(port, alex, "@Goblin the header is too tall");
    assert.deepEqual(posted.chat.participants.map((person: { name: string }) => person.name).sort(), ["Ada", "Alex"]);
    const circle = await api(port, "GET", "/api/me", { token: alex.token, status: 200 });
    assert.deepEqual(circle.circle.members.map((member: { name: string }) => member.name).sort(), ["Ada", "Alex"]);
    assert.equal(Number((db.prepare("SELECT COUNT(*) AS n FROM users WHERE name LIKE '%oblin%'").get() as { n: number }).n), 0);
    assert.equal(Number((db.prepare("SELECT COUNT(*) AS n FROM memberships WHERE circle_id = ?").get(circleId) as { n: number }).n), 2);

    // Ada sees only Alex's message as unread, not the reply, and after reading nothing is unread.
    const summary = await api(port, "GET", `/api/chats?circle=${circleId}`, { token: ada.token, status: 200 });
    assert.equal(summary.circle.unread, 1);
    // Alex wrote the gripe, so the reply stored under his id is not unread for him either.
    const mine = await api(port, "GET", `/api/chats?circle=${circleId}`, { token: alex.token, status: 200 });
    assert.equal(mine.circle.unread, 0);
    await api(port, "GET", "/api/circles/chat", { token: ada.token, status: 200 });
    const after = await api(port, "GET", `/api/chats?circle=${circleId}`, { token: ada.token, status: 200 });
    assert.equal(after.circle.unread, 0);
  });
});

test("the Goblin's reply is not a writer and cannot be reacted to, replied to or deleted", async () => {
  await withChat(async ({ port }) => {
    const { people: [alex, ada] } = await circleOf(port, ["Alex", "Ada", "Nia"]);
    // A social chat: only the host and people coming (and writers) are in its audience. Nia is not.
    const social = await api(port, "POST", "/api/socials", { token: alex.token, body: { note: "Dinner" }, status: 201 });
    const path = `/api/socials/${social.social.id}/chat`;
    await api(port, "POST", `/api/socials/${social.social.id}/reply`, { token: ada.token, body: { reply: "in" }, status: 200 });

    const before = await api(port, "GET", path, { token: alex.token, status: 200 });
    assert.deepEqual(before.chat.participants.map((person: { name: string }) => person.name).sort(), ["Ada", "Alex"]);
    const posted = await say(port, alex, "@Goblin the dinner chip is tiny", {}, path);
    assert.deepEqual(posted.chat.participants.map((person: { name: string }) => person.name).sort(), ["Ada", "Alex"]);
    const reply = posted.chat.messages.at(-1) as Message;
    assert.equal(reply.goblin, true);

    await api(port, "POST", `/api/messages/${reply.id}/reactions`, { token: alex.token, body: { emoji: "👍" }, status: 400 });
    await api(port, "POST", path, { token: alex.token, body: { text: "ok", replyTo: reply.id }, status: 400 });
    await api(port, "DELETE", `/api/messages/${reply.id}`, { token: alex.token, status: 403 });
  });
});

test("a Goblin reply does not become the chat's preview author", async () => {
  await withChat(async ({ port }) => {
    const { people: [alex, ada], circleId } = await circleOf(port, ["Alex", "Ada"]);
    const social = await api(port, "POST", "/api/socials", { token: alex.token, body: { note: "Dinner" }, status: 201 });
    await say(port, alex, "@Goblin the chip is tiny", {}, `/api/socials/${social.social.id}/chat`);
    const summary = await api(port, "GET", `/api/chats?circle=${circleId}`, { token: ada.token, status: 200 });
    const row = summary.events.find((item: { id: string }) => item.id === social.social.id);
    assert.equal(row.previewBy, "Goblin");
    assert.ok((GOBLIN_LINES.received as readonly string[]).includes(row.preview));
    assert.equal(row.unread, 1, "only Alex's own line counts, never the reply");
  });
});

test("the mention follows the same word-boundary rule as other mentions", async () => {
  await withChat(async ({ port }) => {
    const { people: [alex] } = await circleOf(port, ["Alex"]);
    for (const text of ["mail@goblin.test is down", "@Goblins are real", "hello Goblin"]) {
      const posted = await say(port, alex, text);
      assert.equal(goblinReplies(posted.chat).length, 0, text);
    }
    assert.deepEqual(await feedbackList(port), []);
    assert.equal(gripeText("@Goblin hi", [{ start: 0, end: 7 }]), "hi");
    assert.equal(gripeText("the map @Goblin pins", [{ start: 8, end: 15 }]), "the map pins");
    assert.equal(gripeText("@Goblin, the map", [{ start: 0, end: 7 }]), "the map");
  });
});

test("the Goblin's lists are non-empty, short and free of em dashes", () => {
  for (const [kind, lines] of Object.entries(GOBLIN_LINES)) {
    assert.ok(lines.length >= 2, kind);
    for (const line of lines) {
      assert.ok(line.length <= 80, line);
      assert.ok(!line.includes("\u2014"), line);
      assert.ok(!/gripe\s+goblin/i.test(line), line);
    }
  }
  assert.ok(GOBLIN_LINES.received.length >= 8);
  assert.ok(GOBLIN_LINES.received.includes("*clanking away* 🔨 got it, the goblin is on it"));
  assert.ok(GOBLIN_LINES.received.includes("Gripe swallowed. Digesting into a fix..."));
  assert.ok(GOBLIN_LINES.received.some((line) => line.includes("clanking away")));
});
