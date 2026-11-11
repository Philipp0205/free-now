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

test("the card Share entry is in the changelog, in plain words without an em dash", () => {
  const share = RAW.find((item) => item.id === "2026-11-07-card-share");
  assert.ok(share, "card Share entry");
  assert.equal(share.title, "Share plans anywhere");
  for (const text of [share.title, ...share.bullets]) assert.ok(!text.includes("\u2014"), text);
});

test("the newest entry is who's in on the card, in plain words", () => {
  const top = RAW[0];
  assert.equal(top.id, "2026-11-10-card-whos-in");
  assert.equal(top.date, "2026-11-10");
  assert.equal(top.title, "See who's in on the card");
  assert.equal(top.bullets.length, 2);
  assert.match(top.bullets[0], /people who are coming/);
  assert.match(top.bullets[1], /can't make it/);
  assert.match(top.bullets[1], /details/);
  for (const line of [top.title, ...top.bullets]) assert.ok(!line.includes("\u2014"), line);
});

test("the Zürich dark map entry is kept, in plain words without an em dash", () => {
  const top = RAW.find((item) => item.id === "2026-11-10-zurich-map")!;
  assert.ok(top, "Zürich dark map entry");
  assert.equal(top.id, "2026-11-10-zurich-map");
  assert.equal(top.date, "2026-11-10");
  assert.equal(top.title, "Dark map in Zürich too");
  assert.equal(top.bullets.length, 3);
  const text = [top.title, ...top.bullets].join(" ");
  assert.match(text, /Zürich/);
  assert.match(text, /Stuttgart/);
  assert.match(text, /between the two cities/);
  assert.match(text, /regular street map/);
  assert.doesNotMatch(text, /\b(pmtiles|archive|vector|tiles?|zoom|bounds)\b/i);
  for (const line of [top.title, ...top.bullets]) assert.ok(!line.includes("\u2014"), line);
});

test("the circle switch alerts entry is kept, in plain words", () => {
  const top = RAW.find((item) => item.id === "2026-11-10-circle-switch-alerts")!;
  assert.ok(top, "circle switch alerts entry");
  assert.equal(top.id, "2026-11-10-circle-switch-alerts");
  assert.equal(top.date, "2026-11-10");
  assert.equal(top.title, "Alerts no longer repeat when you switch circles");
  assert.equal(top.bullets.length, 3);
  const text = [top.title, ...top.bullets].join(" ");
  assert.match(text, /already seen/);
  assert.match(text, /shows once/);
  for (const line of top.bullets) assert.ok(line.length <= 140, line);
  for (const line of [top.title, ...top.bullets]) assert.ok(!line.includes("\u2014"), line);
});

test("the Flic button entry is kept, in plain words", () => {
  const top = RAW.find((item) => item.id === "2026-11-10-flic-button")!;
  assert.ok(top, "Flic button entry");
  assert.equal(top.id, "2026-11-10-flic-button");
  assert.equal(top.date, "2026-11-10");
  assert.ok(top.title.length <= 60, top.title);
  assert.ok(top.bullets.length <= 4);
  for (const line of top.bullets) assert.ok(line.length <= 140, line);
  const text = [top.title, ...top.bullets].join(" ");
  assert.match(text, /Flic button/);
  assert.match(text, /You tab/);
  for (const line of [top.title, ...top.bullets]) assert.ok(!line.includes("\u2014"), line);
});

test("calendar availability is listed, in plain words", () => {
  const top = RAW.find((entry) => entry.id === "2026-11-10-calendar-availability")!;
  assert.equal(top.id, "2026-11-10-calendar-availability");
  assert.equal(top.date, "2026-11-10");
  assert.ok(top.title.length <= 60, top.title);
  assert.ok(top.bullets.length <= 4);
  for (const line of top.bullets) assert.ok(line.length <= 140, line);
  const text = [top.title, ...top.bullets].join(" ");
  assert.match(text, /busy or free/);
  assert.match(text, /never the names/);
  assert.match(text, /until you turn one on/);
  assert.match(text, /I'm in/);
  for (const line of [top.title, ...top.bullets]) assert.ok(!line.includes("\u2014"), line);
});

test("the monthly calendar entry is kept, in plain words", () => {
  const top = RAW.find((item) => item.id === "2026-11-10-calendar-month")!;
  assert.ok(top, "monthly calendar entry");
  assert.equal(top.id, "2026-11-10-calendar-month");
  assert.equal(top.date, "2026-11-10");
  assert.equal(top.title, "Events: a monthly calendar and the map");
  assert.ok(top.title.length <= 60, top.title);
  assert.equal(top.bullets.length, 4);
  const text = [top.title, ...top.bullets].join(" ");
  assert.match(text, /called Events/);
  assert.match(text, /calendar icon/);
  assert.match(text, /Map \/ Calendar/);
  assert.match(text, /Calendar is the first view/);
  assert.match(text, /remembers/);
  assert.match(text, /past days/);
  assert.match(text, /who is in/);
  assert.match(text, /This circle \/ All circles works on the calendar/);
  for (const line of [top.title, ...top.bullets]) assert.ok(!line.includes("\u2014"), line);
});

test("the clearer notification icon entry is kept, in plain words", () => {
  const top = RAW.find((item) => item.id === "2026-11-10-notification-icon");
  assert.ok(top, "notification icon entry");
  assert.equal(top.id, "2026-11-10-notification-icon");
  assert.equal(top.date, "2026-11-10");
  assert.equal(top.bullets.length, 3);
  const text = [top.title, ...top.bullets].join(" ");
  assert.match(text, /Android/);
  assert.match(text, /solid dot/);
  for (const line of [top.title, ...top.bullets]) assert.ok(!line.includes("\u2014"), line);
});

test("the one map for every circle entry stays, in plain words", () => {
  const top = RAW.find((item) => item.id === "2026-11-09-map-all-circles")!;
  assert.equal(top.id, "2026-11-09-map-all-circles");
  assert.equal(top.date, "2026-11-09");
  assert.equal(top.title, "One map for every circle");
  assert.equal(top.bullets.length, 3);
  const text = [top.title, ...top.bullets].join(" ");
  assert.match(text, /This circle \/ All circles/);
  assert.match(text, /names the circle/);
  for (const line of [top.title, ...top.bullets]) assert.ok(!line.includes("\u2014"), line);
});

test("the glass map pins entry is kept, in plain words", () => {
  const top = RAW.find((item) => item.id === "2026-11-09-glass-pins")!;
  assert.ok(top, "glass pins entry");
  assert.equal(top.title, "Nicer map pins");
  assert.equal(top.bullets.length, 3);
  const text = [top.title, ...top.bullets].join(" ");
  assert.match(text, /glass chip/);
  assert.match(text, /Reduce motion/);
  for (const line of [top.title, ...top.bullets]) assert.ok(!line.includes("\u2014"), line);
});

test("the map card close entry is kept, in plain words without an em dash", () => {
  const top = RAW.find((item) => item.id === "2026-11-09-map-card-close");
  assert.ok(top, "map card close entry");
  assert.equal(top.title, "Close the map card");
  assert.equal(top.bullets.length, 2);
  assert.match(top.bullets[0], /X in its corner/);
  assert.match(top.bullets[1], /empty spot on the map/);
  assert.match(top.bullets[1], /Escape/);
  for (const line of [top.title, ...top.bullets]) assert.ok(!line.includes("\u2014"), line);
});

test("the dark map that sticks over the covered area is kept, in plain words", () => {
  const top = RAW.find((item) => item.id === "2026-11-09-dark-map-sticks");
  assert.ok(top, "dark map sticks entry");
  assert.equal(top.title, "The dark map stays put");
  assert.equal(top.bullets.length, 2);
  assert.equal(
    top.bullets[0],
    "Dark map sticks while you look at the covered area, even if the edges stick out a little; zoom out past it and the usual map returns.",
  );
  const text = [top.title, ...top.bullets].join(" ");
  assert.doesNotMatch(text, /\b(now live|everywhere|worldwide|all over)\b/i);
  for (const line of [top.title, ...top.bullets]) assert.ok(!line.includes("\u2014"), line);
});

test("the dark map entry is kept, and it does not claim the map is live everywhere", () => {
  const top = RAW.find((item) => item.id === "2026-11-08-dark-map-ready");
  assert.ok(top, "dark map entry");
  assert.equal(top.title, "A dark map, where we have one");
  assert.equal(top.bullets.length, 3);
  const text = [top.title, ...top.bullets].join(" ");
  assert.match(text, /only for an area the server has a map file for/);
  assert.match(text, /usual map/);
  assert.doesNotMatch(text, /\b(now live|everywhere|worldwide|all over)\b/i);
  for (const line of [top.title, ...top.bullets]) assert.ok(!line.includes("\u2014"), line);
});

test("the menu and tab polish entry is kept, in plain words without an em dash", () => {
  const top = RAW.find((item) => item.id === "2026-11-08-menu-tab-polish");
  assert.ok(top, "menu and tab polish entry");
  assert.equal(top.title, "Smoother menus and tabs");
  assert.equal(top.bullets.length, 2);
  for (const text of [top.title, ...top.bullets]) assert.ok(!text.includes("\u2014"), text);
  assert.ok(RAW.some((item) => item.id === "2026-11-07-plan-another-day"), "older entries are kept");
});

test("Plan for another day is in the changelog, in plain words without an em dash", () => {
  const entry = RAW.find((item) => item.id === "2026-11-07-plan-another-day");
  assert.ok(entry, "Plan for another day entry");
  assert.equal(entry.title, "Now and later first");
  assert.equal(entry.bullets.length, 2);
  assert.ok(entry.bullets.some((bullet) => bullet.includes("Plan for another day")));
  for (const text of [entry.title, ...entry.bullets]) assert.ok(!text.includes("\u2014"), text);
});

test("the map pins entry is in the changelog, in plain words without an em dash", () => {
  const top = RAW.find((item) => item.id === "2026-11-08-map-dates-buzz");
  assert.ok(top, "map pins entry");
  assert.equal(top.id, "2026-11-08-map-dates-buzz");
  assert.equal(top.title, "Livelier map pins");
  assert.equal(top.bullets.length, 3);
  assert.ok(top.bullets.some((bullet) => bullet.includes("Later today 19:00")));
  assert.ok(top.bullets.some((bullet) => bullet.includes("buzz")));
  assert.ok(top.bullets.some((bullet) => bullet.includes("crowd")));
  for (const text of [top.title, ...top.bullets]) assert.ok(!text.includes("\u2014"), text);
  assert.ok(RAW.some((item) => item.id === "2026-11-07-plan-another-day"), "older entries are kept");
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
  assert.equal(cache?.[1], "hangry-v71");
  const shell = /const SHELL = (\[[^\]]*\])/.exec(sw)?.[1] ?? "[]";
  const paths = JSON.parse(shell) as string[];
  assert.ok(paths.includes("/whats-new.js"));
  assert.ok(paths.includes("/whats-new.json"));
  assert.ok(paths.includes("/map-pin.js"));
  assert.ok(paths.includes("/calendar-month.js"));
  assert.ok(paths.includes("/freebusy.js"));
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
