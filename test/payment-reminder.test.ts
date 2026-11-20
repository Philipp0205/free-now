import assert from "node:assert/strict";
import test from "node:test";
import {
  AGE_LEVELS,
  DISMISS_KEY,
  MAX_LEVEL,
  REMINDER_LEVELS,
  REMINDER_THROTTLE_MS,
  addDismiss,
  ageLevel,
  billsReady,
  dismissLevel,
  oldestDebtDays,
  readDismissCount,
  reminderCopy,
  reminderLevel,
  resetDismiss,
  resetIfSettled,
  shouldShowReminder,
  throttleOpen,
  unpaidItems,
} from "../public/js/payment-reminder.js";

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => (data.has(key) ? data.get(key)! : null),
    setItem: (key: string, value: string) => { data.set(key, String(value)); },
  };
}

const OWE = { kind: "plan", id: "p1", title: "Ramen", day: "2026-11-20", amount: "10.00" };
const ready = (owe: unknown[] = [OWE], owed: unknown[] = []) => ({ loaded: true, loading: false, failed: false, owe, owed });
const NOW = Date.parse("2026-11-20T12:00:00Z");

test("the sheet shows when the viewer owes something and the bills are good", () => {
  assert.equal(shouldShowReminder({ bills: ready(), now: NOW }), true);
  assert.equal(shouldShowReminder({ bills: ready([OWE, { ...OWE, id: "p2" }]), now: NOW }), true);
});

test("the sheet does not show when nothing is owed, even if others owe the viewer", () => {
  assert.equal(shouldShowReminder({ bills: ready([]), now: NOW }), false);
  assert.equal(shouldShowReminder({ bills: ready([], [{ kind: "plan", id: "p9" }]), now: NOW }), false);
  assert.deepEqual(unpaidItems(ready([], [{ id: "x" }])), []);
});

test("the sheet does not show on missing, loading or failed bills, signed out, or while something else is open", () => {
  assert.equal(shouldShowReminder({ bills: null, now: NOW }), false);
  assert.equal(shouldShowReminder({ bills: undefined, now: NOW }), false);
  assert.equal(shouldShowReminder({ bills: { loaded: false, loading: true }, now: NOW }), false);
  assert.equal(shouldShowReminder({ bills: { ...ready(), loading: true }, now: NOW }), false);
  assert.equal(shouldShowReminder({ bills: { ...ready(), failed: true }, now: NOW }), false);
  assert.equal(shouldShowReminder({ bills: { loaded: true, owe: "nope" }, now: NOW }), false);
  assert.equal(shouldShowReminder({ bills: ready(), now: NOW, signedIn: false }), false);
  assert.equal(shouldShowReminder({ bills: ready(), now: NOW, blocked: true }), false);
  assert.equal(billsReady(ready()), true);
  assert.equal(billsReady({ ...ready(), failed: true }), false);
});

test("throttle: the first show is allowed, a second inside the window is skipped, and one after it is allowed", () => {
  assert.equal(REMINDER_THROTTLE_MS, 4 * 60 * 1000);
  assert.equal(throttleOpen(null, NOW), true);
  assert.equal(throttleOpen(undefined, NOW), true);
  const shown = NOW;
  assert.equal(shouldShowReminder({ bills: ready(), now: shown + 1000, lastShownAt: shown }), false);
  assert.equal(shouldShowReminder({ bills: ready(), now: shown + REMINDER_THROTTLE_MS - 1, lastShownAt: shown }), false);
  assert.equal(shouldShowReminder({ bills: ready(), now: shown + REMINDER_THROTTLE_MS, lastShownAt: shown }), true);
  assert.equal(shouldShowReminder({ bills: ready(), now: shown + 60 * 60 * 1000, lastShownAt: shown }), true);
});

test("throttle: a clock that went backwards does not lock the sheet out", () => {
  assert.equal(throttleOpen(NOW, NOW - 5000), true);
});

test("dismiss level: 0 dismissals is level 1, each dismissal adds one, and it stops at 5", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 40].map(dismissLevel), [1, 2, 3, 4, 5, 5, 5, 5]);
  assert.equal(dismissLevel(-3), 1);
  assert.equal(dismissLevel(Number.NaN), 1);
  assert.equal(dismissLevel("2"), 3);
});

test("age level: under 3 days is 1, 3 to 6 is 2, 7 to 13 is 3, 14 to 29 is 4, 30 or more is 5", () => {
  assert.deepEqual(AGE_LEVELS.map((row) => [row.from, row.level]), [[30, 5], [14, 4], [7, 3], [3, 2], [0, 1]]);
  const at = (days: number) => ageLevel(days);
  assert.deepEqual([0, 1, 2].map(at), [1, 1, 1]);
  assert.deepEqual([3, 6].map(at), [2, 2]);
  assert.deepEqual([7, 13].map(at), [3, 3]);
  assert.deepEqual([14, 29].map(at), [4, 4]);
  assert.deepEqual([30, 31, 400].map(at), [5, 5, 5]);
  assert.equal(at(-5), 1);
});

test("oldest debt age comes from the oldest owe item and never goes below 0", () => {
  const today = "2026-11-20";
  assert.equal(oldestDebtDays([{ day: "2026-11-20" }], today), 0);
  assert.equal(oldestDebtDays([{ day: "2026-11-17" }, { day: "2026-11-19" }], today), 3);
  assert.equal(oldestDebtDays([{ day: "2026-10-01" }, { day: "2026-11-19" }], today), 50);
  assert.equal(oldestDebtDays([{ day: "2026-12-05" }], today), 0, "a future event is not old");
  assert.equal(oldestDebtDays([{ day: "" }, {}, null], today), 0);
  assert.equal(oldestDebtDays([], today), 0);
  assert.equal(oldestDebtDays([{ day: "2026-11-01" }], "soon"), 0);
});

test("the level is the ruder of the dismiss level and the age level", () => {
  assert.equal(reminderLevel(), 1);
  assert.equal(reminderLevel({ dismissCount: 0, ageDays: 0 }), 1);
  assert.equal(reminderLevel({ dismissCount: 2, ageDays: 0 }), 3);
  assert.equal(reminderLevel({ dismissCount: 0, ageDays: 20 }), 4);
  assert.equal(reminderLevel({ dismissCount: 3, ageDays: 8 }), 4);
  assert.equal(reminderLevel({ dismissCount: 1, ageDays: 14 }), 4);
  assert.equal(reminderLevel({ dismissCount: 9, ageDays: 0 }), MAX_LEVEL);
  assert.equal(reminderLevel({ dismissCount: 0, ageDays: 90 }), MAX_LEVEL);
});

test("every level has its own heading and body, spelled out", () => {
  assert.equal(REMINDER_LEVELS.length, 5);
  assert.deepEqual(REMINDER_LEVELS, [
    { level: 1, heading: "Quick reminder", body: "You have a bill to settle. Two taps and your friends are happy again." },
    { level: 2, heading: "Still on the list", body: "Your bill is still open. Nobody is mad yet, but the group chat is watching." },
    { level: 3, heading: "Hello again", body: "We have met a few times now, and the bill has not paid itself. Believe us, we checked." },
    { level: 4, heading: "This is getting awkward", body: "Your unpaid bill now has its own seat at the table. Pay up before it orders dessert." },
    {
      level: 5,
      heading: "Legend of the unpaid bill",
      body: "Songs will be written about this debt. Tap Mark paid and save your good name, or at least your spot on the next plan.",
    },
  ]);
  REMINDER_LEVELS.forEach((row, index) => {
    assert.equal(row.level, index + 1);
    assert.equal(reminderCopy(index + 1), row);
  });
  assert.equal(reminderCopy(0), REMINDER_LEVELS[0]);
  assert.equal(reminderCopy(99), REMINDER_LEVELS[4]);
  assert.equal(reminderCopy("x"), REMINDER_LEVELS[0]);
  assert.equal(new Set(REMINDER_LEVELS.map((row) => row.heading)).size, 5);
});

test("the copy has no em dash and stays short enough for a phone sheet", () => {
  for (const row of REMINDER_LEVELS) {
    for (const text of [row.heading, row.body]) assert.ok(!text.includes("\u2014"), text);
    assert.ok(row.heading.length <= 40, row.heading);
    assert.ok(row.body.length <= 140, row.body);
  }
});

test("dismissals are counted per device in storage, up to 5, and unreadable values count as 0", () => {
  const storage = fakeStorage();
  assert.equal(readDismissCount(storage), 0);
  assert.equal(addDismiss(storage), 1);
  assert.equal(storage.data.get(DISMISS_KEY), "1");
  assert.equal(addDismiss(storage), 2);
  assert.equal(readDismissCount(storage), 2);
  for (let i = 0; i < 10; i += 1) addDismiss(storage);
  assert.equal(readDismissCount(storage), 5);
  assert.equal(readDismissCount(fakeStorage({ [DISMISS_KEY]: "abc" })), 0);
  assert.equal(readDismissCount(fakeStorage({ [DISMISS_KEY]: "-4" })), 0);
  assert.equal(readDismissCount(fakeStorage({ [DISMISS_KEY]: "99" })), 5);
  assert.equal(readDismissCount(null), 0);
  const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  assert.equal(readDismissCount(broken), 0);
  assert.doesNotThrow(() => addDismiss(broken));
  assert.doesNotThrow(() => resetDismiss(broken));
});

test("each dismissal makes the next sheet ruder, level by level", () => {
  const storage = fakeStorage();
  const seen: number[] = [];
  for (let i = 0; i < 6; i += 1) {
    seen.push(reminderLevel({ dismissCount: readDismissCount(storage), ageDays: 0 }));
    addDismiss(storage);
  }
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 5]);
});

test("a good load with nothing owed resets the count, so the next debt starts at level 1", () => {
  const storage = fakeStorage({ [DISMISS_KEY]: "4" });
  assert.equal(resetIfSettled(ready([OWE]), storage), false);
  assert.equal(readDismissCount(storage), 4, "still owing keeps the count");
  assert.equal(resetIfSettled({ ...ready([]), failed: true }, storage), false);
  assert.equal(resetIfSettled(null, storage), false);
  assert.equal(readDismissCount(storage), 4, "a failed or missing load never resets");
  assert.equal(resetIfSettled(ready([], [{ id: "owed-to-me" }]), storage), true);
  assert.equal(readDismissCount(storage), 0);
  assert.equal(reminderLevel({ dismissCount: readDismissCount(storage), ageDays: 0 }), 1);
});

test("settle flow: owe, dismiss twice, pay, then a new debt starts at level 1 again", () => {
  const storage = fakeStorage();
  addDismiss(storage);
  addDismiss(storage);
  assert.equal(reminderLevel({ dismissCount: readDismissCount(storage), ageDays: 0 }), 3);
  resetIfSettled(ready([]), storage);
  assert.equal(shouldShowReminder({ bills: ready([]), now: NOW }), false, "paid: nothing to show");
  assert.equal(shouldShowReminder({ bills: ready([OWE]), now: NOW }), true, "a new debt shows again");
  assert.equal(reminderLevel({ dismissCount: readDismissCount(storage), ageDays: 0 }), 1);
});
