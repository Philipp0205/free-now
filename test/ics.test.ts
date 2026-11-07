import assert from "node:assert/strict";
import test from "node:test";
import { buildCalendar, dateValue, escapeText, foldLine, nextDay, utcStamp, type IcsEvent } from "../src/ics.js";
import { calendarFileName, planDescription, planSequence, planStatus, planWhen, uidHost } from "../src/calendar.js";

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
  assert.equal(
    planDescription({ creator_name: "Alex", description: "Bring snacks" }, "https://h.example/?plan=p1"),
    "Hosted by Alex\n\nBring snacks\n\nHangry: https://h.example/?plan=p1",
  );
  assert.equal(planDescription({ creator_name: "Alex", description: "  " }, "L"), "Hosted by Alex\n\nHangry: L");
  assert.equal(calendarFileName("Sushi night!"), "sushi-night.ics");
  assert.equal(calendarFileName("Café über Straße"), "cafe-uber-stra-e.ics");
  assert.equal(calendarFileName("🍣🍣"), "hangry-plan.ics");
  assert.ok(calendarFileName("a".repeat(100)).length <= 52);
});
