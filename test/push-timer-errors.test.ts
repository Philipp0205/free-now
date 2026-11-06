import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { CHAT_BATCH_MS, flushChatNotices, postThread, type ChatDeps } from "../src/chat.js";
import { addMember, insertCircle, insertUser, openDb, upsertPushSub } from "../src/db.js";
import type { PushPayload, PushSender } from "../src/push.js";
import { REPLY_PUSH_WAIT_MS, scheduleReplyPush } from "../src/reply-push.js";
import { START } from "./http.js";

/** Collects unhandled rejections until the returned stop() is called. */
function watchRejections(): { seen: unknown[]; stop: () => void } {
  const seen: unknown[] = [];
  const onReject = (reason: unknown) => seen.push(reason);
  process.on("unhandledRejection", onReject);
  return { seen, stop: () => process.off("unhandledRejection", onReject) };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("a rejecting reply push is logged, not left unhandled", async (t: TestContext) => {
  const errors = t.mock.method(console, "error", () => {});
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const watch = watchRejections();
  try {
    scheduleReplyPush("test:reply", async () => {
      throw new Error("boom");
    });
    t.mock.timers.tick(REPLY_PUSH_WAIT_MS);
    await settle();
    await settle();
  } finally {
    watch.stop();
  }
  assert.deepEqual(watch.seen, []);
  assert.equal(errors.mock.callCount(), 1);
  assert.equal(errors.mock.calls[0].arguments[0], "reply push failed");
});

/** Two people in one circle, Bea subscribed. `fail` makes chat_mutes reads throw. */
function chatSetup() {
  const real = openDb(":memory:");
  const state = { fail: false, now: START };
  const db = new Proxy(real, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          if (state.fail && sql.includes("chat_mutes")) throw new Error("db down");
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as DatabaseSync;
  const sent: PushPayload[] = [];
  const push: PushSender = { async send(_sub, payload) { sent.push(payload); } };
  const deps: ChatDeps = { db, push, config: { tz: "UTC" }, now: () => state.now };
  const user = (name: string) => {
    const id = crypto.randomUUID();
    insertUser(real, { id, name, token_hash: crypto.randomUUID(), buzz_token: crypto.randomUUID(), created_at: START });
    return id;
  };
  const alex = user("Alex");
  const bea = user("Bea");
  const circleId = crypto.randomUUID();
  insertCircle(real, { id: circleId, name: "friends", invite_code: "TESTCODE", created_by: alex, created_at: START }, alex, START);
  addMember(real, circleId, bea, START);
  upsertPushSub(real, { id: crypto.randomUUID(), userId: bea, endpoint: "https://push.example/bea", p256dh: "p", auth: "a", createdAt: START });
  const post = (text: string) => postThread(deps, alex, "Alex", "circle", "", text);
  return { real, state, sent, post };
}

test("a chat slot that throws clears busy and can fire again", async (t: TestContext) => {
  t.mock.method(console, "error", () => {});
  const { real, state, sent, post } = chatSetup();
  try {
    await post("hi");
    state.fail = true;
    await assert.rejects(flushChatNotices(true), /db down/);
    state.fail = false;
    await flushChatNotices(true);
    assert.deepEqual(sent.map((item) => item.body), ["Alex: hi"]);
  } finally {
    state.fail = false;
    await flushChatNotices(true);
    real.close();
  }
});

test("a chat timer that throws is logged, not left unhandled", async (t: TestContext) => {
  const errors = t.mock.method(console, "error", () => {});
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { real, state, sent, post } = chatSetup();
  const watch = watchRejections();
  try {
    await post("hi");
    state.fail = true;
    state.now += CHAT_BATCH_MS;
    t.mock.timers.tick(CHAT_BATCH_MS);
    await settle();
    await settle();
  } finally {
    watch.stop();
    state.fail = false;
  }
  try {
    assert.deepEqual(watch.seen, []);
    assert.equal(errors.mock.callCount(), 1);
    assert.equal(errors.mock.calls[0].arguments[0], "chat push failed");
    await flushChatNotices(true);
    assert.deepEqual(sent.map((item) => item.body), ["Alex: hi"]);
  } finally {
    await flushChatNotices(true);
    real.close();
  }
});
