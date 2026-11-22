import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { flushChatNotices } from "../../src/chat/chat.js";
import { loadConfig } from "../../src/config.js";
import { sweepOrphanPhotos } from "../../src/social/event-photo.js";
import { api, testEmail, withApp, type AppCtx, type SentPush } from "../http.js";

// Fake people only. Alex hosts, Bea and Cam are in his circle, Olli is in a circle of his own.

type Person = { token: string; user: { id: string; name: string } };

const UNKNOWN = "00000000-0000-4000-8000-000000000000";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("0000000d49484452", "hex")]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>');
const GIF = Buffer.from("GIF89a\x01\x00\x01\x00", "latin1");
const photosDir = () => loadConfig({ DB_PATH: ":memory:" }).eventPhotosDir;

function withChat(fn: (ctx: AppCtx<SentPush>) => Promise<void>) {
  return withApp(async (ctx) => {
    try {
      await fn(ctx);
    } finally {
      await flushChatNotices(true);
    }
  }, { sent: "envelope" });
}

async function seed(port: number) {
  const start = (name: string, code?: string): Promise<Person> =>
    api(port, "POST", "/api/auth/start", { body: code ? { name, email: testEmail(), code } : { name, email: testEmail() }, status: 201 });
  const alex = await start("Alex");
  const circle = (await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Friends" }, status: 201 })).circle;
  const bea = await start("Bea", circle.inviteCode);
  const cam = await start("Cam", circle.inviteCode);
  const olli = await start("Olli");
  await api(port, "POST", "/api/circles", { token: olli.token, body: { name: "Elsewhere" }, status: 201 });
  for (const person of [alex, bea, cam]) {
    await api(port, "POST", "/api/push/subscribe", {
      token: person.token,
      body: { endpoint: `https://push.example/${person.user.id}`, keys: { p256dh: "p", auth: "a" } },
      status: 204,
    });
  }
  return { alex, bea, cam, olli, circle };
}

function upload(ctx: AppCtx, path: string, token: string | null, data: Buffer, circleId?: string) {
  return fetch(`http://127.0.0.1:${ctx.port}${path}`, {
    method: "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(circleId ? { "x-circle": circleId } : {}),
      "content-type": "application/octet-stream",
    },
    body: new Uint8Array(data),
  });
}

function getPhoto(ctx: AppCtx, id: string, token: string | null, method = "GET") {
  return fetch(`http://127.0.0.1:${ctx.port}/api/messages/${id}/photo`, { method, headers: token ? { authorization: `Bearer ${token}` } : {} });
}

async function sendCirclePhoto(ctx: AppCtx, person: Person, circleId: string, data = JPEG): Promise<string> {
  const res = await upload(ctx, "/api/circles/chat/photo", person.token, data, circleId);
  assert.equal(res.status, 201);
  const { chat } = (await res.json()) as { chat: { messages: Array<{ id: string; photo: boolean }> } };
  return chat.messages.filter((message) => message.photo).at(-1)!.id;
}

const filesOf = (id: string) => fs.readdirSync(photosDir()).filter((name) => name.includes(id));

test("a circle photo is posted, listed as a photo message and served to members only", async () => {
  await withChat(async (ctx) => {
    const { alex, bea, olli, circle } = await seed(ctx.port);
    const res = await upload(ctx, "/api/circles/chat/photo", alex.token, JPEG, circle.id);
    assert.equal(res.status, 201);
    const { chat } = (await res.json()) as { chat: { messages: Array<Record<string, any>> } };
    const message = chat.messages.at(-1)!;
    assert.equal(message.photo, true);
    assert.equal(message.text, "Photo", "words-only clients see a label, never a path");
    assert.equal(message.mine, true);
    assert.equal(message.canDelete, true);
    assert.equal(message.canEdit, false, "a photo cannot be edited");
    assert.equal(JSON.stringify(chat).includes(photosDir()), false, "no filesystem path in the JSON");

    const seen = await api(ctx.port, "GET", `/api/circles/chat?circle=${circle.id}`, { token: bea.token });
    assert.equal(seen.chat.messages.at(-1).photo, true);

    const got = await getPhoto(ctx, message.id, bea.token);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get("content-type"), "image/jpeg");
    assert.match(got.headers.get("cache-control") ?? "", /private/);
    assert.equal(got.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), JPEG);
    assert.equal((await getPhoto(ctx, message.id, bea.token, "HEAD")).status, 200);

    assert.equal((await getPhoto(ctx, message.id, null)).status, 401);
    const outsider = await getPhoto(ctx, message.id, olli.token);
    const missing = await getPhoto(ctx, UNKNOWN, olli.token);
    assert.equal(outsider.status, 404);
    assert.equal(await outsider.text(), await missing.text(), "an outsider gets the answer for a message that does not exist");
    assert.equal((await getPhoto(ctx, "not-a-uuid", bea.token)).status, 404);
  });
});

test("only the right types and sizes are kept, and nothing is stored on a refusal", async () => {
  await withChat(async (ctx) => {
    const { alex, circle } = await seed(ctx.port);
    const db = ctx.db;
    const path = "/api/circles/chat/photo";
    assert.equal((await upload(ctx, path, alex.token, SVG, circle.id)).status, 415, "SVG is refused");
    assert.equal((await upload(ctx, path, alex.token, GIF, circle.id)).status, 415, "GIF is refused");
    assert.equal((await upload(ctx, path, alex.token, Buffer.alloc(0), circle.id)).status, 415, "an empty body is not a photo");
    assert.equal((await upload(ctx, path, alex.token, Buffer.concat([JPEG, Buffer.alloc(700 * 1024)]), circle.id)).status, 413);
    assert.equal((await upload(ctx, path, null, JPEG, circle.id)).status, 401);
    const count = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind = 'photo'").get() as { n: number };
    assert.equal(count.n, 0);
    const wrong = await fetch(`http://127.0.0.1:${ctx.port}${path}`, { method: "PUT", headers: { authorization: `Bearer ${alex.token}`, "x-circle": circle.id }, body: new Uint8Array(JPEG) });
    assert.equal(wrong.status, 405);
  });
});

for (const kind of ["socials", "plans"] as const) {
  test(`${kind}: a photo goes in the event chat and an uninvited friend cannot see it`, async () => {
    await withChat(async (ctx) => {
      const { alex, bea, cam, circle } = await seed(ctx.port);
      const event = kind === "socials"
        ? (await api(ctx.port, "POST", `/api/socials?circle=${circle.id}`, { token: alex.token, body: { note: "Walk", invitees: [bea.user.id] }, status: 201 })).social
        : (await api(ctx.port, "POST", `/api/plans?circle=${circle.id}`, { token: alex.token, body: { note: "Supper", place: "Hall", date: "2026-06-03", time: "18:00", invitees: [bea.user.id] }, status: 201 })).plan;
      const path = `/api/${kind}/${event.id}/chat/photo`;
      const res = await upload(ctx, path, alex.token, PNG, circle.id);
      assert.equal(res.status, 201);
      const { chat } = (await res.json()) as { chat: { kind: string; messages: Array<{ id: string; photo: boolean }> } };
      assert.equal(chat.kind, kind === "socials" ? "social" : "plan");
      const id = chat.messages.at(-1)!.id;
      assert.equal((await getPhoto(ctx, id, bea.token)).headers.get("content-type"), "image/png");
      assert.equal((await getPhoto(ctx, id, cam.token)).status, 404, "an unpicked friend");
      assert.equal((await upload(ctx, path, cam.token, JPEG, circle.id)).status, 404, "and cannot post one either");
      assert.equal((await upload(ctx, `/api/${kind}/${UNKNOWN}/chat/photo`, alex.token, JPEG, circle.id)).status, 404);
    });
  });
}

test("a photo can be a reply, and a reply to a missing message stores nothing", async () => {
  await withChat(async (ctx) => {
    const { alex, bea, circle } = await seed(ctx.port);
    const first = await api(ctx.port, "POST", `/api/circles/chat?circle=${circle.id}`, { token: alex.token, body: { text: "Pic?" }, status: 201 });
    const parent = first.chat.messages.at(-1).id;
    const res = await upload(ctx, `/api/circles/chat/photo?replyTo=${parent}`, bea.token, JPEG, circle.id);
    assert.equal(res.status, 201);
    const { chat } = (await res.json()) as { chat: { messages: Array<Record<string, any>> } };
    assert.equal(chat.messages.at(-1)!.replyTo.id, parent);
    assert.equal(chat.messages.at(-1)!.replyTo.text, "Pic?");
    assert.equal(chat.messages.at(-1)!.photo, true);
    const before = fs.readdirSync(photosDir()).length;
    assert.equal((await upload(ctx, `/api/circles/chat/photo?replyTo=${UNKNOWN}`, bea.token, JPEG, circle.id)).status, 404);
    assert.equal(fs.readdirSync(photosDir()).length, before, "no file for a refused reply");
  });
});

test("a photo pings the thread as 'sent a photo' without showing any image data", async () => {
  await withChat(async (ctx) => {
    const { alex, circle } = await seed(ctx.port);
    await sendCirclePhoto(ctx, alex, circle.id);
    await flushChatNotices(true);
    const bodies = ctx.sent.map((item) => item.payload?.body).filter(Boolean) as string[];
    assert.ok(bodies.some((body) => body === "Alex: sent a photo"), JSON.stringify(bodies));
    for (const body of bodies) {
      assert.equal(/https?:/i.test(body), false, body);
      assert.equal(body.includes(photosDir()), false, body);
    }
  });
});

test("deleting a photo removes its file and the picture is gone for everyone", async () => {
  await withChat(async (ctx) => {
    const { alex, bea, cam, circle } = await seed(ctx.port);
    const id = await sendCirclePhoto(ctx, bea, circle.id);
    assert.equal(filesOf(id).length, 1);
    await api(ctx.port, "DELETE", `/api/messages/${id}`, { token: cam.token, status: 403 });
    await api(ctx.port, "DELETE", `/api/messages/${id}`, { token: alex.token, status: 204 });
    assert.deepEqual(filesOf(id), [], "the file is removed with the message");
    assert.equal((await getPhoto(ctx, id, bea.token)).status, 404);
  });
});

test("the sweep drops a chat photo whose message is gone and keeps live ones and event photos", async () => {
  await withChat(async (ctx) => {
    const { alex, circle } = await seed(ctx.port);
    const keep = await sendCirclePhoto(ctx, alex, circle.id);
    const gone = await sendCirclePhoto(ctx, alex, circle.id, PNG);
    ctx.db.prepare("DELETE FROM messages WHERE id = ?").run(gone);
    const strayEvent = `${photosDir()}/plan-${UNKNOWN}.jpg`;
    fs.writeFileSync(strayEvent, JPEG);
    await sweepOrphanPhotos(ctx.db, photosDir());
    assert.equal(filesOf(keep).length, 1, "a live photo stays");
    assert.deepEqual(filesOf(gone), [], "an orphan goes");
    assert.equal(fs.existsSync(strayEvent), true, "the event sweep still honours its grace period");
    fs.rmSync(strayEvent, { force: true });
  });
});

test("deleting the circle removes its chat photos", async () => {
  await withChat(async (ctx) => {
    const { alex, circle } = await seed(ctx.port);
    const id = await sendCirclePhoto(ctx, alex, circle.id);
    await api(ctx, "DELETE", `/api/circles?circle=${circle.id}`, { token: alex.token, status: 200 });
    assert.deepEqual(filesOf(id), []);
  });
});

test("a photo cannot be posted to a closed event chat, and nothing is stored", async () => {
  await withChat(async (ctx) => {
    const { alex, bea, circle } = await seed(ctx.port);
    const social = (await api(ctx.port, "POST", `/api/socials?circle=${circle.id}`, { token: alex.token, body: { note: "Walk" }, status: 201 })).social;
    await api(ctx.port, "POST", `/api/socials/${social.id}/reply`, { token: bea.token, body: { reply: "in" }, status: 200 });
    await api(ctx.port, "DELETE", `/api/socials/${social.id}`, { token: alex.token, status: 204 });
    const res = await upload(ctx, `/api/socials/${social.id}/chat/photo`, bea.token, JPEG, circle.id);
    assert.equal(res.status, 403);
    assert.equal((await res.json() as { error: string }).error, "This chat is closed.");
    const count = ctx.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind = 'photo'").get() as { n: number };
    assert.equal(count.n, 0);
    assert.equal(fs.readdirSync(photosDir()).filter((name) => name.startsWith("chat-")).length, 0);
  });
});

test("a friend can react to a photo, and editing it is refused", async () => {
  await withChat(async (ctx) => {
    const { alex, bea, circle } = await seed(ctx.port);
    const id = await sendCirclePhoto(ctx, alex, circle.id);
    const reacted = await api(ctx.port, "POST", `/api/messages/${id}/reactions`, { token: bea.token, body: { emoji: "🔥" }, status: 200 });
    assert.deepEqual(reacted.reactions.map((item: { emoji: string; count: number }) => [item.emoji, item.count]), [["🔥", 1]]);
    const edited = await api(ctx.port, "PATCH", `/api/messages/${id}`, { token: alex.token, body: { text: "caption" }, status: 403 });
    assert.equal(edited.error, "You can't edit that.");
  });
});
