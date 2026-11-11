/**
 * Busy/free labels for friends and the owner-only "I'm in" calendar check. Pure, so the
 * rules can be tested. The page passes the viewer's timezone; nothing here reads app state.
 */
import { addDays, zonedParts } from "./when.js";

/** A timed plan is treated as two hours long, same as DEFAULT_DURATION_MS in src/calendar.ts. */
export const PLAN_DURATION_MS = 2 * 60 * 60 * 1000;

function clockAt(ms, tz) {
  const parts = zonedParts(ms, tz);
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

function weekdayAt(ms, tz) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short" }).format(new Date(ms));
}

/** "14:30", "tomorrow 11:00" or "Thu 09:00", seen from `from`. */
export function untilText(until, from, tz = "Europe/Berlin") {
  const day = zonedParts(until, tz).day;
  const base = zonedParts(from, tz).day;
  const time = clockAt(until, tz);
  if (day === base) return time;
  if (day === addDays(base, 1)) return `tomorrow ${time}`;
  return `${weekdayAt(until, tz)} ${time}`;
}

/**
 * "Busy until 14:30", "Free until 16:00", or just "Free" / "Busy" when there is no end in
 * the synced window. Null when the person does not share (or the data is stale).
 */
export function availabilityText(availability, from, tz = "Europe/Berlin") {
  if (!availability || (availability.state !== "busy" && availability.state !== "free")) return "";
  const word = availability.state === "busy" ? "Busy" : "Free";
  if (!Number.isFinite(availability.until)) return word;
  return `${word} until ${untilText(availability.until, from, tz)}`;
}

/** True when the event and the hangout share any time. No window (untimed plan) means no highlight. */
export function eventOverlaps(event, window) {
  if (!window || !Number.isFinite(window.start) || !Number.isFinite(window.end)) return false;
  return event.start < window.end && event.end > window.start;
}

/**
 * The time shown for one of the owner's events on `day` (dayStart..dayEnd in ms).
 * Events that run past either edge of the day say so instead of naming another day's clock.
 */
export function eventTimeText(event, dayStart, dayEnd, tz = "Europe/Berlin") {
  const before = event.start <= dayStart;
  const after = event.end >= dayEnd;
  if (event.allDay || (before && after)) return "All day";
  if (before) return `until ${clockAt(event.end, tz)}`;
  if (after) return `from ${clockAt(event.start, tz)}`;
  return `${clockAt(event.start, tz)} to ${clockAt(event.end, tz)}`;
}

/** Sort by start, keep at most `max`. Titles stay as they are: only the owner ever gets them. */
export function dayEvents(events, max = 20) {
  if (!Array.isArray(events)) return [];
  return events
    .filter((event) => event && Number.isFinite(event.start) && Number.isFinite(event.end))
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .slice(0, max);
}
