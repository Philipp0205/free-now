/** Calendar date in a timezone, as YYYY-MM-DD. */
export function isoDate(ms: number, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function addDays(iso: string, days: number): string {
  const [year, month, day] = iso.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + days));
  return next.toISOString().slice(0, 10);
}

export type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number };

export function zonedParts(ms: number, tz: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(ms));
  const num = (type: Intl.DateTimeFormatPartTypes) => {
    const value = Number(parts.find((part) => part.type === type)?.value ?? "0");
    return type === "hour" && value === 24 ? 0 : value;
  };
  return {
    year: num("year"),
    month: num("month"),
    day: num("day"),
    hour: num("hour"),
    minute: num("minute"),
  };
}

export function clockLabel(ms: number, tz: string): string {
  const parts = zonedParts(ms, tz);
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

/** Local wall time minus UTC, in ms, at one instant. */
function offsetAt(ms: number, tz: string): number {
  const got = zonedParts(ms, tz);
  const minuteStart = Math.floor(ms / 60_000) * 60_000;
  return Date.UTC(got.year, got.month - 1, got.day, got.hour, got.minute) - minuteStart;
}

/**
 * UTC instant for a clock time on a calendar day in `tz`. Same rule as RFC 5545:
 * a time that happens twice (fall back) is the first one, and a time that does not
 * exist (spring forward) uses the offset from before the gap, so 02:30 becomes 03:30.
 */
export function zonedDateTime(isoDay: string, hhmm: string, tz: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!match) throw new Error("bad time");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error("bad time");
  const [year, month, day] = isoDay.split("-").map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const DAY_MS = 86_400_000;
  // The offsets a day either side. A zone changes at most once in that span.
  const before = offsetAt(wall - DAY_MS, tz);
  const after = offsetAt(wall + DAY_MS, tz);
  const fits = [wall - before, wall - after].filter((utc) => utc + offsetAt(utc, tz) === wall);
  if (fits.length) return Math.min(...fits);
  return wall - before;
}

/** True for a real YYYY-MM-DD day. "2026-02-30" is not. */
export function isCalendarDate(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const [year, month, day] = iso.split("-").map(Number);
  const back = new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
  return back === iso;
}

/** Calendar days from `from` to `to`. Works on dates, so DST never shifts it. */
export function daysBetween(from: string, to: string): number {
  const utc = (iso: string) => {
    const [year, month, day] = iso.split("-").map(Number);
    return Date.UTC(year, month - 1, day);
  };
  return Math.round((utc(to) - utc(from)) / 86_400_000);
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function weekday(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  return WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}

/** "Sat 14 Nov", with the year only when it is not this year: "Sun 28 Mar 2027". */
export function shortDate(iso: string, today: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  const base = `${weekday(iso).slice(0, 3)} ${day} ${MONTHS[month - 1]}`;
  return iso.slice(0, 4) === today.slice(0, 4) ? base : `${base} ${year}`;
}

/** Today, Tomorrow, a weekday for the next 6 days, then a short date. */
export function dayLabel(iso: string, today: string): string {
  const gap = daysBetween(today, iso);
  if (gap === 0) return "Today";
  if (gap === 1) return "Tomorrow";
  if (gap > 1 && gap <= 6) return weekday(iso);
  return shortDate(iso, today);
}

/** For a push or a notification row, which is read later: no bare weekday. */
export function noticeDay(iso: string, today: string): string {
  const gap = daysBetween(today, iso);
  return gap === 0 || gap === 1 ? dayLabel(iso, today) : shortDate(iso, today);
}

export function assertTimeZone(tz: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(0);
  } catch {
    throw new Error(`Invalid APP_TZ: ${tz}`);
  }
}
