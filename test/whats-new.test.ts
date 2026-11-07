import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  SEEN_KEY,
  formatEntryDate,
  latestId,
  newerSeen,
  normalizeEntries,
  unseenEntries,
  validId,
} from "../public/whats-new.js";
import { api, withApp } from "./http.js";

const read = (file: string) => fs.readFileSync(new URL(file, import.meta.url), "utf8");
const RAW = JSON.parse(read("../public/whats-new.json")) as Array<{
  id: string;
  date: string;
  title: string;
  bullets: string[];
}>;

const entry = (id: string) => ({ id, date: "2026-11-05", title: id, bullets: ["one", "two"] });
const LIST = [entry("c"), entry("b"), entry("a")];

test("the shipped changelog is newest first and every entry is well-formed", () => {
  assert.ok(Array.isArray(RAW) && RAW.length > 0);
  const ids = new Set<string>();
  let previous = "9999-12-31";
  for (const item of RAW) {
    assert.deepEqual(Object.keys(item).sort(), ["bullets", "date", "id", "title"], item.id);
    assert.ok(validId(item.id), `bad id ${item.id}`);
    assert.equal(ids.has(item.id), false, `duplicate id ${item.id}`);
    ids.add(item.id);
    assert.match(item.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(!Number.isNaN(Date.parse(`${item.date}T00:00:00Z`)), item.date);
    assert.ok(item.date <= previous, `${item.id} is out of order`);
    previous = item.date;
    assert.ok(item.title.trim().length > 0 && item.title.length <= 60, item.id);
    assert.ok(item.bullets.length >= 2 && item.bullets.length <= 4, `${item.id} needs 2–4 bullets`);
    for (const bullet of item.bullets) assert.ok(bullet.trim().length > 0 && bullet.length <= 140, bullet);
  }
  assert.equal(normalizeEntries(RAW).length, RAW.length);
});

test("unseen entries: nothing seen shows all, a known id shows what is newer, an unknown id shows none", () => {
  assert.deepEqual(unseenEntries(LIST, null).map((item) => item.id), ["c", "b", "a"]);
  assert.deepEqual(unseenEntries(LIST, "a").map((item) => item.id), ["c", "b"]);
  assert.deepEqual(unseenEntries(LIST, "b").map((item) => item.id), ["c"]);
  assert.deepEqual(unseenEntries(LIST, "c"), []);
  assert.deepEqual(unseenEntries(LIST, "from-a-newer-build"), []);
  assert.deepEqual(unseenEntries([], null), []);
  assert.deepEqual(unseenEntries(null, null), []);
  assert.equal(latestId(LIST), "c");
  assert.equal(latestId([]), null);
});

test("the newer of the phone's and the account's seen id wins", () => {
  assert.equal(newerSeen(LIST, null, null), null);
  assert.equal(newerSeen(LIST, "a", null), "a");
  assert.equal(newerSeen(LIST, null, "b"), "b");
  assert.equal(newerSeen(LIST, "a", "c"), "c");
  assert.equal(newerSeen(LIST, "c", "a"), "c");
  assert.equal(newerSeen(LIST, "b", "b"), "b");
  assert.equal(newerSeen(LIST, "a", "unknown"), "unknown");
  assert.equal(newerSeen(LIST, "unknown", "c"), "unknown");
});

test("broken entries are dropped instead of breaking the popup", () => {
  const kept = normalizeEntries([
    entry("ok"),
    { id: "Bad Id", date: "2026-11-05", title: "x", bullets: ["y"] },
    { id: "no-bullets", date: "2026-11-05", title: "x", bullets: [] },
    { id: "no-title", date: "2026-11-05", title: " ", bullets: ["y"] },
    { id: "blank-bullet", date: "2026-11-05", title: "x", bullets: ["y", ""] },
    null,
    "nope",
  ]);
  assert.deepEqual(kept.map((item) => item.id), ["ok"]);
  assert.deepEqual(normalizeEntries({ not: "a list" }), []);
});

test("entry dates read as a short day, month, and year", () => {
  assert.equal(formatEntryDate("2026-11-05"), "5 Nov 2026");
  assert.equal(formatEntryDate("2026-01-31"), "31 Jan 2026");
  assert.equal(formatEntryDate("soon"), "soon");
  assert.equal(SEEN_KEY, "fn_whats_new_seen");
});

test("the service worker caches the changelog and matches the app's build label", () => {
  const sw = read("../public/sw.js");
  const cache = /const CACHE = "(hangry-v(\d+))"/.exec(sw);
  assert.equal(cache?.[1], "hangry-v38");
  const shell = /const SHELL = (\[[^\]]*\])/.exec(sw)?.[1] ?? "[]";
  const paths = JSON.parse(shell) as string[];
  assert.ok(paths.includes("/whats-new.js"));
  assert.ok(paths.includes("/whats-new.json"));
  const app = read("../public/app.js");
  assert.equal(/const APP_VERSION = "([^"]+)"/.exec(app)?.[1], cache?.[1]);
});

test("/api/me carries whatsNewSeen and POST /api/me/whats-new stores it", async () => {
  await withApp(async ({ port, db }) => {
    const alex = await api(port, "POST", "/api/auth/start", { body: { name: "Alex" }, status: 201 });
    assert.equal(alex.user.whatsNewSeen, null);
    await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Friends" }, status: 201 });

    const fresh = await api(port, "GET", "/api/me", { token: alex.token });
    assert.equal(fresh.user.whatsNewSeen, null);

    const saved = await api(port, "POST", "/api/me/whats-new", {
      token: alex.token,
      body: { id: RAW[0].id },
      status: 200,
    });
    assert.deepEqual(saved, { whatsNewSeen: RAW[0].id });
    const after = await api(port, "GET", "/api/me", { token: alex.token });
    assert.equal(after.user.whatsNewSeen, RAW[0].id);
    const row = db.prepare("SELECT whats_new_seen AS seen FROM users WHERE id = ?").get(alex.user.id) as { seen: string };
    assert.equal(row.seen, RAW[0].id);

    // A second device of the same person signs in and already has it.
    const recovered = await api(port, "POST", "/api/auth/recover", { body: { token: alex.buzzToken }, status: 200 });
    const other = await api(port, "GET", "/api/me", { token: recovered.token });
    assert.equal(other.user.whatsNewSeen, RAW[0].id);

    for (const id of ["", "Has Caps", "a".repeat(65), "semi;colon", 42, null]) {
      const bad = await api(port, "POST", "/api/me/whats-new", { token: alex.token, body: { id }, status: 400 });
      assert.equal(bad.error, "id is required");
    }
    await api(port, "POST", "/api/me/whats-new", { body: { id: "x" }, status: 401 });
    assert.equal((await api(port, "GET", "/api/me", { token: alex.token })).user.whatsNewSeen, RAW[0].id);
  });
});

test("whats-new.json is served as JSON", async () => {
  await withApp(async ({ port }) => {
    const response = await fetch(`http://127.0.0.1:${port}/whats-new.json`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
    assert.deepEqual(await response.json(), RAW);
    const module = await fetch(`http://127.0.0.1:${port}/whats-new.js`);
    assert.equal(module.status, 200);
    assert.match(module.headers.get("content-type") ?? "", /^text\/javascript/);
  });
});

test("an older database gains the whats_new_seen column", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { openDb } = await import("../src/db.js");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hangry-wn-"));
  const file = path.join(dir, "old.db");
  try {
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      buzz_token TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
    )`);
    old.prepare("INSERT INTO users (id, name, token_hash, buzz_token, created_at) VALUES ('u1', 'Old', 'h', 'b', 1)").run();
    old.close();
    const db = openDb(file);
    const cols = (db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>).map((col) => col.name);
    assert.ok(cols.includes("whats_new_seen"));
    const row = db.prepare("SELECT whats_new_seen AS seen FROM users WHERE id = 'u1'").get() as { seen: string | null };
    assert.equal(row.seen, null);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
    assert.ok(tables.includes("feedback"));
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
