import http from "node:http";
import type { AppDeps } from "../app.js";
import {
  type CalendarContext,
  feedCalendar,
  feedOwner,
  feedStatus,
  issueFeed,
  revokeFeed,
  uidHost,
} from "./calendar.js";
import {
  CalendarError,
  circleAvailability,
  connectCalendar,
  connectGoogle,
  disconnectCalendar,
  isConnected,
  ownDayEvents,
  ownFriendView,
  setSharedCircles,
  syncStatus,
  syncUser,
} from "./freebusy.js";
import { consumeGoogleState, googleEnabled, startGoogleAuth } from "./google-calendar.js";
import {
  type CircleRow,
  type PlanRow,
  type SocialRow,
  type UserRow,
  listCirclesForUser,
  listPlansOnDays,
  listSocialsStartedBetween,
} from "../db.js";
import type { AuthedRouteContext, Limits, RouteContext } from "../lib/context.js";
import { HttpError, requestOrigin, safeDecode, sendEmpty, sendJson } from "../lib/http.js";
import { addDays, daysBetween, isCalendarDate, isoDate, zonedDateTime } from "../lib/time.js";
import { isAllCircles } from "../lib/validate.js";
import { requireCircle } from "../social/circles.js";
import { planPayload, socialPayload } from "../social/payload.js";
import { visibleEvents } from "../social/visibility.js";

export async function handleGoogleCallbackRoute(ctx: RouteContext): Promise<boolean> {
  const { req, res, deps, url, method, pathname } = ctx;
  if (method === "GET" && pathname === "/api/calendar/google/callback") {
    await handleGoogleCallback(req, res, deps, url);
    return true;
  }
  return false;
}

export async function handleCalendarMonthRoute(ctx: AuthedRouteContext): Promise<boolean> {
  const { res, deps, url, method, pathname, requested, me } = ctx;
  if (method === "GET" && pathname === "/api/calendar-month") {
    const range = readCalendarRange(url);
    const circles = isAllCircles(method, pathname, url)
      ? listCirclesForUser(deps.db, me.id)
      : [requireCircle(deps, me.id, requested)];
    sendJson(res, 200, calendarMonth(deps, circles, range, me.id));
    return true;
  }
  return false;
}

export async function handleCalendarRoutes(ctx: AuthedRouteContext): Promise<boolean> {
  const { req, res, deps, limits, url, method, pathname, body, requested, me } = ctx;
  if (pathname === "/api/me/calendar-feed") {
    if (method === "GET") {
      sendJson(res, 200, feedStatus(deps.db, me.id));
      return true;
    }
    if (method === "POST") {
      sendJson(res, 201, issueFeed(deps.db, me.id, requestOrigin(req, deps.config), deps.now()));
      return true;
    }
    if (method === "DELETE") {
      revokeFeed(deps.db, me.id);
      sendEmpty(res, 204);
      return true;
    }
    throw new HttpError(405, "method not allowed");
  }

  if (method === "GET" && pathname === "/api/calendar/google/start") {
    if (!googleEnabled(deps.config)) throw new HttpError(404, "not found");
    if (!limits.calendarSync.hit(`calendar-sync:${me.id}`, deps.now())) throw new HttpError(429, "Too many tries. Wait a minute.");
    sendJson(res, 200, { url: startGoogleAuth(deps.db, deps.config, me.id, requestOrigin(req, deps.config), deps.now()) });
    return true;
  }

  if (pathname.startsWith("/api/me/calendar-sync")) {
    await handleCalendarSync(req, res, deps, limits, method, pathname, url, body, me);
    return true;
  }

  if (method === "GET" && pathname === "/api/circles/availability") {
    const circle = requireCircle(deps, me.id, requested);
    const now = deps.now();
    const raw = url.searchParams.get("at");
    const at = raw == null || raw === "" ? now : Number(raw);
    if (!Number.isFinite(at) || at < now - 60 * 60 * 1000 || at > now + 30 * 24 * 60 * 60 * 1000) {
      throw new HttpError(400, "at must be a time in the next 30 days");
    }
    const seen = circleAvailability(deps.db, circle.id, me.id, Math.round(at), now);
    const people = [...seen].filter(([id, value]) => id !== me.id && value).map(([id, value]) => ({ id, ...value! }));
    sendJson(res, 200, { at: Math.round(at), people });
    return true;
  }
  return false;
}

/** A month grid is at most 6 weeks; a little slack, never a dump of every event. */
export const CALENDAR_MAX_DAYS = 62;
/** Per kind. A busy month is a few dozen, so this only stops a runaway answer. */
export const CALENDAR_MAX_EVENTS = 500;

function readCalendarRange(url: URL): { from: string; to: string } {
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  if (!isCalendarDate(from) || !isCalendarDate(to)) throw new HttpError(400, "from and to are required");
  const span = daysBetween(from, to);
  if (span < 0 || span >= CALENDAR_MAX_DAYS) throw new HttpError(400, "pick a shorter range");
  return { from, to };
}

/**
 * Every plan (by for_date) and social (by the app-timezone day it started) in [from, to],
 * across `circles`, ended ones included. Each event once, with its home circle.
 */
function calendarMonth(deps: AppDeps, circles: CircleRow[], range: { from: string; to: string }, viewerId: string) {
  const tz = deps.config.tz;
  const today = isoDate(deps.now(), tz);
  const plans = new Map<string, PlanRow>();
  const socials = new Map<string, SocialRow>();
  // A day of slack each side, then the exact day in the app timezone decides.
  const fromMs = zonedDateTime(addDays(range.from, -1), "00:00", tz);
  const toMs = zonedDateTime(addDays(range.to, 2), "00:00", tz);
  for (const circle of circles) {
    for (const row of visibleEvents(deps.db, "plan", listPlansOnDays(deps.db, circle.id, range.from, range.to), viewerId)) if (!plans.has(row.id)) plans.set(row.id, row);
    for (const row of visibleEvents(deps.db, "social", listSocialsStartedBetween(deps.db, circle.id, fromMs, toMs), viewerId)) {
      const day = isoDate(row.starts_at ?? row.created_at, tz);
      if (day >= range.from && day <= range.to && !socials.has(row.id)) socials.set(row.id, row);
    }
  }
  const planList = [...plans.values()]
    .sort((a, b) =>
      a.for_date.localeCompare(b.for_date) ||
      Number(a.at_time == null) - Number(b.at_time == null) ||
      (a.at_time ?? "").localeCompare(b.at_time ?? "") ||
      a.created_at - b.created_at,
    )
    .slice(0, CALENDAR_MAX_EVENTS)
    .map((row) => ({ ...planPayload(deps.db, row, today, viewerId), endedAt: row.ended_at ?? null }));
  const socialList = [...socials.values()]
    .sort((a, b) => (a.starts_at ?? a.created_at) - (b.starts_at ?? b.created_at))
    .slice(0, CALENDAR_MAX_EVENTS)
    .map((row) => ({ ...socialPayload(deps.db, row, viewerId), day: isoDate(row.starts_at ?? row.created_at, tz) }));
  return { from: range.from, to: range.to, today, plans: planList, socials: socialList };
}

/**
 * /api/me/calendar-sync: the availability import for the signed-in person.
 * GET status, PUT or POST {url} to connect or replace, PATCH {sharedCircleIds}, DELETE to remove,
 * POST /refresh to sync now, GET /day?date=YYYY-MM-DD for their own titles (owner only).
 */
async function handleCalendarSync(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: AppDeps,
  limits: Limits,
  method: string,
  pathname: string,
  url: URL,
  body: Record<string, unknown>,
  me: UserRow,
): Promise<void> {
  const fb = { db: deps.db, config: deps.config, now: deps.now, calendarNet: deps.calendarNet };
  const limit = () => {
    if (!limits.calendarSync.hit(`calendar-sync:${me.id}`, deps.now())) throw new HttpError(429, "Too many tries. Wait a minute.");
  };
  const asHttp = (error: unknown): never => {
    if (error instanceof CalendarError) throw new HttpError(400, error.message);
    throw error;
  };
  if (pathname === "/api/me/calendar-sync") {
    if (method === "GET") {
      sendJson(res, 200, syncStatus(deps.db, me.id, deps.config));
      return;
    }
    if (method === "PUT" || method === "POST") {
      limit();
      await connectCalendar(fb, me.id, body.url).catch(asHttp);
      sendJson(res, 200, syncStatus(deps.db, me.id, deps.config));
      return;
    }
    if (method === "PATCH") {
      if (!isConnected(deps.db, me.id)) throw new HttpError(409, "Connect a calendar first.");
      try {
        setSharedCircles(deps.db, me.id, body.sharedCircleIds);
      } catch (error) {
        asHttp(error);
      }
      sendJson(res, 200, syncStatus(deps.db, me.id, deps.config));
      return;
    }
    if (method === "DELETE") {
      await disconnectCalendar(fb, me.id);
      sendJson(res, 200, syncStatus(deps.db, me.id, deps.config));
      return;
    }
    throw new HttpError(405, "method not allowed");
  }
  if (pathname === "/api/me/calendar-sync/refresh" && method === "POST") {
    if (!isConnected(deps.db, me.id)) throw new HttpError(409, "Connect a calendar first.");
    limit();
    await syncUser(fb, me.id);
    sendJson(res, 200, syncStatus(deps.db, me.id, deps.config));
    return;
  }
  if (pathname === "/api/me/calendar-sync/preview" && method === "GET") {
    // What friends see of the signed-in owner's own busy times. Busy spans only, never titles.
    const now = deps.now();
    sendJson(res, 200, { now, ...ownFriendView(deps.db, me.id, now) });
    return;
  }
  if (pathname === "/api/me/calendar-sync/day" && method === "GET") {
    const day = url.searchParams.get("date") ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !isCalendarDate(day)) throw new HttpError(400, "date must be YYYY-MM-DD");
    const connected = isConnected(deps.db, me.id);
    // Titles for the signed-in owner only. sendJson already sends cache-control: no-store.
    sendJson(res, 200, { connected, date: day, events: connected ? ownDayEvents(deps.db, deps.config, me.id, day) : [] });
    return;
  }
  throw new HttpError(404, "not found");
}

/**
 * Google sends the browser back here. No session: the stored one-time state says who started it.
 * Always lands on /?calendar=google or /?calendar=google-error, with nothing secret in the URL.
 */
async function handleGoogleCallback(req: http.IncomingMessage, res: http.ServerResponse, deps: AppDeps, url: URL): Promise<void> {
  if (!googleEnabled(deps.config)) throw new HttpError(404, "not found");
  const origin = requestOrigin(req, deps.config);
  const code = url.searchParams.get("code") ?? "";
  const pending = consumeGoogleState(deps.db, url.searchParams.get("state") ?? "", deps.now());
  let ok = false;
  if (pending && code && code.length <= 2048 && !url.searchParams.get("error")) {
    const fb = { db: deps.db, config: deps.config, now: deps.now, calendarNet: deps.calendarNet };
    try {
      await connectGoogle(fb, pending.userId, code, pending.verifier, origin);
      ok = true;
    } catch (error) {
      console.log(`google calendar connect failed reason="${error instanceof Error ? error.message : "unknown"}"`);
    }
  }
  res.writeHead(302, {
    location: `${origin}/?calendar=${ok ? "google" : "google-error"}`,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  res.end();
}

export function calendarContext(req: http.IncomingMessage, deps: AppDeps): CalendarContext {
  return {
    db: deps.db,
    tz: deps.config.tz,
    now: deps.now(),
    origin: requestOrigin(req, deps.config),
    uidHost: uidHost(deps.config.publicBaseUrl),
  };
}

/** The subscribed feed. An unknown or revoked token is a bare 404 that says nothing about why. */
export function serveFeed(req: http.IncomingMessage, res: http.ServerResponse, deps: AppDeps, rawToken: string): void {
  const owner = feedOwner(deps.db, safeDecode(rawToken));
  if (!owner) {
    sendEmpty(res, 404);
    return;
  }
  sendCalendar(res, feedCalendar(calendarContext(req, deps), owner), null, req.method === "HEAD");
}

export function sendCalendar(res: http.ServerResponse, body: string, fileName: string | null, headOnly = false): void {
  const data = Buffer.from(body, "utf8");
  res.writeHead(200, {
    "content-type": "text/calendar; charset=utf-8",
    "content-length": data.length,
    ...(fileName ? { "content-disposition": `attachment; filename="${fileName}"` } : {}),
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex",
  });
  if (headOnly) res.end();
  else res.end(data);
}

function feedSegment(rawUrl: string | undefined): string | null {
  let pathname: string;
  try {
    pathname = new URL(rawUrl ?? "/", "http://localhost").pathname;
  } catch {
    return null;
  }
  const match = /^\/cal\/(.*)$/i.exec(pathname);
  return match ? match[1].replace(/\.ics$/i, "") : null;
}

export function isFeedPath(rawUrl: string | undefined): boolean {
  return feedSegment(rawUrl) !== null;
}

/** Drops the feed token (raw, normalized, or decoded, or as any /cal/ path) from a log line. */
export function redactFeedToken(text: string, rawUrl: string | undefined): string {
  let out = text;
  const raw = /^\/cal\/([^?#]*)/i.exec(rawUrl ?? "")?.[1]?.replace(/\.ics$/i, "") ?? "";
  const parsed = feedSegment(rawUrl) ?? "";
  const secrets = new Set([raw, parsed, safeDecode(raw), safeDecode(parsed)]);
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret.length >= 8) out = out.split(secret).join("[token]");
  }
  return out.replace(/\/cal\/[^\s/?#"'<>]+/gi, "/cal/[token]");
}
