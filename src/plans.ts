import crypto from "node:crypto";
import {
  countUpcomingPlans,
  getCircleById,
  getPlan,
  getPlanReply,
  insertPlan,
  listMembers,
  setPlanReply,
  type PlanRow,
  type UserRow,
} from "./db.js";
import { audiencePlace, eventTitle, notifyUsers, planReplyBody, replyPushBody } from "./notify.js";
import { addDays, clockLabel, isoDate, zonedDateTime } from "./time.js";
import { recordEventLine, replyLogText } from "./chat.js";
import { HttpError, parseId, planPayload, requireCircle, type AppDeps } from "./app.js";
import { normalizeReply, readArriveAt } from "./socials.js";

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
) {
  const circle = requireCircle(deps, user.id, requested);
  const now = deps.now();
  const today = isoDate(now, deps.config.tz);
  const tomorrow = addDays(today, 1);
  if (countUpcomingPlans(deps.db, circle.id, today) >= 30) {
    throw new HttpError(409, "too many plans");
  }
  const id = crypto.randomUUID();
  insertPlan(deps.db, {
    id,
    circleId: circle.id,
    creatorId: user.id,
    note,
    forDate: tomorrow,
    createdAt: now,
    lat: point?.lat ?? null,
    lng: point?.lng ?? null,
    place,
    atTime: time,
  });
  const recipients = listMembers(deps.db, circle.id).filter((member) => member.id !== user.id);
  const when = time ? ` · ${time}` : "";
  await notifyUsers(
    deps.db,
    deps.push,
    now,
    recipients.map((member) => ({
      userId: member.id,
      title: "Tomorrow",
      body: place ? `${user.name}: ${note}${when} · ${audiencePlace(place)}` : `${user.name}: ${note}${when}`,
      kind: "plan",
      refId: id,
      tag: `plan:${id}`,
      url: `/?plan=${id}`,
    })),
    circle,
  );
  const plan = getPlan(deps.db, id);
  if (!plan) throw new HttpError(500, "plan missing");
  return planPayload(deps.db, plan, today, tomorrow, user.id);
}

export async function joinPlan(deps: AppDeps, user: UserRow, rawId: string, requested: string | null = null) {
  const id = parseId(rawId);
  const circle = requireCircle(deps, user.id, requested);
  const plan = getPlan(deps.db, id);
  if (!plan || plan.circle_id !== circle.id) throw new HttpError(404, "plan not found");
  const now = deps.now();
  const today = isoDate(now, deps.config.tz);
  const tomorrow = addDays(today, 1);
  assertPlanOpen(plan, today);
  if (plan.creator_id === user.id) throw new HttpError(400, "you made this plan");
  const planBlock = getPlanReply(deps.db, plan.id, user.id);
  if (planBlock?.blocked) throw new HttpError(403, removedMessage(planBlock.removed_by));
  await setPlanComing(deps, user, plan, now);
  const fresh = getPlan(deps.db, plan.id);
  if (!fresh) throw new HttpError(500, "plan missing");
  return planPayload(deps.db, fresh, today, tomorrow, user.id);
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
  if (!plan || plan.circle_id !== circle.id) throw new HttpError(404, "plan not found");
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
        circleId: circle.id,
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
      ], circle);
    }
  } else {
    const previous = getPlanReply(deps.db, plan.id, user.id);
    if (previous?.reply !== "declined") {
      setPlanReply(deps.db, plan.id, user.id, now, "declined", null);
      recordEventLine(deps.db, {
        circleId: circle.id,
        kind: "plan",
        refId: plan.id,
        hostId: plan.creator_id,
        title: plan.note,
        actorId: user.id,
        text: replyLogText(user.name, "declined", null, "", false),
        now,
      });
      await notifyPlanReply(deps, user, plan, now, "declined");
    }
  }
  const fresh = getPlan(deps.db, plan.id);
  if (!fresh) throw new HttpError(500, "plan missing");
  return planPayload(deps.db, fresh, today, addDays(today, 1), user.id);
}

async function notifyPlanReply(
  deps: AppDeps,
  user: UserRow,
  plan: PlanRow,
  now: number,
  reply: "coming" | "declined",
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

function assertPlanOpen(plan: PlanRow, today: string): void {
  if (plan.ended_at != null || plan.for_date < today) throw new HttpError(410, "That plan has ended.");
}

function readPlanArrive(value: unknown, day: string, now: number, tz: string): number {
  const start = zonedDateTime(day, "06:00", tz);
  const end = zonedDateTime(day, "23:59", tz);
  return readArriveAt(value, now, tz, start, end);
}
