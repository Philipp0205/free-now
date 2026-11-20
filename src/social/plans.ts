import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  claimLateReminders,
  claimPlanReminder,
  countUpcomingPlans,
  getCircleById,
  getPlan,
  getPlanReply,
  insertPlan,
  listPlanCircleIds,
  planInCircle,
  listMembers,
  listPlanRemindedUserIds,
  setPlanReply,
  type PlanRow,
  type UserRow,
} from "../db.js";
import { audiencePlace, eventTitle, notifyUsers, planRemindTitle, planReplyBody, replyPushBody, type Notice } from "../push/notify.js";
import { addDays, clockLabel, isCalendarDate, isoDate, noticeDay, zonedDateTime } from "../lib/time.js";
import { recordEventLine, replyLogText } from "../chat/chat.js";
import { HttpError, parseId, planPayload, requireCircle, type AppDeps } from "../app.js";
import { normalizeReply, readArriveAt, type Reply } from "./socials.js";
import { ensureShareId } from "./plan-share.js";

/** How far ahead a plan can go, in calendar days in APP_TZ. */
export const PLAN_DAYS_AHEAD = 365;

/** A plan day from today through PLAN_DAYS_AHEAD, as YYYY-MM-DD. */
export function readPlanDate(value: unknown, today: string): string {
  if (typeof value !== "string" || !isCalendarDate(value)) throw new HttpError(400, "That date doesn't exist.");
  if (value < today) throw new HttpError(400, "Pick a date from today on.");
  if (value > addDays(today, PLAN_DAYS_AHEAD)) throw new HttpError(400, "Pick a date within a year.");
  return value;
}

/** A clock on today must still be ahead, the same rule as a later-today post. */
export function assertPlanClock(forDate: string, time: string | null, now: number, tz: string): void {
  if (!time || forDate !== isoDate(now, tz)) return;
  if (zonedDateTime(forDate, time, tz) <= now) throw new HttpError(400, "Pick a time later today.");
}

function removedMessage(actor: string | null | undefined): string {
  const name = actor?.trim() || "Someone";
  return `${name} removed you from this.`;
}

export async function publishPlan(
  deps: AppDeps,
  user: UserRow,
  note: string,
  place: string,
  point?: { lat: number; lng: number } | null,
  time: string | null = null,
  requested: string | null = null,
  date: unknown = undefined,
  description = "",
  cardColor: number | null = null,
) {
  const circle = requireCircle(deps, user.id, requested);
  const now = deps.now();
  const today = isoDate(now, deps.config.tz);
  // No date is the original request shape, which always meant tomorrow.
  const forDate = date == null ? addDays(today, 1) : readPlanDate(date, today);
  assertPlanClock(forDate, time, now, deps.config.tz);
  if (countUpcomingPlans(deps.db, circle.id, today) >= 30) {
    throw new HttpError(409, "too many plans");
  }
  const id = crypto.randomUUID();
  insertPlan(deps.db, {
    id,
    circleId: circle.id,
    creatorId: user.id,
    note,
    forDate,
    createdAt: now,
    lat: point?.lat ?? null,
    lng: point?.lng ?? null,
    place,
    atTime: time,
    description,
    cardColor,
  });
  // Made now so the first Share tap needs no round trip. Old plans get one on first share.
  ensureShareId(deps.db, id);
  const plan = getPlan(deps.db, id);
  if (!plan) throw new HttpError(500, "plan missing");
  const recipients = listMembers(deps.db, circle.id).filter((member) => member.id !== user.id);
  await notifyUsers(
    deps.db,
    deps.push,
    now,
    recipients.map((member) => ({ userId: member.id, ...newPlanNotice(plan, user.name, today) })),
    circle,
  );
  return planPayload(deps.db, plan, today, user.id, deps.now());
}

/** The new-plan push. Also sent once to a circle the plan is shared with later. */
export function newPlanNotice(plan: PlanRow, hostName: string, today: string) {
  const when = plan.at_time ? ` · ${plan.at_time}` : "";
  const place = plan.place ?? "";
  return {
    title: noticeDay(plan.for_date, today),
    body: place ? `${hostName}: ${plan.note}${when} · ${audiencePlace(place)}` : `${hostName}: ${plan.note}${when}`,
    kind: "plan",
    refId: plan.id,
    tag: `plan:${plan.id}`,
    url: `/?plan=${plan.id}`,
  };
}

export async function joinPlan(deps: AppDeps, user: UserRow, rawId: string, requested: string | null = null) {
  const id = parseId(rawId);
  const circle = requireCircle(deps, user.id, requested);
  const plan = getPlan(deps.db, id);
  if (!plan || !planInCircle(deps.db, plan.id, circle.id)) throw new HttpError(404, "plan not found");
  const now = deps.now();
  const today = isoDate(now, deps.config.tz);
  assertPlanOpen(plan, today);
  if (plan.creator_id === user.id) throw new HttpError(400, "you made this plan");
  const planBlock = getPlanReply(deps.db, plan.id, user.id);
  if (planBlock?.blocked) throw new HttpError(403, removedMessage(planBlock.removed_by));
  await setPlanComing(deps, user, plan, now);
  const fresh = getPlan(deps.db, plan.id);
  if (!fresh) throw new HttpError(500, "plan missing");
  return planPayload(deps.db, fresh, today, user.id, deps.now());
}

async function setPlanComing(
  deps: AppDeps,
  user: UserRow,
  plan: PlanRow,
  now: number,
): Promise<void> {
  const previous = getPlanReply(deps.db, plan.id, user.id);
  if (previous?.reply === "coming") return;
  setPlanReply(deps.db, plan.id, user.id, now, "coming", null);
  recordEventLine(deps.db, {
    circleId: plan.circle_id,
    kind: "plan",
    refId: plan.id,
    hostId: plan.creator_id,
    title: plan.note,
    actorId: user.id,
    text: replyLogText(user.name, "coming", null, "", false),
    now,
  });
  await notifyPlanReply(deps, user, plan, now, "coming");
}

export async function replyPlan(deps: AppDeps, user: UserRow, rawId: string, body: Record<string, unknown>, requested: string | null = null) {
  const id = parseId(rawId);
  const circle = requireCircle(deps, user.id, requested);
  const plan = getPlan(deps.db, id);
  if (!plan || !planInCircle(deps.db, plan.id, circle.id)) throw new HttpError(404, "plan not found");
  const now = deps.now();
  const today = isoDate(now, deps.config.tz);
  assertPlanOpen(plan, today);
  if (plan.creator_id === user.id) throw new HttpError(400, "you made this plan");
  const reply = normalizeReply(body.reply);
  const planReplyBlock = getPlanReply(deps.db, plan.id, user.id);
  if (reply === "coming" && planReplyBlock?.blocked) {
    throw new HttpError(403, removedMessage(planReplyBlock.removed_by));
  }
  if (reply === "coming") {
    const previous = getPlanReply(deps.db, plan.id, user.id);
    let arriveAt: number | null = previous?.reply === "coming" ? (previous.arrive_at ?? null) : null;
    if (body.arriveAt) arriveAt = readPlanArrive(body.arriveAt, plan.for_date, now, deps.config.tz);
    const became = previous?.reply !== "coming";
    const arriveChanged = (previous?.arrive_at ?? null) !== arriveAt && arriveAt != null;
    setPlanReply(deps.db, plan.id, user.id, now, "coming", arriveAt);
    if (became || arriveChanged) {
      const arriveLabel = arriveAt ? clockLabel(arriveAt, deps.config.tz) : "";
      recordEventLine(deps.db, {
        circleId: plan.circle_id,
        kind: "plan",
        refId: plan.id,
        hostId: plan.creator_id,
        title: plan.note,
        actorId: user.id,
        text: replyLogText(user.name, "coming", null, arriveLabel, !became && Boolean(arriveAt)),
        now,
      });
      await notifyUsers(deps.db, deps.push, now, [
        {
          userId: plan.creator_id,
          title: eventTitle("reply"),
          body: arriveAt
            ? replyPushBody(user.name, "coming", null, clockLabel(arriveAt, deps.config.tz))
            : planReplyBody(user.name, plan.note, "coming"),
          kind: "plan-reply",
          refId: plan.id,
          tag: `plan-reply:${plan.id}:${user.id}`,
          url: `/?plan=${plan.id}`,
        },
      ], getCircleById(deps.db, plan.circle_id));
    }
  } else {
    const previous = getPlanReply(deps.db, plan.id, user.id);
    if (previous?.reply !== reply) {
      setPlanReply(deps.db, plan.id, user.id, now, reply, null);
      recordEventLine(deps.db, {
        circleId: plan.circle_id,
        kind: "plan",
        refId: plan.id,
        hostId: plan.creator_id,
        title: plan.note,
        actorId: user.id,
        text: replyLogText(user.name, reply, null, "", false),
        now,
      });
      await notifyPlanReply(deps, user, plan, now, reply);
    }
  }
  const fresh = getPlan(deps.db, plan.id);
  if (!fresh) throw new HttpError(500, "plan missing");
  return planPayload(deps.db, fresh, today, user.id, deps.now());
}

async function notifyPlanReply(
  deps: AppDeps,
  user: UserRow,
  plan: PlanRow,
  now: number,
  reply: Reply,
): Promise<void> {
  await notifyUsers(deps.db, deps.push, now, [
    {
      userId: plan.creator_id,
      title: eventTitle("reply"),
      body: planReplyBody(user.name, plan.note, reply),
      kind: "plan-reply",
      refId: plan.id,
      tag: `plan-reply:${plan.id}:${user.id}`,
      url: `/?plan=${plan.id}`,
    },
  ], getCircleById(deps.db, plan.circle_id));
}

/**
 * One "Remind friends" per plan per hour, whoever sends it. Inside the hour a reminder still
 * reaches people not reminded in that hour (someone who joined the circle later), and only them.
 * Who was reminded lives in plan_reminders, not in Alerts, so clearing or pruning Alerts changes nothing.
 */
export const REMIND_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * When the next reminder is allowed, or null if one is allowed now: none sent yet, or someone
 * the viewer could remind was not reminded in the running hour.
 */
export function remindAgainAt(db: DatabaseSync, plan: PlanRow, viewerId: string | null = null): number | null {
  if (plan.reminded_at == null) return null;
  if (viewerId && remindTargets(db, plan, viewerId, listPlanRemindedUserIds(db, plan.id, plan.reminded_at)).size > 0) return null;
  return plan.reminded_at + REMIND_COOLDOWN_MS;
}

/**
 * Who a reminder from `senderId` reaches, per linked circle, leaving out `skip`.
 * In, Can't and removed count as answered. Maybe is tentative, so it still gets the reminder. The host is always in.
 */
function remindTargets(db: DatabaseSync, plan: PlanRow, senderId: string, skip: Set<string>): Map<string, string[]> {
  const answered = (userId: string) => {
    if (userId === plan.creator_id) return true;
    const row = getPlanReply(db, plan.id, userId);
    return Boolean(row) && (Boolean(row?.blocked) || row?.reply !== "maybe");
  };
  const byCircle = new Map<string, string[]>();
  for (const circleId of listPlanCircleIds(db, plan.id)) {
    const ids = listMembers(db, circleId)
      .map((member) => member.id)
      .filter((userId) => userId !== senderId && !skip.has(userId) && !answered(userId));
    if (ids.length) byCircle.set(circleId, ids);
  }
  return byCircle;
}

/**
 * Sends the plan's push again, as a reminder, to everyone in its circles who has not answered or said Maybe.
 * One push per person. One Alert per person in each linked circle they are in.
 */
export async function remindPlan(deps: AppDeps, user: UserRow, rawId: string, requested: string | null = null) {
  const id = parseId(rawId);
  const circle = requireCircle(deps, user.id, requested);
  const plan = getPlan(deps.db, id);
  if (!plan || !planInCircle(deps.db, plan.id, circle.id)) throw new HttpError(404, "plan not found");
  const now = deps.now();
  const today = isoDate(now, deps.config.tz);
  assertPlanOpen(plan, today);
  const block = getPlanReply(deps.db, plan.id, user.id);
  if (block?.blocked) throw new HttpError(403, removedMessage(block.removed_by));
  const retryAt = plan.reminded_at == null ? null : plan.reminded_at + REMIND_COOLDOWN_MS;
  const cooling = retryAt != null && retryAt > now;
  // Inside the hour, anyone already reminded in it is left alone.
  const hourStart = plan.reminded_at ?? now;
  const skip = cooling ? listPlanRemindedUserIds(deps.db, plan.id, hourStart) : new Set<string>();
  const targets = remindTargets(deps.db, plan, user.id, skip);
  const everyone = [...new Set([...targets.values()].flat())];
  if (cooling && everyone.length === 0) throw new HttpError(429, "Already reminded.", { retryAt });
  // Nobody left to ask: no push, and the hour stays free for later.
  if (everyone.length === 0) return { reminded: 0, plan: planPayload(deps.db, plan, today, user.id, deps.now()) };
  // Claimed before any await, in one transaction with the record of who was reminded, so two taps
  // at once send one reminder. A newcomer-only reminder keeps the hour as it was.
  let claimed: Set<string>;
  if (cooling) {
    claimed = new Set(claimLateReminders(deps.db, plan.id, user.id, everyone, now, hourStart));
    if (claimed.size === 0) throw new HttpError(429, "Already reminded.", { retryAt });
  } else if (claimPlanReminder(deps.db, plan.id, user.id, everyone, now, now - REMIND_COOLDOWN_MS)) {
    claimed = new Set(everyone);
  } else {
    const fresh = getPlan(deps.db, plan.id);
    throw new HttpError(429, "Already reminded.", { retryAt: fresh?.reminded_at != null ? fresh.reminded_at + REMIND_COOLDOWN_MS : now + REMIND_COOLDOWN_MS });
  }
  const batches: Array<{ circle: NonNullable<ReturnType<typeof getCircleById>>; notices: Notice[] }> = [];
  const pushed = new Set<string>();
  for (const [circleId, userIds] of targets) {
    const target = getCircleById(deps.db, circleId);
    const mine = userIds.filter((userId) => claimed.has(userId));
    if (!target || mine.length === 0) continue;
    const notices: Notice[] = mine.map((userId) => ({
      userId,
      ...planRemindNotice(plan, user.name, today),
      skipPush: pushed.has(userId),
    }));
    for (const userId of mine) pushed.add(userId);
    batches.push({ circle: target, notices });
  }
  for (const batch of batches) await notifyUsers(deps.db, deps.push, now, batch.notices, batch.circle);
  const fresh = getPlan(deps.db, plan.id);
  if (!fresh) throw new HttpError(500, "plan missing");
  return { reminded: claimed.size, plan: planPayload(deps.db, fresh, today, user.id, deps.now()) };
}

/** The reminder push. Shaped like the reschedule push: the news in the title, the place under it. */
export function planRemindNotice(plan: PlanRow, senderName: string, today: string) {
  const place = plan.place ?? "";
  return {
    title: planRemindTitle(senderName, plan.note, noticeDay(plan.for_date, today), plan.at_time),
    body: place ? audiencePlace(place) : "Tap to see the plan.",
    kind: "plan-remind",
    refId: plan.id,
    tag: `plan-remind:${plan.id}`,
    url: `/?plan=${plan.id}`,
  };
}

function assertPlanOpen(plan: PlanRow, today: string): void {
  if (plan.ended_at != null || plan.for_date < today) throw new HttpError(410, "That plan has ended.");
}

function readPlanArrive(value: unknown, day: string, now: number, tz: string): number {
  const start = zonedDateTime(day, "06:00", tz);
  const end = zonedDateTime(day, "23:59", tz);
  return readArriveAt(value, now, tz, start, end);
}
