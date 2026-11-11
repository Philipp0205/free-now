import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  activeStatus,
  circleStatusLine,
  statusBadge,
  statusLine,
  statusShort,
  statusToday,
  statusUntilDay,
  untilText,
  STATUS_PLACE_MAX as CLIENT_PLACE_MAX,
  STATUS_TEXT_MAX as CLIENT_TEXT_MAX,
  STATUS_TZ as CLIENT_TZ,
} from "../public/status.js";
import { STATUS_PLACE_MAX, STATUS_TEXT_MAX, STATUS_TZ } from "../src/status.js";
import { endOfDay } from "../src/time.js";

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

test("the worker caches status.js with the shell", () => {
  const sw = fs.readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
  const shell = JSON.parse(/const SHELL = (\[[^\]]*\]);/.exec(sw)?.[1] ?? "[]") as string[];
  assert.ok(shell.includes("/status.js"));
});
