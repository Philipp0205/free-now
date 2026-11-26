import { clockText, zonedParts } from "../when.js";
import { END_COPY } from "./event-end-copy.js";

/** A fresh end draft: no end clock, nothing touched yet. */
export function emptyEnd() {
  return { until: "", touched: false, error: "" };
}

/** The draft for an existing event: its end as a clock in `tz`, untouched. */
export function endFromItem(item, tz = "Europe/Berlin") {
  const draft = emptyEnd();
  if (!item?.endsAt) return draft;
  const part = zonedParts(item.endsAt, tz);
  return { ...draft, until: clockText(part.hour, part.minute) };
}

/**
 * What to send for the end. An untouched draft sends nothing, so the server keeps the end as it is.
 * An empty clock sends null to clear the end; a filled one sends the clock.
 */
export function endPayload(draft) {
  if (!draft?.touched) return {};
  return { endsAt: draft.until || null };
}

/**
 * The problem with the draft, or "". `start` is the start clock ("HH:MM") when there is one.
 * A plan needs a start for any end (`needsStart`); a social starts now when it has none.
 */
export function endError(draft, start = "", needsStart = false) {
  if (!draft?.until) return "";
  if (needsStart && !start) return END_COPY.needsStart;
  if (!/^\d{2}:\d{2}$/.test(draft.until)) return END_COPY.pickEnd;
  return start && draft.until <= start ? END_COPY.afterStart : "";
}

function clockOf(ms, tz) {
  const part = zonedParts(ms, tz);
  return clockText(part.hour, part.minute);
}

/** The start clock of a social: its start, "Now" while live without one, else when it was posted. */
function socialStart(item, now, tz) {
  if (item.startsAt) return clockOf(item.startsAt, tz);
  const ended = Number(item.endsAt) <= now || Number(item.expiresAt) <= now;
  return ended ? clockOf(item.createdAt, tz) : END_COPY.now;
}

/** "19:00 - 22:00" for an event with an end, "" without one. Clocks follow `tz`. */
export function eventRange(kind, item, now = Date.now(), tz = "Europe/Berlin") {
  if (!item?.endsAt) return "";
  const start = kind === "plan" ? item.time : socialStart(item, now, tz);
  if (!start) return "";
  return `${start} - ${clockOf(item.endsAt, tz)}`;
}
