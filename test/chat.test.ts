import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { flushChatNotices, nextChatPushDelay, CHAT_BATCH_MS, CHAT_GAP_MS } from "../src/chat.js";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import type { PushPayload, PushSender } from "../src/push.js";

const START = Date.parse("2026-06-01T15:00:00.000Z");

async function withApp(fn: (ctx: { port: number; db: DatabaseSync; sent: PushPayload[]; at: (ms: number) => void }) => Promise<void>) {
  const sent: PushPayload[] = [];
  let now = START;
  const db = openDb(":memory:");
  const push: PushSender = { async send(_sub, payload) { sent.push(payload); } };
  const config = loadConfig({ PORT: "3000", APP_TZ: "UTC", DB_PATH: ":memory:" });
  const server = http.createServer(createApp({ db, push, config: { ...config, dbPath: ":memory:" }, now: () => now }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn({ port, db, sent, at(ms) { now = ms; } });
  } finally {
    await flushChatNotices(true);
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
}

async function api(port: number, method: string, pathname: string, options: { token?: string; body?: unknown; status?: number } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: {
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (options.status !== undefined && response.status !== options.status) {
    throw new Error(`${method} ${pathname} -> ${response.status} ${text}`);
  }
  return json;
}

test("chat pushes wait out a burst, then a quiet gap", () => {
  assert.equal(nextChatPushDelay(0, 1_000), CHAT_BATCH_MS);
  assert.equal(nextChatPushDelay(1_000, 1_000 + 10_000), CHAT_GAP_MS - 10_000);
  assert.equal(nextChatPushDelay(1_000, 1_000 + CHAT_GAP_MS), CHAT_BATCH_MS);
});

test("circle members can chat on an event, and a removed person cannot post", async () => {
  await withApp(async ({ port, db, at }) => {
    const alex = await api(port, "POST", "/api/auth/start", { body: { name: "Alex" }, status: 201 });
    const created = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "friends" }, status: 201 });
    const sam = await api(port, "POST", "/api/auth/start", { body: { name: "Sam", code: created.circle.inviteCode }, status: 201 });
    const nia = await api(port, "POST", "/api/auth/start", { body: { name: "Nia", code: created.circle.inviteCode }, status: 201 });
    const outsider = await api(port, "POST", "/api/auth/start", { body: { name: "Out" }, status: 201 });
    await api(port, "POST", "/api/circles", { token: outsider.token, body: { name: "other" }, status: 201 });
    for (const person of [alex, sam, nia]) {
      await api(port, "POST", "/api/push/subscribe", {
        token: person.token,
        body: { endpoint: `https://push.example/${person.user.id}`, keys: { p256dh: "p", auth: "a" } },
        status: 204,
      });
    }
    const social = await api(port, "POST", "/api/socials", { token: alex.token, body: { note: "Coffee" }, status: 201 });
    await api(port, "POST", `/api/socials/${social.social.id}/reply`, { token: sam.token, body: { reply: "in", arriveAt: "16:00" }, status: 200 });
    const thread = await api(port, "GET", `/api/socials/${social.social.id}/chat`, { token: alex.token });
    assert.equal(thread.chat.title, "Coffee");
    assert.equal(thread.chat.closed, false);
    assert.equal(thread.chat.messages.at(-1).text, "Sam is in, arriving 16:00");
    assert.equal(thread.chat.messages.at(-1).system, true);

    const empty = await api(port, "POST", `/api/socials/${social.social.id}/chat`, { token: sam.token, body: { text: "  " }, status: 400 });
    assert.equal(empty.error, "Write a message.");
    const long = await api(port, "POST", `/api/socials/${social.social.id}/chat`, { token: sam.token, body: { text: "a".repeat(1001) }, status: 400 });
    assert.equal(long.error, "Keep it under 1000 characters.");
    await api(port, "POST", `/api/socials/${social.social.id}/chat`, { token: outsider.token, body: { text: "nope" }, status: 404 });

    at(START + 1000);
    const posted = await api(port, "POST", `/api/socials/${social.social.id}/chat`, { token: sam.token, body: { text: "On my way" }, status: 201 });
    assert.equal(posted.chat.messages.at(-1).text, "On my way");
    assert.equal(posted.chat.messages.at(-1).name, "Sam");
    const seen = await api(port, "GET", `/api/socials/${social.social.id}/chat`, { token: nia.token });
    assert.equal(seen.chat.messages.some((message: { text: string }) => message.text === "On my way"), true);
    const unread = await api(port, "GET", "/api/chats", { token: alex.token });
    assert.equal(unread.events.find((row: { id: string }) => row.id === social.social.id).unread, 1);
    await api(port, "GET", `/api/socials/${social.social.id}/chat`, { token: alex.token });
    const cleared = await api(port, "GET", "/api/chats", { token: alex.token });
    assert.equal(cleared.events.find((row: { id: string }) => row.id === social.social.id).unread, 0);

    const own = posted.chat.messages.at(-1).id;
    await api(port, "DELETE", `/api/messages/${own}`, { token: nia.token, status: 403 });
    await api(port, "DELETE", `/api/messages/${own}`, { token: sam.token, status: 204 });

    const niaMsg = await api(port, "POST", `/api/socials/${social.social.id}/chat`, { token: nia.token, body: { text: "Save me a seat" }, status: 201 });
    await api(port, "DELETE", `/api/messages/${niaMsg.chat.messages.at(-1).id}`, { token: alex.token, status: 204 });

    await api(port, "POST", "/api/circles/chat", { token: sam.token, body: { text: "Hello" }, status: 201 });
    await api(port, "POST", "/api/circles/chat", { token: sam.token, body: { text: "Again" }, status: 201 });
    const circle = await api(port, "GET", "/api/circles/chat", { token: nia.token });
    await api(port, "POST", `/api/chats/${circle.chat.id}/mute`, { token: nia.token, body: { muted: true }, status: 204 });
    await flushChatNotices(true);
    const notes = db.prepare("SELECT user_id, title, body FROM notifications WHERE kind = 'chat'").all() as Array<{ user_id: string; title: string; body: string }>;
    assert.equal(notes.some((note) => note.user_id === nia.user.id && note.title === "Circle chat"), false);
    assert.equal(notes.some((note) => note.user_id === alex.user.id && note.title === "Circle chat" && note.body === "2 new messages"), true);
    const circleMsg = circle.chat.messages.find((message: { text: string }) => message.text === "Hello");
    await api(port, "DELETE", `/api/messages/${circleMsg.id}`, { token: nia.token, status: 403 });
    await api(port, "POST", `/api/circles/members/${nia.user.id}`, { token: alex.token, body: { admin: true }, status: 200 });
    await api(port, "DELETE", `/api/messages/${circleMsg.id}`, { token: nia.token, status: 204 });

    await api(port, "POST", `/api/socials/${social.social.id}/reply`, { token: nia.token, body: { reply: "in" }, status: 200 });
    await api(port, "DELETE", `/api/socials/${social.social.id}/people/${nia.user.id}`, { token: alex.token, status: 204 });
    const removed = await api(port, "GET", `/api/socials/${social.social.id}/chat`, { token: nia.token });
    assert.equal(removed.chat.messages.some((message: { text: string }) => message.text === "Alex removed Nia"), true);
    const blocked = await api(port, "POST", `/api/socials/${social.social.id}/chat`, { token: nia.token, body: { text: "still here" }, status: 403 });
    assert.equal(blocked.error, "The host removed you from this.");

    await api(port, "DELETE", `/api/socials/${social.social.id}`, { token: alex.token, status: 204 });
    const closed = await api(port, "GET", `/api/socials/${social.social.id}/chat`, { token: sam.token });
    assert.equal(closed.chat.closed, true);
    assert.equal(closed.chat.messages.some((message: { text: string }) => message.text === "On my way"), false);
    const denied = await api(port, "POST", `/api/socials/${social.social.id}/chat`, { token: sam.token, body: { text: "too late" }, status: 403 });
    assert.equal(denied.error, "This chat is closed.");

    const plan = await api(port, "POST", "/api/plans", { token: alex.token, body: { note: "Dinner" }, status: 201 });
    await api(port, "POST", `/api/plans/${plan.plan.id}/reply`, { token: sam.token, body: { reply: "can't" }, status: 200 });
    const planChat = await api(port, "GET", `/api/plans/${plan.plan.id}/chat`, { token: alex.token });
    assert.equal(planChat.chat.messages.at(-1).text, "Sam can't make it");
    await api(port, "POST", `/api/plans/${plan.plan.id}/chat`, { token: sam.token, body: { text: "Next week?" }, status: 201 });
  });
});
