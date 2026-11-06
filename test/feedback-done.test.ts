import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { openDb } from "../src/db.js";
import { FEEDBACK_DONE_TITLE, feedbackDoneBody, feedbackExcerpt } from "../src/feedback.js";
import { api, withApp } from "./http.js";

const ADMIN = "a".repeat(32);
const ENV = { env: { ADMIN_TOKEN: ADMIN } };

type Hit = { status: number; json: any };

async function hit(
  port: number,
  method: string,
  pathname: string,
  options: { token?: string; body?: unknown; forwarded?: string } = {},
): Promise<Hit> {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: {
      "x-forwarded-for": options.forwarded ?? "203.0.113.200",
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

const markDone = (port: number, id: string, status = "done") =>
  hit(port, "POST", `/api/admin/feedback/${id}`, { token: ADMIN, body: { status } });

async function circleOfTwo(port: number) {
  const alex = await api(port, "POST", "/api/auth/start", { body: { name: "Alex" }, status: 201 });
  const created = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Friends" }, status: 201 });
  const circle = created.circle as { id: string; inviteCode: string };
  const bea = await api(port, "POST", "/api/auth/start", { body: { name: "Bea", code: circle.inviteCode }, status: 201 });
  return { alex, bea, circle };
}

async function send(port: number, token: string, text: string, circleId?: string): Promise<string> {
  const sent = await hit(port, "POST", "/api/feedback", { token, body: { text, ...(circleId ? { circleId } : {}) } });
  assert.equal(sent.status, 201);
  return sent.json.id;
}

function doneRows(db: DatabaseSync, feedbackId: string) {
  return db
    .prepare("SELECT user_id, circle_id, title, body, kind, ref_id FROM notifications WHERE kind = 'feedback-done' AND ref_id = ?")
    .all(feedbackId)
    .map((row) => ({ ...row }));
}

test("excerpt is one short line without control, zero-width, or bidi characters", () => {
  assert.equal(feedbackExcerpt("  dark\n\tmode\u0000 please  "), "dark mode please");
  assert.equal(feedbackExcerpt("a\u202eevil\u200bb\u2066"), "a evil b");
  const long = feedbackExcerpt("x".repeat(500));
  assert.equal(Array.from(long).length, 80);
  assert.ok(long.endsWith("…"));
  // Cut on a code point, never inside an emoji surrogate pair.
  const emoji = feedbackExcerpt("🍕".repeat(200));
  assert.equal(Array.from(emoji).length, 80);
  assert.ok(emoji.isWellFormed());
  assert.equal(feedbackDoneBody("More pins"), 'You suggested: "More pins". It is in the app now. Thanks!');
  assert.equal(feedbackDoneBody("\u200b\u0007"), "It is in the app now. Thanks!");
});

test("done sends one personal alert to the submitter only, and nobody else sees the feedback", async () => {
  await withApp(async ({ port, db, sent }) => {
    const { alex, bea, circle } = await circleOfTwo(port);
    const id = await send(port, bea.token, "Please add a dark map", circle.id);
    const pushesBefore = sent.length;

    const done = await markDone(port, id);
    assert.equal(done.status, 200);
    assert.equal(done.json.doneAlert, "sent");
    assert.equal(done.json.feedback.status, "done");

    const rows = doneRows(db, id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].user_id, bea.user.id);
    assert.equal(rows[0].circle_id, null, "personal, not circle-wide");
    assert.equal(rows[0].title, FEEDBACK_DONE_TITLE);
    assert.match(String(rows[0].body), /Please add a dark map/);
    assert.equal(sent.length, pushesBefore, "no push in this version");

    const beaNotes = await api(port, "GET", "/api/notifications", { token: bea.token });
    const mine = beaNotes.notifications.filter((note: { kind: string }) => note.kind === "feedback-done");
    assert.equal(mine.length, 1);
    assert.equal(mine[0].title, "Your suggestion is live");
    assert.equal(mine[0].refId, id);

    const alexNotes = await api(port, "GET", "/api/notifications", { token: alex.token });
    assert.equal(JSON.stringify(alexNotes).includes("dark map"), false);
    assert.equal(alexNotes.notifications.some((note: { kind: string }) => note.kind === "feedback-done"), false);
    const alexMe = await api(port, "GET", "/api/me", { token: alex.token });
    assert.equal(JSON.stringify(alexMe).includes("dark map"), false);

    // Reading clears it like any other alert.
    await api(port, "POST", "/api/notifications/read", { token: bea.token, body: {}, status: 204 });
    const after = await api(port, "GET", "/api/notifications", { token: bea.token });
    assert.ok(after.notifications.find((note: { kind: string }) => note.kind === "feedback-done").readAt);
  }, ENV);
});

test("repeat done writes, other edits, and reopen then done never add a second alert", async () => {
  await withApp(async ({ port, db }) => {
    const { bea, circle } = await circleOfTwo(port);
    const id = await send(port, bea.token, "Bigger buttons", circle.id);
    assert.equal((await markDone(port, id, "in_progress")).json.doneAlert, "none");
    assert.equal(doneRows(db, id).length, 0, "only done sends");
    assert.equal((await markDone(port, id)).json.doneAlert, "sent");
    assert.equal((await markDone(port, id)).json.doneAlert, "already");
    const note = await hit(port, "POST", `/api/admin/feedback/${id}`, { token: ADMIN, body: { note: "shipped" } });
    assert.equal(note.json.doneAlert, "none");
    assert.equal((await markDone(port, id, "in_progress")).json.doneAlert, "none");
    assert.equal((await markDone(port, id)).json.doneAlert, "already");
    const parallel = await Promise.all([markDone(port, id), markDone(port, id), markDone(port, id)]);
    for (const result of parallel) assert.equal(result.status, 200);
    assert.equal(doneRows(db, id).length, 1);
    // The marker outlives the 30-day alert sweep, so a later done still does not resend.
    db.prepare("DELETE FROM notifications WHERE kind = 'feedback-done'").run();
    assert.equal((await markDone(port, id)).json.doneAlert, "already");
    assert.equal(doneRows(db, id).length, 0);
  }, ENV);
});

test("the submitter still gets it after leaving the source circle, or with no circle at all", async () => {
  await withApp(async ({ port, db }) => {
    const { alex, bea, circle } = await circleOfTwo(port);
    const other = await api(port, "POST", "/api/circles", { token: bea.token, body: { name: "Club" }, status: 201 });
    const first = await send(port, bea.token, "Calendar export", circle.id);
    const second = await send(port, bea.token, "Swipe to dismiss", circle.id);
    await api(port, "POST", `/api/circles/leave?circle=${circle.id}`, { token: bea.token, body: {}, status: 200 });

    assert.equal((await markDone(port, first)).json.doneAlert, "sent");
    const inClub = await api(port, "GET", `/api/notifications?circle=${other.circle.id}`, { token: bea.token });
    assert.equal(inClub.notifications.filter((note: { kind: string }) => note.kind === "feedback-done").length, 1);
    // The old circle is not readable any more, and its members do not get the alert.
    assert.equal((await hit(port, "GET", `/api/notifications?circle=${circle.id}`, { token: bea.token })).status, 404);
    const alexNotes = await api(port, "GET", "/api/notifications", { token: alex.token });
    assert.equal(JSON.stringify(alexNotes).includes("Calendar export"), false);

    await api(port, "POST", `/api/circles/leave?circle=${other.circle.id}`, { token: bea.token, body: {}, status: 200 });
    assert.equal((await markDone(port, second)).json.doneAlert, "sent");
    const alone = await api(port, "GET", "/api/notifications", { token: bea.token });
    assert.deepEqual(
      alone.notifications.map((note: { refId: string }) => note.refId).sort(),
      [first, second].sort(),
    );
    assert.equal(alone.notifications.every((note: { kind: string }) => note.kind === "feedback-done"), true);
    await api(port, "POST", "/api/notifications/read", { token: bea.token, body: {}, status: 204 });
    const read = await api(port, "GET", "/api/notifications", { token: bea.token });
    assert.equal(read.notifications.every((note: { readAt: number | null }) => note.readAt !== null), true);
    assert.equal(doneRows(db, first).length + doneRows(db, second).length, 2);
  }, ENV);
});

test("personal alerts stay personal when old notifications are backfilled on boot", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hangry-feedback-"));
  const file = path.join(dir, "app.db");
  try {
    const db = openDb(file);
    db.prepare("INSERT INTO users (id, name, token_hash, buzz_token, created_at) VALUES ('u1', 'Bea', 'h1', 'b1', 1)").run();
    db.prepare("INSERT INTO circles (id, name, invite_code, created_by, created_at) VALUES ('c1', 'Club', 'CODE1', 'u1', 1)").run();
    db.prepare("INSERT INTO memberships (user_id, circle_id, joined_at) VALUES ('u1', 'c1', 1)").run();
    db.prepare(
      "INSERT INTO notifications (id, user_id, title, body, kind, ref_id, circle_id, created_at) VALUES ('n1', 'u1', 't', 'b', 'feedback-done', 'f1', NULL, 1)",
    ).run();
    db.close();
    const again = openDb(file);
    const row = again.prepare("SELECT circle_id FROM notifications WHERE id = 'n1'").get();
    assert.equal(row?.circle_id, null);
    again.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("feedback already done before the upgrade never sends, even after reopen then done", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hangry-feedback-"));
  const file = path.join(dir, "old.db");
  try {
    // An old database: feedback table without done_alert, one row already done, one still new.
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
        buzz_token TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
      CREATE TABLE feedback (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
        circle_id TEXT, text TEXT NOT NULL, app_version TEXT, created_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'new', pr_url TEXT, note TEXT, updated_at INTEGER);
      INSERT INTO users VALUES ('u1', 'Bea', 'h1', 'b1', 1);
      INSERT INTO feedback (id, user_id, text, created_at, status)
        VALUES ('11111111-1111-4111-8111-111111111111', 'u1', 'old idea', 1, 'done');
      INSERT INTO feedback (id, user_id, text, created_at, status)
        VALUES ('22222222-2222-4222-8222-222222222222', 'u1', 'new idea', 2, 'new');
    `);
    old.close();

    const migrated = openDb(file);
    const markers = migrated.prepare("SELECT id, done_alert FROM feedback ORDER BY created_at").all().map((row) => ({ ...row }));
    assert.deepEqual(markers, [
      { id: "11111111-1111-4111-8111-111111111111", done_alert: "legacy" },
      { id: "22222222-2222-4222-8222-222222222222", done_alert: null },
    ]);
    const count = () => Number(migrated.prepare("SELECT COUNT(*) AS n FROM notifications").get()?.n);
    assert.equal(count(), 0, "no backfill alerts at startup");
    migrated.close();

    // A second boot does not re-run the backfill or touch the markers.
    const reopened = openDb(file);
    assert.equal(reopened.prepare("SELECT done_alert FROM feedback WHERE status = 'new'").get()?.done_alert, null);
    reopened.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // Same rule through the admin route: a legacy-marked done row stays silent through reopen then done.
  await withApp(async ({ port, db }) => {
    const { bea, circle } = await circleOfTwo(port);
    const id = await send(port, bea.token, "old idea", circle.id);
    db.prepare("UPDATE feedback SET status = 'done', done_alert = 'legacy' WHERE id = ?").run(id);
    assert.equal((await markDone(port, id, "in_progress")).json.doneAlert, "none");
    assert.equal((await markDone(port, id)).json.doneAlert, "already");
    assert.equal(doneRows(db, id).length, 0);
  }, ENV);
});

test("a deleted submitter is skipped safely and marked so it never sends later", async () => {
  await withApp(async ({ port, db }) => {
    const { bea, circle } = await circleOfTwo(port);
    const id = await send(port, bea.token, "Ghost idea", circle.id);
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(bea.user.id);
    db.prepare("DELETE FROM memberships WHERE user_id = ?").run(bea.user.id);
    db.prepare("DELETE FROM users WHERE id = ?").run(bea.user.id);
    db.exec("PRAGMA foreign_keys = ON");

    const done = await markDone(port, id);
    assert.equal(done.status, 200);
    assert.equal(done.json.doneAlert, "no-user");
    assert.equal(done.json.feedback.userName, null);
    assert.equal(doneRows(db, id).length, 0);
    assert.equal(db.prepare("SELECT done_alert FROM feedback WHERE id = ?").get(id)?.done_alert, "no-user");
    assert.equal((await markDone(port, id)).json.doneAlert, "already");
  }, ENV);
});

test("untrusted feedback text is stored as plain text and the client renders alerts as text", async () => {
  await withApp(async ({ port, db }) => {
    const { bea, circle } = await circleOfTwo(port);
    const evil = '<img src=x onerror="alert(1)">\u202e\u0007<script>x</script>';
    const id = await send(port, bea.token, evil, circle.id);
    await markDone(port, id);
    const [row] = doneRows(db, id);
    const body = String(row.body);
    assert.equal(/[\u0000-\u001f\u202a-\u202e]/.test(body), false);
    assert.ok(body.length < 160);
    const notes = await api(port, "GET", "/api/notifications", { token: bea.token });
    const note = notes.notifications.find((item: { kind: string }) => item.kind === "feedback-done");
    assert.equal(note.body, body, "JSON carries the text as is; it is never HTML");
  }, ENV);
  // The alert list and banner set note.title/body through textContent (el's "text"), never innerHTML.
  const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const card = /function alertCard\(note\) \{[\s\S]*?\n\}/.exec(app)?.[0] ?? "";
  assert.match(card, /el\("h3", \{ text: note\.title \}\)/);
  assert.match(card, /el\("p", \{ text: note\.body \}\)/);
  assert.equal(/innerHTML|insertAdjacentHTML/.test(card), false);
  assert.match(app, /state\.notifications\.map\(alertCard\)/);
  assert.match(app, /else if \(key === "text"\) node\.textContent = String\(value\);/);
  assert.match(app, /function openNotification\(note\) \{\n  if \(note\.kind === "feedback-done"\) \{[^}]*void openWhatsNewList\(\);/);
});

test("only the operator token can mark done; app users and bad tokens send nothing", async () => {
  await withApp(async ({ port, db }) => {
    const { alex, bea, circle } = await circleOfTwo(port);
    const id = await send(port, bea.token, "Secret wish", circle.id);
    for (const token of [undefined, alex.token, bea.token, "b".repeat(32)]) {
      const denied = await hit(port, "POST", `/api/admin/feedback/${id}`, { token, body: { status: "done" }, forwarded: "198.51.100.9" });
      assert.equal(denied.status, 404);
      assert.deepEqual(denied.json, { error: "not found" });
    }
    assert.equal(db.prepare("SELECT status FROM feedback WHERE id = ?").get(id)?.status, "new");
    assert.equal(doneRows(db, id).length, 0);
  }, ENV);
  await withApp(async ({ port, db }) => {
    // No ADMIN_TOKEN configured: the route is hidden for everyone.
    const { bea, circle } = await circleOfTwo(port);
    const id = await send(port, bea.token, "Secret wish", circle.id);
    assert.equal((await markDone(port, id)).status, 404);
    assert.equal(doneRows(db, id).length, 0);
  });
});

test("zero-circle submitter reads their alert with no circle named; unrelated people get nothing", async () => {
  await withApp(async ({ port, db }) => {
    const { alex, bea, circle } = await circleOfTwo(port);
    const stranger = await api(port, "POST", "/api/auth/start", { body: { name: "Cam" }, status: 201 });
    const elsewhere = await api(port, "POST", "/api/auth/start", { body: { name: "Dee" }, status: 201 });
    const club = await api(port, "POST", "/api/circles", { token: elsewhere.token, body: { name: "Club" }, status: 201 });
    const strangerOwn = await send(port, stranger.token, "Cam's own idea");
    const id = await send(port, bea.token, "Shared calendar view", circle.id);
    await api(port, "POST", `/api/circles/leave?circle=${circle.id}`, { token: bea.token, body: {}, status: 200 });
    assert.equal((await markDone(port, id)).json.doneAlert, "sent");

    // What the app sends when it has no circle: no x-circle header, no circle param.
    const mine = await api(port, "GET", "/api/notifications", { token: bea.token });
    assert.equal(mine.notifications.length, 1);
    assert.equal(mine.notifications[0].kind, "feedback-done");
    assert.equal(mine.notifications[0].title, "Your suggestion is live");
    assert.equal(mine.notifications[0].readAt, null);
    assert.match(mine.notifications[0].body, /Shared calendar view/);
    // A stale remembered circle is still refused, which is why the client drops the header.
    const stale = await fetch(`http://127.0.0.1:${port}/api/notifications`, {
      headers: { authorization: `Bearer ${bea.token}`, "x-circle": circle.id },
    });
    assert.equal(stale.status, 404);

    // Unrelated people: a zero-circle user with their own unfinished feedback, a member of another
    // circle, and the member of the source circle. None get an alert or see the text.
    const others: Array<[string, string]> = [
      [stranger.token, "/api/notifications"],
      [elsewhere.token, `/api/notifications?circle=${club.circle.id}`],
      [alex.token, `/api/notifications?circle=${circle.id}`],
    ];
    for (const [token, url] of others) {
      const got = await api(port, "GET", url, { token });
      assert.deepEqual(got.notifications.filter((note: { kind: string }) => note.kind === "feedback-done"), []);
      assert.equal(JSON.stringify(got).includes("Shared calendar"), false);
    }
    assert.equal(doneRows(db, strangerOwn).length, 0);

    // Reading with no circle clears only Bea's personal alerts.
    await api(port, "POST", "/api/notifications/read", { token: bea.token, body: {}, status: 204 });
    const read = await api(port, "GET", "/api/notifications", { token: bea.token });
    assert.ok(read.notifications[0].readAt);
  }, ENV);
});

test("client: zero-circle refresh loads personal alerts, setup lists them, and the banner opens What's new", () => {
  const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  // refresh() no longer bails out without a circle.
  assert.match(app, /async function refresh\(\{ initial = false \} = \{\}\) \{\n  if \(state\.token && state\.me && !state\.me\.circle\) \{\n    await refreshPersonalAlerts\(\);/);
  assert.match(app, /api\("\/api\/notifications", \{ circle: null \}\)/);
  assert.match(app, /root\.append\(setup\(\)\);\n    if \(state\.sheet === "whats-new"\) root\.append\(whatsNewSheet\(\)\);/);
  assert.match(app, /personalAlerts\(\),\n  \]\);/);
  assert.match(app, /if \(note\.kind === "feedback-done"\) \{\n      openNotification\(note\);/);
});
