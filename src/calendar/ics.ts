// A small RFC 5545 writer. Pure: no clock, no database, no config.

export type IcsStatus = "TENTATIVE" | "CONFIRMED" | "CANCELLED";

/** A timed event is a pair of UTC instants. An all-day event is a local day (YYYY-MM-DD). */
export type IcsWhen =
  | { kind: "timed"; startMs: number; endMs: number }
  | { kind: "day"; day: string };

export type IcsEvent = {
  uid: string;
  dtstamp: number;
  sequence: number;
  lastModified: number;
  summary: string;
  description: string;
  location: string;
  url: string;
  status: IcsStatus;
  when: IcsWhen;
};

export type IcsCalendar = {
  /** X-WR-CALNAME, for a subscribed feed. */
  name?: string;
  /** X-WR-TIMEZONE, a display hint. Times are UTC either way. */
  tz?: string;
  /** Feed only: asks clients to poll this often (REFRESH-INTERVAL, X-PUBLISHED-TTL). */
  refreshHours?: number;
  events: IcsEvent[];
};

export const PRODID = "-//Spontaco//Calendar 1.0//EN";
const CRLF = "\r\n";
const MAX_OCTETS = 75;

/** TEXT value escaping: backslash, semicolon, comma, and newlines. Other control characters are dropped. */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

/**
 * Folds one content line at 75 octets. Continuation lines start with a space.
 * Counts UTF-8 bytes and never splits a character.
 */
export function foldLine(line: string): string {
  const parts: string[] = [];
  let current = "";
  let octets = 0;
  let limit = MAX_OCTETS;
  for (const char of line) {
    const size = Buffer.byteLength(char, "utf8");
    if (octets + size > limit) {
      parts.push(current);
      current = "";
      octets = 0;
      limit = MAX_OCTETS - 1;
    }
    current += char;
    octets += size;
  }
  parts.push(current);
  return parts.join(`${CRLF} `);
}

/** 20260601T150000Z */
export function utcStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** 2026-06-01 to 20260601. */
export function dateValue(day: string): string {
  return day.replace(/-/g, "");
}

/** The day after a YYYY-MM-DD, for an all-day DTEND (exclusive). */
export function nextDay(day: string): string {
  const next = new Date(`${day}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

function whenLines(when: IcsWhen): string[] {
  if (when.kind === "day") {
    return [`DTSTART;VALUE=DATE:${dateValue(when.day)}`, `DTEND;VALUE=DATE:${dateValue(nextDay(when.day))}`];
  }
  return [`DTSTART:${utcStamp(when.startMs)}`, `DTEND:${utcStamp(when.endMs)}`];
}

function eventLines(event: IcsEvent): string[] {
  return [
    "BEGIN:VEVENT",
    `UID:${event.uid}`,
    `DTSTAMP:${utcStamp(event.dtstamp)}`,
    `LAST-MODIFIED:${utcStamp(event.lastModified)}`,
    `SEQUENCE:${Math.max(0, Math.floor(event.sequence))}`,
    ...whenLines(event.when),
    `SUMMARY:${escapeText(event.summary)}`,
    event.description ? `DESCRIPTION:${escapeText(event.description)}` : "",
    event.location ? `LOCATION:${escapeText(event.location)}` : "",
    event.url ? `URL:${event.url}` : "",
    `STATUS:${event.status}`,
    "TRANSP:OPAQUE",
    "END:VEVENT",
  ].filter(Boolean);
}

/** Polling hints. Apple Calendar honors them; Google Calendar ignores them and polls on its own. */
function refreshLines(hours: number | undefined): string[] {
  if (!hours || hours < 1) return [];
  const duration = `PT${Math.floor(hours)}H`;
  return [`REFRESH-INTERVAL;VALUE=DURATION:${duration}`, `X-PUBLISHED-TTL:${duration}`];
}

/** A whole VCALENDAR, CRLF line endings, folded, ending in CRLF. */
export function buildCalendar(calendar: IcsCalendar): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${PRODID}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    calendar.name ? `X-WR-CALNAME:${escapeText(calendar.name)}` : "",
    calendar.tz ? `X-WR-TIMEZONE:${escapeText(calendar.tz)}` : "",
    ...refreshLines(calendar.refreshHours),
    ...calendar.events.flatMap(eventLines),
    "END:VCALENDAR",
  ].filter(Boolean);
  return lines.map(foldLine).join(CRLF) + CRLF;
}
