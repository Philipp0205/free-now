import type { AppDeps } from "../app.js";
import { closeEventChat, recordEventLine } from "../chat/chat.js";
import {
  type CircleRow,
  type PlanRow,
  type UserRow,
  addSocialJoin,
  blockPlanGuest,
  blockSocialGuest,
  finishPlan,
  finishSocial,
  getCircleById,
  getPlan,
  getPlanReply,
  getSocial,
  getSocialReply,
  hasSocialJoin,
  isCircleAdmin,
  linkPlanCircle,
  listCirclesForUser,
  listMembers,
  listPlanAudience,
  listPlanCircleIds,
  listPlanJoins,
  listSocialJoins,
  patchPlanDetails,
  patchSocialDetails,
  planCircleForUser,
  planInCircle,
  removePlanJoin,
  removeSocialJoin,
  unlinkPlanCircle,
} from "../db.js";
import { HttpError } from "../lib/http.js";
import { clockLabel, isoDate, shortDate } from "../lib/time.js";
import { cleanDescription, cleanNote, cleanPlace, parseId, readClock, readPoint, readStart } from "../lib/validate.js";
import { audiencePlace, eventTitle, notifyUsers } from "../push/notify.js";
import { requireCircle } from "./circles.js";
import { planPayload, socialPayload } from "./payload.js";
import { assertPlanClock, newPlanNotice, readPlanDate } from "./plans.js";

export async function joinSocial(deps: AppDeps, user: UserRow, rawId: string, requested: string | null = null) {
  const id = parseId(rawId);
  const circle = requireCircle(deps, user.id, requested);
  const social = getSocial(deps.db, id);
  if (!social || social.circle_id !== circle.id) throw new HttpError(404, "social not found");
  const now = deps.now();
  if (social.expires_at <= now) throw new HttpError(410, "that social has ended");
  if (social.creator_id === user.id) throw new HttpError(400, "you started this one");
  const socialBlock = getSocialReply(deps.db, social.id, user.id);
  if (socialBlock?.blocked) throw new HttpError(403, removedMessage(socialBlock.removed_by));
  if (!hasSocialJoin(deps.db, social.id, user.id)) {
    addSocialJoin(deps.db, social.id, user.id, now);
    await notifyUsers(deps.db, deps.push, now, [
      {
        userId: social.creator_id,
        title: eventTitle("reply"),
        body: `${user.name} is in`,
        kind: "join",
        refId: social.id,
        tag: `join:${social.id}:${user.id}`,
      },
    ], circle);
  }
  const fresh = getSocial(deps.db, social.id);
  if (!fresh) throw new HttpError(500, "social missing");
  return socialPayload(deps.db, fresh, user.id, deps.now());
}

export function leaveSocial(deps: AppDeps, user: UserRow, rawId: string, requested: string | null = null) {
  const id = parseId(rawId);
  const circle = requireCircle(deps, user.id, requested);
  const social = getSocial(deps.db, id);
  if (!social || social.circle_id !== circle.id) throw new HttpError(404, "social not found");
  if (social.expires_at <= deps.now()) throw new HttpError(410, "that social has ended");
  removeSocialJoin(deps.db, social.id, user.id);
  return socialPayload(deps.db, social, user.id, deps.now());
}

export function leavePlan(deps: AppDeps, user: UserRow, rawId: string, requested: string | null = null) {
  const id = parseId(rawId);
  const circle = requireCircle(deps, user.id, requested);
  const plan = getPlan(deps.db, id);
  if (!plan || !planInCircle(deps.db, plan.id, circle.id)) throw new HttpError(404, "plan not found");
  removePlanJoin(deps.db, plan.id, user.id);
  const now = deps.now();
  const today = isoDate(now, deps.config.tz);
  return planPayload(deps.db, plan, today, user.id, deps.now());
}

export async function removeSocialGuest(deps: AppDeps, user: UserRow, rawSocialId: string, rawUserId: string, requested: string | null = null): Promise<void> {
  const socialId = parseId(rawSocialId);
  const guestId = parseId(rawUserId);
  const circle = requireCircle(deps, user.id, requested);
  const social = getSocial(deps.db, socialId);
  if (!social || social.circle_id !== circle.id) throw new HttpError(404, "social not found");
  if (guestId === social.creator_id) throw new HttpError(400, "you started this one");
  assertEventHost(deps, user, circle.id, social.creator_id);
  const guest = listMembers(deps.db, circle.id).find((member) => member.id === guestId);
  if (!guest) throw new HttpError(404, "member not found");
  blockSocialGuest(deps.db, social.id, guestId, deps.now(), user.name);
  const eventName = social.note.trim() || "Free now";
  recordEventLine(deps.db, {
    circleId: circle.id,
    kind: "social",
    refId: social.id,
    hostId: social.creator_id,
    title: eventName,
    actorId: user.id,
    text: `${user.name} removed ${guest.name}`,
    now: deps.now(),
  });
  await notifyUsers(deps.db, deps.push, deps.now(), [
    {
      userId: guestId,
      title: "Removed",
      body: `${user.name} removed you from ${eventName}`,
      kind: "removed",
      refId: social.id,
      tag: `removed:social:${social.id}:${guestId}`,
    },
  ], circle);
}

export async function removePlanGuest(deps: AppDeps, user: UserRow, rawPlanId: string, rawUserId: string, requested: string | null = null): Promise<void> {
  const planId = parseId(rawPlanId);
  const guestId = parseId(rawUserId);
  const circle = requireCircle(deps, user.id, requested);
  const plan = getPlan(deps.db, planId);
  if (!plan || !planInCircle(deps.db, plan.id, circle.id)) throw new HttpError(404, "plan not found");
  if (guestId === plan.creator_id) throw new HttpError(400, "you made this plan");
  assertEventHost(deps, user, plan.circle_id, plan.creator_id);
  const guest = listPlanAudience(deps.db, plan.id).find((member) => member.id === guestId);
  if (!guest) throw new HttpError(404, "member not found");
  blockPlanGuest(deps.db, plan.id, guestId, deps.now(), user.name);
  recordEventLine(deps.db, {
    circleId: plan.circle_id,
    kind: "plan",
    refId: plan.id,
    hostId: plan.creator_id,
    title: plan.note,
    actorId: user.id,
    text: `${user.name} removed ${guest.name}`,
    now: deps.now(),
  });
  await notifyUsers(deps.db, deps.push, deps.now(), [
    {
      userId: guestId,
      title: "Removed",
      body: `${user.name} removed you from ${plan.note}`,
      kind: "removed",
      refId: plan.id,
      tag: `removed:plan:${plan.id}:${guestId}`,
    },
  ], planCircleForUser(deps.db, plan.id, guestId) ?? circle);
}

function removedMessage(actor: string | null | undefined): string {
  const name = actor?.trim() || "Someone";
  return `${name} removed you from this.`;
}

/** Host of the event, or an admin of its circle. */
function assertEventHost(deps: AppDeps, user: UserRow, circleId: string, hostId: string): void {
  if (user.id === hostId || isCircleAdmin(deps.db, circleId, user.id)) return;
  throw new HttpError(403, "Only the host can do that.");
}

export async function endSocial(deps: AppDeps, user: UserRow, rawId: string, requested: string | null = null): Promise<void> {
  const id = parseId(rawId);
  const circle = requireCircle(deps, user.id, requested);
  const social = getSocial(deps.db, id);
  if (!social || social.circle_id !== circle.id) throw new HttpError(404, "social not found");
  assertEventHost(deps, user, circle.id, social.creator_id);
  closeEventChat(deps.db, circle.id, "social", social.id, deps.now());
  if (!finishSocial(deps.db, social.id, deps.now())) throw new HttpError(404, "social not found");
  const notices = [];
  if (social.creator_id !== user.id) {
    const label = social.note.trim() || "your free post";
    notices.push(endedNotice(social.creator_id, `${user.name} ended ${label}`, "social", social.id));
  }
  const label = social.note.trim() || "Free now";
  for (const id of comingIds(listSocialJoins(deps.db, social.id), [user.id, social.creator_id])) {
    notices.push(endedNotice(id, `${user.name} ended ${label}`, "social", social.id));
  }
  await notifyUsers(deps.db, deps.push, deps.now(), notices, circle);
}

function endedNotice(userId: string, body: string, kind: "social" | "plan", refId: string) {
  return { userId, title: "Ended", body, kind: "ended", refId, tag: `ended:${kind}:${refId}` };
}

/** People who said they're in, minus the given ids. Declined and silent people are left out. */
function comingIds(joins: Array<{ id: string; reply: string | null }>, skip: string[]): string[] {
  return joins.filter((join) => isInReply(join.reply) && !skip.includes(join.id)).map((join) => join.id);
}

export function isInReply(reply: string | null | undefined): boolean {
  return reply === "coming" || reply === "join" || reply === "in";
}

function changeBody(changes: Array<{ name: string; next: string }>): string {
  return changes
    .map((change) => (change.next ? `${change.name} is now ${change.next}.` : `The ${change.name.toLowerCase()} was cleared.`))
    .join(" ");
}

async function pushEdit(
  deps: AppDeps,
  now: number,
  userIds: string[],
  title: string,
  body: string,
  refId: string,
  url: string,
  circle: CircleRow,
): Promise<void> {
  const ids = [...new Set(userIds)];
  if (!ids.length || !body) return;
  await notifyUsers(deps.db, deps.push, now, ids.map((userId) => ({
    userId,
    title,
    body,
    kind: "plan-change",
    refId,
    tag: `plan-change:${refId}`,
    url,
  })), circle);
}

export async function editSocial(deps: AppDeps, user: UserRow, rawId: string, body: Record<string, unknown>, requested: string | null = null) {
  const id = parseId(rawId);
  const circle = requireCircle(deps, user.id, requested);
  const social = getSocial(deps.db, id);
  if (!social || social.circle_id !== circle.id) throw new HttpError(404, "social not found");
  if (social.expires_at <= deps.now()) throw new HttpError(410, "That post has ended.");
  assertEventHost(deps, user, circle.id, social.creator_id);
  // Only plans can live in more than one circle. Say so instead of silently dropping it.
  if (body.circleIds !== undefined) throw new HttpError(400, "Only plans can be shared with other circles.");
  const note = Object.prototype.hasOwnProperty.call(body, "note") ? cleanNote(body.note, false) : social.note;
  const place = Object.prototype.hasOwnProperty.call(body, "place") ? cleanPlace(body.place) : (social.place ?? "");
  let lat = social.lat;
  let lng = social.lng;
  if (Object.prototype.hasOwnProperty.call(body, "lat") || Object.prototype.hasOwnProperty.call(body, "lng")) {
    const point = readPoint(body);
    lat = point?.lat ?? null;
    lng = point?.lng ?? null;
  }
  let startsAt = social.starts_at;
  let remindedAt = social.reminded_at;
  let expiresAt = social.expires_at;
  if (Object.prototype.hasOwnProperty.call(body, "startsAt") || Object.prototype.hasOwnProperty.call(body, "time")) {
    const raw = Object.prototype.hasOwnProperty.call(body, "startsAt") ? body.startsAt : body.time;
    const start = readStart({ startsAt: raw }, deps.now(), deps.config.tz);
    startsAt = start === undefined ? social.starts_at : start;
    const now = deps.now();
    const anchor = startsAt != null && startsAt > now ? startsAt : now;
    expiresAt = anchor + deps.config.socialTtlMs;
    remindedAt = startsAt != null && startsAt > now ? null : now;
  }
  const noteChanged = note !== social.note;
  const placeChanged = place !== (social.place ?? "") || lat !== social.lat || lng !== social.lng;
  const timeChanged = startsAt !== social.starts_at;
  patchSocialDetails(deps.db, social.id, note, place, lat, lng, startsAt, remindedAt, expiresAt);
  const changes = [];
  if (noteChanged) changes.push({ name: "Note", next: note });
  if (timeChanged) changes.push({ name: "Time", next: startsAt == null ? "" : clockLabel(startsAt, deps.config.tz) });
  if (placeChanged) changes.push({ name: "Place", next: place ? audiencePlace(place) : "" });
  if (changes.length) {
    const label = note.trim() || "Free now";
    const coming = listSocialJoins(deps.db, social.id).filter((join) => isInReply(join.reply) && join.id !== user.id && join.id !== social.creator_id);
    await pushEdit(
      deps,
      deps.now(),
      coming.map((join) => join.id),
      `Updated: ${label}`,
      changeBody(changes),
      social.id,
      `/?social=${social.id}`,
      circle,
    );
    if (user.id !== social.creator_id) {
      await pushEdit(
        deps,
        deps.now(),
        [social.creator_id],
        `${user.name} edited your free post: ${label}`,
        changeBody(changes),
        social.id,
        `/?social=${social.id}`,
        circle,
      );
    }
  }
  const fresh = getSocial(deps.db, social.id);
  if (!fresh) throw new HttpError(500, "social missing");
  return socialPayload(deps.db, fresh, user.id, deps.now());
}

export async function endPlan(deps: AppDeps, user: UserRow, rawId: string, requested: string | null = null): Promise<void> {
  const id = parseId(rawId);
  const circle = requireCircle(deps, user.id, requested);
  const plan = getPlan(deps.db, id);
  if (!plan || !planInCircle(deps.db, plan.id, circle.id)) throw new HttpError(404, "plan not found");
  assertEventHost(deps, user, plan.circle_id, plan.creator_id);
  closeEventChat(deps.db, plan.circle_id, "plan", plan.id, deps.now());
  if (!finishPlan(deps.db, plan.id, deps.now())) throw new HttpError(404, "plan not found");
  const notices = [];
  if (plan.creator_id !== user.id) notices.push(endedNotice(plan.creator_id, `${user.name} ended ${plan.note}`, "plan", plan.id));
  for (const id of comingIds(listPlanJoins(deps.db, plan.id), [user.id, plan.creator_id])) {
    notices.push(endedNotice(id, `${user.name} ended ${plan.note}`, "plan", plan.id));
  }
  await notifyUsers(deps.db, deps.push, deps.now(), notices, getCircleById(deps.db, plan.circle_id) ?? circle);
}

export async function editPlan(deps: AppDeps, user: UserRow, rawId: string, body: Record<string, unknown>, requested: string | null = null) {
  const id = parseId(rawId);
  const circle = requireCircle(deps, user.id, requested);
  const plan = getPlan(deps.db, id);
  if (!plan || !planInCircle(deps.db, plan.id, circle.id)) throw new HttpError(404, "plan not found");
  assertEventHost(deps, user, plan.circle_id, plan.creator_id);
  const now = deps.now();
  const today = isoDate(now, deps.config.tz);
  if (plan.ended_at != null || plan.for_date < today) throw new HttpError(410, "That plan has ended.");
  const note = Object.prototype.hasOwnProperty.call(body, "note") ? cleanNote(body.note, true) : plan.note;
  const place = Object.prototype.hasOwnProperty.call(body, "place") ? cleanPlace(body.place) : (plan.place ?? "");
  let lat = plan.lat;
  let lng = plan.lng;
  if (Object.prototype.hasOwnProperty.call(body, "lat") || Object.prototype.hasOwnProperty.call(body, "lng")) {
    const point = readPoint(body);
    lat = point?.lat ?? null;
    lng = point?.lng ?? null;
  }
  let atTime = plan.at_time;
  if (Object.prototype.hasOwnProperty.call(body, "time")) atTime = readClock(body.time);
  const forDate = body.date == null ? plan.for_date : readPlanDate(body.date, today);
  const dateChanged = forDate !== plan.for_date;
  const timeChanged = atTime !== plan.at_time;
  if (dateChanged || timeChanged) assertPlanClock(forDate, atTime, now, deps.config.tz);
  const placeChanged = place !== (plan.place ?? "") || lat !== plan.lat || lng !== plan.lng;
  const description = Object.prototype.hasOwnProperty.call(body, "description")
    ? cleanDescription(body.description)
    : (plan.description ?? "");
  const wantedCircles = body.circleIds === undefined ? null : readPlanCircles(deps, user, plan, body.circleIds);
  const contentChanged = dateChanged || timeChanged || note !== plan.note || place !== (plan.place ?? "")
    || (description || null) !== (plan.description || null);
  patchPlanDetails(deps.db, plan.id, note, place, lat, lng, atTime, forDate, description || null, contentChanged ? now : null);
  // Unlinked circles go first, so a move in the same save does not ping them.
  const kept = wantedCircles ? unlinkDropped(deps, plan.id, wantedCircles) : [];
  // Only a move (day, time, or place) pings people. Note or description edits stay quiet.
  if (dateChanged || timeChanged || placeChanged) {
    const spot = place ? audiencePlace(place) : "";
    const moved = dateChanged || timeChanged;
    const when = `${shortDate(forDate, today)}${atTime ? ` · ${atTime}` : ""}`;
    const title = moved ? `${note} moved to ${when}` : spot ? `${note} moved to ${spot}` : `${note}: place removed`;
    // Every linked circle, once each. People who said they can't come are left out.
    const others = listPlanAudience(deps.db, plan.id).filter((member) =>
      member.id !== user.id && getPlanReply(deps.db, plan.id, member.id)?.reply !== "declined");
    await pushEdit(
      deps,
      now,
      others.map((member) => member.id),
      title,
      moved && spot ? spot : "Tap to see the plan.",
      plan.id,
      `/?plan=${plan.id}`,
      getCircleById(deps.db, plan.circle_id) ?? circle,
    );
  }
  const fresh = getPlan(deps.db, plan.id);
  if (!fresh) throw new HttpError(500, "plan missing");
  if (wantedCircles) await linkAdded(deps, user, fresh, kept, wantedCircles, now, today);
  return planPayload(deps.db, fresh, today, user.id, deps.now());
}

/** circleIds is the full set. Creator only, their own circles only. The home circle always stays. */
function readPlanCircles(deps: AppDeps, user: UserRow, plan: PlanRow, raw: unknown): string[] {
  if (plan.creator_id !== user.id) throw new HttpError(403, "Only the host can do that.");
  if (!Array.isArray(raw) || raw.length > 20 || raw.some((id) => typeof id !== "string")) {
    throw new HttpError(400, "circleIds must be a list of circles");
  }
  const mine = new Set(listCirclesForUser(deps.db, user.id).map((item) => item.id));
  const wanted = new Set<string>([plan.circle_id]);
  for (const id of raw as string[]) {
    if (id === plan.circle_id) continue;
    if (!mine.has(id)) throw new HttpError(400, "You can only share with your own circles.");
    wanted.add(id);
  }
  return [...wanted];
}

/** Drops links not in the wanted set. No push. Returns the links that stay. */
function unlinkDropped(deps: AppDeps, planId: string, wanted: string[]): string[] {
  const before = listPlanCircleIds(deps.db, planId);
  for (const id of before) if (!wanted.includes(id)) unlinkPlanCircle(deps.db, planId, id);
  return before.filter((id) => wanted.includes(id));
}

/** Links new circles and sends each one the new-plan push once. The circles it was already in hear nothing. */
async function linkAdded(deps: AppDeps, user: UserRow, plan: PlanRow, kept: string[], wanted: string[], now: number, today: string): Promise<void> {
  const added = wanted.filter((id) => !kept.includes(id));
  if (!added.length) return;
  // Anyone who could already see it is skipped, so no one hears about it twice.
  const told = new Set<string>([user.id]);
  for (const id of kept) for (const member of listMembers(deps.db, id)) told.add(member.id);
  for (const id of added) {
    linkPlanCircle(deps.db, plan.id, id, now);
    const target = getCircleById(deps.db, id);
    if (!target) continue;
    const fresh = listMembers(deps.db, id).filter((member) => !told.has(member.id));
    for (const member of fresh) told.add(member.id);
    await notifyUsers(deps.db, deps.push, now, fresh.map((member) => ({
      userId: member.id,
      ...newPlanNotice(plan, user.name, today),
    })), target);
  }
}
