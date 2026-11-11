import type { DatabaseSync } from "node:sqlite";
import {
  clearBusyHours,
  clearUserStatus,
  getBusyHours,
  getUserStatus,
  getUserTimezone,
  hasLiveSocial,
  liveSocialUsers,
  listVisibleBusyHours,
  setBusyHours,
  setUserStatus,
  setUserTimezone,
  type BusyBlock,
  type BusySchedule,
  type StatusRow,
} from "./db.js";
import { endOfDay, isCalendarDate, isoDate, isTimeZone, zonedDateTime, zonedParts } from "./time.js";

/** Until instants use the user's stored timezone when present, else Europe/Berlin. */
export const STATUS_TZ = "Europe/Berlin";
export const STATUS_TYPES = ["away", "busy"] as const;
export const STATUS_TEXT_MAX = 60;
export const STATUS_PLACE_MAX = 40;

export type StatusType = (typeof STATUS_TYPES)[number];

/**
 * What a person object carries. `until` is an epoch ms: the last ms of the end day, or a chosen instant.
 * `source` is "schedule" for weekly busy hours; a manual status leaves it out.
 */
export type PersonStatus = {
  type: StatusType;
  text: string | null;
  place: string | null;
  until: number | null;
  source?: "manual" | "schedule";
};

const DAY_MS = 86_400_000;
const MAX_UNTIL_MS = 366 * DAY_MS;
export const BUSY_BLOCKS_MAX = 3;

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

/** Busy from the weekly hours when `now` is inside a block in the schedule's zone, else null. */
export function scheduleStatus(schedule: BusySchedule | undefined | null, now: number): PersonStatus | null {
  if (!schedule || !isTimeZone(schedule.timezone)) return null;
  const day = isoDate(now, schedule.timezone);
  const [year, month, date] = day.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, date)).getUTCDay() || 7;
  const parts = zonedParts(now, schedule.timezone);
  const minutes = parts.hour * 60 + parts.minute;
  let end: string | null = null;
  for (const block of schedule.blocks) {
    if (!block.days.includes(weekday)) continue;
    if (clockMinutes(block.start) > minutes || minutes >= clockMinutes(block.end)) continue;
    if (end == null || block.end > end) end = block.end;
  }
  if (end == null) return null;
  return { type: "busy", text: null, place: null, until: zonedDateTime(day, end, schedule.timezone), source: "schedule" };
}

function clockMinutes(hhmm: string): number {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}

/**
 * Own status for /api/me: a manual one first, else weekly busy hours unless an "I'm free" is live.
 * An expired manual one is cleared from the row on the way.
 */
export function ownStatus(db: DatabaseSync, userId: string, now: number): PersonStatus | null {
  const row = getUserStatus(db, userId);
  const status = activeStatus(row, now);
  if (status) return status;
  if (row && (row.status_type != null || row.status_text != null || row.status_place != null || row.status_until != null)) {
    clearUserStatus(db, userId);
  }
  const fromHours = scheduleStatus(getBusyHours(db, userId), now);
  if (!fromHours || hasLiveSocial(db, userId, now)) return null;
  return fromHours;
}

/**
 * Statuses the viewer may see: their own, and anyone sharing at least one circle with them.
 * Effective ones: manual wins, then weekly busy hours unless the person has a live "I'm free".
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
  const fromHours = new Map<string, PersonStatus>();
  for (const [id, schedule] of listVisibleBusyHours(db, viewerId)) {
    const status = map.has(id) ? null : scheduleStatus(schedule, now);
    if (status) fromHours.set(id, status);
  }
  if (fromHours.size) {
    const free = liveSocialUsers(db, [...fromHours.keys()], now);
    for (const [id, status] of fromHours) if (!free.has(id)) map.set(id, status);
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

/** Validates a PUT /api/me/status body into the stored columns. `tz` counts the end day. */
export function readStatusBody(body: Record<string, unknown>, now: number, tz: string = STATUS_TZ): StatusRow {
  if (!isType(body.type)) throw new StatusError("Pick Away or Busy");
  const text = cleanText(body.text, "Note", STATUS_TEXT_MAX);
  const place = cleanText(body.place, "Place", STATUS_PLACE_MAX);
  let until: number | null = null;
  const instant = body.until;
  const day = body.untilDay;
  if (instant != null && instant !== "") {
    // A chosen instant wins over an end day.
    if (typeof instant !== "number" || !Number.isFinite(instant)) throw new StatusError("Pick a valid end time");
    if (instant <= now) throw new StatusError("The end time has passed");
    if (instant > now + MAX_UNTIL_MS) throw new StatusError("The end time is too far ahead");
    until = Math.floor(instant);
  } else if (day != null && day !== "") {
    if (typeof day !== "string" || !isCalendarDate(day)) throw new StatusError("Pick a valid end day");
    if (day < isoDate(now, tz)) throw new StatusError("The end day has passed");
    until = endOfDay(day, tz);
  }
  return { status_type: body.type, status_text: text, status_place: place, status_until: until };
}

/** A zone from the body, null when omitted. */
function readTimezone(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !isTimeZone(value)) throw new StatusError("Pick a valid time zone");
  return value;
}

export function saveStatus(db: DatabaseSync, userId: string, body: Record<string, unknown>, now: number): void {
  const sent = readTimezone(body.timezone);
  const stored = getUserTimezone(db, userId);
  const tz = sent ?? (stored && isTimeZone(stored) ? stored : STATUS_TZ);
  const row = readStatusBody(body, now, tz);
  if (sent) setUserTimezone(db, userId, sent);
  setUserStatus(db, userId, row);
}

function readTime(value: unknown): string {
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new StatusError("Times must look like 09:00");
  return value;
}

function readBlock(value: unknown): BusyBlock {
  if (!value || typeof value !== "object") throw new StatusError("Each block needs days, start and end");
  const block = value as Record<string, unknown>;
  const days = block.days;
  if (!Array.isArray(days) || !days.length) throw new StatusError("Pick at least one day");
  if (!days.every((day) => Number.isInteger(day) && day >= 1 && day <= 7)) throw new StatusError("Days are 1 (Mon) to 7 (Sun)");
  const start = readTime(block.start);
  const end = readTime(block.end);
  if (start >= end) throw new StatusError("A block must end after it starts");
  return { days: [...new Set(days as number[])].sort((a, b) => a - b), start, end };
}

/** Validates a PUT /api/me/busy-hours body. No blocks means no schedule (null). */
export function readBusyHours(body: Record<string, unknown>): { timezone: string; blocks: BusyBlock[] } | null {
  if (!Array.isArray(body.blocks)) throw new StatusError("blocks must be a list");
  if (!body.blocks.length) return null;
  if (body.blocks.length > BUSY_BLOCKS_MAX) throw new StatusError(`Use at most ${BUSY_BLOCKS_MAX} blocks`);
  const timezone = readTimezone(body.timezone);
  if (!timezone) throw new StatusError("Pick a valid time zone");
  return { timezone, blocks: body.blocks.map(readBlock) };
}

/** Saves or, for an empty list, removes the weekly hours. Returns what is stored. */
export function saveBusyHours(db: DatabaseSync, userId: string, body: Record<string, unknown>, now: number): BusySchedule | null {
  const hours = readBusyHours(body);
  if (!hours) {
    clearBusyHours(db, userId);
    return null;
  }
  return setBusyHours(db, userId, hours.timezone, hours.blocks, now);
}
