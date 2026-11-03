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

/** UTC instant for a clock time on a calendar day in `tz`. */
export function zonedDateTime(isoDay: string, hhmm: string, tz: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!match) throw new Error("bad time");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error("bad time");
  const [year, month, day] = isoDay.split("-").map(Number);
  let utc = Date.UTC(year, month - 1, day, hour, minute);
  for (let i = 0; i < 4; i += 1) {
    const got = zonedParts(utc, tz);
    const delta = Date.UTC(year, month - 1, day, hour, minute)
      - Date.UTC(got.year, got.month - 1, got.day, got.hour, got.minute);
    if (delta === 0) break;
    utc += delta;
  }
  return utc;
}

export function whenLabel(forDate: string, today: string, tomorrow: string): string {
  if (forDate === tomorrow) return "Tomorrow";
  if (forDate === today) return "Today";
  return forDate;
}

export function assertTimeZone(tz: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(0);
  } catch {
    throw new Error(`Invalid APP_TZ: ${tz}`);
  }
}
