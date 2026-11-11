/**
 * Away / busy status text. Pure, so the rules can be tested. The server already drops
 * expired statuses; the page checks `until` again so a cached screen never shows a stale one.
 */

export const STATUS_TZ = "Europe/Berlin";
export const STATUS_TEXT_MAX = 60;
export const STATUS_PLACE_MAX = 40;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LABELS = { away: "Away", busy: "Busy" };
const BADGES = { away: "\u2708\ufe0f", busy: "\u23f3" };

/** The status object when it is a known type and not past its end, else null. */
export function activeStatus(status, now = Date.now()) {
  if (!status || typeof status !== "object" || !LABELS[status.type]) return null;
  if (typeof status.until === "number" && now > status.until) return null;
  return status;
}

export function statusLabel(type) {
  return LABELS[type] || "";
}

export function statusBadge(type) {
  return BADGES[type] || "";
}

function localParts(ms, tz, extra) {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", ...extra }).formatToParts(new Date(ms));
}

/** YYYY-MM-DD of an instant in `tz`. */
function localDay(ms, tz = STATUS_TZ) {
  const parts = localParts(ms, tz, { year: "numeric", month: "2-digit", day: "2-digit" });
  const read = (type) => parts.find((part) => part.type === type)?.value ?? "";
  return `${read("year")}-${read("month")}-${read("day")}`;
}

function addDay(day, count) {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date + count)).toISOString().slice(0, 10);
}

/** Local wall time minus UTC, in ms, at one instant. */
function offsetAt(ms, tz) {
  const parts = localParts(ms, tz, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const read = (type) => Number(parts.find((part) => part.type === type)?.value ?? 0) % (type === "hour" ? 24 : Infinity);
  return Date.UTC(read("year"), read("month") - 1, read("day"), read("hour"), read("minute")) - Math.floor(ms / 60000) * 60000;
}

/** UTC instant for HH:MM on a YYYY-MM-DD day in `tz`. A time that does not exist uses the offset from before the gap. */
function dayTime(day, hhmm, tz) {
  const [year, month, date] = day.split("-").map(Number);
  const [hour, minute] = hhmm.split(":").map(Number);
  const wall = Date.UTC(year, month - 1, date, hour, minute);
  const DAY = 86400000;
  const before = offsetAt(wall - DAY, tz);
  const after = offsetAt(wall + DAY, tz);
  const fits = [wall - before, wall - after].filter((utc) => utc + offsetAt(utc, tz) === wall);
  return fits.length ? Math.min(...fits) : wall - before;
}

function dayEnd(day, tz) {
  return dayTime(addDay(day, 1), "00:00", tz) - 1;
}

/** YYYY-MM-DD today in the status zone (Berlin unless given), the zone the end day is counted in. */
export function statusToday(now = Date.now(), tz = STATUS_TZ) {
  return localDay(now, tz);
}

/** The end day as YYYY-MM-DD, for the date field. */
export function statusUntilDay(status, tz = STATUS_TZ) {
  return typeof status?.until === "number" ? localDay(status.until, tz) : "";
}

/**
 * "until 13 Nov" for an end of day, with the year when it is not this year.
 * Any other instant reads as a clock: "until 18:00", "until tomorrow 18:00", "until Fri 18:00".
 * Empty without an end.
 */
export function untilText(until, now = Date.now(), tz = STATUS_TZ) {
  if (typeof until !== "number") return "";
  const day = localDay(until, tz);
  const [year, month, date] = day.split("-").map(Number);
  const sameYear = day.slice(0, 4) === localDay(now, tz).slice(0, 4);
  if (localDay(until + 1, tz) !== day) {
    const base = `until ${date} ${MONTHS[month - 1]}`;
    return sameYear ? base : `${base} ${year}`;
  }
  const parts = localParts(until, tz, { hour: "2-digit", minute: "2-digit", weekday: "short" });
  const read = (type) => parts.find((part) => part.type === type)?.value ?? "";
  const clock = `${String(Number(read("hour")) % 24).padStart(2, "0")}:${read("minute")}`;
  const today = localDay(now, tz);
  if (day === today) return `until ${clock}`;
  if (day === addDay(today, 1)) return `until tomorrow ${clock}`;
  const base = `until ${read("weekday")} ${clock}`;
  return sameYear ? base : `${base} ${year}`;
}

/** The next time the clock reads HH:MM in `tz`: today if still ahead, else tomorrow. Null for a bad time. */
export function untilFromClock(hhmm, now = Date.now(), tz = STATUS_TZ) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(typeof hhmm === "string" ? hhmm : "");
  if (!match) return null;
  const today = localDay(now, tz);
  const at = dayTime(today, hhmm, tz);
  return at > now ? at : dayTime(addDay(today, 1), hhmm, tz);
}

/** Quick picks for "busy until": two hours, 6pm, tomorrow. */
export function busyUntilPresets(now = Date.now(), tz = STATUS_TZ) {
  return [
    { id: "1h", label: "1 hour", until: now + 3600000 },
    { id: "2h", label: "2 hours", until: now + 7200000 },
    { id: "6pm", label: "Until 6pm", until: untilFromClock("18:00", now, tz) },
    { id: "tomorrow", label: "Until tomorrow", until: dayEnd(addDay(localDay(now, tz), 1), tz) },
  ];
}

/** Note and place, without saying the place twice when the note already names it. */
function details(status) {
  const text = (status.text || "").trim();
  const place = (status.place || "").trim();
  if (text && place && text.toLowerCase().includes(place.toLowerCase())) return [text];
  return [text, place].filter(Boolean);
}

/** "Away · Tennis vacation in Portugal · until 13 Nov". Null without an active status. */
export function statusLine(status, now = Date.now(), tz = STATUS_TZ) {
  const live = activeStatus(status, now);
  if (!live) return null;
  return [statusLabel(live.type), ...details(live), untilText(live.until, now, tz)].filter(Boolean).join(" · ");
}

/** "Away until 13 Nov", for tight rows. */
export function statusShort(status, now = Date.now(), tz = STATUS_TZ) {
  const live = activeStatus(status, now);
  if (!live) return null;
  return [statusLabel(live.type), untilText(live.until, now, tz)].filter(Boolean).join(" ");
}

/**
 * One line for a circle: "Away: Phil, until 13 Nov · Busy: Alex, Bea".
 * Up to `max` names per group, then "+N". The end day only shows for a lone person.
 */
export function circleStatusLine(members, selfId = "", now = Date.now(), max = 3, tz = STATUS_TZ) {
  const groups = [];
  for (const type of ["away", "busy"]) {
    const people = (members || []).filter((member) => activeStatus(member?.status, now)?.type === type);
    if (!people.length) continue;
    const names = people.slice(0, max).map((member) => (member.id === selfId ? "You" : member.name));
    const more = people.length - max;
    let text = `${statusLabel(type)}: ${names.join(", ")}${more > 0 ? ` +${more}` : ""}`;
    if (people.length === 1) {
      const until = untilText(people[0].status.until, now, tz);
      if (until) text += `, ${until}`;
    }
    groups.push(text);
  }
  return groups.length ? groups.join(" · ") : null;
}
