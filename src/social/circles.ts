import crypto from "node:crypto";
import http from "node:http";
import type { DatabaseSync } from "node:sqlite";
import type { AppDeps } from "../app.js";
import { hashSecret } from "../app-kit/auth-code.ts";
import { circleAvailability, isConnected } from "../calendar/freebusy.js";
import { colorHex } from "../chat/chat-color.js";
import {
  type CircleRow,
  type UserRow,
  getBusyHours,
  getBuzzCircles,
  getCircleByCode,
  getUserById,
  insertCircle,
  isCircleAdmin,
  listCirclesForUser,
  listMembers,
  unreadNotificationsByCircle,
} from "../db.js";
import { HttpError, requestOrigin } from "../lib/http.js";
import { visiblePaymentUrls } from "../lib/payment-url.js";
import { cleanCode } from "../lib/validate.js";
import { notifyUsers } from "../push/notify.js";
import { reachForCircle } from "../push/push-status.js";
import { ownStatus, visibleStatuses } from "./status.js";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export const BUZZ_PRESSES = ["single", "double", "hold"] as const;
export type BuzzPress = (typeof BUZZ_PRESSES)[number];

/** The circle id each Flic press posts in, null where the press uses the default circle. */
export function buzzCirclesFor(db: DatabaseSync, userId: string): Record<BuzzPress, string | null> {
  const stored = getBuzzCircles(db, userId);
  return { single: stored.single ?? null, double: stored.double ?? null, hold: stored.hold ?? null };
}

export function requireCircle(deps: AppDeps, userId: string, requested: string | null = null): CircleRow {
  const circles = listCirclesForUser(deps.db, userId);
  if (requested) {
    const circle = circles.find((item) => item.id === requested);
    if (!circle) throw new HttpError(404, "not found");
    return circle;
  }
  if (circles.length === 1) return circles[0];
  if (circles.length === 0) throw new HttpError(409, "join a circle first");
  throw new HttpError(400, "circle is required");
}

export function requireAdmin(deps: AppDeps, circleId: string, userId: string): void {
  if (!isCircleAdmin(deps.db, circleId, userId)) throw new HttpError(403, "Only an admin can do that.");
}

export function requireLiveInvite(db: DatabaseSync, code: string, now: number): CircleRow {
  const circle = getCircleByCode(db, cleanCode(code));
  if (!circle || circle.invite_expires_at == null) throw new HttpError(404, "invite not found");
  if (circle.invite_expires_at <= now) throw new HttpError(410, "invite expired");
  return circle;
}

export function createCircle(deps: AppDeps, userId: string, name: string, now: number): CircleRow {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const circle: CircleRow = {
      id: crypto.randomUUID(),
      name,
      invite_code: inviteCode(),
      created_by: userId,
      created_at: now,
      invite_expires_at: now + INVITE_TTL_MS,
    };
    try {
      insertCircle(deps.db, circle, userId, now);
      return circle;
    } catch (error) {
      if (attempt === 4 || !isUnique(error)) throw error;
    }
  }
  throw new HttpError(500, "could not create a circle");
}

export function circlePayload(deps: AppDeps, req: http.IncomingMessage, circle: CircleRow, viewerId: string | null = null) {
  const members = listMembers(deps.db, circle.id);
  const reach = reachForCircle(deps.db, circle.id);
  const statuses = visibleStatuses(deps.db, viewerId, deps.now());
  const payments = visiblePaymentUrls(deps.db, viewerId);
  const now = deps.now();
  // Busy or free only, never a title. Only people who shared their calendar with this circle.
  const availability = viewerId ? circleAvailability(deps.db, circle.id, viewerId, now, now) : new Map();
  return {
    id: circle.id,
    name: circle.name,
    inviteCode: circle.invite_code,
    inviteUrl: `${requestOrigin(req, deps.config)}/join/${circle.invite_code}`,
    youAreAdmin: Boolean(viewerId && members.some((member) => member.id === viewerId && member.is_admin)),
    members: members.map((member) => ({
      id: member.id,
      name: member.name,
      color: colorHex(member.id, member.color),
      avatarRev: member.avatar_rev || null,
      status: statuses.get(member.id) ?? null,
      paymentUrl: payments.get(member.id) ?? null,
      admin: Boolean(member.is_admin),
      reach: reach.get(member.id) ?? "off",
      availability: member.id === viewerId ? null : availability.get(member.id) ?? null,
    })),
  };
}

export function mePayload(deps: AppDeps, req: http.IncomingMessage, user: UserRow, requested: string | null = null, agent = false) {
  const circles = listCirclesForUser(deps.db, user.id);
  const alertUnread = unreadNotificationsByCircle(deps.db, user.id);
  let active: CircleRow | undefined;
  if (requested) {
    active = circles.find((circle) => circle.id === requested);
    if (!active) throw new HttpError(404, "not found");
  } else {
    active = circles[0];
  }
  const row = getUserById(deps.db, user.id);
  return {
    user: {
      id: user.id,
      name: user.name,
      color: colorHex(user.id, row?.color),
      avatarRev: row?.avatar_rev || null,
      status: ownStatus(deps.db, user.id, deps.now()),
      paymentUrl: row?.payment_url ?? null,
      timezone: row?.timezone ?? null,
      busyHours: getBusyHours(deps.db, user.id),
      // The recovery code would let an agent token take over the account.
      // recoveryIsFlic: the recovery code is still the buzz token, so showing one shows the other.
      ...(agent
        ? {}
        : {
            buzzToken: user.buzz_token,
            buzzCircles: buzzCirclesFor(deps.db, user.id),
            email: row?.email ?? null,
            emailVerifiedAt: row?.email_verified_at ?? null,
            recoveryIsFlic: row?.recovery_hash === hashSecret(user.buzz_token),
          }),
      whatsNewSeen: user.whats_new_seen ?? null,
      calendarConnected: isConnected(deps.db, user.id),
    },
    circles: circles.map((circle) => ({
      id: circle.id,
      name: circle.name,
      admin: isCircleAdmin(deps.db, circle.id, user.id),
      alertUnread: alertUnread[circle.id] ?? 0,
    })),
    circle: active ? circlePayload(deps, req, active, user.id) : null,
  };
}

/** Tells everyone else in the circle that someone new is in. */
export async function notifyMemberJoined(deps: AppDeps, circle: CircleRow, joiner: { id: string; name: string }): Promise<void> {
  const others = listMembers(deps.db, circle.id).filter((member) => member.id !== joiner.id);
  await notifyUsers(deps.db, deps.push, deps.now(), others.map((member) => ({
    userId: member.id,
    title: "New member",
    body: `${joiner.name} joined ${circle.name}`,
    kind: "member-join",
    refId: joiner.id,
    tag: `member-join:${circle.id}:${joiner.id}`,
    namesCircle: true,
  })), circle);
}

export async function notifyCircleDeleted(
  deps: AppDeps,
  circle: { id: string; name: string },
  actor: UserRow,
  members: Array<{ id: string }>,
): Promise<void> {
  const notices = members
    .filter((member) => member.id !== actor.id)
    .map((member) => ({
      userId: member.id,
      title: "Circle deleted",
      body: `${circle.name} was deleted by ${actor.name}`,
      kind: "circle-deleted",
      refId: null,
      tag: `circle-deleted:${circle.id}`,
      url: "/",
    }));
  await notifyUsers(deps.db, deps.push, deps.now(), notices);
}

export function inviteCode(): string {
  const bytes = crypto.randomBytes(8);
  let code = "";
  for (let i = 0; i < 8; i += 1) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return code;
}

function isUnique(error: unknown): boolean {
  return error instanceof Error && /UNIQUE/i.test(error.message);
}
