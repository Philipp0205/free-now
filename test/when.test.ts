import assert from "node:assert/strict";
import test from "node:test";
import { isLaterToday, minLaterClock, nextLaterSlot } from "../public/when.js";

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

test("a clock that would fall on the next calendar day is an empty slot", () => {
  // 23:20 + 15 min = 23:35, which rounds to 24:00.
  assert.equal(nextLaterSlot(Date.parse("2026-06-15T23:20:00Z"), UTC), "");
  // 23:50 + 15 min is already the next calendar day.
  assert.equal(nextLaterSlot(Date.parse("2026-06-15T23:50:00Z"), UTC), "");
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

  // 23:20 Berlin + 15 min rounds to 24:00.
  assert.equal(nextLaterSlot(Date.parse("2026-11-04T22:20:00Z"), BERLIN), "");
  // 23:50 Berlin + 15 min is the next calendar day.
  assert.equal(nextLaterSlot(Date.parse("2026-11-04T22:50:00Z"), BERLIN), "");
  // During the last minute, now+1min is tomorrow, so every clock is rejected.
  const lastMinute = Date.parse("2026-11-04T22:59:30Z");
  assert.equal(minLaterClock(lastMinute, BERLIN), "");
  assert.equal(isLaterToday("23:59", lastMinute, BERLIN), false);
});
