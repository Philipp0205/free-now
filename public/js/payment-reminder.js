/**
 * The payment reminder: a sheet that lists what the signed-in person still owes (GET /api/bills, the "owe" side).
 * This file is the rules, the copy and the per-device counter. It imports no app state and touches no DOM or
 * storage at import, so the unit tests load it in node and pass a fake storage. The sheet itself is in
 * payment-reminder-ui.js.
 *
 * When it shows
 *   - On a cold start once the bills are loaded, and when the app comes back to the foreground.
 *   - At most once per REMINDER_THROTTLE_MS since it was last shown (kept in memory, so a fresh page load is
 *     always allowed). A quick hide and show inside that window does not open it again.
 *   - Never when the person owes nothing. What others owe them ("owed") is not a debt of theirs.
 *   - Never while the bills are missing, loading or failed, and never over another open sheet.
 *
 * How rude it is (the level)
 *   level = max(dismiss level, age level), from 1 (nudge) to 5 (dramatic roast).
 *   dismiss level = 1 + times the sheet was dismissed without paying, at most 5.
 *       0 dismissals: 1,  1: 2,  2: 3,  3: 4,  4 or more: 5.
 *   age level = how many days the oldest owe item has been open (today minus its day, never below 0).
 *       0 to 2 days: 1,  3 to 6: 2,  7 to 13: 3,  14 to 29: 4,  30 or more: 5.
 *   The dismiss count lives in localStorage on this device and goes back to 0 whenever a load shows nothing owed,
 *   so the next debt starts again at level 1.
 */

import { daysBetween } from "./when.js";

/** The sheet shows at most once in this window (ms), and coming back counts only after being away this long. */
export const REMINDER_THROTTLE_MS = 4 * 60 * 1000;

/** How many times this device dismissed the sheet without paying. Reset to 0 once nothing is owed. */
export const DISMISS_KEY = "fn_payment_reminder_dismissed";

export const MAX_LEVEL = 5;

/** Age of the oldest owe item in days, and the level it gives: the first row whose `from` is at or under the age. */
export const AGE_LEVELS = [
  { from: 30, level: 5 },
  { from: 14, level: 4 },
  { from: 7, level: 3 },
  { from: 3, level: 2 },
  { from: 0, level: 1 },
];

/** Friendly at the top, a dramatic roast at the bottom. Playful only: no money worries, no real insults. */
export const REMINDER_LEVELS = [
  {
    level: 1,
    heading: "Quick reminder",
    body: "You have a bill to settle. Two taps and your friends are happy again.",
  },
  {
    level: 2,
    heading: "Still on the list",
    body: "Your bill is still open. Nobody is mad yet, but the group chat is watching.",
  },
  {
    level: 3,
    heading: "Hello again",
    body: "We have met a few times now, and the bill has not paid itself. Believe us, we checked.",
  },
  {
    level: 4,
    heading: "This is getting awkward",
    body: "Your unpaid bill now has its own seat at the table. Pay up before it orders dessert.",
  },
  {
    level: 5,
    heading: "Legend of the unpaid bill",
    body: "Songs will be written about this debt. Tap Mark paid and save your good name, or at least your spot on the next plan.",
  },
];

/** The copy for a level, 1 to 5. Anything else is clamped into that range. */
export function reminderCopy(level) {
  const at = Math.min(MAX_LEVEL, Math.max(1, Math.trunc(Number(level)) || 1));
  return REMINDER_LEVELS[at - 1];
}

/** 1 + dismissals, at most MAX_LEVEL. */
export function dismissLevel(dismissCount) {
  const count = Math.max(0, Math.trunc(Number(dismissCount)) || 0);
  return Math.min(MAX_LEVEL, 1 + count);
}

/** The level an open debt of this many days gives. */
export function ageLevel(ageDays) {
  const days = Math.max(0, Math.trunc(Number(ageDays)) || 0);
  return AGE_LEVELS.find((row) => days >= row.from).level;
}

/** Days the oldest owe item has been open, from each item's day (YYYY-MM-DD). Items without a day are ignored. */
export function oldestDebtDays(owe, today) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today || "")) return 0;
  let oldest = 0;
  for (const bill of owe || []) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(bill?.day || "")) continue;
    oldest = Math.max(oldest, daysBetween(bill.day, today));
  }
  return oldest;
}

/** The level to show: the ruder of the dismiss level and the age level. */
export function reminderLevel({ dismissCount = 0, ageDays = 0 } = {}) {
  return Math.max(dismissLevel(dismissCount), ageLevel(ageDays));
}

/** True when the bills answer can be trusted: loaded, not loading again, and the last load did not fail. */
export function billsReady(bills) {
  return Boolean(bills?.loaded && !bills.loading && !bills.failed && Array.isArray(bills.owe));
}

/** What the person owes. Empty unless the bills are ready, so a failed or missing load never shows anything. */
export function unpaidItems(bills) {
  return billsReady(bills) ? bills.owe : [];
}

/** Not shown yet, the clock went back, or the window has passed. */
export function throttleOpen(lastShownAt, now, everyMs = REMINDER_THROTTLE_MS) {
  if (lastShownAt === null || lastShownAt === undefined) return true;
  return now < lastShownAt || now - lastShownAt >= everyMs;
}

/** The whole decision: something is owed, the data is good, nothing else is open, and the throttle allows it. */
export function shouldShowReminder({ bills, now, lastShownAt = null, signedIn = true, blocked = false, everyMs = REMINDER_THROTTLE_MS }) {
  if (!signedIn || blocked) return false;
  if (!unpaidItems(bills).length) return false;
  return throttleOpen(lastShownAt, now, everyMs);
}

/** The dismiss count in storage. Anything unreadable is 0. */
export function readDismissCount(storage) {
  try {
    const count = Number.parseInt(storage?.getItem(DISMISS_KEY) ?? "", 10);
    return Number.isFinite(count) && count > 0 ? Math.min(count, MAX_LEVEL) : 0;
  } catch {
    return 0;
  }
}

/** One more dismissal. Returns the new count. The count stops at MAX_LEVEL, which is all the levels use. */
export function addDismiss(storage) {
  const next = Math.min(MAX_LEVEL, readDismissCount(storage) + 1);
  try {
    storage?.setItem(DISMISS_KEY, String(next));
  } catch {
    /* storage can be full or blocked */
  }
  return next;
}

export function resetDismiss(storage) {
  try {
    if (readDismissCount(storage) > 0) storage.setItem(DISMISS_KEY, "0");
  } catch {
    /* storage can be full or blocked */
  }
}

/** A good load that shows nothing owed puts the dismiss count back to 0. Returns true when it did. */
export function resetIfSettled(bills, storage) {
  if (!billsReady(bills) || bills.owe.length) return false;
  resetDismiss(storage);
  return true;
}
