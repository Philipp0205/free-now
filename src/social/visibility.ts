import type { DatabaseSync } from "node:sqlite";
import type { EventKind } from "../db.js";
import { HttpError } from "../lib/http.js";
import { UUID_RE } from "../lib/validate.js";

/**
 * Private events. A social or plan with rows in event_invitees is for those people and its host only.
 * No rows means everyone in the circle, as before. This file holds no circle or push logic, only who may see what.
 */
export type { EventKind };

export type InviteeRow = { id: string; name: string; color: number | null; avatar_rev: number | null };

const INVITEE_MAX = 50;

const TABLE: Record<EventKind, string> = { social: "socials", plan: "plans" };
const JOINS: Record<EventKind, { table: string; column: string }> = {
  social: { table: "social_joins", column: "social_id" },
  plan: { table: "plan_joins", column: "plan_id" },
};

/** The people a private event is for (host included), or null when it is open to the whole circle. */
export function inviteeIds(db: DatabaseSync, kind: EventKind, id: string): Set<string> | null {
  const rows = db.prepare("SELECT user_id FROM event_invitees WHERE kind = ? AND event_id = ?").all(kind, id) as Array<{ user_id: string }>;
  return rows.length ? new Set(rows.map((row) => row.user_id)) : null;
}

export function isPrivateEvent(db: DatabaseSync, kind: EventKind, id: string): boolean {
  return inviteeIds(db, kind, id) !== null;
}

/** Whether this viewer may know the event exists. Public events: any viewer. Private: the host and invitees. */
export function canSeeEvent(db: DatabaseSync, kind: EventKind, event: { id: string; creator_id: string }, viewerId: string | null): boolean {
  const invited = inviteeIds(db, kind, event.id);
  if (!invited) return true;
  return viewerId !== null && (viewerId === event.creator_id || invited.has(viewerId));
}

/** Same as canSeeEvent for a caller that only has the event id. A missing event counts as visible: callers 404 it themselves. */
export function canSeeEventId(db: DatabaseSync, kind: EventKind, id: string, viewerId: string | null): boolean {
  const invited = inviteeIds(db, kind, id);
  if (!invited) return true;
  if (viewerId === null) return false;
  if (invited.has(viewerId)) return true;
  const host = db.prepare(`SELECT creator_id FROM ${TABLE[kind]} WHERE id = ?`).get(id) as { creator_id: string } | undefined;
  return host?.creator_id === viewerId;
}

/** The rows this viewer may see, in the same order. */
export function visibleEvents<T extends { id: string; creator_id: string }>(db: DatabaseSync, kind: EventKind, rows: T[], viewerId: string | null): T[] {
  return rows.filter((row) => canSeeEvent(db, kind, row, viewerId));
}

/** Members who may see the event. Public events keep everyone. */
export function visibleMembers<T extends { id: string }>(db: DatabaseSync, kind: EventKind, event: { id: string; creator_id: string }, members: T[]): T[] {
  const invited = inviteeIds(db, kind, event.id);
  if (!invited) return members;
  return members.filter((member) => member.id === event.creator_id || invited.has(member.id));
}

/** The people on a private event, host first, or an empty list for a public one. */
export function listInvitees(db: DatabaseSync, kind: EventKind, id: string, hostId: string): InviteeRow[] {
  const rows = db.prepare(
    `SELECT u.id, u.name, u.color, u.avatar_rev FROM event_invitees i JOIN users u ON u.id = i.user_id
     WHERE i.kind = ? AND i.event_id = ? ORDER BY u.id = ? DESC, u.name COLLATE NOCASE ASC`,
  ).all(kind, id, hostId) as InviteeRow[];
  return rows.map((row) => ({ ...row }));
}

/**
 * Replaces the invitee list. An empty list makes the event public again. A non-empty one also drops
 * the replies and alerts of people who are no longer on it (a removed guest stays removed).
 */
export function setInvitees(db: DatabaseSync, kind: EventKind, id: string, userIds: string[]): void {
  db.prepare("DELETE FROM event_invitees WHERE kind = ? AND event_id = ?").run(kind, id);
  if (!userIds.length) return;
  const insert = db.prepare("INSERT INTO event_invitees (kind, event_id, user_id) VALUES (?, ?, ?)");
  for (const userId of userIds) insert.run(kind, id, userId);
  const joins = JOINS[kind];
  const marks = userIds.map(() => "?").join(", ");
  db.prepare(`DELETE FROM ${joins.table} WHERE ${joins.column} = ? AND blocked = 0 AND user_id NOT IN (${marks})`).run(id, ...userIds);
  // Drop leftover alerts so someone taken off the list does not keep seeing the event in Alerts.
  db.prepare(`DELETE FROM notifications WHERE ref_id = ? AND user_id NOT IN (${marks})`).run(id, ...userIds);
}

function isMemberOfAny(db: DatabaseSync, userId: string, circleIds: string[]): boolean {
  if (!circleIds.length) return false;
  const marks = circleIds.map(() => "?").join(", ");
  return Boolean(db.prepare(`SELECT 1 AS ok FROM memberships WHERE user_id = ? AND circle_id IN (${marks})`).get(userId, ...circleIds));
}

/**
 * Reads an `invitees` value from a request. Undefined means the caller did not mention it. Null or an empty list means
 * everyone. Otherwise every id must belong to someone in one of `circleIds`, and the host is always added.
 */
export function readInvitees(db: DatabaseSync, raw: unknown, hostId: string, circleIds: string[]): string[] | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return [];
  if (!Array.isArray(raw) || raw.length > INVITEE_MAX || raw.some((id) => typeof id !== "string")) {
    throw new HttpError(400, "invitees must be a list of people");
  }
  if (raw.length === 0) return [];
  const ids = [...new Set((raw as string[]).map((id) => id.toLowerCase()))].filter((id) => id !== hostId);
  // Only the host picked: nobody to hide it from, so it stays open to the circle.
  if (ids.length === 0) return [];
  for (const id of ids) {
    if (!UUID_RE.test(id) || !isMemberOfAny(db, id, circleIds)) throw new HttpError(400, "You can only invite people in this circle.");
  }
  return [hostId, ...ids];
}
