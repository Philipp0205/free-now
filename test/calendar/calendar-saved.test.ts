import assert from "node:assert/strict";
import test from "node:test";
import { SAVED_CAP, SAVED_KEY, calendarSavedState, planWhenWhere, readSaved, sequenceFromIcs, writeSaved } from "../../public/js/calendar-saved.js";

function memory() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
  };
}

test("saved state is none, current or stale against the plan's calendarRev", () => {
  const map = { p1: 5 };
  assert.equal(calendarSavedState({ id: "p2", calendarRev: 0 }, map), "none");
  assert.equal(calendarSavedState({ id: "p1", calendarRev: 5 }, map), "current");
  assert.equal(calendarSavedState({ id: "p1", calendarRev: 9 }, map), "stale");
  assert.equal(calendarSavedState({ id: "p1" }, {}), "none");
  assert.equal(calendarSavedState({ id: "p1", calendarRev: 0 }, { p1: 0 }), "current", "a rev of 0 still counts as saved");
});

test("a save is read back from the same store", () => {
  const store = memory();
  writeSaved("p1", 3, store);
  writeSaved("p2", 0, store);
  assert.deepEqual(readSaved(store), { p1: 3, p2: 0 });
  writeSaved("p1", 7, store);
  assert.equal(readSaved(store).p1, 7);
});

test("missing, broken or junk storage never throws", () => {
  assert.deepEqual(readSaved(null), {});
  assert.doesNotThrow(() => writeSaved("p1", 1, null));
  const broken = { getItem: () => { throw new Error("no"); }, setItem: () => { throw new Error("full"); } };
  assert.deepEqual(readSaved(broken), {});
  assert.doesNotThrow(() => writeSaved("p1", 1, broken));
  const junk = memory();
  junk.setItem(SAVED_KEY, "{not json");
  assert.deepEqual(readSaved(junk), {});
  junk.setItem(SAVED_KEY, JSON.stringify({ a: "x", b: 2, c: null }));
  assert.deepEqual(readSaved(junk), { b: 2 });
  junk.setItem(SAVED_KEY, "[1]");
  assert.deepEqual(readSaved(junk), {});
});

test("the map keeps the newest 100 plans", () => {
  const store = memory();
  for (let index = 0; index < SAVED_CAP + 5; index += 1) writeSaved(`p${index}`, index, store);
  const map = readSaved(store);
  assert.equal(Object.keys(map).length, SAVED_CAP);
  assert.equal(map.p0, undefined, "the oldest are dropped");
  assert.equal(map.p4, undefined);
  assert.equal(map.p5, 5);
  assert.equal(map[`p${SAVED_CAP + 4}`], SAVED_CAP + 4);
});

test("SEQUENCE is read from file text, and when and where is a stable key", () => {
  assert.equal(sequenceFromIcs("BEGIN:VEVENT\r\nSEQUENCE:42\r\nEND:VEVENT\r\n"), 42);
  assert.equal(sequenceFromIcs("nothing"), null);
  const plan = { forDate: "2026-06-02", time: "19:00", endsAt: null, place: "Bar" };
  assert.equal(planWhenWhere(plan), planWhenWhere({ ...plan }));
  assert.notEqual(planWhenWhere(plan), planWhenWhere({ ...plan, time: "20:00" }));
});
