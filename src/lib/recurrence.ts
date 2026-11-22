import { HttpError } from "./http.js";
import { addDays, zonedDateTime } from "./time.js";

export type Recurrence = "weekly" | "biweekly" | "monthly";

export const RECURRENCES: readonly Recurrence[] = ["weekly", "biweekly", "monthly"];

/**
 * Reads a repeat token from a request body. Undefined means the field was left out,
 * null means "never" (or an explicit null), a token is returned as is, anything else is a 400.
 */
export function readRecurrence(raw: unknown): Recurrence | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === "never" || raw === "") return null;
  if (typeof raw === "string" && (RECURRENCES as readonly string[]).includes(raw)) return raw as Recurrence;
  throw new HttpError(400, "Repeats must be never, weekly, biweekly or monthly");
}

/** Socials never repeat. Anything other than off is a 400. */
export function rejectSocialRecurrence(raw: unknown): void {
  if (readRecurrence(raw)) throw new HttpError(400, "Only plans can repeat");
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Same day of the month `months` later, clamped to that month's last day. `anchorDay` defaults to the day of `iso`. */
export function addMonths(iso: string, months: number, anchorDay?: number): string {
  const [year, month, day] = iso.split("-").map(Number);
  const index = year * 12 + (month - 1) + months;
  const nextYear = Math.floor(index / 12);
  const nextMonth = (index % 12) + 1;
  const dom = Math.min(anchorDay ?? day, daysInMonth(nextYear, nextMonth));
  return `${String(nextYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}-${String(dom).padStart(2, "0")}`;
}

/** The day after `iso` for a rule. A monthly series passes its anchor day so a clamp does not drift. */
export function nextOccurrenceDate(iso: string, rule: Recurrence, anchorDay?: number): string {
  if (rule === "weekly") return addDays(iso, 7);
  if (rule === "biweekly") return addDays(iso, 14);
  return addMonths(iso, 1, anchorDay);
}

/** The day of the month a monthly series sticks to. */
export function anchorDayOf(iso: string): number {
  return Number(iso.slice(8, 10));
}

/**
 * End instant for the next occurrence: the old length (end minus the old start) added to the new day's
 * local start. Local start times are used, never a fixed ms day, so a DST change keeps 15:00-17:00 local.
 */
export function nextEndsAt(
  endsAt: number | null,
  oldDate: string,
  newDate: string,
  atTime: string | null,
  tz: string,
): number | null {
  if (endsAt == null) return null;
  const clock = atTime ?? "00:00";
  const length = endsAt - zonedDateTime(oldDate, clock, tz);
  return zonedDateTime(newDate, clock, tz) + length;
}

/** True for one of the three repeat tokens. */
export function isRecurrence(value: unknown): value is Recurrence {
  return typeof value === "string" && (RECURRENCES as readonly string[]).includes(value);
}
