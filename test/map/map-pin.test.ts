import assert from "node:assert/strict";
import test from "node:test";
import { eventIsNow, goingCrowd, isGoing, pinLabel, pinWhenLabel, socialPinState } from "../../public/js/map-pin.js";

const BERLIN = "Europe/Berlin";
// Sat 14 Nov 2026, 15:00 in Berlin (UTC+1 in November).
const NOW = Date.parse("2026-11-14T14:00:00Z");
const MIN = 60_000;

const person = (id: string, reply?: string, avatarRev: number | null = null) => ({ id, name: id, color: "#336699", avatarRev, reply });

test("a free-now social is now only while it runs", () => {
  assert.equal(socialPinState({ startsAt: null, expiresAt: NOW + 60 * MIN }, NOW), "now");
  assert.equal(socialPinState({ startsAt: NOW - 5 * MIN, expiresAt: NOW + 60 * MIN }, NOW), "now", "a later social that has started");
  assert.equal(socialPinState({ startsAt: NOW + 30 * MIN, expiresAt: NOW + 150 * MIN }, NOW), "later");
  assert.equal(socialPinState({ startsAt: null, expiresAt: NOW - MIN }, NOW), "ended", "expired is never now");
  assert.equal(socialPinState({ startsAt: null, expiresAt: NOW }, NOW), "ended", "the end instant is already over");
  assert.equal(socialPinState({ startsAt: null }, NOW), "ended", "no end time is not treated as live");
  assert.equal(socialPinState(null, NOW), "ended");
});

test("cards use the map's now rule: live socials, and a plan without an end is never now", () => {
  const live = { startsAt: null, expiresAt: NOW + 60 * MIN };
  assert.equal(eventIsNow("social", live, NOW), true);
  assert.equal(eventIsNow("social", { startsAt: NOW - 5 * MIN, expiresAt: NOW + 60 * MIN }, NOW), true, "a later social that has started");
  assert.equal(eventIsNow("social", { startsAt: NOW + 30 * MIN, expiresAt: NOW + 150 * MIN }, NOW), false, "later");
  assert.equal(eventIsNow("social", { startsAt: null, expiresAt: NOW - MIN }, NOW), false, "ended");
  assert.equal(eventIsNow("social", null, NOW), false);
  assert.equal(eventIsNow("plan", { forDate: "2026-11-14", time: "15:00", expiresAt: NOW + 60 * MIN }, NOW), false, "a plan without an end is never now");
  for (const item of [live, { startsAt: NOW + 30 * MIN, expiresAt: NOW + 150 * MIN }, { startsAt: null, expiresAt: NOW - MIN }]) {
    assert.equal(eventIsNow("social", item, NOW), socialPinState(item, NOW) === "now", "the same answer as the map");
  }
});

test("a live buzzer has no date label; a later one shows its start", () => {
  assert.equal(pinLabel("social", { startsAt: null, expiresAt: NOW + 60 * MIN }, NOW, BERLIN), "");
  assert.equal(pinLabel("social", { startsAt: NOW - MIN, expiresAt: NOW + 60 * MIN }, NOW, BERLIN), "");
  assert.equal(pinLabel("social", { startsAt: null, expiresAt: NOW - MIN }, NOW, BERLIN), "");
  // 18:00 Berlin.
  assert.equal(pinLabel("social", { startsAt: Date.parse("2026-11-14T17:00:00Z"), expiresAt: Date.parse("2026-11-14T19:00:00Z") }, NOW, BERLIN), "Later today 18:00");
});

test("plan labels: later today with the time, tomorrow, a weekday, then a short date", () => {
  assert.equal(pinWhenLabel("2026-11-14", "19:00", NOW, BERLIN), "Later today 19:00");
  assert.equal(pinWhenLabel("2026-11-14", "15:01", NOW, BERLIN), "Later today 15:01");
  assert.equal(pinWhenLabel("2026-11-14", "15:00", NOW, BERLIN), "Today", "the time has come, no longer later");
  assert.equal(pinWhenLabel("2026-11-14", null, NOW, BERLIN), "Today");
  assert.equal(pinWhenLabel("2026-11-15", "19:00", NOW, BERLIN), "Tomorrow");
  assert.equal(pinWhenLabel("2026-11-15", null, NOW, BERLIN), "Tomorrow");
  assert.equal(pinWhenLabel("2026-11-21", "10:00", NOW, BERLIN), "Sat 21 Nov");
  assert.equal(pinWhenLabel("2026-11-17", "10:00", NOW, BERLIN), "Tue 17 Nov");
  assert.equal(pinWhenLabel("2027-01-09", null, NOW, BERLIN), "Sat 9 Jan 2027");
  assert.equal(pinWhenLabel("2026-11-13", "19:00", NOW, BERLIN), "", "a past day has no label");
  assert.equal(pinWhenLabel("", "19:00", NOW, BERLIN), "");
  assert.equal(pinLabel("plan", { forDate: "2026-11-14", time: "19:00" }, NOW, BERLIN), "Later today 19:00");
});

test("the day rolls over at midnight in the app timezone, not in UTC", () => {
  const before = Date.parse("2026-11-14T22:59:30Z"); // 23:59:30 Sat in Berlin
  const after = Date.parse("2026-11-14T23:00:30Z"); // 00:00:30 Sun in Berlin, still Saturday in UTC
  assert.equal(pinWhenLabel("2026-11-15", "19:00", before, BERLIN), "Tomorrow");
  assert.equal(pinWhenLabel("2026-11-15", "19:00", after, BERLIN), "Later today 19:00");
  assert.equal(pinWhenLabel("2026-11-16", "19:00", after, BERLIN), "Tomorrow");
  assert.equal(pinWhenLabel("2026-11-14", "23:59", before, BERLIN), "Today");
  assert.equal(pinWhenLabel("2026-11-14", "23:59", after, BERLIN), "", "yesterday's plan is past");
  assert.equal(pinWhenLabel("2026-11-15", "19:00", after, "UTC"), "Tomorrow", "UTC has not turned the day yet");
});

test("only In counts as going; Maybe and Can't do not", () => {
  assert.equal(isGoing(person("a", "coming")), true);
  assert.equal(isGoing(person("a", "join")), true);
  assert.equal(isGoing(person("a", "in")), true);
  assert.equal(isGoing(person("a", "maybe")), false);
  assert.equal(isGoing(person("a", "declined")), false);
  assert.equal(isGoing(person("a")), false);
});

test("the crowd: nobody else going, one, and many with mixed photos", () => {
  const host = person("host", undefined, 3);
  assert.deepEqual(goingCrowd(host, [], 3), { faces: [host], more: 0, total: 1 });
  assert.deepEqual(goingCrowd(host, undefined, 3), { faces: [host], more: 0, total: 1 });

  const ana = person("ana", "coming", 7);
  assert.deepEqual(goingCrowd(host, [ana], 3).faces.map((p) => p.id), ["host", "ana"]);

  const joined = [ana, person("ben", "coming"), person("cy", "maybe", 2), person("dee", "declined"), person("eve", "coming", 9)];
  const crowd = goingCrowd(host, joined, 3);
  assert.deepEqual(crowd.faces.map((p) => p.id), ["host", "ana", "ben"]);
  assert.deepEqual(crowd.faces.map((p) => p.avatarRev), [3, 7, null], "photo and no photo side by side");
  assert.equal(crowd.more, 1, "eve is the +1, maybe and can't are not counted");
  assert.equal(crowd.total, 4);
});

test("the crowd overflows into +N and lists the host once", () => {
  const host = person("host");
  const joined = [person("host", "coming"), ...["a", "b", "c", "d", "e", "f"].map((id) => person(id, "coming"))];
  const crowd = goingCrowd(host, joined, 3);
  assert.deepEqual(crowd.faces.map((p) => p.id), ["host", "a", "b"]);
  assert.equal(crowd.more, 4);
  assert.equal(crowd.total, 7, "the host is counted once");
  assert.equal(goingCrowd(host, [person("x", "maybe"), person("y", "declined")], 3).total, 1);
});
