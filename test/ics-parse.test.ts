import assert from "node:assert/strict";
import test from "node:test";
import { mergeBusy, parseIcs, resolveTzid, wallToUtc } from "../src/ics-parse.js";

const TZ = "Europe/Berlin";
// Tue 10 Nov 2026 09:00 Berlin (08:00 UTC).
const NOW = Date.UTC(2026, 10, 10, 8, 0);
const H = 3_600_000;
const D = 24 * H;

function cal(...events: string[]): string {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//EN", ...events, "END:VCALENDAR", ""].join("\r\n");
}

function ev(...lines: string[]): string {
  return ["BEGIN:VEVENT", ...lines, "END:VEVENT"].join("\r\n");
}

function berlin(y: number, m: number, d: number, h = 0, min = 0): number {
  return wallToUtc(Date.UTC(y, m - 1, d, h, min), TZ);
}

test("reads UTC, TZID, floating, and all-day events inside the window", () => {
  const text = cal(
    ev("UID:a", "DTSTART:20261110T100000Z", "DTEND:20261110T110000Z", "SUMMARY:Dentist"),
    ev("UID:b", "DTSTART;TZID=Europe/Berlin:20261111T090000", "DTEND;TZID=Europe/Berlin:20261111T100000", "SUMMARY:Standup"),
    ev("UID:c", "DTSTART:20261112T180000", "DURATION:PT2H", "SUMMARY:Floating"),
    ev("UID:d", "DTSTART;VALUE=DATE:20261113", "DTEND;VALUE=DATE:20261115", "SUMMARY:Trip"),
    ev("UID:e", "DTSTART;VALUE=DATE:20261116", "SUMMARY:One day"),
  );
  const result = parseIcs(text, { now: NOW, tz: TZ });
  assert.equal(result.skipped, 0);
  assert.deepEqual(result.events.map((e) => [e.title, e.start, e.end, e.allDay]), [
    ["Dentist", Date.UTC(2026, 10, 10, 10), Date.UTC(2026, 10, 10, 11), false],
    ["Standup", berlin(2026, 11, 11, 9), berlin(2026, 11, 11, 10), false],
    ["Floating", berlin(2026, 11, 12, 18), berlin(2026, 11, 12, 20), false],
    ["Trip", berlin(2026, 11, 13), berlin(2026, 11, 15), true],
    ["One day", berlin(2026, 11, 16), berlin(2026, 11, 17), true],
  ]);
});

test("keeps an event already in progress and drops ones outside the window", () => {
  const text = cal(
    ev("UID:a", "DTSTART:20261110T073000Z", "DTEND:20261110T090000Z", "SUMMARY:Now"),
    ev("UID:b", "DTSTART:20261109T073000Z", "DTEND:20261109T090000Z", "SUMMARY:Yesterday"),
    ev("UID:c", "DTSTART:20261130T073000Z", "DTEND:20261130T090000Z", "SUMMARY:Far"),
  );
  const result = parseIcs(text, { now: NOW, tz: TZ });
  assert.deepEqual(result.events.map((e) => e.title), ["Now"]);
  assert.deepEqual(result.busy, [[NOW, Date.UTC(2026, 10, 10, 9)]]);
});

test("unfolds lines, reads quoted params, and ignores VALARM and free events", () => {
  const text = cal(
    [
      "BEGIN:VEVENT",
      "UID:a",
      'DTSTART;TZID="W. Europe Standard Time":20261110T140000',
      'DTEND;TZID="W. Europe Standard Time":20261110T150000',
      "SUMMARY:Long ti",
      " tle\\, folded",
      "BEGIN:VALARM",
      "TRIGGER:-PT15M",
      "DTSTART:20261201T000000Z",
      "END:VALARM",
      "END:VEVENT",
    ].join("\r\n"),
    ev("UID:b", "DTSTART:20261110T150000Z", "DTEND:20261110T160000Z", "STATUS:CANCELLED"),
    ev("UID:c", "DTSTART:20261110T150000Z", "DTEND:20261110T160000Z", "TRANSP:TRANSPARENT"),
    ev("UID:d", "DTSTART:20261110T150000Z", "DTEND:20261110T160000Z", "X-MICROSOFT-CDO-BUSYSTATUS:FREE"),
  );
  const result = parseIcs(text, { now: NOW, tz: TZ });
  assert.deepEqual(result.events.map((e) => [e.title, e.start]), [["Long title, folded", berlin(2026, 11, 10, 14)]]);
});

test("resolves vendor-prefixed and Windows TZIDs, else APP_TZ", () => {
  assert.equal(resolveTzid("/mozilla.org/20050126_1/Europe/London", TZ), "Europe/London");
  assert.equal(resolveTzid("/softwarestudio.org/Olson_20011030_5/America/New_York", TZ), "America/New_York");
  assert.equal(resolveTzid("Pacific Standard Time", TZ), "America/Los_Angeles");
  assert.equal(resolveTzid("GMT Standard Time", TZ), "Europe/London");
  assert.equal(resolveTzid("Romance Standard Time", TZ), "Europe/Paris");
  assert.equal(resolveTzid("Not A Zone", TZ), TZ);
  assert.equal(resolveTzid(undefined, TZ), TZ);
});

test("weekly RRULE with BYDAY, EXDATE, and a moved instance", () => {
  const text = cal(
    ev(
      "UID:gym",
      "DTSTART;TZID=Europe/Berlin:20261102T180000",
      "DTEND;TZID=Europe/Berlin:20261102T190000",
      "RRULE:FREQ=WEEKLY;BYDAY=MO,WE",
      "EXDATE;TZID=Europe/Berlin:20261111T180000",
      "SUMMARY:Gym",
    ),
    ev(
      "UID:gym",
      "RECURRENCE-ID;TZID=Europe/Berlin:20261116T180000",
      "DTSTART;TZID=Europe/Berlin:20261116T200000",
      "DTEND;TZID=Europe/Berlin:20261116T210000",
      "SUMMARY:Gym late",
    ),
  );
  const result = parseIcs(text, { now: NOW, tz: TZ });
  assert.deepEqual(result.events.map((e) => [e.title, e.start]), [
    ["Gym late", berlin(2026, 11, 16, 20)],
    ["Gym", berlin(2026, 11, 18, 18)],
    ["Gym", berlin(2026, 11, 23, 18)],
  ]);
});

test("COUNT counts from DTSTART and UNTIL stops the series", () => {
  const counted = cal(ev("UID:a", "DTSTART:20261105T120000Z", "DTEND:20261105T130000Z", "RRULE:FREQ=DAILY;COUNT=8", "SUMMARY:C"));
  assert.deepEqual(parseIcs(counted, { now: NOW, tz: TZ }).events.map((e) => e.start), [
    Date.UTC(2026, 10, 10, 12),
    Date.UTC(2026, 10, 11, 12),
    Date.UTC(2026, 10, 12, 12),
  ]);
  const until = cal(ev("UID:b", "DTSTART:20261101T120000Z", "DTEND:20261101T130000Z", "RRULE:FREQ=DAILY;INTERVAL=2;UNTIL=20261114T120000Z", "SUMMARY:U"));
  assert.deepEqual(parseIcs(until, { now: NOW, tz: TZ }).events.map((e) => e.start), [
    Date.UTC(2026, 10, 11, 12),
    Date.UTC(2026, 10, 13, 12),
  ]);
});

test("monthly ordinal BYDAY and negative BYMONTHDAY, yearly BYMONTH", () => {
  const text = cal(
    ev("UID:a", "DTSTART;TZID=Europe/Berlin:20260113T190000", "DURATION:PT1H", "RRULE:FREQ=MONTHLY;BYDAY=2TU", "SUMMARY:Second Tuesday"),
    ev("UID:b", "DTSTART;TZID=Europe/Berlin:20260131T080000", "DURATION:PT1H", "RRULE:FREQ=MONTHLY;BYMONTHDAY=-1", "SUMMARY:Last day"),
    ev("UID:c", "DTSTART;VALUE=DATE:20201119", "RRULE:FREQ=YEARLY;BYMONTH=11", "SUMMARY:Birthday"),
  );
  const result = parseIcs(text, { now: NOW, tz: TZ, windowMs: 25 * D });
  assert.deepEqual(result.events.map((e) => [e.title, e.start]), [
    ["Second Tuesday", berlin(2026, 11, 10, 19)],
    ["Birthday", berlin(2026, 11, 19)],
    ["Last day", berlin(2026, 11, 30, 8)],
  ]);
});

test("unsupported rules are skipped and counted, not guessed", () => {
  const text = cal(
    ev("UID:a", "DTSTART:20261110T120000Z", "DURATION:PT1H", "RRULE:FREQ=MONTHLY;BYDAY=MO,TU;BYSETPOS=-1"),
    ev("UID:b", "DTSTART:20261110T120000Z", "DURATION:PT1H", "RRULE:FREQ=HOURLY"),
    ev("UID:c", "DTSTART:20261110T120000Z", "DURATION:PT1H", "RRULE:FREQ=WEEKLY;BYHOUR=9"),
    ev("UID:d", "DTSTART:20261110T130000Z", "DURATION:PT1H", "SUMMARY:Fine"),
  );
  const result = parseIcs(text, { now: NOW, tz: TZ });
  assert.equal(result.skipped, 3);
  assert.deepEqual(result.events.map((e) => e.title), ["Fine"]);
});

test("a recurring event through the spring DST change keeps its wall time", () => {
  const spring = Date.UTC(2027, 2, 25, 0);
  const text = cal(ev("UID:a", "DTSTART;TZID=Europe/Berlin:20270322T090000", "DTEND;TZID=Europe/Berlin:20270322T100000", "RRULE:FREQ=DAILY", "SUMMARY:Daily"));
  const result = parseIcs(text, { now: spring, tz: TZ, windowMs: 4 * D });
  assert.deepEqual(result.events.map((e) => e.start), [
    berlin(2027, 3, 25, 9),
    berlin(2027, 3, 26, 9),
    berlin(2027, 3, 27, 9),
    berlin(2027, 3, 28, 9),
  ]);
  assert.equal(berlin(2027, 3, 28, 9) - berlin(2027, 3, 27, 9), 23 * H);
});

test("merges overlapping busy time and caps the event list", () => {
  assert.deepEqual(mergeBusy([{ start: 0, end: 10 }, { start: 5, end: 20 }, { start: 20, end: 30 }, { start: 40, end: 50 }], 0, 45), [[0, 30], [40, 45]]);
  const many = Array.from({ length: 30 }, (_, i) =>
    ev(`UID:${i}`, `DTSTART:202611${String(11 + (i % 10)).padStart(2, "0")}T${String(8 + Math.floor(i / 10)).padStart(2, "0")}0000Z`, "DURATION:PT30M"),
  );
  const result = parseIcs(cal(...many), { now: NOW, tz: TZ, maxEvents: 12 });
  assert.equal(result.events.length, 12);
});

test("garbage and missing calendars give nothing, without throwing", () => {
  assert.deepEqual(parseIcs("hello", { now: NOW, tz: TZ }).events, []);
  const bad = cal(ev("UID:a", "DTSTART:2026-11-10", "SUMMARY:Bad"), ev("UID:b", "DTSTART:20261399T000000Z"));
  const result = parseIcs(bad, { now: NOW, tz: TZ });
  assert.equal(result.events.length, 0);
  assert.equal(result.skipped, 2);
});
