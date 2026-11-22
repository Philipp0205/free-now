/**
 * Pure "later today" clock and plan day helpers. The page passes the circle timezone;
 * this file does not touch app state, so the rules can be tested.
 */

export function zonedParts(ms, tz = "Europe/Berlin") {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(ms));
  const read = (type) => parts.find((part) => part.type === type)?.value ?? "";
  let hour = Number(read("hour"));
  if (hour === 24) hour = 0;
  return {
    day: `${read("year")}-${read("month")}-${read("day")}`,
    hour,
    minute: Number(read("minute")),
  };
}

export function clockText(hour, minute) {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** The instant (ms) of a clock time on a YYYY-MM-DD day in `tz`. NaN for a bad day or clock. */
export function zonedInstant(day, hhmm, tz = "Europe/Berlin") {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || "") || !/^\d{2}:\d{2}$/.test(hhmm || "")) return NaN;
  const wall = Date.parse(`${day}T${hhmm}:00Z`);
  let utc = wall;
  // Two passes settle the zone offset, also on a day the clocks change.
  for (let pass = 0; pass < 2; pass += 1) {
    const got = zonedParts(utc, tz);
    utc += wall - Date.parse(`${got.day}T${clockText(got.hour, got.minute)}:00Z`);
  }
  return utc;
}

export function nextLaterSlot(now = Date.now(), tz = "Europe/Berlin") {
  const earliest = now + 15 * 60 * 1000;
  const today = zonedParts(now, tz).day;
  const part = zonedParts(earliest, tz);
  let { hour, minute } = part;
  if (minute !== 0 && minute !== 30) {
    if (minute < 30) minute = 30;
    else { minute = 0; hour += 1; }
  }
  if (part.day === today && hour < 24) return clockText(hour, minute);
  // The next :00/:30 is past midnight. 23:59 is the last clock still later today.
  if (minLaterClock(now, tz)) return "23:59";
  if (hour >= 24) hour -= 24;
  return clockText(hour, minute);
}

/** "tomorrow" once now+1min has crossed midnight, so the default slot is not today. */
export function nextLaterDay(now = Date.now(), tz = "Europe/Berlin") {
  return minLaterClock(now, tz) ? "today" : "tomorrow";
}

export function minLaterClock(now = Date.now(), tz = "Europe/Berlin") {
  const part = zonedParts(now + 60 * 1000, tz);
  if (part.day !== zonedParts(now, tz).day) return "";
  return clockText(part.hour, part.minute);
}

export function isLaterToday(hhmm, now = Date.now(), tz = "Europe/Berlin") {
  if (!/^\d{2}:\d{2}$/.test(hhmm)) return false;
  const min = minLaterClock(now, tz);
  if (!min) return false;
  return hhmm >= min;
}

/** How far ahead a plan can go, in calendar days. Same as PLAN_DAYS_AHEAD on the server. */
export const PLAN_DAYS_AHEAD = 365;

/** Calendar math on YYYY-MM-DD, so a DST day never shifts the date. */
export function addDays(iso, days) {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function daysBetween(from, to) {
  const utc = (iso) => {
    const [year, month, day] = iso.split("-").map(Number);
    return Date.UTC(year, month - 1, day);
  };
  return Math.round((utc(to) - utc(from)) / 86400000);
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function weekday(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  return WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}

/** Today, Tomorrow, a weekday for the next 6 days, then "Sat 14 Nov" (plus the year if not this year). */
export function dayLabel(iso, today) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || "")) return "";
  const gap = daysBetween(today, iso);
  if (gap === 0) return "Today";
  if (gap === 1) return "Tomorrow";
  if (gap > 1 && gap <= 6) return weekday(iso);
  return shortDate(iso, today);
}

/** "Sat 14 Nov" (plus the year if not this year). For text read later, like a shared link. Same as the server. */
export function shortDate(iso, today) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || "")) return "";
  const [year, month, day] = iso.split("-").map(Number);
  const base = `${weekday(iso).slice(0, 3)} ${day} ${MONTHS[month - 1]}`;
  return iso.slice(0, 4) === String(today || "").slice(0, 4) ? base : `${base} ${year}`;
}

/** The days a plan can be on, from today in `tz`. */
export function planDayRange(now = Date.now(), tz = "Europe/Berlin") {
  const today = zonedParts(now, tz).day;
  return { today, tomorrow: addDays(today, 1), min: today, max: addDays(today, PLAN_DAYS_AHEAD) };
}

/** "today", "tomorrow", or "pick" for a stored plan day. */
export function planDayChoice(forDate, now = Date.now(), tz = "Europe/Berlin") {
  const range = planDayRange(now, tz);
  if (forDate === range.today) return "today";
  if (forDate === range.tomorrow) return "tomorrow";
  return "pick";
}

/** The YYYY-MM-DD a choice stands for. "pick" uses the picked date. */
export function planDayDate(choice, picked, now = Date.now(), tz = "Europe/Berlin") {
  const range = planDayRange(now, tz);
  if (choice === "today") return range.today;
  if (choice === "tomorrow") return range.tomorrow;
  return /^\d{4}-\d{2}-\d{2}$/.test(picked || "") ? picked : "";
}
