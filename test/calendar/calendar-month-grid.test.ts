import assert from "node:assert/strict";
import test from "node:test";
import { CIRCLE_COLORS, circleColor, eventCrowd, freeOnDay, gridRange, initialOf, monthGrid, monthStart, monthTitle, shiftMonth } from "../../public/js/calendar-month.js";

test("a month grid is whole Monday to Sunday weeks around the month", () => {
  // 1 Nov 2026 is a Sunday, 30 Nov a Monday.
  const grid = monthGrid("2026-11-01");
  assert.equal(grid.length % 7, 0);
  assert.equal(grid[0].day, "2026-10-26");
  assert.equal(grid[0].inMonth, false);
  assert.equal(grid[6].day, "2026-11-01");
  assert.equal(grid[6].inMonth, true);
  assert.equal(grid[grid.length - 1].day, "2026-12-06");
  assert.equal(grid.filter((cell) => cell.inMonth).length, 30);
  assert.deepEqual(gridRange("2026-11-01"), { from: "2026-10-26", to: "2026-12-06" });
});

test("a month that starts on Monday has no leading padding", () => {
  // 1 Feb 2027 is a Monday and February 2027 is exactly four weeks.
  const grid = monthGrid("2027-02-01");
  assert.equal(grid[0].day, "2027-02-01");
  assert.equal(grid.length, 28);
});

test("months shift across years and read as names", () => {
  assert.equal(monthStart("2026-11-10"), "2026-11-01");
  assert.equal(shiftMonth("2026-12-01", 1), "2027-01-01");
  assert.equal(shiftMonth("2026-01-01", -1), "2025-12-01");
  assert.equal(monthTitle("2026-11-01"), "November 2026");
});

test("a circle keeps one colour", () => {
  assert.equal(circleColor("c1"), circleColor("c1"));
  assert.ok(CIRCLE_COLORS.includes(circleColor("anything")));
});

const person = (id: string, name: string, reply?: string, avatarRev: number | null = null) => ({ id, name, reply, avatarRev, color: "#5ac8fa" });

test("an event's crowd is the host and everyone In, never maybe or Can't", () => {
  const host = person("h", "Hana", undefined, 4);
  const joined = [person("a", "ana", "coming"), person("b", "Ben", "maybe"), person("c", "Cy", "declined"), person("d", "Dee", "join")];
  const crowd = eventCrowd({ creator: host, joined }, 3);
  assert.deepEqual(crowd.faces.map((face) => face.person.id), ["h", "a", "d"]);
  assert.equal(crowd.more, 0);
  assert.equal(crowd.total, 3);
});

test("an event's crowd overflows into +N and lists the host once", () => {
  const host = person("h", "Hana");
  const joined = [person("h", "Hana", "coming"), ...["Ana", "Ben", "Cy", "Dee", "Eve"].map((name) => person(name.toLowerCase(), name, "coming"))];
  const crowd = eventCrowd({ creator: host, joined }, 2);
  assert.deepEqual(crowd.faces.map((face) => face.initial), ["H", "A"]);
  assert.equal(crowd.more, 4);
  assert.equal(crowd.total, 6);
});

test("a face uses the photo when there is one, else the first letter", () => {
  const crowd = eventCrowd({ creator: person("h", "hana", undefined, 7), joined: [person("z", "zoë", "coming")] }, 3);
  assert.deepEqual(crowd.faces.map((face) => [face.initial, face.photo]), [["H", true], ["Z", false]]);
  assert.equal(initialOf(""), "?");
  assert.equal(initialOf("  émile"), "É");
  assert.deepEqual(eventCrowd({ creator: null, joined: [] }), { faces: [], more: 0, total: 0 });
});

test("freeOnDay lists nobody yet", () => {
  assert.deepEqual(freeOnDay("2026-11-10", [], []), []);
  assert.deepEqual(freeOnDay("2026-11-10", [{ kind: "plan", item: { id: "p" } }], [person("a", "Ana")]), []);
});
