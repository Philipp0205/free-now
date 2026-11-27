// What the user saved as a one-time .ics file, per plan. Pure: no DOM. Lives next to calendar-sync.js (no calendar/ folder yet).

export const SAVED_KEY = "fn_calendar_saved";
export const SAVED_CAP = 100;

function defaultStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

/** planId -> the calendarRev that was saved. Empty when storage is missing, broken or holds junk. */
export function readSaved(storage = defaultStorage()) {
  try {
    const parsed = JSON.parse(storage?.getItem(SAVED_KEY) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const clean = {};
    for (const [id, rev] of Object.entries(parsed)) if (Number.isFinite(rev)) clean[id] = rev;
    return clean;
  } catch {
    return {};
  }
}

/** Remembers the rev saved for a plan. The newest save goes last; past SAVED_CAP the oldest are dropped. */
export function writeSaved(planId, rev, storage = defaultStorage()) {
  const map = readSaved(storage);
  delete map[planId];
  map[planId] = rev;
  const keys = Object.keys(map);
  for (const key of keys.slice(0, Math.max(0, keys.length - SAVED_CAP))) delete map[key];
  try {
    storage?.setItem(SAVED_KEY, JSON.stringify(map));
  } catch {
    // Storage full or blocked: the nudge just does not appear.
  }
  return map;
}

/** "none" when never saved, "current" when the saved file matches the plan, "stale" when the plan has changed since. */
export function calendarSavedState(plan, map) {
  const saved = map?.[plan?.id];
  if (!Number.isFinite(saved)) return "none";
  return saved >= (plan.calendarRev || 0) ? "current" : "stale";
}

/** Just the parts of a plan that a calendar event shows as when and where. */
export function planWhenWhere(plan) {
  return [plan?.forDate, plan?.time, plan?.endsAt, plan?.place].map((part) => part ?? "").join("|");
}

/** The SEQUENCE of the first event in .ics text, or null. */
export function sequenceFromIcs(text) {
  const match = /^SEQUENCE:(\d+)\s*$/m.exec(String(text || ""));
  return match ? Number(match[1]) : null;
}
