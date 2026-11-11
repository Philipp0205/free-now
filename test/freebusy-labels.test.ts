import assert from "node:assert/strict";
import test from "node:test";
import { PLAN_DURATION_MS, availabilityText, dayEvents, eventOverlaps, eventTimeText, untilText } from "../public/freebusy.js";

const TZ = "Europe/Berlin";
// Tue 10 Nov 2026, 12:00 in Berlin (UTC+1).
const NOON = Date.UTC(2026, 10, 10, 11, 0);
const at = (h: number, m = 0, day = 10) => Date.UTC(2026, 10, day, h - 1, m);

test("busy and free labels name the end time, or the day when it is not today", () => {
  assert.equal(availabilityText({ state: "busy", until: at(14, 30) }, NOON, TZ), "Busy until 14:30");
  assert.equal(availabilityText({ state: "free", until: at(11, 0, 11) }, NOON, TZ), "Free until tomorrow 11:00");
  assert.equal(availabilityText({ state: "free", until: null }, NOON, TZ), "Free");
  assert.equal(availabilityText({ state: "busy", until: null }, NOON, TZ), "Busy");
  assert.equal(availabilityText(null, NOON, TZ), "");
  assert.equal(untilText(at(9, 0, 13), NOON, TZ), "Fri 09:00");
});

test("overlap is any shared minute, and an untimed plan highlights nothing", () => {
  const plan = { start: at(19), end: at(19) + PLAN_DURATION_MS };
  assert.equal(PLAN_DURATION_MS, 2 * 60 * 60 * 1000);
  assert.equal(eventOverlaps({ start: at(20), end: at(22) }, plan), true);
  assert.equal(eventOverlaps({ start: at(17), end: at(19) }, plan), false);
  assert.equal(eventOverlaps({ start: at(21), end: at(22) }, plan), false);
  assert.equal(eventOverlaps({ start: at(18), end: at(23) }, plan), true);
  assert.equal(eventOverlaps({ start: at(20), end: at(22) }, null), false);
});

test("event times read as a range, all day, or running in from or out to another day", () => {
  const dayStart = at(0);
  const dayEnd = at(0, 0, 11);
  assert.equal(eventTimeText({ start: at(9), end: at(10, 30), allDay: false }, dayStart, dayEnd, TZ), "09:00 to 10:30");
  assert.equal(eventTimeText({ start: dayStart, end: dayEnd, allDay: true }, dayStart, dayEnd, TZ), "All day");
  assert.equal(eventTimeText({ start: at(22, 0, 9), end: at(1), allDay: false }, dayStart, dayEnd, TZ), "until 01:00");
  assert.equal(eventTimeText({ start: at(23), end: at(2, 0, 11), allDay: false }, dayStart, dayEnd, TZ), "from 23:00");
});

test("day events sort by start and drop broken rows", () => {
  const rows = dayEvents([
    { title: "B", start: at(15), end: at(16) },
    { title: "bad", start: "x", end: at(16) },
    { title: "A", start: at(9), end: at(10) },
  ]);
  assert.deepEqual(rows.map((row: { title: string }) => row.title), ["A", "B"]);
  assert.deepEqual(dayEvents(undefined), []);
});
