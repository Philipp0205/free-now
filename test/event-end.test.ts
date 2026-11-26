import assert from "node:assert/strict";
import test from "node:test";
import { compactWhen } from "../public/js/compact-home.js";
import { eventIsNow, socialPinState } from "../public/js/map-pin.js";
import { emptyEnd, endError, endFromItem, endPayload, eventRange } from "../public/js/plans/event-end.js";
import { END_COPY } from "../public/js/plans/event-end-copy.js";
import { zonedInstant } from "../public/js/when.js";

const BERLIN = "Europe/Berlin";
const MIN = 60_000;
// Sat 14 Nov 2026, 15:00 in Berlin (UTC+1).
const NOW = Date.parse("2026-11-14T14:00:00Z");
const at = (iso: string) => Date.parse(iso);

test("zonedInstant turns a day and a clock into the instant, across the offset change", () => {
  assert.equal(zonedInstant("2026-11-14", "19:00", BERLIN), at("2026-11-14T18:00:00Z"), "winter, UTC+1");
  assert.equal(zonedInstant("2026-06-15", "19:00", BERLIN), at("2026-06-15T17:00:00Z"), "summer, UTC+2");
  assert.equal(zonedInstant("2026-03-29", "12:00", BERLIN), at("2026-03-29T10:00:00Z"), "the day the clocks go forward");
  assert.equal(zonedInstant("2026-10-25", "12:00", BERLIN), at("2026-10-25T11:00:00Z"), "the day the clocks go back");
  assert.equal(zonedInstant("2026-11-14", "19:00", "UTC"), at("2026-11-14T19:00:00Z"));
});

test("zonedInstant is NaN for a bad day or clock", () => {
  assert.ok(Number.isNaN(zonedInstant("", "19:00", BERLIN)));
  assert.ok(Number.isNaN(zonedInstant("2026-11-14", "", BERLIN)));
  assert.ok(Number.isNaN(zonedInstant("2026-11-14", "7pm", BERLIN)));
  assert.ok(Number.isNaN(zonedInstant("14.11.2026", "19:00", BERLIN)));
});

test("an untouched draft sends nothing, so the server keeps the end", () => {
  assert.deepEqual(endPayload(emptyEnd()), {});
  assert.deepEqual(endPayload(endFromItem({ endsAt: at("2026-11-14T21:00:00Z") }, BERLIN)), {});
});

test("a touched draft sends the end clock, or null when it is empty", () => {
  assert.deepEqual(endPayload({ ...emptyEnd(), touched: true }), { endsAt: null }, "an empty end clears it");
  assert.deepEqual(endPayload({ ...emptyEnd(), until: "22:00", touched: true }), { endsAt: "22:00" });
});

test("an event's end opens the edit sheet as a clock in the app zone", () => {
  assert.deepEqual(
    endFromItem({ endsAt: at("2026-11-14T21:00:00Z") }, BERLIN),
    { until: "22:00", touched: false, error: "" },
  );
  assert.deepEqual(endFromItem({ endsAt: null }, BERLIN), emptyEnd());
  assert.deepEqual(endFromItem(null, BERLIN), emptyEnd());
});

test("endError: a plan needs a start, the end must be a clock after the start", () => {
  const end = (value: string) => ({ ...emptyEnd(), until: value, touched: true });
  assert.equal(endError(emptyEnd(), "", true), "", "no end is always fine");
  assert.equal(endError(end(""), "19:00", true), "", "a cleared end is fine");
  assert.equal(endError(end("22:00"), "", true), END_COPY.needsStart, "a plan without a time cannot end");
  assert.equal(endError(end("22:00"), "", false), "", "a live social has no start clock to compare");
  assert.equal(endError(end("7pm"), "19:00", true), END_COPY.pickEnd, "not a clock");
  assert.equal(endError(end("18:00"), "19:00", true), END_COPY.afterStart);
  assert.equal(endError(end("19:00"), "19:00", true), END_COPY.afterStart, "the same minute is not an end");
  assert.equal(endError(end("22:00"), "19:00", true), "");
});

test("the copy has no em dash", () => {
  for (const text of [END_COPY.needsStart, END_COPY.pickEnd, END_COPY.afterStart, END_COPY.endLabel]) {
    assert.ok(!text.includes("\u2014"), text);
  }
});

test("eventRange: a plan shows its start and end, and nothing without both", () => {
  const plan = { time: "19:00", endsAt: at("2026-11-14T21:00:00Z") };
  assert.equal(eventRange("plan", plan, NOW, BERLIN), "19:00 - 22:00");
  assert.equal(eventRange("plan", { time: "19:00", endsAt: null }, NOW, BERLIN), "", "no end, so the old labels stay");
  assert.equal(eventRange("plan", { time: "", endsAt: plan.endsAt }, NOW, BERLIN), "", "no start time");
  assert.equal(eventRange("plan", null, NOW, BERLIN), "");
});

test("eventRange: a social starts at its start, at Now while live, or when it was posted once over", () => {
  const later = { startsAt: at("2026-11-14T18:00:00Z"), endsAt: at("2026-11-14T21:00:00Z"), expiresAt: at("2026-11-14T21:00:00Z"), createdAt: NOW };
  assert.equal(eventRange("social", later, NOW, BERLIN), "19:00 - 22:00");
  const live = { startsAt: null, endsAt: NOW + 120 * MIN, expiresAt: NOW + 120 * MIN, createdAt: NOW - 30 * MIN };
  assert.equal(eventRange("social", live, NOW, BERLIN), "Now - 17:00");
  const over = { startsAt: null, endsAt: NOW - MIN, expiresAt: NOW - MIN, createdAt: at("2026-11-14T11:00:00Z") };
  assert.equal(eventRange("social", over, NOW, BERLIN), "12:00 - 14:59", "after the end, the posted clock replaces Now");
  assert.equal(eventRange("social", { ...live, endsAt: null }, NOW, BERLIN), "");
});

test("a plan is now between its start and its end, and never without an end", () => {
  const plan = (time: string, endsAt: number | null) => ({ forDate: "2026-11-14", time, endsAt });
  assert.equal(eventIsNow("plan", plan("15:00", NOW + 60 * MIN), NOW, BERLIN), true, "the start minute counts");
  assert.equal(eventIsNow("plan", plan("14:00", NOW + 60 * MIN), NOW, BERLIN), true, "inside the window");
  assert.equal(eventIsNow("plan", plan("15:01", NOW + 60 * MIN), NOW, BERLIN), false, "not started yet");
  assert.equal(eventIsNow("plan", plan("13:00", NOW), NOW, BERLIN), false, "the end instant is already over");
  assert.equal(eventIsNow("plan", plan("13:00", NOW - MIN), NOW, BERLIN), false, "ended");
  assert.equal(eventIsNow("plan", plan("15:00", null), NOW, BERLIN), false, "no end, never now");
  assert.equal(eventIsNow("plan", { forDate: "2026-11-14", time: "", endsAt: NOW + 60 * MIN }, NOW, BERLIN), false, "no start time");
  assert.equal(eventIsNow("plan", { forDate: "2026-11-15", time: "15:00", endsAt: NOW + 60 * MIN * 30 }, NOW, BERLIN), false, "another day");
});

test("a social stops being live at its end, even if expiresAt were later", () => {
  assert.equal(socialPinState({ startsAt: null, expiresAt: NOW + 60 * MIN, endsAt: NOW + 30 * MIN }, NOW), "now");
  assert.equal(socialPinState({ startsAt: null, expiresAt: NOW + 60 * MIN, endsAt: NOW - MIN }, NOW), "ended");
  assert.equal(socialPinState({ startsAt: null, expiresAt: NOW + 60 * MIN, endsAt: null }, NOW), "now", "no end keeps the old rule");
  assert.equal(eventIsNow("social", { startsAt: null, expiresAt: NOW + 60 * MIN, endsAt: NOW - MIN }, NOW, BERLIN), false);
});

test("compact rows show the range in place of the clock, and keep the old text without an end", () => {
  const day = Date.parse("2026-11-20T12:00:00Z");
  const plan = { forDate: "2026-11-20", time: "19:00", endsAt: at("2026-11-20T21:00:00Z") };
  assert.equal(compactWhen("plan", plan, day, BERLIN), "Today 19:00 - 22:00");
  assert.equal(compactWhen("plan", { ...plan, endsAt: null }, day, BERLIN), "Today 19:00");
  const live = { startsAt: null, expiresAt: at("2026-11-20T20:00:00Z"), endsAt: at("2026-11-20T20:00:00Z"), createdAt: day };
  assert.equal(compactWhen("social", live, day, BERLIN), "Now - 21:00");
  assert.equal(compactWhen("social", { ...live, endsAt: null }, day, BERLIN), "Now");
  const later = { startsAt: at("2026-11-20T17:00:00Z"), expiresAt: at("2026-11-20T20:00:00Z"), endsAt: at("2026-11-20T20:00:00Z"), createdAt: day };
  assert.equal(compactWhen("social", later, day, BERLIN), "Today 18:00 - 21:00");
  assert.equal(compactWhen("social", { ...later, endsAt: null }, day, BERLIN), "Today 18:00");
});
