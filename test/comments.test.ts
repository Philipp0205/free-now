import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import type { PushPayload, PushSender } from "../src/push.js";

const START = Date.parse("2026-06-01T15:00:00.000Z");
const TTL = 2 * 60 * 60 * 1000;

type Ctx = { base: string; db: DatabaseSync; sent: PushPayload[]; advance: (ms: number) => void };

async function withApp(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  let now = START;
  const sent: PushPayload[] = [];
  const db = openDb(":memory:");
  const config = loadConfig({ PORT: "3000", DB_PATH: ":memory:", APP_TZ: "UTC", SOCIAL_TTL_MS: String(TTL) });
  const push: PushSender = { async send(_sub, payload) { sent.push(payload); } };
  const server = http.createServer(createApp({ db, push, config: { ...config, dbPath: ":memory:" }, now: () => now }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn({ base: `http://127.0.0.1:${port}`, db, sent, advance: (ms) => { now += ms; } });
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
}

async function call(ctx: Ctx, method: string, path: string, token: string, body?: unknown) {
  const response = await fetch(`${ctx.base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

async function circleOfThree(ctx: Ctx) {
  const alex = (await call(ctx, "POST", "/api/auth/start", "", { name: "Alex" })).json;
  const circle = (await call(ctx, "POST", "/api/circles", alex.token, { name: "friends" })).json.circle;
  const veit = (await call(ctx, "POST", "/api/auth/start", "", { name: "Veit" })).json;
  await call(ctx, "POST", "/api/circles/join", veit.token, { code: circle.inviteCode });
  const mia = (await call(ctx, "POST", "/api/auth/start", "", { name: "Mia" })).json;
  await call(ctx, "POST", "/api/circles/join", mia.token, { code: circle.inviteCode });
  return { alex: alex.token as string, veit: veit.token as string, mia: mia.token as string };
}

test("friends comment on a social, and only the author can edit or delete", async () => {
  await withApp(async (ctx) => {
    const { alex, veit, mia } = await circleOfThree(ctx);
    const social = (await call(ctx, "POST", "/api/socials", alex, { note: "Rooftop" })).json.social;
    assert.deepEqual(social.comments, []);

    const posted = await call(ctx, "POST", `/api/socials/${social.id}/comments`, veit, { body: "  Bringing snacks\n\n\n\nsee you  " });
    assert.equal(posted.status, 201);
    const [comment] = posted.json.social.comments;
    assert.equal(comment.body, "Bringing snacks\n\nsee you");
    assert.equal(comment.author.name, "Veit");
    assert.equal(comment.editedAt, null);

    const forbidden = await call(ctx, "PATCH", `/api/comments/${comment.id}`, mia, { body: "hijacked" });
    assert.equal(forbidden.status, 403);
    assert.equal((await call(ctx, "DELETE", `/api/comments/${comment.id}`, alex)).status, 403);

    ctx.advance(60_000);
    const edited = await call(ctx, "PATCH", `/api/comments/${comment.id}`, veit, { body: "Bringing chips" });
    assert.equal(edited.status, 200);
    assert.equal(edited.json.comment.body, "Bringing chips");
    assert.equal(edited.json.comment.editedAt, START + 60_000);

    const listed = (await call(ctx, "GET", "/api/socials", mia)).json.socials[0];
    assert.equal(listed.comments[0].body, "Bringing chips");

    assert.equal((await call(ctx, "DELETE", `/api/comments/${comment.id}`, veit)).status, 204);
    assert.deepEqual((await call(ctx, "GET", "/api/socials", mia)).json.socials[0].comments, []);
  });
});

test("reactions toggle per person and only from the fixed set", async () => {
  await withApp(async (ctx) => {
    const { alex, veit, mia } = await circleOfThree(ctx);
    const plan = (await call(ctx, "POST", "/api/plans", alex, { note: "Dinner" })).json.plan;
    const comment = (await call(ctx, "POST", `/api/plans/${plan.id}/comments`, veit, { body: "Which place?" })).json.plan.comments[0];
    const veitId = (await call(ctx, "GET", "/api/me", veit)).json.user.id;
    const miaId = (await call(ctx, "GET", "/api/me", mia)).json.user.id;

    await call(ctx, "POST", `/api/comments/${comment.id}/reactions`, veit, { emoji: "👍" });
    await call(ctx, "POST", `/api/comments/${comment.id}/reactions`, mia, { emoji: "👍" });
    const both = await call(ctx, "POST", `/api/comments/${comment.id}/reactions`, mia, { emoji: "🔥" });
    assert.deepEqual(both.json.comment.reactions, [
      { emoji: "👍", userIds: [veitId, miaId] },
      { emoji: "🔥", userIds: [miaId] },
    ]);

    const undone = await call(ctx, "POST", `/api/comments/${comment.id}/reactions`, mia, { emoji: "👍" });
    assert.deepEqual(undone.json.comment.reactions, [
      { emoji: "👍", userIds: [veitId] },
      { emoji: "🔥", userIds: [miaId] },
    ]);

    assert.equal((await call(ctx, "POST", `/api/comments/${comment.id}/reactions`, mia, { emoji: "<script>" })).status, 400);
    const shown = (await call(ctx, "GET", "/api/plans", alex)).json.plans[0].comments[0];
    assert.equal(shown.reactions.length, 2);
  });
});

test("a new comment pings the host and earlier commenters, not the author", async () => {
  await withApp(async (ctx) => {
    const { alex, veit, mia } = await circleOfThree(ctx);
    const social = (await call(ctx, "POST", "/api/socials", alex, { note: "Rooftop" })).json.social;
    await call(ctx, "POST", `/api/socials/${social.id}/comments`, veit, { body: "On my way" });
    const alexAlerts = (await call(ctx, "GET", "/api/notifications", alex)).json.notifications;
    assert.equal(alexAlerts[0].kind, "comment");
    assert.equal(alexAlerts[0].body, "Veit: On my way");
    assert.ok(!(await call(ctx, "GET", "/api/notifications", veit)).json.notifications.some((n: { kind: string }) => n.kind === "comment"));

    await call(ctx, "POST", `/api/socials/${social.id}/comments`, mia, { body: "Me too" });
    const veitAlerts = (await call(ctx, "GET", "/api/notifications", veit)).json.notifications;
    assert.deepEqual(
      veitAlerts.filter((n: { kind: string }) => n.kind === "comment").map((n: { body: string }) => n.body),
      ["Mia: Me too"],
    );
    const miaAlerts = (await call(ctx, "GET", "/api/notifications", mia)).json.notifications;
    assert.ok(!miaAlerts.some((n: { kind: string }) => n.kind === "comment"));
  });
});

test("comments are closed once the social ends or for someone outside the circle", async () => {
  await withApp(async (ctx) => {
    const { alex, veit } = await circleOfThree(ctx);
    const social = (await call(ctx, "POST", "/api/socials", alex, { note: "Rooftop" })).json.social;
    const comment = (await call(ctx, "POST", `/api/socials/${social.id}/comments`, veit, { body: "hi" })).json.social.comments[0];

    const stranger = (await call(ctx, "POST", "/api/auth/start", "", { name: "Sam" })).json.token;
    await call(ctx, "POST", "/api/circles", stranger, { name: "other" });
    assert.equal((await call(ctx, "POST", `/api/socials/${social.id}/comments`, stranger, { body: "hey" })).status, 404);
    assert.equal((await call(ctx, "POST", `/api/comments/${comment.id}/reactions`, stranger, { emoji: "👍" })).status, 404);

    assert.equal((await call(ctx, "POST", `/api/socials/${social.id}/comments`, veit, { body: "" })).status, 400);
    assert.equal((await call(ctx, "POST", `/api/socials/${social.id}/comments`, veit, { body: "x".repeat(501) })).status, 400);

    ctx.advance(TTL + 1);
    assert.equal((await call(ctx, "POST", `/api/socials/${social.id}/comments`, veit, { body: "late" })).status, 410);
    assert.equal((await call(ctx, "PATCH", `/api/comments/${comment.id}`, veit, { body: "late" })).status, 410);
  });
});

test("comments go with their social when it is swept", async () => {
  await withApp(async (ctx) => {
    const { alex, veit } = await circleOfThree(ctx);
    const social = (await call(ctx, "POST", "/api/socials", alex, { note: "Rooftop" })).json.social;
    const comment = (await call(ctx, "POST", `/api/socials/${social.id}/comments`, veit, { body: "hi" })).json.social.comments[0];
    await call(ctx, "POST", `/api/comments/${comment.id}/reactions`, alex, { emoji: "❤️" });
    assert.equal((await call(ctx, "DELETE", `/api/socials/${social.id}`, alex)).status, 204);
    const left = ctx.db.prepare("SELECT (SELECT COUNT(*) FROM event_comments) AS c, (SELECT COUNT(*) FROM comment_reactions) AS r").get();
    assert.deepEqual({ ...left }, { c: 0, r: 0 });
  });
});
