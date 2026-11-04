/**
 * Pure "later today" clock helpers. The page passes the circle timezone;
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
