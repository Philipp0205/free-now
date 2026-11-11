import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  activeStatus,
  busyUntilPresets,
  circleStatusLine,
  statusBadge,
  statusLine,
  statusShort,
  statusToday,
  statusUntilDay,
  untilFromClock,
  untilText,
  STATUS_PLACE_MAX as CLIENT_PLACE_MAX,
  STATUS_TEXT_MAX as CLIENT_TEXT_MAX,
  STATUS_TZ as CLIENT_TZ,
} from "../public/status.js";
import { STATUS_PLACE_MAX, STATUS_TEXT_MAX, STATUS_TZ } from "../src/status.js";
import { endOfDay, zonedDateTime } from "../src/time.js";

const NOW = Date.parse("2026-11-09T11:00:00Z");
const UNTIL = endOfDay("2026-11-13", "Europe/Berlin");
const away = { type: "away", text: "Tennis vacation in Portugal", place: "Portugal", until: UNTIL };

test("page and server agree on the zone and limits", () => {
  assert.equal(CLIENT_TZ, STATUS_TZ);
  assert.equal(CLIENT_TEXT_MAX, STATUS_TEXT_MAX);
  assert.equal(CLIENT_PLACE_MAX, STATUS_PLACE_MAX);
});

test("activeStatus ignores unknown shapes, delivery strings and ended statuses", () => {
  assert.equal(activeStatus(away, NOW), away);
  assert.equal(activeStatus(away, UNTIL), away);
  assert.equal(activeStatus(away, UNTIL + 1), null);
  assert.equal(activeStatus("delivered", NOW), null);
  assert.equal(activeStatus(null, NOW), null);
  assert.equal(activeStatus({ type: "gone" }, NOW), null);
  assert.equal(activeStatus({ type: "busy", until: null }, NOW)?.type, "busy");
});

test("status lines name the note once and the end day in Berlin", () => {
  assert.equal(statusLine(away, NOW), "Away · Tennis vacation in Portugal · until 13 Nov");
  assert.equal(statusLine({ ...away, text: "Tennis", place: "Portugal" }, NOW), "Away · Tennis · Portugal · until 13 Nov");
  assert.equal(statusLine({ type: "busy", text: null, place: null, until: null }, NOW), "Busy");
  assert.equal(statusLine({ ...away, until: endOfDay("2027-01-02", "Europe/Berlin") }, NOW), "Away · Tennis vacation in Portugal · until 2 Jan 2027");
  assert.equal(statusLine({ ...away, until: NOW - 1 }, NOW), null);
  assert.equal(statusShort(away, NOW), "Away until 13 Nov");
  assert.equal(statusShort({ type: "busy", until: null }, NOW), "Busy");
  assert.equal(untilText(null, NOW), "");
  assert.equal(statusBadge("away"), "\u2708\ufe0f");
  assert.equal(statusBadge("busy"), "\u23f3");
  assert.equal(statusBadge("nope"), "");
});

test("today and the end day are Berlin days, not UTC days", () => {
  assert.equal(statusToday(Date.parse("2026-11-09T23:30:00Z")), "2026-11-10");
  assert.equal(statusToday(Date.parse("2026-11-09T22:59:00Z")), "2026-11-09");
  assert.equal(statusUntilDay(away), "2026-11-13");
  assert.equal(statusUntilDay({ type: "busy", until: null }), "");
});

test("circle line groups by type, says You, caps names and shows a lone end day", () => {
  const members = [
    { id: "p", name: "Phil", status: away },
    { id: "a", name: "Alex", status: { type: "busy", until: null } },
    { id: "b", name: "Bea", status: null },
  ];
  assert.equal(circleStatusLine(members, "b", NOW), "Away: Phil, until 13 Nov · Busy: Alex");
  assert.equal(circleStatusLine(members, "p", NOW), "Away: You, until 13 Nov · Busy: Alex");
  const many = ["A", "B", "C", "D", "E"].map((name) => ({ id: name, name, status: away }));
  assert.equal(circleStatusLine(many, "", NOW), "Away: A, B, C +2");
  assert.equal(circleStatusLine([{ id: "b", name: "Bea", status: null }], "", NOW), null);
  assert.equal(circleStatusLine(members, "", UNTIL + 1), "Busy: Alex");
});

test("one UTC instant reads as a different clock, and day word, in each viewer's zone", () => {
  const lisbon = "Europe/Lisbon";
  const berlin = "Europe/Berlin";
  // 18:00 in Lisbon is 18:00Z in winter, which is 19:00 in Berlin.
  const six = Date.parse("2026-11-09T18:00:00Z");
  assert.equal(untilText(six, NOW, lisbon), "until 18:00");
  assert.equal(untilText(six, NOW, berlin), "until 19:00");
  assert.equal(statusLine({ type: "busy", text: null, place: null, until: six }, NOW, lisbon), "Busy · until 18:00");
  assert.equal(statusLine({ type: "busy", text: null, place: null, until: six }, NOW, berlin), "Busy · until 19:00");
  // 23:30Z is still today in Lisbon and already tomorrow in Berlin.
  const late = Date.parse("2026-11-09T23:30:00Z");
  assert.equal(untilText(late, NOW, lisbon), "until 23:30");
  assert.equal(untilText(late, NOW, berlin), "until tomorrow 00:30");
  const member = [{ id: "a", name: "Alex", status: { type: "busy", until: late } }];
  assert.equal(circleStatusLine(member, "", NOW, 3, lisbon), "Busy: Alex, until 23:30");
  assert.equal(circleStatusLine(member, "", NOW, 3, berlin), "Busy: Alex, until tomorrow 00:30");
});

test("untilText reads an end of day as a date and any other instant as a clock", () => {
  const at = (iso: string) => Date.parse(iso);
  // NOW is Mon 9 Nov 2026 12:00 Berlin.
  assert.equal(untilText(at("2026-11-09T17:00:00Z"), NOW), "until 18:00");
  assert.equal(untilText(at("2026-11-10T17:00:00Z"), NOW), "until tomorrow 18:00");
  assert.equal(untilText(at("2026-11-13T17:00:00Z"), NOW), "until Fri 18:00");
  assert.equal(untilText(at("2027-01-08T17:00:00Z"), NOW), "until Fri 18:00 2027");
  assert.equal(untilText(at("2026-11-09T23:00:00Z"), NOW), "until tomorrow 00:00", "midnight sharp is a clock time, not an end of day");
  assert.equal(untilText(endOfDay("2026-11-13", "Europe/Berlin"), NOW), "until 13 Nov");
  assert.equal(untilText(endOfDay("2027-01-02", "Europe/Berlin"), NOW), "until 2 Jan 2027");
  // The same instants read in another zone.
  assert.equal(untilText(at("2026-11-09T17:00:00Z"), NOW, "Europe/Lisbon"), "until 17:00");
  assert.equal(untilText(endOfDay("2026-11-13", "Europe/Lisbon"), NOW, "Europe/Lisbon"), "until 13 Nov");
  assert.equal(untilText(endOfDay("2026-11-13", "Europe/Lisbon"), NOW), "until Sat 00:59", "a Lisbon end of day is not a Berlin one");
  assert.equal(statusLine({ type: "busy", text: null, place: null, until: at("2026-11-09T17:00:00Z") }, NOW), "Busy · until 18:00");
  assert.equal(statusShort({ type: "busy", until: at("2026-11-10T17:00:00Z") }, NOW), "Busy until tomorrow 18:00");
  assert.equal(statusShort({ type: "busy", until: at("2026-11-09T17:00:00Z") }, NOW, "Europe/Lisbon"), "Busy until 17:00");
  assert.equal(circleStatusLine([{ id: "a", name: "Alex", status: { type: "busy", until: at("2026-11-09T17:00:00Z") } }], "", NOW), "Busy: Alex, until 18:00");
  assert.equal(circleStatusLine([{ id: "a", name: "Alex", status: { type: "busy", until: at("2026-11-09T17:00:00Z") } }], "", NOW, 3, "Europe/Lisbon"), "Busy: Alex, until 17:00");
});

test("untilFromClock is the next occurrence of a clock time", () => {
  assert.equal(untilFromClock("18:00", NOW), Date.parse("2026-11-09T17:00:00Z"));
  assert.equal(untilFromClock("11:59", NOW), Date.parse("2026-11-10T10:59:00Z"));
  assert.equal(untilFromClock("12:00", NOW), Date.parse("2026-11-10T11:00:00Z"), "now exactly rolls to tomorrow");
  assert.equal(untilFromClock("18:00", NOW, "Europe/Lisbon"), Date.parse("2026-11-09T18:00:00Z"));
  assert.equal(untilFromClock("nope", NOW), null);
  assert.equal(untilFromClock("25:00", NOW), null);
  // Across the spring-forward day the answer matches the server rule.
  const before = Date.parse("2026-03-28T20:00:00Z");
  assert.equal(untilFromClock("18:00", before), zonedDateTime("2026-03-29", "18:00", "Europe/Berlin"));
});

test("busy presets: 1 hour, 2 hours, 6pm and the end of tomorrow", () => {
  const presets = busyUntilPresets(NOW);
  assert.deepEqual(presets.map((p: { id: string }) => p.id), ["1h", "2h", "6pm", "tomorrow"]);
  assert.deepEqual(presets.map((p: { label: string }) => p.label), ["1 hour", "2 hours", "Until 6pm", "Until tomorrow"]);
  assert.deepEqual(presets.map((p: { until: number }) => p.until), [
    NOW + 3_600_000,
    NOW + 7_200_000,
    Date.parse("2026-11-09T17:00:00Z"),
    endOfDay("2026-11-10", "Europe/Berlin"),
  ]);
  const evening = Date.parse("2026-11-09T18:30:00Z"); // 19:30 Berlin
  const late = busyUntilPresets(evening);
  assert.equal(late[2].until, Date.parse("2026-11-10T17:00:00Z"), "6pm has passed, so tomorrow");
  assert.equal(late[3].until, endOfDay("2026-11-10", "Europe/Berlin"));
  // Just after midnight in Berlin, "tomorrow" is still the next Berlin day.
  const night = Date.parse("2026-11-09T23:30:00Z"); // 00:30 on the 10th
  assert.equal(busyUntilPresets(night)[3].until, endOfDay("2026-11-11", "Europe/Berlin"));
  assert.equal(busyUntilPresets(NOW, "Europe/Lisbon")[3].until, endOfDay("2026-11-10", "Europe/Lisbon"));
  assert.equal(untilText(presets[3].until, NOW), "until 10 Nov");
  assert.equal(untilText(presets[2].until, NOW), "until 18:00");
});

test("the worker caches status.js with the shell", () => {
  const sw = fs.readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
  const shell = JSON.parse(/const SHELL = (\[[^\]]*\]);/.exec(sw)?.[1] ?? "[]") as string[];
  assert.ok(shell.includes("/status.js"));
});
