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

const SOURCE_LABELS = { google: "Google", ics: "Calendar link", weekly: "Weekly hours" };

/** The small tag on a busy row: where friends' view of that span comes from. */
export function sourceLabel(source) {
  return SOURCE_LABELS[source] || "";
}

/** The instant a YYYY-MM-DD day starts in `tz`, found by nudging a UTC guess until the clock reads 00:00. */
function dayStartMs(day, tz) {
  const [year, month, date] = day.split("-").map(Number);
  const target = Date.UTC(year, month - 1, date);
  let at = target;
  for (let i = 0; i < 3; i += 1) {
    const parts = zonedParts(at, tz);
    const [y, m, d] = parts.day.split("-").map(Number);
    const diff = Date.UTC(y, m - 1, d, parts.hour, parts.minute) - target;
    if (diff === 0) break;
    at -= diff;
  }
  return at;
}

/**
 * Busy spans [{start, end, source}] grouped by local day in `tz`, for `days` days from today.
 * A span over midnight is split, one piece per day, flagged fromEarlier / untilLater. Spans that
 * have ended are dropped. Days with nothing busy are left out. Sorted by day, then start.
 */
export function busyByDay(blocks, tz = "Europe/Berlin", now = Date.now(), days = 7) {
  const today = zonedParts(now, tz).day;
  const limit = addDays(today, days);
  const groups = new Map();
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!block || !Number.isFinite(block.start) || !Number.isFinite(block.end)) continue;
    if (block.end <= now || block.end <= block.start) continue;
    const last = zonedParts(block.end - 1, tz).day;
    for (let day = zonedParts(block.start, tz).day; day <= last && day < limit; day = addDays(day, 1)) {
      if (day < today) continue;
      const dayStart = dayStartMs(day, tz);
      const dayEnd = dayStartMs(addDays(day, 1), tz);
      const start = Math.max(block.start, dayStart);
      const end = Math.min(block.end, dayEnd);
      const piece = {
        start,
        end,
        source: block.source,
        allDay: start <= dayStart && end >= dayEnd,
        fromEarlier: block.start < dayStart,
        untilLater: block.end > dayEnd,
      };
      if (!groups.has(day)) groups.set(day, []);
      groups.get(day).push(piece);
    }
  }
  return [...groups.keys()].sort().map((day) => ({
    day,
    spans: groups.get(day).sort((a, b) => a.start - b.start || a.end - b.end),
  }));
}

/** "Blocked from 09:00 to 11:30", "Blocked until 11:30", "Blocked from 20:00" or "Blocked all day" for one piece from busyByDay. */
export function busySpanText(span, tz = "Europe/Berlin") {
  if (span.allDay) return "Blocked all day";
  if (span.fromEarlier) return `Blocked until ${clockAt(span.end, tz)}`;
  if (span.untilLater || clockAt(span.end, tz) === "00:00") return `Blocked from ${clockAt(span.start, tz)}`;
  return `Blocked from ${clockAt(span.start, tz)} to ${clockAt(span.end, tz)}`;
}
