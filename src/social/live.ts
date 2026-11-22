import type { DatabaseSync } from "node:sqlite";
import type { AppDeps } from "../app.js";
import { colorHex } from "../chat/chat-color.js";
import {
  type EventKind,
  type PlanRow,
  type SocialRow,
  type UserRow,
  LIVE_TTL_MS,
  dropLive,
  getCircleById,
  getPlanReply,
  getSocialReply,
  listCirclesForUser,
  listPlanJoins,
  listSocialJoins,
  planCircleForUser,
} from "../db.js";
import { HttpError, sendEmpty, sendJson } from "../lib/http.js";
import type { AuthedRouteContext } from "../lib/context.js";
import { isoDate } from "../lib/time.js";
import { parseId, readPoint } from "../lib/validate.js";
import { haversineMeters } from "../map/geocode.js";
import { arrivedBody, notifyUsers } from "../push/notify.js";
import { loadEvent } from "./event-photo-access.js";
import { isOpenPlan } from "./plan-share.js";
import { canSeeEvent } from "./visibility.js";

type EventRow = SocialRow | PlanRow;

/** Within this many metres of the pin counts as arrived. Pins are stored to about 100 m, so it stays generous. */
export const ARRIVE_RADIUS_M = 150;
/** A reading less exact than this never counts as arrived, so a wide Wi-Fi guess near the pin does not fire it. */
export const ARRIVE_MAX_ACCURACY_M = 100;

const ACCURACY_CAP_M = 10_000;
const IN_REPLIES = new Set(["coming", "join", "in"]);

export type LivePoint = {
  id: string;
  name: string;
  color: string;
  avatarRev: number | null;
  lat: number;
  lng: number;
  updatedAt: number;
};

type LiveRow = { user_id: string; name: string; color: number | null; avatar_rev: number | null; lat: number; lng: number; updated_at: number };

/** Whether the event can still have people sharing: a social before it expires, a plan that is open. */
export function isOpenEvent(kind: EventKind, event: EventRow, now: number, tz: string): boolean {
  if (kind === "social") return (event as SocialRow).expires_at > now;
  return isOpenPlan(event as PlanRow, isoDate(now, tz), now);
}

/** The host, or someone whose reply is in and who was not removed. */
export function isInEvent(db: DatabaseSync, kind: EventKind, event: { id: string; creator_id: string }, userId: string): boolean {
  if (event.creator_id === userId) return true;
  const reply = kind === "social" ? getSocialReply(db, event.id, userId) : getPlanReply(db, event.id, userId);
  return Boolean(reply && !reply.blocked && IN_REPLIES.has(reply.reply));
}

/** Fresh points of people still in, newest first. Expired points are never returned. */
export function listLive(db: DatabaseSync, kind: EventKind, event: { id: string; creator_id: string }, now: number): LivePoint[] {
  const rows = db.prepare(
    `SELECT l.user_id, l.lat, l.lng, l.updated_at, u.name, u.color, u.avatar_rev
     FROM event_live l JOIN users u ON u.id = l.user_id
     WHERE l.kind = ? AND l.event_id = ? AND l.lat IS NOT NULL AND l.updated_at > ?
     ORDER BY l.updated_at DESC`,
  ).all(kind, event.id, now - LIVE_TTL_MS) as LiveRow[];
  return rows
    .filter((row) => isInEvent(db, kind, event, row.user_id))
    .map((row) => ({
      id: row.user_id,
      name: row.name,
      color: colorHex(row.user_id, row.color),
      avatarRev: row.avatar_rev || null,
      lat: row.lat,
      lng: row.lng,
      updatedAt: row.updated_at,
    }));
}

/** `live` for a payload, only for the host and people who are in, and only while the event is open. Otherwise no field. */
export function liveField(
  db: DatabaseSync,
  kind: EventKind,
  event: { id: string; creator_id: string },
  viewerId: string | null,
  now: number,
  open: boolean,
): { live?: LivePoint[] } {
  if (!open || viewerId === null || !canSeeEvent(db, kind, event, viewerId) || !isInEvent(db, kind, event, viewerId)) return {};
  return { live: listLive(db, kind, event, now) };
}

function isMember(db: DatabaseSync, kind: EventKind, event: EventRow, userId: string): boolean {
  if (kind === "plan") return Boolean(planCircleForUser(db, event.id, userId));
  return listCirclesForUser(db, userId).some((circle) => circle.id === (event as SocialRow).circle_id);
}

/** The event for a circle member who may see it. Missing, hidden and not-yours all read the same, so an id is never confirmed. */
function visibleEvent(deps: AppDeps, me: UserRow, kind: EventKind, rawId: string): EventRow {
  const event = loadEvent(deps.db, kind, parseId(rawId));
  if (!event || !isMember(deps.db, kind, event, me.id) || !canSeeEvent(deps.db, kind, event, me.id)) {
    throw new HttpError(404, `${kind} not found`);
  }
  return event;
}

/** Who is sharing right now, for a person who is in. An empty list for anyone else. */
export function getLive(deps: AppDeps, me: UserRow, kind: EventKind, rawId: string): LivePoint[] {
  const event = visibleEvent(deps, me, kind, rawId);
  const now = deps.now();
  return liveField(deps.db, kind, event, me.id, now, isOpenEvent(kind, event, now, deps.config.tz)).live ?? [];
}

/** Toggle off: forget this person's point and their arrival mark. Safe on an ended event. */
export function stopLive(deps: AppDeps, me: UserRow, kind: EventKind, rawId: string): void {
  const event = visibleEvent(deps, me, kind, rawId);
  dropLive(deps.db, kind, event.id, me.id);
}

/** A reading from the body: both coordinates, in range, and an optional accuracy in metres. */
function readReading(body: Record<string, unknown>): { lat: number; lng: number; accuracy: number | null } {
  const point = readPoint({ lat: body.lat, lng: body.lng, precise: true });
  if (!point) throw new HttpError(400, "lat and lng are required");
  const raw = body.accuracy;
  if (raw == null) return { ...point, accuracy: null };
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) throw new HttpError(400, "accuracy must be a number of metres");
  return { ...point, accuracy: Math.min(raw, ACCURACY_CAP_M) };
}

/** Near the pin, with a reading exact enough to trust. */
export function hasArrived(pin: { lat: number; lng: number }, reading: { lat: number; lng: number; accuracy: number | null }): boolean {
  if (reading.accuracy != null && reading.accuracy > ARRIVE_MAX_ACCURACY_M) return false;
  return haversineMeters(pin, reading) <= ARRIVE_RADIUS_M;
}

function storePoint(db: DatabaseSync, kind: EventKind, id: string, userId: string, reading: { lat: number; lng: number; accuracy: number | null }, now: number): void {
  db.prepare(
    `INSERT INTO event_live (kind, event_id, user_id, lat, lng, accuracy, updated_at, arrived_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT (kind, event_id, user_id) DO UPDATE SET lat = excluded.lat, lng = excluded.lng, accuracy = excluded.accuracy,
       updated_at = excluded.updated_at, arrived_at = NULL`,
  ).run(kind, id, userId, reading.lat, reading.lng, reading.accuracy, now);
}

/** Drops the point and leaves a short mark, so a late post from the same share does not push a second time. */
function storeArrival(db: DatabaseSync, kind: EventKind, id: string, userId: string, now: number): void {
  db.prepare(
    `INSERT INTO event_live (kind, event_id, user_id, lat, lng, accuracy, updated_at, arrived_at) VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?)
     ON CONFLICT (kind, event_id, user_id) DO UPDATE SET lat = NULL, lng = NULL, accuracy = NULL, updated_at = excluded.updated_at, arrived_at = excluded.arrived_at`,
  ).run(kind, id, userId, now, now);
}

function recentArrival(db: DatabaseSync, kind: EventKind, id: string, userId: string, now: number): boolean {
  const row = db.prepare("SELECT arrived_at FROM event_live WHERE kind = ? AND event_id = ? AND user_id = ?").get(kind, id, userId) as
    | { arrived_at: number | null }
    | undefined;
  return row?.arrived_at != null && now - row.arrived_at < LIVE_TTL_MS;
}

/** The host and everyone in, minus the person who arrived, who may still see the event. */
function arrivalAudience(db: DatabaseSync, kind: EventKind, event: EventRow, arriverId: string): string[] {
  const joins = kind === "social" ? listSocialJoins(db, event.id) : listPlanJoins(db, event.id);
  const ids = new Set([event.creator_id, ...joins.filter((join) => IN_REPLIES.has(join.reply)).map((join) => join.id)]);
  ids.delete(arriverId);
  return [...ids].filter((id) => canSeeEvent(db, kind, event, id));
}

/** One push per arrival. The text names the person and the place, never coordinates. */
async function pushArrival(deps: AppDeps, me: UserRow, kind: EventKind, event: EventRow, now: number): Promise<void> {
  const url = kind === "social" ? `/?social=${event.id}` : `/?plan=${event.id}`;
  const body = arrivedBody(me.name, event.place ?? "");
  const notices = arrivalAudience(deps.db, kind, event, me.id).map((userId) => ({
    userId,
    title: "Arrived",
    body,
    kind: "arrived",
    refId: event.id,
    tag: `arrived:${kind}:${event.id}:${me.id}`,
    url,
  }));
  await notifyUsers(deps.db, deps.push, now, notices, getCircleById(deps.db, event.circle_id));
}

/** The checks a post needs: the event is open, has a pin, and the caller is in. Returns the pin. */
function postTarget(deps: AppDeps, me: UserRow, kind: EventKind, rawId: string, now: number): { event: EventRow; pin: { lat: number; lng: number } } {
  const event = visibleEvent(deps, me, kind, rawId);
  if (!isOpenEvent(kind, event, now, deps.config.tz)) throw new HttpError(404, `${kind} not found`);
  if (event.lat == null || event.lng == null) throw new HttpError(400, "This has no pin on the map.");
  if (!isInEvent(deps.db, kind, event, me.id)) throw new HttpError(403, "Say you are in to share your location.");
  return { event, pin: { lat: event.lat, lng: event.lng } };
}

/** GET, POST and DELETE on /api/{socials,plans}/:id/live. Returns false when the method is not one of those. */
export async function handleLive(ctx: AuthedRouteContext, kind: EventKind, rawId: string): Promise<boolean> {
  const { res, deps, method, body, me } = ctx;
  if (method === "GET") {
    sendJson(res, 200, { live: getLive(deps, me, kind, rawId) });
    return true;
  }
  if (method === "DELETE") {
    stopLive(deps, me, kind, rawId);
    sendEmpty(res, 204);
    return true;
  }
  if (method !== "POST") return false;
  if (!ctx.limits.live.hit(me.id, deps.now())) throw new HttpError(429, "Too many location updates. Slow down.");
  sendJson(res, 200, await postLive(deps, me, kind, rawId, body));
  return true;
}

/**
 * Keeps the caller's last point (one row, replaced each time). Near the pin it stops the share instead,
 * keeps no point and tells the others once. Returns whether the caller arrived.
 */
export async function postLive(deps: AppDeps, me: UserRow, kind: EventKind, rawId: string, body: Record<string, unknown>): Promise<{ arrived: boolean; updatedAt: number }> {
  const now = deps.now();
  const { event, pin } = postTarget(deps, me, kind, rawId, now);
  const reading = readReading(body);
  if (recentArrival(deps.db, kind, event.id, me.id, now)) return { arrived: true, updatedAt: now };
  if (hasArrived(pin, reading)) {
    storeArrival(deps.db, kind, event.id, me.id, now);
    await pushArrival(deps, me, kind, event, now);
    return { arrived: true, updatedAt: now };
  }
  storePoint(deps.db, kind, event.id, me.id, reading, now);
  return { arrived: false, updatedAt: now };
}
