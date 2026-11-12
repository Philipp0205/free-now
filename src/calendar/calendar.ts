import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  deleteCalendarFeed,
  getCalendarFeed,
  getPlan,
  getPlanReply,
  getUserByFeedHash,
  listFeedPlans,
  planCircleForUser,
  setCalendarFeed,
  type PlanRow,
  type UserRow,
} from "../db.js";
import { buildCalendar, type IcsEvent, type IcsStatus, type IcsWhen } from "./ics.js";
import { addDays, clockLabel, isoDate, zonedDateTime } from "../lib/time.js";
import { HttpError, parseId } from "../app.js";
import { isOpenPlan } from "../social/plan-share.js";

/** A plan with a time lasts this long in a calendar. Hangry has no end time. */
export const DEFAULT_DURATION_MS = 2 * 60 * 60 * 1000;
/** The feed keeps this many days of past plans. */
export const FEED_PAST_DAYS = 30;
/** At most this many events in one feed. */
export const FEED_MAX_EVENTS = 200;
/** Feed fetches per client. Calendar servers share addresses, so this is loose. */
export const FEED_LIMIT = { limit: 120, windowMs: 60_000 };
export const FEED_NAME = "Hangry";

export type CalendarContext = {
  db: DatabaseSync;
  tz: string;
  now: number;
  /** https://example.com, no trailing slash. Used for the app link. */
  origin: string;
  /** The part after @ in every UID. Same for the single file and the feed. */
  uidHost: string;
};

/** Hostname of PUBLIC_BASE_URL, or "hangry" when unset. */
export function uidHost(publicBaseUrl: string | null | undefined): string {
  if (!publicBaseUrl) return "hangry";
  try {
    return new URL(publicBaseUrl).hostname || "hangry";
  } catch {
    return "hangry";
  }
}

export function planUid(planId: string, host: string): string {
  return `${planId}@${host}`;
}

/** 0 until the first change, then seconds since creation. Grows with every later change. */
export function planSequence(plan: Pick<PlanRow, "created_at" | "updated_at">): number {
  if (plan.updated_at == null) return 0;
  return Math.max(1, Math.ceil((plan.updated_at - plan.created_at) / 1000));
}

/** Ended is CANCELLED. Host or in is CONFIRMED. Anything else (maybe, no answer) is TENTATIVE. */
export function planStatus(plan: Pick<PlanRow, "ended_at" | "creator_id">, viewerId: string, reply: string | null): IcsStatus {
  if (plan.ended_at != null) return "CANCELLED";
  if (plan.creator_id === viewerId || reply === "coming") return "CONFIRMED";
  return "TENTATIVE";
}

/**
 * A time is a UTC start in APP_TZ plus the default length. No time (TBD) is an all-day event.
 * Uses the app's own zonedDateTime: a fall-back time is the first occurrence, a
 * spring-forward time that does not exist moves ahead by the gap (02:30 to 03:30).
 */
export function planWhen(plan: Pick<PlanRow, "for_date" | "at_time">, tz: string): IcsWhen {
  if (!plan.at_time) return { kind: "day", day: plan.for_date };
  const startMs = zonedDateTime(plan.for_date, plan.at_time, tz);
  return { kind: "timed", startMs, endMs: startMs + DEFAULT_DURATION_MS };
}

export function planAppUrl(origin: string, planId: string): string {
  return `${origin}/?plan=${planId}`;
}

export const DURATION_NOTE = "Hangry plans have no end time, so this shows 2 hours.";

/**
 * A note when the plan's clock time does not exist on that day (spring forward).
 * Found by turning the start back into a wall time in APP_TZ and comparing.
 */
export function gapNote(plan: Pick<PlanRow, "at_time">, when: IcsWhen, tz: string): string | null {
  if (!plan.at_time || when.kind !== "timed") return null;
  const shown = clockLabel(when.startMs, tz);
  if (shown === plan.at_time) return null;
  return `Planned for ${plan.at_time}, a time that does not exist on this day because clocks move forward. Shown at ${shown}.`;
}

/**
 * Host, the plan's own description, time notes, then the app link.
 * No other names, chat, or share links.
 */
export function planDescription(
  plan: Pick<PlanRow, "creator_name" | "description" | "for_date" | "at_time">,
  link: string,
  tz: string,
): string {
  const parts = [`Hosted by ${plan.creator_name}`];
  const text = (plan.description ?? "").trim();
  if (text) parts.push(text);
  const when = planWhen(plan, tz);
  if (when.kind === "timed") {
    const gap = gapNote(plan, when, tz);
    parts.push(gap ? `${gap}\n${DURATION_NOTE}` : DURATION_NOTE);
  }
  parts.push(`Hangry: ${link}`);
  return parts.join("\n\n");
}

export function planEvent(ctx: CalendarContext, plan: PlanRow, viewerId: string, reply: string | null): IcsEvent {
  const link = planAppUrl(ctx.origin, plan.id);
  return {
    uid: planUid(plan.id, ctx.uidHost),
    dtstamp: ctx.now,
    sequence: planSequence(plan),
    lastModified: plan.updated_at ?? plan.created_at,
    summary: plan.note,
    description: planDescription(plan, link, ctx.tz),
    location: (plan.place ?? "").trim(),
    url: link,
    status: planStatus(plan, viewerId, reply),
    when: planWhen(plan, ctx.tz),
  };
}

/** The live reply that counts for a calendar: coming or maybe, never a blocked row. */
function liveReply(db: DatabaseSync, planId: string, userId: string): string | null {
  const row = getPlanReply(db, planId, userId);
  if (!row || row.blocked) return null;
  return row.reply;
}

/** One plan as a file. Only someone who can see it now. A removed guest gets 404 like a stranger. */
export function planCalendarFile(ctx: CalendarContext, viewer: UserRow, rawId: string): { body: string; plan: PlanRow } {
  const plan = getPlan(ctx.db, parseId(rawId));
  if (!plan || !planCircleForUser(ctx.db, plan.id, viewer.id)) throw new HttpError(404, "plan not found");
  if (getPlanReply(ctx.db, plan.id, viewer.id)?.blocked) throw new HttpError(404, "plan not found");
  if (!isOpenPlan(plan, isoDate(ctx.now, ctx.tz))) throw new HttpError(410, "That plan has ended.");
  const event = planEvent(ctx, plan, viewer.id, liveReply(ctx.db, plan.id, viewer.id));
  return { body: buildCalendar({ tz: ctx.tz, events: [event] }), plan };
}

/** The subscribed feed: 30 days back, everything ahead, at most 200 events. */
export function feedCalendar(ctx: CalendarContext, viewer: UserRow): string {
  const today = isoDate(ctx.now, ctx.tz);
  const plans = listFeedPlans(ctx.db, viewer.id, addDays(today, -FEED_PAST_DAYS), today, FEED_MAX_EVENTS);
  const events = plans.map((plan) => planEvent(ctx, plan, viewer.id, liveReply(ctx.db, plan.id, viewer.id)));
  return buildCalendar({ name: FEED_NAME, tz: ctx.tz, events });
}

/** A file name from the plan title: letters, digits, and dashes. */
export function calendarFileName(note: string): string {
  const slug = note
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return `${slug || "hangry-plan"}.ics`;
}

const FEED_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function newFeedToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function feedTokenHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** The person behind a feed token, or undefined for anything unknown, revoked, or malformed. */
export function feedOwner(db: DatabaseSync, token: string): UserRow | undefined {
  if (!FEED_TOKEN_RE.test(token)) return undefined;
  return getUserByFeedHash(db, feedTokenHash(token));
}

export function feedUrls(origin: string, token: string): { url: string; webcalUrl: string } {
  const url = `${origin}/cal/${token}.ics`;
  return { url, webcalUrl: url.replace(/^https?:\/\//i, "webcal://") };
}

export function feedStatus(db: DatabaseSync, userId: string): { active: boolean; createdAt: number | null } {
  const row = getCalendarFeed(db, userId);
  return { active: Boolean(row), createdAt: row?.created_at ?? null };
}

/** Makes or replaces the token. The plain token leaves the server only in this answer. */
export function issueFeed(db: DatabaseSync, userId: string, origin: string, now: number) {
  const token = newFeedToken();
  setCalendarFeed(db, userId, feedTokenHash(token), now);
  return { active: true, createdAt: now, ...feedUrls(origin, token) };
}

export function revokeFeed(db: DatabaseSync, userId: string): void {
  deleteCalendarFeed(db, userId);
}
