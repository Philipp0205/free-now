import type { DatabaseSync } from "node:sqlite";
import { clearUserStatus, getUserStatus, setUserStatus, type StatusRow } from "./db.js";
import { endOfDay, isCalendarDate, isoDate } from "./time.js";

/** The "until" day is a Berlin calendar day, whatever APP_TZ says. No per-user zone yet. */
export const STATUS_TZ = "Europe/Berlin";
export const STATUS_TYPES = ["away", "busy"] as const;
export const STATUS_TEXT_MAX = 60;
export const STATUS_PLACE_MAX = 40;

export type StatusType = (typeof STATUS_TYPES)[number];

/** What a person object carries. `until` is the last ms of the end day, like other instants in the API. */
export type PersonStatus = { type: StatusType; text: string | null; place: string | null; until: number | null };

export class StatusError extends Error {}

function isType(value: unknown): value is StatusType {
  return typeof value === "string" && (STATUS_TYPES as readonly string[]).includes(value);
}

/** Active means a known type and an end that has not passed. Anything else reads as no status. */
export function activeStatus(row: StatusRow | undefined, now: number): PersonStatus | null {
  if (!row || !isType(row.status_type)) return null;
  if (row.status_until != null && now > row.status_until) return null;
  return {
    type: row.status_type,
    text: row.status_text || null,
    place: row.status_place || null,
    until: row.status_until ?? null,
  };
}

/** Own status for /api/me. An expired one is cleared from the row on the way. */
export function ownStatus(db: DatabaseSync, userId: string, now: number): PersonStatus | null {
  const row = getUserStatus(db, userId);
  const status = activeStatus(row, now);
  if (!status && row && (row.status_type != null || row.status_text != null || row.status_place != null || row.status_until != null)) {
    clearUserStatus(db, userId);
  }
  return status;
}

/**
 * Statuses the viewer may see: their own, and anyone sharing at least one circle with them.
 * No viewer, no statuses.
 */
export function visibleStatuses(db: DatabaseSync, viewerId: string | null, now: number): Map<string, PersonStatus> {
  const map = new Map<string, PersonStatus>();
  if (!viewerId) return map;
  const rows = db.prepare(
    `SELECT u.id, u.status_type, u.status_text, u.status_place, u.status_until FROM users u
     WHERE u.status_type IS NOT NULL
       AND (u.status_until IS NULL OR u.status_until >= ?)
       AND (u.id = ? OR EXISTS (
         SELECT 1 FROM memberships mine JOIN memberships theirs ON theirs.circle_id = mine.circle_id
         WHERE mine.user_id = ? AND theirs.user_id = u.id
       ))`,
  ).all(now, viewerId, viewerId) as Array<StatusRow & { id: string }>;
  for (const row of rows) {
    const status = activeStatus(row, now);
    if (status) map.set(row.id, status);
  }
  return map;
}

function cleanText(value: unknown, label: string, max: number): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new StatusError(`${label} must be text`);
  const text = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!text) return null;
  // Code points, so an emoji counts once.
  if ([...text].length > max) throw new StatusError(`${label} must be at most ${max} characters`);
  return text;
}

/** Validates a PUT /api/me/status body into the stored columns. */
export function readStatusBody(body: Record<string, unknown>, now: number): StatusRow {
  if (!isType(body.type)) throw new StatusError("Pick Away or Busy");
  const text = cleanText(body.text, "Note", STATUS_TEXT_MAX);
  const place = cleanText(body.place, "Place", STATUS_PLACE_MAX);
  let until: number | null = null;
  const day = body.untilDay;
  if (day != null && day !== "") {
    if (typeof day !== "string" || !isCalendarDate(day)) throw new StatusError("Pick a valid end day");
    if (day < isoDate(now, STATUS_TZ)) throw new StatusError("The end day has passed");
    until = endOfDay(day, STATUS_TZ);
  }
  return { status_type: body.type, status_text: text, status_place: place, status_until: until };
}

export function saveStatus(db: DatabaseSync, userId: string, body: Record<string, unknown>, now: number): void {
  setUserStatus(db, userId, readStatusBody(body, now));
}
