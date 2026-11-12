import assert from "node:assert/strict";
import test from "node:test";
import {
  BUZZ_ANIMATIONS,
  BUZZ_FRESH_MS,
  BUZZ_INDEX_KEY,
  BUZZ_SEEN_KEY,
  buzzerStage,
  cleanBuzzName,
  consumeBuzz,
  fitText,
  nextBuzzIndex,
  pickBuzz,
} from "../public/js/buzzer.js";

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => (data.has(key) ? data.get(key)! : null),
    setItem: (key: string, value: string) => void data.set(key, String(value)),
  };
}

const throwing = {
  getItem: () => { throw new Error("denied"); },
  setItem: () => { throw new Error("denied"); },
};

const NOW = 1_800_000_000_000;
const social = (id: string, buzzedAt: unknown, name = "Alex") => ({ id, buzzedAt, creator: { id: `u-${id}`, name } });

test("the animations cycle in order and wrap", () => {
  assert.deepEqual(BUZZ_ANIMATIONS, ["shockwave", "slam", "flood", "bell"]);
  const storage = fakeStorage();
  const seen = Array.from({ length: 5 }, () => nextBuzzIndex(storage));
  assert.deepEqual(seen, ["shockwave", "slam", "flood", "bell", "shockwave"]);
});

test("the index persists in storage between calls", () => {
  const storage = fakeStorage();
  assert.equal(nextBuzzIndex(storage), "shockwave");
  assert.equal(storage.data.get(BUZZ_INDEX_KEY), "1");
  assert.equal(nextBuzzIndex(storage), "slam");
  assert.equal(storage.data.get(BUZZ_INDEX_KEY), "2");
  assert.equal(nextBuzzIndex(fakeStorage({ [BUZZ_INDEX_KEY]: "3" })), "bell");
});

test("a garbage stored index starts over at the first animation", () => {
  for (const bad of ["", "abc", "-1", "1.5", "NaN", "{}", "1e3"]) {
    const storage = fakeStorage({ [BUZZ_INDEX_KEY]: bad });
    assert.equal(nextBuzzIndex(storage), "shockwave", `value ${JSON.stringify(bad)}`);
    assert.equal(storage.data.get(BUZZ_INDEX_KEY), "1");
  }
  assert.equal(nextBuzzIndex(fakeStorage({ [BUZZ_INDEX_KEY]: "9" })), "slam");
});

test("a throwing storage never breaks the index", () => {
  assert.equal(nextBuzzIndex(throwing), "shockwave");
  assert.equal(nextBuzzIndex(null), "shockwave");
  assert.equal(nextBuzzIndex(undefined), "shockwave");
  const readOnly = { getItem: () => "2", setItem: () => { throw new Error("full"); } };
  assert.equal(nextBuzzIndex(readOnly), "flood");
});

test("pickBuzz takes the newest fresh unseen buzz", () => {
  const list = [social("a", NOW - 30_000), social("b", NOW - 5_000), social("c", NOW - 60_000)];
  assert.equal(pickBuzz(list, 0, NOW)?.id, "b");
  assert.equal(pickBuzz(list, undefined as unknown as number, NOW)?.id, "b");
  assert.equal(pickBuzz(list, "x" as unknown as number, NOW)?.id, "b");
});

test("pickBuzz ignores null, old, seen, stale and far-future values", () => {
  assert.equal(pickBuzz([social("a", null), social("b", undefined), social("c", "123")], 0, NOW), null);
  assert.equal(pickBuzz([social("a", NOW - 10_000)], NOW - 10_000, NOW), null, "equal to seen is not newer");
  assert.equal(pickBuzz([social("a", NOW - 10_000)], NOW - 5_000, NOW), null, "older than seen");
  assert.equal(pickBuzz([social("a", NOW - BUZZ_FRESH_MS - 1)], 0, NOW), null, "stale");
  assert.equal(pickBuzz([social("a", NOW - BUZZ_FRESH_MS)], 0, NOW)?.id, "a", "edge of fresh");
  assert.equal(pickBuzz([social("a", NOW + 61_000)], 0, NOW), null, "far future");
  assert.equal(pickBuzz([social("a", NOW + 30_000)], 0, NOW)?.id, "a", "small clock skew is fine");
  assert.equal(pickBuzz([social("a", NaN), social("b", Infinity)], 0, NOW), null);
  assert.equal(pickBuzz([], 0, NOW), null);
  assert.equal(pickBuzz(null as unknown as [], 0, NOW), null);
  // A stale newest is skipped, a fresh older one still plays.
  assert.equal(pickBuzz([social("old", NOW - 500_000), social("new", NOW - 1_000)], 0, NOW)?.id, "new");
});

test("consumeBuzz returns the social once, then null for the same data", () => {
  const storage = fakeStorage();
  const list = [social("a", NOW - 2_000, "Sam"), social("b", null, "Kim")];
  const first = consumeBuzz(list, storage, NOW);
  assert.equal(first?.social.id, "a");
  assert.equal(first?.name, "Sam");
  assert.equal(storage.data.get(BUZZ_SEEN_KEY), String(NOW - 2_000));
  assert.equal(consumeBuzz(list, storage, NOW + 1_000), null);
  // A re-press moves buzzedAt forward and plays again.
  const again = consumeBuzz([social("a", NOW + 5_000, "Sam")], storage, NOW + 6_000);
  assert.equal(again?.social.id, "a");
});

test("consumeBuzz skips a stale buzz silently but still advances the marker", () => {
  const storage = fakeStorage();
  const stale = NOW - BUZZ_FRESH_MS - 5_000;
  assert.equal(consumeBuzz([social("a", stale)], storage, NOW), null);
  assert.equal(storage.data.get(BUZZ_SEEN_KEY), String(stale));
  // The marker never moves backwards.
  assert.equal(consumeBuzz([social("a", stale - 10_000)], storage, NOW), null);
  assert.equal(storage.data.get(BUZZ_SEEN_KEY), String(stale));
});

test("consumeBuzz ignores in-app socials and leaves the animation index alone", () => {
  const storage = fakeStorage();
  assert.equal(consumeBuzz([social("a", null), social("b", null)], storage, NOW), null);
  assert.equal(storage.data.has(BUZZ_SEEN_KEY), false);
  assert.equal(storage.data.has(BUZZ_INDEX_KEY), false);
  consumeBuzz([social("a", NOW - 1_000)], storage, NOW);
  assert.equal(storage.data.has(BUZZ_INDEX_KEY), false);
});

test("consumeBuzz survives a throwing storage and a missing creator name", () => {
  assert.equal(consumeBuzz([social("a", NOW - 1_000)], throwing, NOW)?.social.id, "a");
  assert.equal(consumeBuzz([{ id: "a", buzzedAt: NOW - 1_000 }], fakeStorage(), NOW)?.name, "Someone");
});

test("names are flattened, capped at 24 characters and never empty", () => {
  assert.equal(cleanBuzzName("  Alex \n Smith "), "Alex Smith");
  assert.equal([...cleanBuzzName("x".repeat(40))].length, 24);
  assert.equal(cleanBuzzName(""), "Someone");
  assert.equal(cleanBuzzName(null), "Someone");
  assert.equal([...cleanBuzzName("\u{1F355}".repeat(30))].length, 24);
});

test("fitText shrinks first, then cuts with an ellipsis", () => {
  const measure = (text: string, px: number) => [...text].length * px * 0.5;
  assert.deepEqual(fitText(measure, "Alex", 50, 300, 20), { text: "Alex", size: 50 });
  const shrunk = fitText(measure, "A".repeat(20), 50, 300, 20);
  assert.equal(shrunk.text, "A".repeat(20));
  assert.ok(shrunk.size < 50 && shrunk.size >= 20);
  assert.ok(measure(shrunk.text, shrunk.size) <= 300);
  const cut = fitText(measure, "A".repeat(60), 50, 300, 20);
  assert.equal(cut.size, 20);
  assert.ok(cut.text.endsWith("\u2026"));
  assert.ok(measure(cut.text, cut.size) <= 300);
  // The fixed suffix counts toward the width.
  const withSuffix = fitText(measure, "Alexander", 30, 120, 12, " is free now");
  assert.ok(measure(withSuffix.text + " is free now", withSuffix.size) <= 120);
});

test("buzzerStage shakes the content and oversizes the dim background", () => {
  const still = buzzerStage(390, 844, 0);
  assert.deepEqual(still, { dx: 0, dy: 0, x: 0, y: 0, w: 390, h: 844 });
  const shaken = buzzerStage(390, 844, 14, () => 1);
  assert.equal(shaken.dx, 14);
  assert.equal(shaken.dy, 14);
  assert.ok(shaken.x <= -14 && shaken.y <= -14);
  assert.ok(shaken.x + shaken.w >= 390 + 14 && shaken.y + shaken.h >= 844 + 14);
  const back = buzzerStage(390, 844, 14, () => 0);
  assert.equal(back.dx, -14);
  assert.ok(back.x <= back.dx && back.x + back.w + back.dx >= 390);
});
