import { HttpError } from "./http.js";
import { isoDate, zonedDateTime } from "./time.js";

/** What the client asked for. Undefined (not returned here) means the body did not mention an end. */
export type EndSpec = null | { clock: string } | { instant: number } | { minutes: number };

const MAX_SPAN_MS = 24 * 60 * 60 * 1000;
const has = (body: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(body, key);

/** Reads endsAt (HH:MM, epoch ms, or null to clear) or durationMin (1..1440). Undefined when neither is in the body. */
export function readEnd(body: Record<string, unknown>): EndSpec | undefined {
  const hasEnd = has(body, "endsAt");
  const hasDuration = has(body, "durationMin");
  if (hasEnd && hasDuration && body.endsAt != null && body.durationMin != null) {
    throw new HttpError(400, "Send either an end time or a duration, not both.");
  }
  if (!hasEnd && !hasDuration) return undefined;
  if (body.durationMin != null) return { minutes: readMinutes(body.durationMin) };
  if (body.endsAt == null || body.endsAt === "") return null;
  if (typeof body.endsAt === "string") {
    if (!/^\d{2}:\d{2}$/.test(body.endsAt) || Number(body.endsAt.slice(0, 2)) > 23 || Number(body.endsAt.slice(3, 5)) > 59) {
      throw new HttpError(400, "Pick a valid end time, like 22:00.");
    }
    return { clock: body.endsAt };
  }
  const instant = Number(body.endsAt);
  if (!Number.isFinite(instant)) throw new HttpError(400, "Pick a valid end time, like 22:00.");
  return { instant };
}

function readMinutes(value: unknown): number {
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60) {
    throw new HttpError(400, "Pick a length between 1 minute and 24 hours.");
  }
  return minutes;
}

/** The end instant for a spec, measured from `start`. Checks it is after the start, still ahead, and within 24 hours. */
export function resolveEnd(spec: Exclude<EndSpec, null>, start: number, now: number, tz: string): number {
  let end: number;
  if ("minutes" in spec) end = start + spec.minutes * 60_000;
  else if ("instant" in spec) end = spec.instant;
  else end = zonedDateTime(isoDate(start, tz), spec.clock, tz);
  end = Math.round(end / 60_000) * 60_000;
  if (end <= start) throw new HttpError(400, "The end must be after the start.");
  if (end <= now) throw new HttpError(400, "Pick an end time that is still ahead.");
  if (end - start > MAX_SPAN_MS) throw new HttpError(400, "An event can run for at most 24 hours.");
  return end;
}

/** A plan end must fall on the plan's own day, and the plan needs a start time to measure from. */
export function resolvePlanEnd(spec: Exclude<EndSpec, null>, forDate: string, atTime: string | null, now: number, tz: string): number {
  if (!atTime) throw new HttpError(400, "Set a start time to add an end.");
  const end = resolveEnd(spec, zonedDateTime(forDate, atTime, tz), now, tz);
  if (isoDate(end, tz) !== forDate) throw new HttpError(400, "A plan has to end the same day it starts.");
  return end;
}

/**
 * Where a plan's end lands after the day or time moved: the same length after the new start.
 * Null when the plan lost its time, or the moved end would cross midnight.
 */
export function shiftPlanEnd(
  endsAt: number,
  from: { forDate: string; atTime: string },
  to: { forDate: string; atTime: string | null },
  tz: string,
): number | null {
  if (!to.atTime) return null;
  const length = endsAt - zonedDateTime(from.forDate, from.atTime, tz);
  const end = zonedDateTime(to.forDate, to.atTime, tz) + length;
  return isoDate(end, tz) === to.forDate ? end : null;
}
