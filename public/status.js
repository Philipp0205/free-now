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

function berlinDay(ms) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: STATUS_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
  const read = (type) => parts.find((part) => part.type === type)?.value ?? "";
  return `${read("year")}-${read("month")}-${read("day")}`;
}

/** YYYY-MM-DD today in Berlin, the zone the end day is counted in. */
export function statusToday(now = Date.now()) {
  return berlinDay(now);
}

/** The end day as YYYY-MM-DD, for the date field. */
export function statusUntilDay(status) {
  return typeof status?.until === "number" ? berlinDay(status.until) : "";
}

/** "until 13 Nov", with the year when it is not this year. Empty without an end. */
export function untilText(until, now = Date.now()) {
  if (typeof until !== "number") return "";
  const day = berlinDay(until);
  const [year, month, date] = day.split("-").map(Number);
  const base = `until ${date} ${MONTHS[month - 1]}`;
  return day.slice(0, 4) === berlinDay(now).slice(0, 4) ? base : `${base} ${year}`;
}

/** Note and place, without saying the place twice when the note already names it. */
function details(status) {
  const text = (status.text || "").trim();
  const place = (status.place || "").trim();
  if (text && place && text.toLowerCase().includes(place.toLowerCase())) return [text];
  return [text, place].filter(Boolean);
}

/** "Away · Tennis vacation in Portugal · until 13 Nov". Null without an active status. */
export function statusLine(status, now = Date.now()) {
  const live = activeStatus(status, now);
  if (!live) return null;
  return [statusLabel(live.type), ...details(live), untilText(live.until, now)].filter(Boolean).join(" · ");
}

/** "Away until 13 Nov", for tight rows. */
export function statusShort(status, now = Date.now()) {
  const live = activeStatus(status, now);
  if (!live) return null;
  return [statusLabel(live.type), untilText(live.until, now)].filter(Boolean).join(" ");
}

/**
 * One line for a circle: "Away: Phil, until 13 Nov · Busy: Alex, Bea".
 * Up to `max` names per group, then "+N". The end day only shows for a lone person.
 */
export function circleStatusLine(members, selfId = "", now = Date.now(), max = 3) {
  const groups = [];
  for (const type of ["away", "busy"]) {
    const people = (members || []).filter((member) => activeStatus(member?.status, now)?.type === type);
    if (!people.length) continue;
    const names = people.slice(0, max).map((member) => (member.id === selfId ? "You" : member.name));
    const more = people.length - max;
    let text = `${statusLabel(type)}: ${names.join(", ")}${more > 0 ? ` +${more}` : ""}`;
    if (people.length === 1) {
      const until = untilText(people[0].status.until, now);
      if (until) text += `, ${until}`;
    }
    groups.push(text);
  }
  return groups.length ? groups.join(" · ") : null;
}
