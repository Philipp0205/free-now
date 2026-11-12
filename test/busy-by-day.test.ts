import assert from "node:assert/strict";
import test from "node:test";
import { busyByDay, busySpanText, sourceLabel } from "../public/freebusy.js";

const TZ = "Europe/Berlin";
// Tue 10 Nov 2026, 12:00 in Berlin (UTC+1).
const NOW = Date.UTC(2026, 10, 10, 11, 0);
const at = (h: number, m = 0, day = 10) => Date.UTC(2026, 10, day, h - 1, m);
const texts = (spans: Parameters<typeof busySpanText>[0][]) => spans.map((span) => busySpanText(span, TZ));

test("spans group by local day, sorted, with the source kept", () => {
  const days = busyByDay(
    [
      { start: at(9, 0, 11), end: at(10, 0, 11), source: "ics" },
      { start: at(15), end: at(16), source: "weekly" },
      { start: at(13), end: at(14), source: "google" },
    ],
    TZ,
    NOW,
  );
  assert.deepEqual(days.map((d) => d.day), ["2026-11-10", "2026-11-11"]);
  assert.deepEqual(days[0].spans.map((s) => [s.start, s.source]), [[at(13), "google"], [at(15), "weekly"]]);
  assert.deepEqual(texts(days[0].spans), ["13:00 to 14:00", "15:00 to 16:00"]);
  assert.deepEqual(texts(days[1].spans), ["09:00 to 10:00"]);
  assert.equal(days[0].spans[0].allDay, false);
});

test("a span over midnight splits in two, flagged for each side", () => {
  const [today, tomorrow] = busyByDay([{ start: at(22), end: at(2, 30, 11), source: "ics" }], TZ, NOW);
  assert.deepEqual(today.spans.map((s) => [s.start, s.end, s.fromEarlier, s.untilLater]), [[at(22), at(24), false, true]]);
  assert.deepEqual(tomorrow.spans.map((s) => [s.start, s.end, s.fromEarlier, s.untilLater]), [[at(24), at(2, 30, 11), true, false]]);
  assert.deepEqual(texts(today.spans), ["from 22:00"]);
  assert.deepEqual(texts(tomorrow.spans), ["until 02:30"]);
});

test("the day is the viewer's day, not the server's", () => {
  const span = { start: Date.UTC(2026, 10, 10, 23, 0), end: Date.UTC(2026, 10, 11, 0, 30), source: "ics" };
  const [berlin] = busyByDay([span], "Europe/Berlin", NOW);
  assert.equal(berlin.day, "2026-11-11");
  assert.deepEqual(texts(berlin.spans), ["00:00 to 01:30"]);
  const lisbon = busyByDay([span], "Europe/Lisbon", NOW);
  assert.deepEqual(lisbon.map((d) => d.day), ["2026-11-10", "2026-11-11"]);
  assert.equal(busySpanText(lisbon[0].spans[0], "Europe/Lisbon"), "from 23:00");
  assert.equal(busySpanText(lisbon[1].spans[0], "Europe/Lisbon"), "until 00:30");
});

test("a whole day reads All day, and so do the middle days of a long span", () => {
  const days = busyByDay(
    [
      { start: at(0, 0, 11), end: at(0, 0, 12), source: "ics" },
      { start: at(18, 0, 13), end: at(9, 0, 15), source: "ics" },
    ],
    TZ,
    NOW,
  );
  assert.deepEqual(days.map((d) => d.day), ["2026-11-11", "2026-11-13", "2026-11-14", "2026-11-15"]);
  assert.equal(days[0].spans[0].allDay, true);
  assert.deepEqual(texts(days[0].spans), ["All day"]);
  assert.deepEqual(texts(days[1].spans), ["from 18:00"]);
  assert.deepEqual(texts(days[2].spans), ["All day"]);
  assert.equal(days[2].spans[0].fromEarlier && days[2].spans[0].untilLater, true);
  assert.deepEqual(texts(days[3].spans), ["until 09:00"]);
});

test("ended spans, bad spans and days past the week are dropped", () => {
  const days = busyByDay(
    [
      { start: at(8), end: at(11, 59), source: "ics" },
      { start: at(9), end: at(9), source: "ics" },
      { start: NaN, end: at(14), source: "ics" },
      { start: at(9, 0, 17), end: at(10, 0, 17), source: "ics" },
      { start: at(11), end: at(13), source: "ics" },
    ],
    TZ,
    NOW,
  );
  assert.equal(days.length, 1);
  assert.deepEqual(days[0].spans.map((s) => s.start), [at(11)]);
  assert.deepEqual(busyByDay([], TZ, NOW), []);
  assert.deepEqual(busyByDay(null, TZ, NOW), []);
});

test("a 23 hour day (clocks forward) still splits at local midnight", () => {
  // Berlin clocks go forward on Sun 29 Mar 2026, so that day runs 23:00Z to 22:00Z.
  const now = Date.UTC(2026, 2, 28, 10, 0);
  const span = { start: Date.UTC(2026, 2, 28, 21, 0), end: Date.UTC(2026, 2, 29, 22, 0), source: "ics" };
  const days = busyByDay([span], TZ, now);
  assert.deepEqual(days.map((d) => d.day), ["2026-03-28", "2026-03-29"]);
  assert.deepEqual(texts(days[0].spans), ["from 22:00"]);
  assert.equal(days[1].spans[0].allDay, true);
  assert.equal(days[1].spans[0].end, Date.UTC(2026, 2, 29, 22, 0));
});

test("source labels", () => {
  assert.equal(sourceLabel("google"), "Google");
  assert.equal(sourceLabel("ics"), "Calendar link");
  assert.equal(sourceLabel("weekly"), "Weekly hours");
  assert.equal(sourceLabel("other"), "");
});
