import type { DatabaseSync } from "node:sqlite";
import { colorHex } from "../chat/chat-color.js";
import {
  type PlanRow,
  type SocialRow,
  getCircleById,
  getPlanReply,
  getSocialReply,
  listPlanCircles,
  listPlanJoins,
  listSocialJoins,
} from "../db.js";
import { visiblePaymentUrls, visibleWeroEmails } from "../lib/payment-url.js";
import { dayLabel } from "../lib/time.js";
import { type PushSummary, pushSummaryForPlan, pushSummaryForViewer } from "../push/push-status.js";
import { buzzAnimationField } from "./buzz-animation.js";
import { photoField } from "./event-photo-access.js";
import { remindAgainAt } from "./plans.js";
import { paymentPayload } from "./payments.js";
import { type PersonStatus, visibleStatuses } from "./status.js";
import { type EventKind, canSeeEvent, isPrivateEvent, listInvitees } from "./visibility.js";

function pointPayload(lat: number | null, lng: number | null): { lat: number; lng: number } | null {
  if (lat == null || lng == null) return null;
  return { lat, lng };
}

function removedByName(reply: { blocked: number; removed_by: string | null } | undefined): string | null {
  if (!reply?.blocked) return null;
  return reply.removed_by?.trim() || "Someone";
}

/** `private` and `invitees` for a private event the viewer may see. Public events add nothing. */
function privateField(db: DatabaseSync, kind: EventKind, event: { id: string; creator_id: string }, viewerId: string | null) {
  if (!isPrivateEvent(db, kind, event.id) || !canSeeEvent(db, kind, event, viewerId)) return {};
  const invitees = listInvitees(db, kind, event.id, event.creator_id).map((person) => ({
    id: person.id,
    name: person.name,
    color: colorHex(person.id, person.color),
    avatarRev: person.avatar_rev || null,
  }));
  return { private: true, invitees };
}

export function socialPayload(db: DatabaseSync, social: SocialRow, viewerId: string | null = null, now: number = Date.now()) {
  const statuses = visibleStatuses(db, viewerId, now);
  const payments = visiblePaymentUrls(db, viewerId);
  const weroEmails = visibleWeroEmails(db, viewerId);
  const joins = listSocialJoins(db, social.id);
  return {
    id: social.id,
    note: social.note,
    createdAt: social.created_at,
    startsAt: social.starts_at,
    endsAt: social.ends_at ?? null,
    buzzedAt: social.buzzed_at ?? null,
    expiresAt: social.expires_at,
    place: social.place ?? "",
    location: pointPayload(social.lat, social.lng),
    circleId: social.circle_id,
    circleName: getCircleById(db, social.circle_id)?.name ?? "",
    creator: { id: social.creator_id, name: social.creator_name, color: colorHex(social.creator_id, social.creator_color), avatarRev: social.creator_avatar_rev || null, status: statuses.get(social.creator_id) ?? null, paymentUrl: payments.get(social.creator_id) ?? null, weroEmail: weroEmails.get(social.creator_id) ?? null, ...buzzAnimationField(social.creator_buzz_animation) },
    removedBy: removedByName(viewerId ? getSocialReply(db, social.id, viewerId) : undefined),
    ...privateField(db, "social", social, viewerId),
    ...photoField(db, "social", social, viewerId),
    joined: joins.map((join) => ({
      id: join.id,
      name: join.name,
      color: colorHex(join.id, join.color),
      avatarRev: join.avatar_rev || null,
      status: statuses.get(join.id) ?? null,
      paymentUrl: payments.get(join.id) ?? null,
      weroEmail: weroEmails.get(join.id) ?? null,
      joinedAt: join.joined_at,
      reply: join.reply ?? "join",
      etaMin: join.eta_min ?? null,
      arriveAt: join.arrive_at ?? null,
    })),
    payment: paymentPayload(db, "social", social, joins, viewerId),
    ...withStatuses(pushField(db, social.circle_id, "social", social.id, social.creator_id, viewerId), statuses),
  };
}

export function planPayload(db: DatabaseSync, plan: PlanRow, today: string, viewerId: string | null = null, now: number = Date.now()) {
  const statuses = visibleStatuses(db, viewerId, now);
  const payments = visiblePaymentUrls(db, viewerId);
  const weroEmails = visibleWeroEmails(db, viewerId);
  const joins = listPlanJoins(db, plan.id);
  return {
    id: plan.id,
    note: plan.note,
    description: plan.description ?? "",
    // Card colour slot 0..13, or null for the id hash default. Not creator.color, which is a chat hex.
    cardColor: plan.card_color ?? null,
    place: plan.place ?? "",
    forDate: plan.for_date,
    whenLabel: dayLabel(plan.for_date, today),
    time: plan.at_time,
    endsAt: plan.ends_at ?? null,
    createdAt: plan.created_at,
    location: pointPayload(plan.lat, plan.lng),
    // Home circle. `circles` below still lists every linked circle.
    circleId: plan.circle_id,
    circleName: getCircleById(db, plan.circle_id)?.name ?? "",
    shareId: plan.share_id ?? null,
    // Last "Remind friends" and when the next one is allowed, so the menu can grey out.
    remindedAt: plan.reminded_at ?? null,
    remindAgainAt: remindAgainAt(db, plan, viewerId),
    creator: { id: plan.creator_id, name: plan.creator_name, color: colorHex(plan.creator_id, plan.creator_color), avatarRev: plan.creator_avatar_rev || null, status: statuses.get(plan.creator_id) ?? null, paymentUrl: payments.get(plan.creator_id) ?? null, weroEmail: weroEmails.get(plan.creator_id) ?? null },
    // Names only. Same event, so other circles' names show, but never their members or codes.
    circles: listPlanCircles(db, plan.id),
    removedBy: removedByName(viewerId ? getPlanReply(db, plan.id, viewerId) : undefined),
    ...privateField(db, "plan", plan, viewerId),
    ...photoField(db, "plan", plan, viewerId),
    joined: joins.map((join) => ({
      id: join.id,
      name: join.name,
      color: colorHex(join.id, join.color),
      avatarRev: join.avatar_rev || null,
      status: statuses.get(join.id) ?? null,
      paymentUrl: payments.get(join.id) ?? null,
      weroEmail: weroEmails.get(join.id) ?? null,
      joinedAt: join.joined_at,
      reply: join.reply ?? "coming",
      arriveAt: join.arrive_at ?? null,
    })),
    payment: paymentPayload(db, "plan", plan, joins, viewerId),
    // Every linked circle, so people reached by "Share with other circles" show too.
    ...withStatuses(optionalPush(pushSummaryForPlan(db, plan.id, plan.creator_id, viewerId)), statuses),
  };
}

function pushField(
  db: DatabaseSync,
  circleId: string,
  kind: "social" | "plan",
  refId: string,
  hostId: string,
  viewerId: string | null,
): { push: ReturnType<typeof pushSummaryForViewer> } | Record<string, never> {
  return optionalPush(pushSummaryForViewer(db, circleId, kind, refId, hostId, viewerId));
}

function optionalPush(push: PushSummary | undefined): { push: PushSummary } | Record<string, never> {
  return push ? { push } : {};
}

/** The host's push roster shows who is away, as userStatus (status there is the delivery state). Delivery is unchanged. */
function withStatuses<T extends { push?: PushSummary }>(field: T, statuses: Map<string, PersonStatus>): T {
  if (!field.push) return field;
  const people = field.push.people.map((person) => ({ ...person, userStatus: statuses.get(person.id) ?? null }));
  return { ...field, push: { ...field.push, people } };
}
