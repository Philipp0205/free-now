import assert from "node:assert/strict";
import test from "node:test";
import { buildCalendar, dateValue, escapeText, foldLine, nextDay, utcStamp, type IcsEvent } from "../src/ics.js";
import { calendarFileName, DURATION_NOTE, gapNote, planDescription, planEvent, planSequence, planStatus, planWhen, uidHost, type CalendarContext } from "../src/calendar.js";
import type { PlanRow } from "../src/db.js";

const BERLIN = "Europe/Berlin";

const BASE: IcsEvent = {
  uid: "p1@hangry",
  dtstamp: Date.parse("2026-06-01T15:00:00Z"),
  sequence: 0,
  lastModified: Date.parse("2026-06-01T12:00:00Z"),
  summary: "Sushi",
  description: "",
  location: "",
  url: "",
  status: "CONFIRMED",
  when: { kind: "day", day: "2026-06-02" },
};

const unfold = (text: string) => text.replace(/\r\n /g, "");

test("TEXT escaping covers backslash, semicolon, comma, and newlines", () => {
  assert.equal(escapeText("a\\b;c,d\ne\r\nf\rg"), "a\\\\b\\;c\\,d\\ne\\nf\\ng");
  assert.equal(escapeText("tab\there\u0007"), "tab\there", "tab is allowed, other controls go");
  assert.equal(escapeText("Sushi: 19:00"), "Sushi: 19:00", "a colon stays as is in TEXT");
});

test("folding keeps every line at 75 octets and never splits a multibyte character", () => {
  const ascii = `DESCRIPTION:${"x".repeat(200)}`;
  const folded = foldLine(ascii);
  for (const line of folded.split("\r\n")) assert.ok(Buffer.byteLength(line, "utf8") <= 75, line);
  assert.equal(unfold(folded), ascii);

  const emoji = `SUMMARY:${"ü🍣€".repeat(40)}`;
  const parts = foldLine(emoji).split("\r\n");
  assert.ok(parts.length > 1);
  for (const [index, line] of parts.entries()) {
    assert.ok(Buffer.byteLength(line, "utf8") <= 75, `line ${index} is ${Buffer.byteLength(line, "utf8")} octets`);
    if (index > 0) assert.equal(line[0], " ");
    assert.ok(!line.includes("\uFFFD"));
    // A lone surrogate would mean an emoji was cut in half.
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(line), `split pair in ${index}`);
  }
  assert.equal(unfold(parts.join("\r\n")), emoji);
  assert.equal(foldLine("SHORT:1"), "SHORT:1");
  const exact = `X:${"a".repeat(73)}`;
  assert.equal(foldLine(exact), exact, "75 octets exactly does not fold");
});

test("dates and stamps", () => {
  assert.equal(utcStamp(Date.parse("2026-06-01T15:04:05.678Z")), "20260601T150405Z");
  assert.equal(dateValue("2026-06-02"), "20260602");
  assert.equal(nextDay("2026-12-31"), "2027-01-01");
  assert.equal(nextDay("2028-02-28"), "2028-02-29");
});

test("a calendar has the required header, CRLF everywhere, and a trailing CRLF", () => {
  const text = buildCalendar({ name: "Hangry", tz: "Europe/Berlin", events: [BASE] });
  assert.ok(text.endsWith("\r\n"));
  assert.equal(text.replace(/\r\n/g, "").includes("\n"), false, "no bare LF");
  assert.equal(text.replace(/\r\n/g, "").includes("\r"), false, "no bare CR");
  const lines = unfold(text).split("\r\n").filter(Boolean);
  assert.deepEqual(lines.slice(0, 7), [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Hangry//Calendar 1.0//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Hangry",
    "X-WR-TIMEZONE:Europe/Berlin",
  ]);
  assert.equal(lines.at(-1), "END:VCALENDAR");
  assert.ok(lines.includes("DTSTART;VALUE=DATE:20260602"));
  assert.ok(lines.includes("DTEND;VALUE=DATE:20260603"));
  assert.ok(lines.includes("DTSTAMP:20260601T150000Z"));
  assert.ok(lines.includes("LAST-MODIFIED:20260601T120000Z"));
  assert.ok(lines.includes("SEQUENCE:0"));
  assert.ok(lines.includes("STATUS:CONFIRMED"));
  assert.equal(lines.some((line) => line.startsWith("DESCRIPTION") || line.startsWith("LOCATION") || line.startsWith("URL")), false, "empty fields are left out");
});

test("a single file has no calendar name", () => {
  const text = buildCalendar({ events: [{ ...BASE, when: { kind: "timed", startMs: Date.parse("2026-06-02T17:00:00Z"), endMs: Date.parse("2026-06-02T19:00:00Z") } }] });
  assert.equal(text.includes("X-WR-CALNAME"), false);
  assert.ok(text.includes("DTSTART:20260602T170000Z\r\n"));
  assert.ok(text.includes("DTEND:20260602T190000Z\r\n"));
});

test("plan times: a clock is a UTC instant in APP_TZ plus 2h, TBD is all day, DST is handled", () => {
  assert.deepEqual(planWhen({ for_date: "2026-06-02", at_time: "19:00" }, "Europe/Berlin"), {
    kind: "timed",
    startMs: Date.parse("2026-06-02T17:00:00Z"),
    endMs: Date.parse("2026-06-02T19:00:00Z"),
  });
  assert.deepEqual(planWhen({ for_date: "2026-01-15", at_time: "19:00" }, "Europe/Berlin"), {
    kind: "timed",
    startMs: Date.parse("2026-01-15T18:00:00Z"),
    endMs: Date.parse("2026-01-15T20:00:00Z"),
  });
  // The fall-back Sunday: 19:00 is CET again.
  const fall = planWhen({ for_date: "2026-10-25", at_time: "19:00" }, "Europe/Berlin");
  assert.equal(fall.kind === "timed" && new Date(fall.startMs).toISOString(), "2026-10-25T18:00:00.000Z");
  assert.deepEqual(planWhen({ for_date: "2026-06-02", at_time: null }, "Europe/Berlin"), { kind: "day", day: "2026-06-02" });
});

test("status: ended is cancelled, host or in is confirmed, maybe is tentative", () => {
  const plan = { ended_at: null, creator_id: "host" };
  assert.equal(planStatus(plan, "host", null), "CONFIRMED");
  assert.equal(planStatus(plan, "guest", "coming"), "CONFIRMED");
  assert.equal(planStatus(plan, "guest", "maybe"), "TENTATIVE");
  assert.equal(planStatus(plan, "guest", null), "TENTATIVE");
  assert.equal(planStatus({ ...plan, ended_at: 1 }, "host", null), "CANCELLED");
  assert.equal(planStatus({ ...plan, ended_at: 1 }, "guest", "coming"), "CANCELLED");
});

test("sequence is 0 before any change and grows with each later change", () => {
  const created = Date.parse("2026-06-01T12:00:00Z");
  assert.equal(planSequence({ created_at: created, updated_at: null }), 0);
  assert.equal(planSequence({ created_at: created, updated_at: created }), 1, "a change in the same millisecond still bumps");
  assert.equal(planSequence({ created_at: created, updated_at: created + 1 }), 1);
  const a = planSequence({ created_at: created, updated_at: created + 60_000 });
  const b = planSequence({ created_at: created, updated_at: created + 61_000 });
  assert.ok(b > a && a > 1);
});

test("uid host, description, and file name", () => {
  assert.equal(uidHost(null), "hangry");
  assert.equal(uidHost("https://hangry.example.com"), "hangry.example.com");
  assert.equal(uidHost("not a url"), "hangry");
  const timed = { for_date: "2026-06-02", at_time: "19:00" };
  assert.equal(
    planDescription({ creator_name: "Alex", description: "Bring snacks", ...timed }, "https://h.example/?plan=p1", BERLIN),
    `Hosted by Alex\n\nBring snacks\n\n${DURATION_NOTE}\n\nHangry: https://h.example/?plan=p1`,
  );
  assert.equal(planDescription({ creator_name: "Alex", description: "  ", ...timed }, "L", BERLIN), `Hosted by Alex\n\n${DURATION_NOTE}\n\nHangry: L`);
  assert.equal(
    planDescription({ creator_name: "Alex", description: null, for_date: "2026-06-02", at_time: null }, "L", BERLIN),
    "Hosted by Alex\n\nHangry: L",
    "an all-day plan has no length to explain",
  );
  assert.equal(calendarFileName("Sushi night!"), "sushi-night.ics");
  assert.equal(calendarFileName("Café über Straße"), "cafe-uber-stra-e.ics");
  assert.equal(calendarFileName("🍣🍣"), "hangry-plan.ics");
  assert.ok(calendarFileName("a".repeat(100)).length <= 52);
});

test("the 2 hour note is exactly this sentence", () => {
  assert.equal(DURATION_NOTE, "Hangry plans have no end time, so this shows 2 hours.");
});

/** A plan row with only what planEvent reads. */
function planRow(forDate: string, atTime: string | null): PlanRow {
  return {
    id: "p1",
    creator_id: "host",
    creator_name: "Alex",
    note: "Late one",
    for_date: forDate,
    at_time: atTime,
    description: null,
    place: "",
    created_at: Date.parse("2026-01-01T12:00:00Z"),
    updated_at: null,
    ended_at: null,
  } as unknown as PlanRow;
}

function eventLinesFor(forDate: string, atTime: string, tz = BERLIN): string[] {
  const ctx = { tz, now: Date.parse("2026-01-01T12:00:00Z"), origin: "https://h.example", uidHost: "h.example" } as CalendarContext;
  const text = buildCalendar({ tz, events: [planEvent(ctx, planRow(forDate, atTime), "host", null)] });
  return unfold(text).split("\r\n").filter(Boolean);
}

test("spring forward: 02:30 does not exist in Berlin, it starts at 03:30 CEST and the description says so", () => {
  const when = planWhen({ for_date: "2026-03-29", at_time: "02:30" }, BERLIN);
  assert.equal(when.kind === "timed" && utcStamp(when.startMs), "20260329T013000Z", "offset before the gap (+01:00), RFC 5545 3.3.5");
  assert.equal(when.kind === "timed" && utcStamp(when.endMs), "20260329T033000Z");
  const note = "Planned for 02:30, a time that does not exist on this day because clocks move forward. Shown at 03:30.";
  assert.equal(gapNote({ at_time: "02:30" }, when, BERLIN), note);

  const lines = eventLinesFor("2026-03-29", "02:30");
  assert.ok(lines.includes("DTSTART:20260329T013000Z"));
  assert.ok(lines.includes("DTEND:20260329T033000Z"));
  const description = lines.find((line) => line.startsWith("DESCRIPTION:")) ?? "";
  assert.equal(description, `DESCRIPTION:Hosted by Alex\\n\\n${escapeText(note)}\\n${escapeText(DURATION_NOTE)}\\n\\nHangry: https://h.example/?plan=p1`);

  // The edges of the gap: 01:59 and 03:00 are real times, so no note.
  for (const [time, stamp] of [["01:59", "20260329T005900Z"], ["03:00", "20260329T010000Z"]]) {
    const edge = eventLinesFor("2026-03-29", time);
    assert.ok(edge.includes(`DTSTART:${stamp}`), time);
    assert.equal(edge.some((line) => line.includes("does not exist")), false, time);
  }
  // Another APP_TZ: New York skips 02:00 to 03:00 on 2026-03-08.
  const york = eventLinesFor("2026-03-08", "02:30", "America/New_York");
  assert.ok(york.includes("DTSTART:20260308T073000Z"));
  assert.ok(york.some((line) => line.includes("Planned for 02:30") && line.includes("Shown at 03:30.")));
});

test("fall back: 02:30 happens twice in Berlin, the first one (CEST) is used and there is no note", () => {
  const when = planWhen({ for_date: "2026-10-25", at_time: "02:30" }, BERLIN);
  assert.equal(when.kind === "timed" && utcStamp(when.startMs), "20261025T003000Z", "first occurrence, +02:00, RFC 5545 3.3.5");
  assert.equal(when.kind === "timed" && utcStamp(when.endMs), "20261025T023000Z");
  assert.equal(gapNote({ at_time: "02:30" }, when, BERLIN), null);
  const lines = eventLinesFor("2026-10-25", "02:30");
  assert.ok(lines.includes("DTSTART:20261025T003000Z"));
  const description = lines.find((line) => line.startsWith("DESCRIPTION:")) ?? "";
  assert.equal(description.includes("does not exist"), false);
  assert.ok(description.includes(escapeText(DURATION_NOTE)));
  // Either side of the repeated hour.
  const at = (time: string) => {
    const value = planWhen({ for_date: "2026-10-25", at_time: time }, BERLIN);
    return value.kind === "timed" ? utcStamp(value.startMs) : "";
  };
  assert.equal(at("02:00"), "20261025T000000Z");
  assert.equal(at("02:59"), "20261025T005900Z");
  assert.equal(at("03:00"), "20261025T020000Z");
  assert.equal(at("01:59"), "20261024T235900Z");
  // New York repeats 01:00 to 02:00 on 2026-11-01. First is EDT (-04:00).
  const york = planWhen({ for_date: "2026-11-01", at_time: "01:30" }, "America/New_York");
  assert.equal(york.kind === "timed" && utcStamp(york.startMs), "20261101T053000Z");
});
