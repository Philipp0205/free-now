/**
 * A small iCalendar (RFC 5545) reader for the availability import. It turns a feed into busy
 * events for a short window (now to now + 14 days by default). No dependency.
 *
 * Read: VEVENT only (nested VALARM and VTIMEZONE bodies are ignored), DTSTART, DTEND, DURATION,
 * SUMMARY (kept for the owner only), STATUS, TRANSP, X-MICROSOFT-CDO-BUSYSTATUS, RRULE, EXDATE,
 * RDATE, RECURRENCE-ID. Folded lines and quoted parameters are handled.
 *
 * Times: UTC (Z), TZID (an IANA name, a vendor-prefixed IANA name such as
 * /mozilla.org/.../Europe/Berlin, or a common Windows name), else floating, which uses APP_TZ.
 * An unknown TZID also falls back to APP_TZ. All-day (VALUE=DATE) events run from APP_TZ midnight
 * to APP_TZ midnight, DTEND exclusive, one day when it is missing.
 *
 * RRULE: FREQ=DAILY, WEEKLY, MONTHLY, and simple YEARLY, with INTERVAL, COUNT (counted from
 * DTSTART), UNTIL, BYDAY (ordinals like 2TU or -1FR in MONTHLY, and in YEARLY with BYMONTH),
 * BYMONTHDAY (negative too), BYMONTH, and WKST.
 * Not supported, so that event is skipped and counted in `skipped`: BYSETPOS, BYHOUR, BYMINUTE,
 * BYSECOND, BYWEEKNO, BYYEARDAY, FREQ=HOURLY/MINUTELY/SECONDLY, and YEARLY BYDAY without BYMONTH.
 *
 * Not busy, so ignored: STATUS:CANCELLED, TRANSP:TRANSPARENT, X-MICROSOFT-CDO-BUSYSTATUS:FREE,
 * and events with no length.
 */

export type ParsedEvent = { start: number; end: number; allDay: boolean; title: string };

export type ParseResult = {
  /** Busy events that overlap the window, sorted by start, at most maxEvents. */
  events: ParsedEvent[];
  /** Merged busy intervals clipped to the window. */
  busy: Array<[number, number]>;
  /** Events left out because they use a rule this reader does not support. */
  skipped: number;
  windowStart: number;
  windowEnd: number;
};

export type ParseOptions = {
  now: number;
  tz: string;
  windowMs?: number;
  maxEvents?: number;
};

const DAY_MS = 86_400_000;
export const FREEBUSY_WINDOW_MS = 14 * DAY_MS;
const MAX_EVENTS = 500;
const MAX_PERIODS = 20_000;
const MAX_TITLE = 80;

type Prop = { name: string; params: Record<string, string>; value: string };
type Component = { props: Prop[] };

// ---------- lines and properties ----------

function unfold(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r\n|\n|\r/)) {
    if ((raw.startsWith(" ") || raw.startsWith("\t")) && out.length) out[out.length - 1] += raw.slice(1);
    else out.push(raw);
  }
  return out;
}

function parseLine(line: string): Prop | null {
  let i = 0;
  let quoted = false;
  let nameEnd = -1;
  let valueStart = -1;
  for (; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === ";" && nameEnd < 0) nameEnd = i;
    else if (!quoted && ch === ":") {
      valueStart = i + 1;
      if (nameEnd < 0) nameEnd = i;
      break;
    }
  }
  if (valueStart < 0) return null;
  const name = line.slice(0, nameEnd).trim().toUpperCase();
  if (!name) return null;
  const params: Record<string, string> = {};
  const paramText = line.slice(nameEnd, valueStart - 1);
  if (paramText.startsWith(";")) {
    let key = "";
    let value = "";
    let inValue = false;
    quoted = false;
    const flush = () => {
      if (key) params[key.trim().toUpperCase()] = value;
      key = "";
      value = "";
      inValue = false;
    };
    for (let j = 1; j < paramText.length; j++) {
      const ch = paramText[j];
      if (ch === '"') quoted = !quoted;
      else if (!quoted && ch === ";") flush();
      else if (!quoted && ch === "=" && !inValue) inValue = true;
      else if (inValue) value += ch;
      else key += ch;
    }
    flush();
  }
  return { name, params, value: line.slice(valueStart) };
}

function readEvents(text: string): Component[] {
  const events: Component[] = [];
  const stack: string[] = [];
  let current: Component | null = null;
  for (const line of unfold(text)) {
    if (!line) continue;
    const prop = parseLine(line);
    if (!prop) continue;
    if (prop.name === "BEGIN") {
      const kind = prop.value.trim().toUpperCase();
      stack.push(kind);
      if (kind === "VEVENT" && stack.length === 2 && stack[0] === "VCALENDAR") current = { props: [] };
      continue;
    }
    if (prop.name === "END") {
      const kind = prop.value.trim().toUpperCase();
      const at = stack.lastIndexOf(kind);
      if (at >= 0) stack.length = at;
      if (kind === "VEVENT" && current && stack.length === 1) {
        events.push(current);
        current = null;
      }
      continue;
    }
    // Only the event's own properties, never a nested VALARM.
    if (current && stack.length === 2 && stack[1] === "VEVENT") current.props.push(prop);
  }
  return events;
}

function first(component: Component, name: string): Prop | undefined {
  return component.props.find((prop) => prop.name === name);
}

function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, ch: string) => (ch === "n" || ch === "N" ? " " : ch));
}

// ---------- time zones ----------

const zoneOk = new Map<string, boolean>();
const zoneFormat = new Map<string, Intl.DateTimeFormat>();

function validZone(tz: string): boolean {
  let ok = zoneOk.get(tz);
  if (ok === undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(0);
      ok = true;
    } catch {
      ok = false;
    }
    if (zoneOk.size < 500) zoneOk.set(tz, ok);
  }
  return ok;
}

const WINDOWS_ZONES: Record<string, string> = {
  "w. europe standard time": "Europe/Berlin",
  "romance standard time": "Europe/Paris",
  "central europe standard time": "Europe/Budapest",
  "central european standard time": "Europe/Warsaw",
  "e. europe standard time": "Europe/Chisinau",
  "fle standard time": "Europe/Helsinki",
  "gtb standard time": "Europe/Bucharest",
  "gmt standard time": "Europe/London",
  "greenwich standard time": "Atlantic/Reykjavik",
  "russian standard time": "Europe/Moscow",
  "turkey standard time": "Europe/Istanbul",
  "israel standard time": "Asia/Jerusalem",
  "arabian standard time": "Asia/Dubai",
  "india standard time": "Asia/Kolkata",
  "se asia standard time": "Asia/Bangkok",
  "singapore standard time": "Asia/Singapore",
  "china standard time": "Asia/Shanghai",
  "tokyo standard time": "Asia/Tokyo",
  "aus eastern standard time": "Australia/Sydney",
  "new zealand standard time": "Pacific/Auckland",
  "pacific standard time": "America/Los_Angeles",
  "mountain standard time": "America/Denver",
  "us mountain standard time": "America/Phoenix",
  "central standard time": "America/Chicago",
  "eastern standard time": "America/New_York",
  "atlantic standard time": "America/Halifax",
  "alaskan standard time": "America/Anchorage",
  "hawaiian standard time": "Pacific/Honolulu",
  "e. south america standard time": "America/Sao_Paulo",
  "utc": "UTC",
  "coordinated universal time": "UTC",
};

/** An IANA zone for a TZID, or the fallback (APP_TZ). */
export function resolveTzid(tzid: string | undefined, fallback: string): string {
  const raw = (tzid ?? "").trim().replace(/^"|"$/g, "");
  if (!raw) return fallback;
  if (validZone(raw)) return raw;
  const parts = raw.split("/").filter(Boolean);
  for (const take of [3, 2]) {
    if (parts.length >= take) {
      const tail = parts.slice(-take).join("/");
      if (/^[A-Za-z]/.test(tail) && validZone(tail)) return tail;
    }
  }
  const windows = WINDOWS_ZONES[raw.toLowerCase()];
  if (windows) return windows;
  return fallback;
}

function formatter(tz: string): Intl.DateTimeFormat {
  let format = zoneFormat.get(tz);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    zoneFormat.set(tz, format);
  }
  return format;
}

function offsetAt(ms: number, tz: string): number {
  if (tz === "UTC") return 0;
  const parts = formatter(tz).formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  const hour = get("hour") === 24 ? 0 : get("hour");
  const wall = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  return wall - Math.floor(ms / 1000) * 1000;
}

/** UTC ms for a wall clock time in tz. Repeated times take the first, skipped times shift forward. */
export function wallToUtc(wall: number, tz: string): number {
  if (tz === "UTC") return wall;
  const before = offsetAt(wall - DAY_MS, tz);
  const after = offsetAt(wall + DAY_MS, tz);
  const fits = [wall - before, wall - after].filter((utc) => utc + offsetAt(utc, tz) === wall);
  if (fits.length) return Math.min(...fits);
  return wall - before;
}

// ---------- values ----------

/** Day number: whole days since 1970-01-01. */
function dayNum(year: number, month: number, day: number): number {
  return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
}

function ymd(dn: number): { year: number; month: number; day: number; weekday: number } {
  const date = new Date(dn * DAY_MS);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), weekday: date.getUTCDay() };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** A DTSTART-like value: a date, or a time of day in a zone ("UTC" for Z). */
type When = { dn: number; secs: number; date: boolean; tz: string };

function parseWhen(value: string, params: Record<string, string>, tz: string): When | null {
  const text = value.trim();
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (dateOnly || params.VALUE?.toUpperCase() === "DATE") {
    const match = dateOnly ?? /^(\d{4})(\d{2})(\d{2})/.exec(text);
    if (!match) return null;
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
    return { dn: dayNum(year, month, day), secs: 0, date: true, tz };
  }
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/i.exec(text);
  if (!match) return null;
  const [year, month, day, hour, minute] = [1, 2, 3, 4, 5].map((i) => Number(match[i]));
  const second = Number(match[6] ?? "0");
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 60) return null;
  const zone = match[7] ? "UTC" : resolveTzid(params.TZID, tz);
  return { dn: dayNum(year, month, day), secs: hour * 3600 + minute * 60 + Math.min(second, 59), date: false, tz: zone };
}

/** The UTC instant of a When moved to another day (same wall time, same zone). */
function instantOn(when: When, dn: number, tz: string): number {
  if (when.date) return wallToUtc(dn * DAY_MS, tz);
  return wallToUtc(dn * DAY_MS + when.secs * 1000, when.tz);
}

function parseDuration(value: string): { days: number; ms: number } | null {
  const match = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(value.trim());
  if (!match || value.trim().length <= 1) return null;
  const sign = match[1] === "-" ? -1 : 1;
  const days = (Number(match[2] ?? 0) * 7 + Number(match[3] ?? 0)) * sign;
  const ms = ((Number(match[4] ?? 0) * 3600 + Number(match[5] ?? 0) * 60 + Number(match[6] ?? 0)) * 1000) * sign;
  return { days, ms };
}

// ---------- recurrence ----------

const WEEKDAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const UNSUPPORTED_PARTS = ["BYSETPOS", "BYHOUR", "BYMINUTE", "BYSECOND", "BYWEEKNO", "BYYEARDAY"];

type Rule = {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  count: number | null;
  until: When | null;
  byDay: Array<{ ord: number; wd: number }> | null;
  byMonthDay: number[] | null;
  byMonth: number[] | null;
  wkst: number;
};

function parseRule(value: string, tz: string): Rule | "unsupported" {
  const parts: Record<string, string> = {};
  for (const piece of value.split(";")) {
    const [key, val] = piece.split("=");
    if (key && val !== undefined) parts[key.trim().toUpperCase()] = val.trim().toUpperCase();
  }
  const freq = parts.FREQ;
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") return "unsupported";
  if (UNSUPPORTED_PARTS.some((key) => key in parts)) return "unsupported";
  const interval = parts.INTERVAL ? Number(parts.INTERVAL) : 1;
  if (!Number.isInteger(interval) || interval < 1 || interval > 1000) return "unsupported";
  const count = parts.COUNT ? Number(parts.COUNT) : null;
  if (count !== null && (!Number.isInteger(count) || count < 1)) return "unsupported";
  let until: When | null = null;
  if (parts.UNTIL) {
    until = parseWhen(parts.UNTIL, {}, tz);
    if (!until) return "unsupported";
  }
  let byDay: Rule["byDay"] = null;
  if (parts.BYDAY) {
    byDay = [];
    for (const item of parts.BYDAY.split(",")) {
      const match = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(item.trim());
      if (!match) return "unsupported";
      const ord = match[1] ? Number(match[1]) : 0;
      if (Math.abs(ord) > 5) return "unsupported";
      byDay.push({ ord, wd: WEEKDAY_CODES.indexOf(match[2]) });
    }
    if (byDay.some((item) => item.ord !== 0) && freq !== "MONTHLY" && freq !== "YEARLY") return "unsupported";
    if (freq === "YEARLY" && !parts.BYMONTH) return "unsupported";
  }
  const numbers = (text: string | undefined, min: number, max: number): number[] | null | "bad" => {
    if (!text) return null;
    const list = text.split(",").map((item) => Number(item.trim()));
    if (list.some((n) => !Number.isInteger(n) || n === 0 || Math.abs(n) > max || n < min)) return "bad";
    return list;
  };
  const byMonthDay = numbers(parts.BYMONTHDAY, -31, 31);
  const byMonth = numbers(parts.BYMONTH, 1, 12);
  if (byMonthDay === "bad" || byMonth === "bad") return "unsupported";
  const wkst = parts.WKST ? WEEKDAY_CODES.indexOf(parts.WKST) : 1;
  if (wkst < 0) return "unsupported";
  return { freq, interval, count, until, byDay, byMonthDay, byMonth, wkst };
}

function monthDays(year: number, month: number, rule: Rule, startDay: number): number[] {
  const last = daysInMonth(year, month);
  const base = dayNum(year, month, 1);
  let days: number[] | null = null;
  if (rule.byMonthDay) {
    days = rule.byMonthDay.map((n) => (n > 0 ? n : last + 1 + n)).filter((n) => n >= 1 && n <= last);
  }
  if (rule.byDay) {
    const fromDay: number[] = [];
    for (const { ord, wd } of rule.byDay) {
      const matches: number[] = [];
      for (let d = 1; d <= last; d++) if (ymd(base + d - 1).weekday === wd) matches.push(d);
      if (ord === 0) fromDay.push(...matches);
      else {
        const pick = ord > 0 ? matches[ord - 1] : matches[matches.length + ord];
        if (pick) fromDay.push(pick);
      }
    }
    days = days ? days.filter((d) => fromDay.includes(d)) : fromDay;
  }
  if (!days) days = startDay <= last ? [startDay] : [];
  return [...new Set(days)].sort((a, b) => a - b).map((d) => base + d - 1);
}

/** Candidate days of one period, sorted. */
function periodDays(rule: Rule, start: ReturnType<typeof ymd>, startDn: number, period: number): number[] {
  if (rule.freq === "DAILY") {
    const dn = startDn + period * rule.interval;
    const date = ymd(dn);
    if (rule.byMonth && !rule.byMonth.includes(date.month)) return [];
    if (rule.byMonthDay && !monthDays(date.year, date.month, { ...rule, byDay: null }, date.day).includes(dn)) return [];
    if (rule.byDay && !rule.byDay.some((item) => item.wd === date.weekday)) return [];
    return [dn];
  }
  if (rule.freq === "WEEKLY") {
    const weekStart = startDn - ((start.weekday - rule.wkst + 7) % 7) + period * rule.interval * 7;
    const wanted = rule.byDay ? rule.byDay.map((item) => item.wd) : [start.weekday];
    const days: number[] = [];
    for (let i = 0; i < 7; i++) {
      const dn = weekStart + i;
      const date = ymd(dn);
      if (!wanted.includes(date.weekday)) continue;
      if (rule.byMonth && !rule.byMonth.includes(date.month)) continue;
      days.push(dn);
    }
    return days;
  }
  if (rule.freq === "MONTHLY") {
    const index = start.year * 12 + (start.month - 1) + period * rule.interval;
    const year = Math.floor(index / 12);
    const month = (index % 12) + 1;
    if (rule.byMonth && !rule.byMonth.includes(month)) return [];
    return monthDays(year, month, rule, start.day);
  }
  const year = start.year + period * rule.interval;
  const months = rule.byMonth ?? (rule.byMonthDay ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] : [start.month]);
  const days: number[] = [];
  for (const month of [...months].sort((a, b) => a - b)) {
    days.push(...monthDays(year, month, rule.byMonthDay || rule.byDay ? rule : { ...rule, byMonthDay: null, byDay: null }, start.day));
  }
  return days;
}

/** First period that can still matter when nothing needs counting from DTSTART. */
function firstPeriod(rule: Rule, start: ReturnType<typeof ymd>, startDn: number, earliestDn: number): number {
  if (rule.count !== null || earliestDn <= startDn) return 0;
  const gap = earliestDn - startDn;
  let period = 0;
  if (rule.freq === "DAILY") period = Math.floor(gap / rule.interval);
  else if (rule.freq === "WEEKLY") period = Math.floor(gap / (7 * rule.interval)) - 1;
  else if (rule.freq === "MONTHLY") {
    const e = ymd(earliestDn);
    period = Math.floor(((e.year - start.year) * 12 + (e.month - start.month)) / rule.interval) - 1;
  } else period = Math.floor((ymd(earliestDn).year - start.year) / rule.interval) - 1;
  return Math.max(0, period);
}

// ---------- main ----------

type Span = { start: number; end: number };

function isBusy(event: Component): boolean {
  const status = first(event, "STATUS")?.value.trim().toUpperCase();
  if (status === "CANCELLED") return false;
  if (first(event, "TRANSP")?.value.trim().toUpperCase() === "TRANSPARENT") return false;
  if (first(event, "X-MICROSOFT-CDO-BUSYSTATUS")?.value.trim().toUpperCase() === "FREE") return false;
  return true;
}

function idKey(when: When, tz: string): string {
  return when.date ? `d${when.dn}` : `t${instantOn(when, when.dn, tz)}`;
}

export function parseIcs(text: string, options: ParseOptions): ParseResult {
  const tz = options.tz;
  const windowStart = options.now;
  const windowEnd = options.now + (options.windowMs ?? FREEBUSY_WINDOW_MS);
  const maxEvents = options.maxEvents ?? MAX_EVENTS;
  const components = readEvents(text);
  const overrides = new Map<string, Set<string>>();
  for (const event of components) {
    const rid = first(event, "RECURRENCE-ID");
    const uid = first(event, "UID")?.value.trim() ?? "";
    if (!rid || !uid) continue;
    const when = parseWhen(rid.value, rid.params, tz);
    if (!when) continue;
    const set = overrides.get(uid) ?? new Set<string>();
    set.add(idKey(when, tz));
    overrides.set(uid, set);
  }

  const found: ParsedEvent[] = [];
  let skipped = 0;
  for (const event of components) {
    if (!isBusy(event)) continue;
    const startProp = first(event, "DTSTART");
    const start = startProp ? parseWhen(startProp.value, startProp.params, tz) : null;
    if (!start) {
      skipped++;
      continue;
    }
    const title = unescapeText(first(event, "SUMMARY")?.value ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
    const firstStart = instantOn(start, start.dn, tz);
    // Length: whole days for all-day events, else exact ms plus nominal days from DURATION.
    let lengthDays = 0;
    let lengthMs = 0;
    const endProp = first(event, "DTEND");
    const durationProp = first(event, "DURATION");
    if (start.date) {
      const end = endProp ? parseWhen(endProp.value, endProp.params, tz) : null;
      const duration = durationProp ? parseDuration(durationProp.value) : null;
      if (end && end.date) lengthDays = end.dn - start.dn;
      else if (duration) lengthDays = duration.days + Math.ceil(duration.ms / DAY_MS);
      else lengthDays = 1;
      if (lengthDays <= 0) lengthDays = 1;
    } else if (endProp) {
      const end = parseWhen(endProp.value, endProp.params, tz);
      if (end) lengthMs = instantOn(end, end.dn, tz) - firstStart;
    } else if (durationProp) {
      const duration = parseDuration(durationProp.value);
      if (duration) {
        lengthDays = duration.days;
        lengthMs = duration.ms;
      }
    }
    const span = (dn: number): Span => {
      const begin = instantOn(start, dn, tz);
      if (start.date) return { start: begin, end: wallToUtc((dn + lengthDays) * DAY_MS, tz) };
      const end = (lengthDays ? instantOn(start, dn + lengthDays, tz) : begin) + lengthMs;
      return { start: begin, end };
    };
    const maxLength = start.date ? (lengthDays + 1) * DAY_MS : Math.abs(lengthDays) * DAY_MS + Math.abs(lengthMs) + DAY_MS;
    const add = (piece: Span) => {
      if (piece.end <= piece.start) return;
      if (piece.end <= windowStart || piece.start >= windowEnd) return;
      found.push({ start: piece.start, end: piece.end, allDay: start.date, title });
    };

    const rruleProp = first(event, "RRULE");
    const isOverride = Boolean(first(event, "RECURRENCE-ID"));
    if (!rruleProp || isOverride) {
      add(span(start.dn));
      continue;
    }
    const rule = parseRule(rruleProp.value, tz);
    if (rule === "unsupported") {
      skipped++;
      continue;
    }
    const uid = first(event, "UID")?.value.trim() ?? "";
    const hidden = new Set<string>(overrides.get(uid) ?? []);
    for (const prop of event.props) {
      if (prop.name !== "EXDATE") continue;
      for (const item of prop.value.split(",")) {
        const when = parseWhen(item, prop.params, tz);
        if (when) hidden.add(idKey(when, tz));
      }
    }
    // A date EXDATE hides that day for timed events too.
    const isHidden = (dn: number) => hidden.has(`d${dn}`) || (!start.date && hidden.has(`t${instantOn(start, dn, tz)}`));
    const untilOk = (dn: number): boolean => {
      if (!rule.until) return true;
      if (rule.until.date) return dn <= rule.until.dn;
      return instantOn(start, dn, tz) <= instantOn(rule.until, rule.until.dn, tz);
    };

    const startDate = ymd(start.dn);
    const earliestDn = Math.floor((windowStart - maxLength) / DAY_MS) - 1;
    const lastDn = Math.floor(windowEnd / DAY_MS) + 1;
    let emitted = 0;
    // DTSTART is always the first instance.
    if (untilOk(start.dn)) {
      emitted++;
      if (!isHidden(start.dn)) add(span(start.dn));
    }
    let period = firstPeriod(rule, startDate, start.dn, earliestDn);
    let done = rule.count !== null && emitted >= rule.count;
    for (let loops = 0; !done && loops < MAX_PERIODS; loops++, period++) {
      const days = periodDays(rule, startDate, start.dn, period);
      for (const dn of days) {
        if (dn <= start.dn) continue;
        if (dn > lastDn || !untilOk(dn)) {
          done = true;
          break;
        }
        emitted++;
        if (!isHidden(dn)) add(span(dn));
        if (rule.count !== null && emitted >= rule.count) {
          done = true;
          break;
        }
      }
      // A period past the window ends the walk even when it had no matching days.
      if (!done && periodStartsAfter(rule, startDate, start.dn, period, lastDn)) done = true;
    }

    for (const prop of event.props) {
      if (prop.name !== "RDATE") continue;
      for (const item of prop.value.split(",")) {
        const when = parseWhen(item.split("/")[0], prop.params, tz);
        if (!when) continue;
        if (start.date) add(span(when.dn));
        else {
          const begin = instantOn(when, when.dn, tz);
          add({ start: begin, end: begin + (span(start.dn).end - firstStart) });
        }
      }
    }
  }

  found.sort((a, b) => a.start - b.start || a.end - b.end);
  const events: ParsedEvent[] = [];
  const seen = new Set<string>();
  for (const item of found) {
    const key = `${item.start}:${item.end}:${item.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(item);
    if (events.length >= maxEvents) break;
  }
  return { events, busy: mergeBusy(events, windowStart, windowEnd), skipped, windowStart, windowEnd };
}

function periodStartsAfter(rule: Rule, start: ReturnType<typeof ymd>, startDn: number, period: number, lastDn: number): boolean {
  if (rule.freq === "DAILY") return startDn + period * rule.interval > lastDn;
  if (rule.freq === "WEEKLY") return startDn - 7 + period * rule.interval * 7 > lastDn;
  if (rule.freq === "MONTHLY") {
    const index = start.year * 12 + (start.month - 1) + period * rule.interval;
    return dayNum(Math.floor(index / 12), (index % 12) + 1, 1) > lastDn;
  }
  return dayNum(start.year + period * rule.interval, 1, 1) > lastDn;
}

export function mergeBusy(events: Array<{ start: number; end: number }>, windowStart: number, windowEnd: number): Array<[number, number]> {
  const spans = events
    .map((item) => [Math.max(item.start, windowStart), Math.min(item.end, windowEnd)] as [number, number])
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([span[0], span[1]]);
  }
  return merged.slice(0, MAX_EVENTS);
}
