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
