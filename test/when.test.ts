import assert from "node:assert/strict";
import test from "node:test";
import { isLaterToday, minLaterClock, nextLaterDay, nextLaterSlot, zonedParts } from "../public/js/when.js";

const UTC = "UTC";
const BERLIN = "Europe/Berlin";

test("next later slot is the upcoming half hour", () => {
  // 14:10 + 15 min = 14:25, which rounds up to 14:30.
  assert.equal(nextLaterSlot(Date.parse("2026-06-15T14:10:00Z"), UTC), "14:30");
  // 14:46 + 15 min = 15:01, which rounds up to 15:30.
  assert.equal(nextLaterSlot(Date.parse("2026-06-15T14:46:00Z"), UTC), "15:30");
  // 14:15 + 15 min lands on 14:30 and stays there.
  assert.equal(nextLaterSlot(Date.parse("2026-06-15T14:15:00Z"), UTC), "14:30");
});

test("a time earlier than now is not later today", () => {
  const now = Date.parse("2026-06-15T14:10:00Z");
  assert.equal(minLaterClock(now, UTC), "14:11");
  assert.equal(isLaterToday("14:10", now, UTC), false);
  assert.equal(isLaterToday("14:00", now, UTC), false);
  assert.equal(isLaterToday("14:11", now, UTC), true);
});

test("a clock that would round past midnight stays on the latest today slot", () => {
  // 23:20 + 15 min = 23:35, which rounds to 24:00. 23:59 is still later today.
  assert.equal(nextLaterSlot(Date.parse("2026-06-15T23:20:00Z"), UTC), "23:59");
  assert.equal(nextLaterDay(Date.parse("2026-06-15T23:20:00Z"), UTC), "today");
  // 23:50 + 15 min is already the next calendar day, but 23:59 is still later today.
  assert.equal(nextLaterSlot(Date.parse("2026-06-15T23:50:00Z"), UTC), "23:59");
  assert.equal(nextLaterDay(Date.parse("2026-06-15T23:50:00Z"), UTC), "today");
});

test("Europe/Berlin around local midnight uses the same rules", () => {
  // 2026-11-04 is CET (UTC+1). 22:10Z is 23:10 in Berlin.
  const ten = Date.parse("2026-11-04T22:10:00Z");
  assert.equal(nextLaterSlot(ten, BERLIN), "23:30");
  assert.equal(nextLaterSlot(ten), "23:30");
  assert.equal(minLaterClock(ten, BERLIN), "23:11");
  assert.equal(isLaterToday("23:10", ten, BERLIN), false);
  assert.equal(isLaterToday("23:00", ten, BERLIN), false);
  assert.equal(isLaterToday("23:11", ten, BERLIN), true);

  // 23:20 Berlin + 15 min would round to 24:00, so the default caps at 23:59.
  assert.equal(nextLaterSlot(Date.parse("2026-11-04T22:20:00Z"), BERLIN), "23:59");
  // 23:50 Berlin + 15 min is the next calendar day, and 23:59 is still later today.
  assert.equal(nextLaterSlot(Date.parse("2026-11-04T22:50:00Z"), BERLIN), "23:59");
  // During the last minute, now+1min is tomorrow, so every clock is rejected.
  const lastMinute = Date.parse("2026-11-04T22:59:30Z");
  assert.equal(minLaterClock(lastMinute, BERLIN), "");
  assert.equal(isLaterToday("23:59", lastMinute, BERLIN), false);
  assert.equal(nextLaterSlot(lastMinute, BERLIN), "00:30");
  assert.equal(nextLaterDay(lastMinute, BERLIN), "tomorrow");
});

test("Berlin boundaries keep a today slot through 23:58 and name midnight as tomorrow", () => {
  // 2026-11-04 is CET (UTC+1).
  assert.equal(nextLaterSlot(Date.parse("2026-11-04T22:15:00Z"), BERLIN), "23:30");
  assert.equal(nextLaterDay(Date.parse("2026-11-04T22:15:00Z"), BERLIN), "today");
  assert.equal(isLaterToday("23:30", Date.parse("2026-11-04T22:15:00Z"), BERLIN), true);

  // 23:16 + 15 min is 23:31, which rounds to 24:00. Cap at 23:59 instead of dropping the slot.
  const sixteen = Date.parse("2026-11-04T22:16:00Z");
  assert.equal(nextLaterSlot(sixteen, BERLIN), "23:59");
  assert.equal(nextLaterDay(sixteen, BERLIN), "today");
  assert.equal(isLaterToday("23:59", sixteen, BERLIN), true);
  assert.equal(isLaterToday("23:30", sixteen, BERLIN), true);
  assert.equal(nextLaterSlot(Date.parse("2026-11-04T22:58:00Z"), BERLIN), "23:59");
  assert.equal(nextLaterDay(Date.parse("2026-11-04T22:58:00Z"), BERLIN), "today");

  const last = Date.parse("2026-11-04T22:59:00Z");
  assert.equal(minLaterClock(last, BERLIN), "");
  assert.equal(nextLaterSlot(last, BERLIN), "00:30");
  assert.equal(nextLaterDay(last, BERLIN), "tomorrow");
  assert.equal(isLaterToday("23:59", last, BERLIN), false);
  assert.equal(isLaterToday("00:30", last, BERLIN), false);

  const midnight = Date.parse("2026-11-04T23:00:00Z");
  assert.equal(zonedParts(midnight, BERLIN).day, "2026-11-05");
  assert.equal(nextLaterSlot(midnight, BERLIN), "00:30");
  assert.equal(nextLaterDay(midnight, BERLIN), "today");
  assert.equal(minLaterClock(midnight, BERLIN), "00:01");
  assert.equal(isLaterToday("00:30", midnight, BERLIN), true);
  assert.equal(isLaterToday("00:00", midnight, BERLIN), false);
});

test("spring-forward Sunday in Berlin keeps the same late-night default", () => {
  // 2026-03-29 moves 02:00 CET to 03:00 CEST. Evening is CEST (UTC+2).
  assert.equal(nextLaterSlot(Date.parse("2026-03-29T21:15:00Z"), BERLIN), "23:30");
  assert.equal(nextLaterSlot(Date.parse("2026-03-29T21:16:00Z"), BERLIN), "23:59");
  assert.equal(nextLaterDay(Date.parse("2026-03-29T21:16:00Z"), BERLIN), "today");
  assert.equal(nextLaterSlot(Date.parse("2026-03-29T21:59:00Z"), BERLIN), "00:30");
  assert.equal(nextLaterDay(Date.parse("2026-03-29T21:59:00Z"), BERLIN), "tomorrow");
  assert.equal(nextLaterSlot(Date.parse("2026-03-29T22:00:00Z"), BERLIN), "00:30");
  assert.equal(nextLaterDay(Date.parse("2026-03-29T22:00:00Z"), BERLIN), "today");
  // Before the gap the next half hour is unchanged. The gap itself is skipped by the zoned instant.
  assert.equal(nextLaterSlot(Date.parse("2026-03-29T00:00:00Z"), BERLIN), "01:30");
  assert.equal(nextLaterSlot(Date.parse("2026-03-29T00:50:00Z"), BERLIN), "03:30");
});
