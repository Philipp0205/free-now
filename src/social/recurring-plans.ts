import crypto from "node:crypto";
import {
  bumpEventPhotoRev,
  getCircleById,
  getPlan,
  insertPlan,
  linkPlanCircle,
  listMembers,
  listPlanCircleIds,
  listRepeatingPlans,
  retirePlanRecurrence,
  seriesDateTaken,
  setPlanRecurrence,
  withTx,
  type PlanRow,
  type UserRow,
} from "../db.js";
import { HttpError } from "../lib/http.js";
import { readEventPhoto, removeEventPhoto, writeEventPhoto } from "../lib/event-photo.js";
import { anchorDayOf, isRecurrence, nextEndsAt, nextOccurrenceDate, readRecurrence, type Recurrence } from "../lib/recurrence.js";
import { isoDate } from "../lib/time.js";
import { notifyUsers } from "../push/notify.js";
import type { AppDeps } from "../app.js";
import { ensureShareId } from "./plan-share.js";
import { newPlanNotice } from "./plans.js";
import { inviteeIds, setInvitees, visibleMembers } from "./visibility.js";

type Deps = Pick<AppDeps, "db" | "push" | "config" | "now">;

/** Done means ended by hand, past its end time, or (with no end time) on a day before today. */
export function isPlanDone(plan: PlanRow, today: string, now: number): boolean {
  if (plan.ended_at != null) return true;
  if (plan.ends_at != null) return plan.ends_at <= now;
  return plan.for_date < today;
}

type Slot = { date: string; endsAt: number | null };

/** The first later day that is not past yet, with its end. Null if none turns up within a sane number of steps. */
function nextSlot(plan: PlanRow, rule: Recurrence, tz: string, now: number, today: string): Slot | null {
  const anchor = plan.series_day ?? anchorDayOf(plan.for_date);
  let date = plan.for_date;
  for (let step = 0; step < 400; step += 1) {
    date = nextOccurrenceDate(date, rule, anchor);
    if (date < today) continue;
    const endsAt = nextEndsAt(plan.ends_at, plan.for_date, date, plan.at_time, tz);
    if (endsAt == null || endsAt > now) return { date, endsAt };
  }
  return null;
}

/** Copies the people, circles, price and share link onto the new row. Runs inside the insert transaction. */
function copyAround(deps: Deps, from: PlanRow, to: string, now: number): void {
  ensureShareId(deps.db, to);
  for (const circleId of listPlanCircleIds(deps.db, from.id)) linkPlanCircle(deps.db, to, circleId, now);
  const invited = inviteeIds(deps.db, "plan", from.id);
  if (invited) setInvitees(deps.db, "plan", to, [...invited]);
}

/** Makes the next occurrence and retires the old rule in one transaction. Returns the new id, or null when nothing was inserted. */
function insertNext(deps: Deps, from: PlanRow, rule: Recurrence, slot: Slot, now: number): string | null {
  const id = crypto.randomUUID();
  let made = false;
  withTx(deps.db, () => {
    made = insertPlan(deps.db, {
      id,
      circleId: from.circle_id,
      creatorId: from.creator_id,
      note: from.note,
      forDate: slot.date,
      createdAt: now,
      lat: from.lat,
      lng: from.lng,
      place: from.place,
      atTime: from.at_time,
      description: from.description,
      cardColor: from.card_color,
      endsAt: slot.endsAt,
      seriesId: from.series_id,
      recurrence: rule,
      seriesDay: from.series_day ?? anchorDayOf(from.for_date),
      priceCents: from.price_cents,
      collectorId: from.collector_id,
      orIgnore: true,
    });
    if (made) copyAround(deps, from, id, now);
    retirePlanRecurrence(deps.db, from.id);
  });
  return made ? id : null;
}

/** Gives the new plan its own copy of the cover photo. A failed copy leaves no photo, never a shared file. */
async function copyPhoto(deps: Deps, from: PlanRow, toId: string): Promise<void> {
  if (!from.photo_rev) return;
  const dir = deps.config.eventPhotosDir;
  try {
    const file = await readEventPhoto(dir, "plan", from.id);
    if (!file) return;
    await writeEventPhoto(dir, "plan", toId, file.data);
    bumpEventPhotoRev(deps.db, "plan", toId, deps.now());
  } catch {
    await removeEventPhoto(dir, "plan", toId).catch(() => {});
  }
}

/** One push per person for the new plan, host left out, the same text as a plan made by hand. */
async function pushNew(deps: Deps, plan: PlanRow, now: number, today: string): Promise<void> {
  const told = new Set<string>([plan.creator_id]);
  for (const circleId of listPlanCircleIds(deps.db, plan.id)) {
    const circle = getCircleById(deps.db, circleId);
    if (!circle) continue;
    const members = visibleMembers(deps.db, "plan", plan, listMembers(deps.db, circleId)).filter((member) => !told.has(member.id));
    for (const member of members) told.add(member.id);
    const notice = newPlanNotice(plan, plan.creator_name, today);
    await notifyUsers(deps.db, deps.push, now, members.map((member) => ({ userId: member.id, ...notice })), circle);
  }
}

/** Handles one finished repeating plan. A host who left the circle ends the series quietly. */
async function materializeOne(deps: Deps, plan: PlanRow, now: number, today: string): Promise<void> {
  const rule = plan.recurrence;
  const hostIn = listMembers(deps.db, plan.circle_id).some((member) => member.id === plan.creator_id);
  const slot = isRecurrence(rule) && hostIn ? nextSlot(plan, rule, deps.config.tz, now, today) : null;
  if (!isRecurrence(rule) || !slot) {
    retirePlanRecurrence(deps.db, plan.id);
    return;
  }
  const id = insertNext(deps, plan, rule, slot, now);
  if (!id) return;
  await copyPhoto(deps, plan, id);
  const fresh = getPlan(deps.db, id);
  if (fresh) await pushNew(deps, fresh, now, today);
}

/**
 * Reads the repeat rule from a plan edit. Host only. Validates now and returns the write to run later, so a 400 or 403
 * happens before anything else is saved. Null means nothing to do. Never touches other occurrences.
 */
export function readRecurrenceEdit(
  deps: Deps,
  user: UserRow,
  plan: PlanRow,
  body: Record<string, unknown>,
  forDate: string,
): (() => void) | null {
  const wanted = readRecurrence(body.recurrence);
  const dateMoved = forDate !== plan.for_date;
  if (wanted !== undefined && user.id !== plan.creator_id) throw new HttpError(403, "Only the host can change how it repeats.");
  if (plan.series_id && dateMoved && seriesDateTaken(deps.db, plan.series_id, plan.id, forDate)) {
    throw new HttpError(409, "This plan already repeats on that day.");
  }
  const next = wanted === undefined ? plan.recurrence : wanted;
  // A moved day re-anchors a monthly series. Otherwise only an explicit change writes anything.
  if (wanted === undefined && !(dateMoved && next)) return null;
  const rule = isRecurrence(next) ? next : null;
  return () => setPlanRecurrence(deps.db, plan.id, rule, anchorDayOf(forDate));
}

/**
 * Makes the next occurrence of every repeating plan that is done, once. Safe to run again: the unique
 * (series, day) index stops a second row and a rerun sends no second push. `onlyId` limits it to one plan.
 */
export async function materializeRecurringPlans(deps: Deps, onlyId?: string): Promise<void> {
  const now = deps.now();
  const today = isoDate(now, deps.config.tz);
  for (const plan of listRepeatingPlans(deps.db)) {
    if (onlyId && plan.id !== onlyId) continue;
    if (!isPlanDone(plan, today, now)) continue;
    try {
      await materializeOne(deps, plan, now, today);
    } catch (error) {
      console.error("recurring plan failed", error instanceof Error ? error.name : "unknown");
    }
  }
}
