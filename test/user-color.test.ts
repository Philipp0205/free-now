import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { CHAT_COLORS, preferredColor } from "../src/chat-color.js";
import { addMember, insertCircle, insertUser, openDb } from "../src/db.js";
import { api, withApp } from "./http.js";

function colorOf(db: DatabaseSync, id: string): number | null {
  return (db.prepare("SELECT color FROM users WHERE id = ?").get(id) as { color: number | null }).color;
}

function idAt(slot: number, prefix: string): string {
  for (let n = 0; n < 4000; n += 1) {
    const id = `${prefix}-${n}`;
    if (preferredColor(id) === slot) return id;
  }
  throw new Error(`no id for slot ${slot}`);
}

function seedUser(db: DatabaseSync, id: string, at = 1): void {
  insertUser(db, { id, name: id, token_hash: `h-${id}`, buzz_token: `b-${id}`, created_at: at });
}

test("a color is stored on the first circle and never moves", () => {
  const db = openDb(":memory:");
  const first = idAt(3, "alone");
  seedUser(db, first);
  assert.equal(colorOf(db, first), null);
  insertCircle(db, { id: "c1", name: "friends", invite_code: "AAAA", created_by: first, created_at: 1 }, first, 1);
  assert.equal(colorOf(db, first), 3, "alone in a circle keeps the hash slot");
  const clash = idAt(3, "clash");
  seedUser(db, clash);
  addMember(db, "c1", clash, 2);
  const taken = colorOf(db, clash);
  assert.notEqual(taken, 3, "the hash slot is taken, so the newcomer moves on");
  insertCircle(db, { id: "c2", name: "home", invite_code: "BBBB", created_by: clash, created_at: 3 }, clash, 3);
  db.prepare("UPDATE users SET name = 'Renamed' WHERE id = ?").run(clash);
  assert.equal(colorOf(db, first), 3);
  assert.equal(colorOf(db, clash), taken);
  db.close();
});

test("a full circle of twelve has twelve colors, and the thirteenth reuses one", () => {
  const db = openDb(":memory:");
  const ids = Array.from({ length: CHAT_COLORS.length + 1 }, (_, n) => `member-${n}`);
  for (const id of ids) seedUser(db, id);
  insertCircle(db, { id: "c1", name: "friends", invite_code: "AAAA", created_by: ids[0], created_at: 1 }, ids[0], 1);
  for (let n = 1; n < CHAT_COLORS.length; n += 1) addMember(db, "c1", ids[n], n + 1);
  const colors = ids.slice(0, CHAT_COLORS.length).map((id) => colorOf(db, id));
  assert.equal(new Set(colors).size, CHAT_COLORS.length);
  addMember(db, "c1", ids[CHAT_COLORS.length], 99);
  const extra = colorOf(db, ids[CHAT_COLORS.length]);
  assert.ok(extra != null && extra >= 0 && extra < CHAT_COLORS.length);
  assert.deepEqual(ids.slice(0, CHAT_COLORS.length).map((id) => colorOf(db, id)), colors, "nobody moved");
  db.close();
});

test("joining a second circle keeps the color even when it clashes there", () => {
  const db = openDb(":memory:");
  const ana = idAt(5, "ana");
  const ben = idAt(5, "ben");
  seedUser(db, ana);
  seedUser(db, ben);
  insertCircle(db, { id: "c1", name: "one", invite_code: "AAAA", created_by: ana, created_at: 1 }, ana, 1);
  insertCircle(db, { id: "c2", name: "two", invite_code: "BBBB", created_by: ben, created_at: 2 }, ben, 2);
  assert.equal(colorOf(db, ana), 5);
  assert.equal(colorOf(db, ben), 5);
  addMember(db, "c1", ben, 3);
  assert.equal(colorOf(db, ana), 5);
  assert.equal(colorOf(db, ben), 5, "stability wins over distinctness");
  db.close();
});

test("the same person has the same color in two circles, in members, events, and chat", async () => {
  await withApp(async (ctx) => {
    const alex = await api(ctx.port, "POST", "/api/auth/start", { body: { name: "Alex" }, status: 201 });
    const one = await api(ctx.port, "POST", "/api/circles", { token: alex.token, body: { name: "One" }, status: 201 });
    const two = await api(ctx.port, "POST", "/api/circles", { token: alex.token, body: { name: "Two" }, status: 201 });
    const bea = await api(ctx.port, "POST", "/api/auth/start", { body: { name: "Bea", code: one.circle.inviteCode }, status: 201 });
    await api(ctx.port, "POST", "/api/circles/join", { token: bea.token, body: { code: two.circle.inviteCode }, status: 200 });
    const cam = await api(ctx.port, "POST", "/api/auth/start", { body: { name: "Cam", code: two.circle.inviteCode }, status: 201 });
    const me = await api(ctx.port, "GET", "/api/me", { token: bea.token, status: 200 });
    const color = me.user.color;
    assert.ok(CHAT_COLORS.includes(color));
    assert.equal(bea.user.color, color);
    const seen: string[] = [];
    for (const circle of [one.circle, two.circle]) {
      const view = await api(ctx.port, "GET", `/api/me?circle=${circle.id}`, { token: alex.token, status: 200 });
      const members = view.circle.members as Array<{ id: string; color: string }>;
      seen.push(members.find((member) => member.id === bea.user.id)!.color);
      assert.equal(new Set(members.map((member) => member.color)).size, members.length, `${circle.name} shares a hue`);
      await api(ctx.port, "POST", `/api/circles/chat?circle=${circle.id}`, { token: bea.token, body: { text: "hi" }, status: 201 });
      const chat = await api(ctx.port, "GET", `/api/circles/chat?circle=${circle.id}`, { token: alex.token, status: 200 });
      seen.push(chat.chat.messages.find((message: { name: string }) => message.name === "Bea").color);
      const mine = await api(ctx.port, "GET", `/api/circles/chat?circle=${circle.id}`, { token: bea.token, status: 200 });
      const own = mine.chat.messages.find((message: { mine: boolean }) => message.mine);
      seen.push(own.color);
    }
    const social = await api(ctx.port, "POST", `/api/socials?circle=${two.circle.id}`, { token: bea.token, body: { note: "Coffee" }, status: 201 });
    seen.push(social.social.creator.color);
    await api(ctx.port, "POST", `/api/socials/${social.social.id}/join?circle=${two.circle.id}`, { token: cam.token, body: {}, status: 200 });
    const listed = await api(ctx.port, "GET", `/api/socials?circle=${two.circle.id}`, { token: cam.token, status: 200 });
    const camColor = (await api(ctx.port, "GET", "/api/me", { token: cam.token, status: 200 })).user.color;
    assert.equal(listed.socials[0].joined[0].color, camColor);
    const pushed = await api(ctx.port, "GET", `/api/socials?circle=${two.circle.id}`, { token: bea.token, status: 200 });
    const rows = pushed.socials[0].push.people as Array<{ name: string; color: string }>;
    assert.equal(rows.find((row) => row.name === "Cam")?.color, camColor);
    assert.deepEqual(new Set(seen), new Set([color]), seen.join(","));
  });
});

test("opening an old database backfills one color per person, deterministically", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hangry-color-"));
  try {
    const build = (file: string) => {
      const raw = new DatabaseSync(file);
      raw.exec(`
        CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, buzz_token TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
        CREATE TABLE circles (id TEXT PRIMARY KEY, name TEXT NOT NULL, invite_code TEXT NOT NULL UNIQUE, created_by TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE memberships (user_id TEXT NOT NULL, circle_id TEXT NOT NULL, joined_at INTEGER NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0, chat_color INTEGER, PRIMARY KEY (user_id, circle_id));
      `);
      const user = raw.prepare("INSERT INTO users (id, name, token_hash, buzz_token, created_at) VALUES (?, ?, ?, ?, 1)");
      for (const id of ["ana", "ben", "cam", "dan", "eve", "lonely"]) user.run(id, id, `h-${id}`, `b-${id}`);
      raw.prepare("INSERT INTO circles (id, name, invite_code, created_by, created_at) VALUES ('c1', 'one', 'AAAA', 'ana', 1)").run();
      raw.prepare("INSERT INTO circles (id, name, invite_code, created_by, created_at) VALUES ('c2', 'two', 'BBBB', 'cam', 1)").run();
      const member = raw.prepare("INSERT INTO memberships (user_id, circle_id, joined_at, is_admin, chat_color) VALUES (?, ?, ?, 0, ?)");
      member.run("ana", "c1", 10, 7); // one circle: keeps 7
      member.run("ben", "c1", 20, 2); // in both circles with the same slot: keeps 2
      member.run("ben", "c2", 25, 2);
      member.run("cam", "c2", 15, 4); // different slots in two circles: re-chosen
      member.run("cam", "c1", 30, 9);
      member.run("dan", "c1", 40, 7); // same slot as ana, who joined first: re-chosen
      member.run("eve", "c2", 50, null); // never opened a chat: chosen fresh
      raw.close();
    };
    const files = [path.join(dir, "a.sqlite"), path.join(dir, "b.sqlite")];
    const results = files.map((file) => {
      build(file);
      const db = openDb(file);
      const rows = db.prepare("SELECT id, color FROM users ORDER BY id").all().map((row) => ({ ...row })) as Array<{ id: string; color: number | null }>;
      const kept = db.prepare("SELECT user_id, circle_id, joined_at, chat_color FROM memberships ORDER BY user_id, circle_id").all().length;
      db.close();
      return { colors: new Map(rows.map((row) => [row.id, row.color])), kept };
    });
    const colors = results[0].colors;
    assert.deepEqual([...results[1].colors], [...colors], "same data, same colors");
    assert.equal(results[0].kept, 7, "memberships untouched");
    assert.equal(colors.get("ana"), 7);
    assert.equal(colors.get("ben"), 2);
    assert.equal(colors.get("lonely"), null, "no circle yet, nothing stored");
    for (const id of ["cam", "dan", "eve"]) assert.equal(typeof colors.get(id), "number", id);
    const circleOne = ["ana", "ben", "cam", "dan"].map((id) => colors.get(id));
    const circleTwo = ["ben", "cam", "eve"].map((id) => colors.get(id));
    assert.equal(new Set(circleOne).size, circleOne.length, `c1 ${circleOne}`);
    assert.equal(new Set(circleTwo).size, circleTwo.length, `c2 ${circleTwo}`);

    const again = openDb(files[0]);
    const reopened = again.prepare("SELECT id, color FROM users ORDER BY id").all().map((row) => ({ ...row })) as Array<{ id: string; color: number | null }>;
    again.close();
    assert.deepEqual(new Map(reopened.map((row) => [row.id, row.color])), colors, "reopening changes nothing");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
