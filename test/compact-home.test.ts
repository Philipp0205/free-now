import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPACT_HOME_KEY,
  COMPACT_WHO_CAP,
  compactTitle,
  compactWhen,
  compactWho,
  readCompactHome,
  writeCompactHome,
} from "../public/js/compact-home.js";

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => (data.has(key) ? data.get(key)! : null),
    setItem: (key: string, value: string) => { data.set(key, String(value)); },
  };
}

const person = (id: string, name: string, reply?: string) => ({ id, name, ...(reply ? { reply } : {}) });
const NOW = Date.parse("2026-11-20T12:00:00Z");
const TZ = "Europe/Berlin";

test("the key is named for what it does", () => {
  assert.equal(COMPACT_HOME_KEY, "fn_compact_home");
});

test("the default is the cards", () => {
  assert.equal(readCompactHome(fakeStorage()), false);
  assert.equal(readCompactHome(null), false);
});

test("compact is saved and read back, and so are the cards again", () => {
  const store = fakeStorage();
  writeCompactHome(true, store);
  assert.equal(store.data.get(COMPACT_HOME_KEY), "1");
  assert.equal(readCompactHome(store), true);
  writeCompactHome(false, store);
  assert.equal(readCompactHome(store), false);
});

test("a fresh read of the same store, as after a reload, still sees the saved choice", () => {
  const store = fakeStorage();
  writeCompactHome(true, store);
  const afterReload = fakeStorage(Object.fromEntries(store.data));
  assert.equal(readCompactHome(afterReload), true);
});

test("an unreadable or unwritable store falls back to the cards and does not throw", () => {
  const broken = {
    getItem: () => { throw new Error("denied"); },
    setItem: () => { throw new Error("full"); },
  };
  assert.equal(readCompactHome(broken as unknown as Storage), false);
  assert.doesNotThrow(() => writeCompactHome(true, broken as unknown as Storage));
  assert.equal(readCompactHome(fakeStorage({ [COMPACT_HOME_KEY]: "banana" })), false);
});

test("the who-line shows a few names, then +N for the rest", () => {
  const host = person("h", "Hana");
  const joined = ["Alex", "Bea", "Cy", "Dee", "Eli"].map((name, i) => person(`p${i}`, name, "in"));
  const who = compactWho(host, joined);
  assert.equal(COMPACT_WHO_CAP, 3);
  assert.deepEqual(who.names, ["Hana", "Alex", "Bea"]);
  assert.equal(who.shown.length, 3);
  assert.equal(who.more, 3);
  assert.equal(who.text, "Hana, Alex, Bea and 3 more");
});

test("the who-line has no +N when everyone fits, and leaves out people who can't make it", () => {
  const who = compactWho(person("h", "Hana"), [person("a", "Alex", "in"), person("b", "Bea", "declined")]);
  assert.deepEqual(who.names, ["Hana", "Alex"]);
  assert.equal(who.more, 0);
  assert.equal(who.text, "Hana, Alex");
});

test("empty, missing and unknown names do not blow up", () => {
  const who = compactWho(person("h", "  "), [{ id: "a" }, { id: "b", name: null }, null, undefined]);
  assert.deepEqual(who.names, ["Someone", "Someone", "Someone"]);
  assert.equal(who.more, 0);
  assert.doesNotThrow(() => compactWho(undefined));
  assert.deepEqual(compactWho(undefined, undefined).names, []);
  assert.equal(compactWho(undefined, null as unknown as unknown[]).text, "");
});

test("the title is the note, with the card's fallbacks", () => {
  assert.equal(compactTitle("plan", { note: "Pizza night" }, NOW), "Pizza night");
  assert.equal(compactTitle("plan", {}, NOW), "Plan");
  assert.equal(compactTitle("social", {}, NOW), "Free now");
  assert.equal(compactTitle("social", { startsAt: NOW + 3600_000 }, NOW), "Free later");
  assert.equal(compactTitle("social", { note: "Coffee" }, NOW), "Coffee");
});

test("a plan's date reads Today, Tomorrow, a weekday or a short date, with the time", () => {
  assert.equal(compactWhen("plan", { forDate: "2026-11-20", time: "19:00" }, NOW, TZ), "Today 19:00");
  assert.equal(compactWhen("plan", { forDate: "2026-11-21" }, NOW, TZ), "Tomorrow");
  assert.equal(compactWhen("plan", { forDate: "2026-11-24", time: "08:30" }, NOW, TZ), "Tuesday 08:30");
  assert.equal(compactWhen("plan", { forDate: "2026-12-14" }, NOW, TZ), "Mon 14 Dec");
  assert.equal(compactWhen("plan", { whenLabel: "Soon" }, NOW, TZ), "Soon");
});

test("a free post reads Now while live, and the start while it is later", () => {
  assert.equal(compactWhen("social", { startsAt: null }, NOW, TZ), "Now");
  assert.equal(compactWhen("social", { startsAt: NOW - 1000 }, NOW, TZ), "Now");
  assert.equal(compactWhen("social", { startsAt: Date.parse("2026-11-20T18:00:00Z") }, NOW, TZ), "Today 19:00");
  assert.equal(compactWhen("social", { startsAt: Date.parse("2026-11-21T09:00:00Z") }, NOW, TZ), "Tomorrow 10:00");
});
