import crypto from "node:crypto";
import {
  clearUserStatus,
  getActiveSocialByCreator,
  getSocial,
  getSocialReply,
  getUserStatus,
  insertSocial,
  listMembers,
  setSocialReply,
  setSocialEnd,
  updateSocial,
  type UserRow,
} from "../db.js";
import { eventTitle, freePushBody, notifyUsers, replyPushBody, type Notice } from "../push/notify.js";
import { cancelReplyPush, scheduleReplyPush } from "../chat/reply-push.js";
import { addDays, clockLabel, isoDate, zonedDateTime } from "../lib/time.js";
import { resolveEnd, type EndSpec } from "../lib/end-time.js";
import { activeStatus } from "./status.js";
import { canSeeEvent, readInvitees, setInvitees, visibleMembers } from "./visibility.js";
import { recordEventLine, replyLogText } from "../chat/chat.js";
import { HttpError, parseId, requireCircle, socialPayload, type AppDeps } from "../app.js";

/** Shortest wait before a changed note or place, or a Flic press, notifies again. */
const FLOOR_MS = 15_000;

/** The host's end for this buzz. Undefined keeps a saved end that is still after the start; null clears it. */
function socialEnd(end: EndSpec | undefined, kept: number | null, anchor: number, now: number, tz: string): number | null {
  if (end === null) return null;
  if (end) return resolveEnd(end, anchor, now, tz);
  return kept != null && kept > anchor ? kept : null;
}

export async function publishSocial(
  deps: AppDeps,
  user: UserRow,
  note: string | undefined,
  point?: { lat: number; lng: number } | null,
  place?: string,
  start?: number | null,
  requested: string | null = null,
  end: EndSpec | undefined = undefined,
  invitees: unknown = undefined,
  flic = false,
): Promise<{ created: boolean; social: ReturnType<typeof socialPayload> }> {
  const circle = requireCircle(deps, user.id, requested);
  // Read first, so a bad list is a 400 before anything is saved. Undefined keeps a live social's list.
  const picked = readInvitees(deps.db, invitees, user.id, [circle.id]);
  const now = deps.now();
  const existing = getActiveSocialByCreator(deps.db, user.id, circle.id, now);
  let created = false;
  let socialId: string;
  let shouldNotify = true;
  let shifted = false;
  // A missing note on a live social keeps the current text. The original
  // createdAt stays put; expiry moves to now + TTL so the window is a full
  // TTL from this buzz and the two timestamps still describe one social.
  // A missing place and missing coordinates keep the saved meetup.
  // A missing start keeps a scheduled time. A later-today social lasts TTL from that time.
  const nextNote = note === undefined ? (existing?.note ?? "") : note;
  const keepWhere = place === undefined && point === undefined;
  const nextPlace = place === undefined ? (existing?.place ?? "") : place;
  const nextPoint = point === undefined
    ? (existing?.lat == null || existing?.lng == null ? null : { lat: existing.lat, lng: existing.lng })
    : point;
  const nextStart = start === undefined ? (existing?.starts_at ?? null) : start;
  const anchor = nextStart != null && nextStart > now ? nextStart : now;
  const endsAt = socialEnd(end, existing?.ends_at ?? null, anchor, now, deps.config.tz);
  const expiresAt = endsAt ?? anchor + deps.config.socialTtlMs;
  const fromTime = nextStart != null && nextStart > now ? clockLabel(nextStart, deps.config.tz) : "";
  const schedule = {
    startsAt: nextStart,
    remindedAt: nextStart != null && nextStart > now ? null : now,
  };
  if (!existing) {
    created = true;
    socialId = crypto.randomUUID();
    insertSocial(deps.db, {
      id: socialId,
      circleId: circle.id,
      creatorId: user.id,
      note: nextNote,
      createdAt: now,
      expiresAt,
      lat: nextPoint?.lat ?? null,
      lng: nextPoint?.lng ?? null,
      place: nextPlace,
      startsAt: nextStart,
      endsAt,
    });
  } else {
    socialId = existing.id;
    const gap = now - existing.last_notified_at;
    const noteChanged = existing.note !== nextNote;
    const whereChanged = !keepWhere && (existing.place !== nextPlace || existing.lat !== (nextPoint?.lat ?? null) || existing.lng !== (nextPoint?.lng ?? null));
    const startChanged = (existing.starts_at ?? null) !== nextStart;
    shifted = startChanged;
    // A Flic press skips the renotify wait but keeps the short floor, so a bouncing press sends once.
    const quick = flic || noteChanged || whereChanged;
    shouldNotify = startChanged || (quick ? gap >= FLOOR_MS : gap >= deps.config.renotifyMs);
    updateSocial(
      deps.db,
      existing.id,
      nextNote,
      expiresAt,
      shouldNotify ? now : existing.last_notified_at,
      keepWhere ? undefined : { point: nextPoint, place: nextPlace },
      start === undefined && !startChanged ? undefined : schedule,
    );
    if (endsAt !== existing.ends_at) setSocialEnd(deps.db, existing.id, endsAt, expiresAt);
  }
  if (picked) setInvitees(deps.db, "social", socialId, picked);
  // Being free now ends a manual Busy. Away stays, and so does a later start.
  if (nextStart == null || nextStart <= now) {
    const row = getUserStatus(deps.db, user.id);
    if (activeStatus(row, now)?.type === "busy") clearUserStatus(deps.db, user.id);
  }
  if (shouldNotify) {
    const recipients = visibleMembers(deps.db, "social", { id: socialId, creator_id: user.id }, listMembers(deps.db, circle.id))
      .filter((member) => member.id !== user.id);
    const notices = flic
      ? flicNotices(user, circle.name, socialId, recipients, nextNote)
      : freeNotices(user, socialId, recipients, { shifted, fromTime, place: nextPlace, note: nextNote });
    await notifyUsers(deps.db, deps.push, now, notices, circle);
  }
  const social = getSocial(deps.db, socialId);
  if (!social) throw new HttpError(500, "social missing");
  return { created, social: socialPayload(deps.db, social, user.id, deps.now()) };
}

/** The usual "Free now" push to the other members. */
function freeNotices(user: UserRow, socialId: string, recipients: Array<{ id: string }>, what: { shifted: boolean; fromTime: string; place: string; note: string }): Notice[] {
  const title = what.shifted ? eventTitle("time") : what.fromTime ? eventTitle("later") : eventTitle("now");
  return recipients.map((member) => ({
    userId: member.id,
    title,
    body: freePushBody(user.name, what.place, what.fromTime, what.shifted, what.note),
    url: `/?social=${socialId}`,
    kind: "social",
    refId: socialId,
    tag: `social:${socialId}`,
  }));
}

/** A Flic press: "pressed the button" for the others (same tag, so it replaces the older push) and a confirmation for the presser. */
function flicNotices(user: UserRow, circleName: string, socialId: string, recipients: Array<{ id: string }>, note: string): Notice[] {
  const base = { title: "Buzz", url: `/?social=${socialId}`, kind: "social", refId: socialId };
  const pressed = note.trim() ? `${user.name} pressed the button – ${note.trim()}` : `${user.name} pressed the button`;
  return [
    ...recipients.map((member) => ({ ...base, userId: member.id, body: pressed, tag: `social:${socialId}` })),
    { ...base, userId: user.id, body: `Your button press went out to ${circleName}`, tag: `social-self:${socialId}`, namesCircle: true },
  ];
}

function removedMessage(actor: string | null | undefined): string {
  const name = actor?.trim() || "Someone";
  return `${name} removed you from this.`;
}

export type Reply = "coming" | "declined" | "maybe";

export function normalizeReply(value: unknown): Reply {
  if (value === "declined" || value === "cant" || value === "can't") return "declined";
  if (value === "maybe") return "maybe";
  if (value === "coming" || value === "join" || value === "in") return "coming";
  throw new HttpError(400, "reply must be in, maybe, or can't");
}

export async function replySocial(deps: AppDeps, user: UserRow, rawId: string, body: Record<string, unknown>, requested: string | null = null) {
  const id = parseId(rawId);
  const circle = requireCircle(deps, user.id, requested);
  const social = getSocial(deps.db, id);
  if (!social || social.circle_id !== circle.id || !canSeeEvent(deps.db, "social", social, user.id)) throw new HttpError(404, "social not found");
  const now = deps.now();
  if (social.expires_at <= now) throw new HttpError(410, "that social has ended");
  if (social.creator_id === user.id) throw new HttpError(400, "you started this one");
  const reply = normalizeReply(body.reply);
  const socialReplyBlock = getSocialReply(deps.db, social.id, user.id);
  if (reply === "coming" && socialReplyBlock?.blocked) {
    throw new HttpError(403, removedMessage(socialReplyBlock.removed_by));
  }
  const live = social.starts_at == null || social.starts_at <= now;
  let eta: number | null = null;
  let arriveAt: number | null = null;
  if (reply === "coming" && body.arriveAt != null && body.arriveAt !== "") {
    const windowStart = live ? now : (social.starts_at ?? now);
    arriveAt = readArriveAt(body.arriveAt, now, deps.config.tz, windowStart, social.expires_at);
  } else if (reply === "coming" && live && body.eta != null) {
    const minutes = Number(body.eta);
    if (![5, 10, 20].includes(minutes)) throw new HttpError(400, "eta must be 5, 10, or 20");
    eta = minutes;
  }
  const previous = getSocialReply(deps.db, social.id, user.id);
  const changed = !previous || previous.reply !== reply || (previous.eta_min ?? null) !== eta || (previous.arrive_at ?? null) !== arriveAt;
  setSocialReply(deps.db, social.id, user.id, now, reply, eta, arriveAt);
  const key = `${social.id}:${user.id}`;
  const becameComing = reply === "coming" && previous?.reply !== "coming";
  const arriveChanged = reply === "coming" && (previous?.arrive_at ?? null) !== arriveAt && arriveAt != null;
  const etaOnly = previous?.reply === "coming" && reply === "coming" && !arriveChanged;
  const held = cancelReplyPush(key);
  const arriveLabel = arriveAt ? clockLabel(arriveAt, deps.config.tz) : "";
  if (changed) {
    recordEventLine(deps.db, {
      circleId: circle.id,
      kind: "social",
      refId: social.id,
      hostId: social.creator_id,
      title: social.note.trim() || "Free now",
      actorId: user.id,
      text: replyLogText(user.name, reply, eta, arriveLabel, previous?.reply === "coming" || previous?.reply === "join"),
      now,
    });
  }
  const notice = () => notifyUsers(deps.db, deps.push, now, [
    {
      userId: social.creator_id,
      title: eventTitle("reply"),
      body: replyPushBody(user.name, reply, eta, arriveLabel),
      kind: "reply",
      refId: social.id,
      tag: `reply:${social.id}:${user.id}`,
      url: `/?social=${social.id}`,
    },
  ], circle);
  if (held || (becameComing && (eta != null || arriveAt != null))) {
    await notice();
  } else if (becameComing) {
    scheduleReplyPush(key, notice);
  } else if (arriveChanged) {
    await notice();
  } else if (etaOnly) {
    /* The host already got the coming push. A 5/10/20 chip a moment later stays on the card. */
  } else if (changed) {
    await notice();
  }
  const fresh = getSocial(deps.db, social.id);
  if (!fresh) throw new HttpError(500, "social missing");
  return socialPayload(deps.db, fresh, user.id, deps.now());
}

export function readArriveAt(value: unknown, now: number, tz: string, start: number, end: number): number {
  if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) {
    throw new HttpError(400, "Pick a time you can arrive.");
  }
  const hour = Number(value.slice(0, 2));
  const minute = Number(value.slice(3, 5));
  if (hour > 23 || minute > 59) throw new HttpError(400, "Pick a time you can arrive.");
  const day = isoDate(Math.max(start, now), tz);
  let at: number;
  try {
    at = zonedDateTime(day, value, tz);
    if (at < start) {
      const next = zonedDateTime(addDays(day, 1), value, tz);
      if (next <= end) at = next;
    }
  } catch {
    throw new HttpError(400, "Pick a time you can arrive.");
  }
  const earliestMinute = Math.max(Math.floor(start / 60_000) * 60_000, Math.floor(now / 60_000) * 60_000);
  if (at < earliestMinute || at > end) throw new HttpError(400, "Pick a time you can arrive.");
  return at;
}
