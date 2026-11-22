import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AppDeps } from "../app.js";
import { calendarFileName, planCalendarFile } from "../calendar/calendar.js";
import { calendarContext, sendCalendar } from "../calendar/routes.js";
import {
  type PlanRow,
  type SocialRow,
  clearPlanShareId,
  getPlan,
  listActiveSocials,
  listCirclesForUser,
  listVisiblePlans,
  planInCircle,
} from "../db.js";
import type { AuthedRouteContext } from "../lib/context.js";
import { HttpError, matchPath, requestOrigin, safeDecode, sendEmpty, sendJson } from "../lib/http.js";
import { PUBLIC_DIR, staticHeaders } from "../lib/static.js";
import { addDays, isoDate } from "../lib/time.js";
import { readEnd } from "../lib/end-time.js";
import {
  cleanDescription,
  cleanNote,
  cleanPlace,
  isAllCircles,
  parseId,
  readClock,
  readCardColor,
  readPlace,
  readPoint,
  readStart,
} from "../lib/validate.js";
import { loadBills } from "./bills.js";
import { requireCircle } from "./circles.js";
import {
  editPlan,
  editSocial,
  endPlan,
  endSocial,
  joinSocial,
  leavePlan,
  leaveSocial,
  markPaid,
  removePlanGuest,
  removeSocialGuest,
} from "./events.js";
import { handleLive } from "./live.js";
import { planPayload, socialPayload } from "./payload.js";
import { ensureShareId, isOpenPlan, openSharedPlan, shareHtml, shareMeta } from "./plan-share.js";
import { PLAN_DAYS_AHEAD, joinPlan, publishPlan, remindPlan, replyPlan } from "./plans.js";
import { publishSocial, replySocial } from "./socials.js";
import { canSeeEvent, visibleEvents } from "./visibility.js";

export async function handleSocialRoutes(ctx: AuthedRouteContext): Promise<boolean> {
  const { res, deps, url, method, pathname, body, requested, me } = ctx;
  if (method === "GET" && pathname === "/api/bills") {
    const now = deps.now();
    sendJson(res, 200, loadBills(deps.db, me.id, now, isoDate(now, deps.config.tz), deps.config.tz));
    return true;
  }

  if (method === "GET" && pathname === "/api/socials" && isAllCircles(method, pathname, url)) {
    const now = deps.now();
    const merged = new Map<string, SocialRow>();
    for (const circle of listCirclesForUser(deps.db, me.id)) {
      for (const row of visibleEvents(deps.db, "social", listActiveSocials(deps.db, circle.id, now), me.id)) merged.set(row.id, row);
    }
    const socials = [...merged.values()]
      .sort((a, b) => b.created_at - a.created_at)
      .map((row) => socialPayload(deps.db, row, me.id, now));
    sendJson(res, 200, { socials });
    return true;
  }

  if (method === "GET" && pathname === "/api/socials") {
    const circle = requireCircle(deps, me.id, requested);
    const socials = visibleEvents(deps.db, "social", listActiveSocials(deps.db, circle.id, deps.now()), me.id)
      .map((row) => socialPayload(deps.db, row, me.id, deps.now()));
    sendJson(res, 200, { socials });
    return true;
  }

  if (method === "POST" && pathname === "/api/socials") {
    const note = cleanNote(body.note, false);
    const result = await publishSocial(deps, me, note, readPoint(body), readPlace(body), readStart(body, deps.now(), deps.config.tz), requested, readEnd(body), body.invitees);
    sendJson(res, result.created ? 201 : 200, { social: result.social });
    return true;
  }

  const socialPerson = matchPath(pathname, /^\/api\/socials\/([^/]+)\/people\/([^/]+)$/);
  if (socialPerson && method === "DELETE") {
    await removeSocialGuest(deps, me, socialPerson[1], socialPerson[2], requested);
    sendEmpty(res, 204);
    return true;
  }

  const socialReply = matchPath(pathname, /^\/api\/socials\/([^/]+)\/reply$/);
  if (socialReply && method === "POST") {
    sendJson(res, 200, { social: await replySocial(deps, me, socialReply[1], body, requested) });
    return true;
  }

  const socialPaid = matchPath(pathname, /^\/api\/socials\/([^/]+)\/paid$/);
  if (socialPaid && method === "POST") {
    sendJson(res, 200, { social: markPaid(deps, me, "social", socialPaid[1], body, requested) });
    return true;
  }

  const socialJoin = matchPath(pathname, /^\/api\/socials\/([^/]+)\/join$/);
  if (socialJoin && method === "POST") {
    sendJson(res, 200, { social: await joinSocial(deps, me, socialJoin[1], requested) });
    return true;
  }

  const socialLeave = matchPath(pathname, /^\/api\/socials\/([^/]+)\/leave$/);
  if (socialLeave && method === "POST") {
    sendJson(res, 200, { social: leaveSocial(deps, me, socialLeave[1], requested) });
    return true;
  }

  const socialLive = matchPath(pathname, /^\/api\/socials\/([^/]+)\/live$/);
  if (socialLive && (await handleLive(ctx, "social", socialLive[1]))) return true;

  const socialId = matchPath(pathname, /^\/api\/socials\/([^/]+)$/);
  if (socialId && method === "PATCH") {
    sendJson(res, 200, { social: await editSocial(deps, me, socialId[1], body, requested) });
    return true;
  }
  if (socialId && method === "DELETE") {
    await endSocial(deps, me, socialId[1], requested);
    sendEmpty(res, 204);
    return true;
  }
  return false;
}

export async function handlePlanRoutes(ctx: AuthedRouteContext): Promise<boolean> {
  const { req, res, deps, url, method, pathname, body, requested, me } = ctx;
  if (method === "GET" && pathname === "/api/plans" && isAllCircles(method, pathname, url)) {
    const today = isoDate(deps.now(), deps.config.tz);
    const through = addDays(today, PLAN_DAYS_AHEAD);
    const merged = new Map<string, PlanRow>();
    for (const circle of listCirclesForUser(deps.db, me.id)) {
      for (const row of visibleEvents(deps.db, "plan", listVisiblePlans(deps.db, circle.id, today, through, deps.now()), me.id)) if (!merged.has(row.id)) merged.set(row.id, row);
    }
    const plans = [...merged.values()]
      .sort((a, b) =>
        a.for_date.localeCompare(b.for_date) ||
        Number(a.at_time == null) - Number(b.at_time == null) ||
        (a.at_time ?? "").localeCompare(b.at_time ?? "") ||
        a.created_at - b.created_at,
      )
      .map((row) => planPayload(deps.db, row, today, me.id, deps.now()));
    sendJson(res, 200, { plans });
    return true;
  }

  if (method === "GET" && pathname === "/api/plans") {
    const circle = requireCircle(deps, me.id, requested);
    const now = deps.now();
    const today = isoDate(now, deps.config.tz);
    const visible = listVisiblePlans(deps.db, circle.id, today, addDays(today, PLAN_DAYS_AHEAD), now);
    const plans = visibleEvents(deps.db, "plan", visible, me.id).map((row) =>
      planPayload(deps.db, row, today, me.id, deps.now()),
    );
    sendJson(res, 200, { plans });
    return true;
  }

  if (method === "POST" && pathname === "/api/plans") {
    const note = cleanNote(body.note, true);
    const place = cleanPlace(body.place);
    const time = Object.prototype.hasOwnProperty.call(body, "time") ? readClock(body.time) : null;
    const description = cleanDescription(body.description);
    const cardColor = readCardColor(body.cardColor);
    sendJson(res, 201, { plan: await publishPlan(deps, me, note, place, readPoint(body), time, requested, body.date, description, cardColor, readEnd(body), body.invitees) });
    return true;
  }

  const planPerson = matchPath(pathname, /^\/api\/plans\/([^/]+)\/people\/([^/]+)$/);
  if (planPerson && method === "DELETE") {
    await removePlanGuest(deps, me, planPerson[1], planPerson[2], requested);
    sendEmpty(res, 204);
    return true;
  }

  const planReply = matchPath(pathname, /^\/api\/plans\/([^/]+)\/reply$/);
  if (planReply && method === "POST") {
    sendJson(res, 200, { plan: await replyPlan(deps, me, planReply[1], body, requested) });
    return true;
  }

  const planPaid = matchPath(pathname, /^\/api\/plans\/([^/]+)\/paid$/);
  if (planPaid && method === "POST") {
    sendJson(res, 200, { plan: markPaid(deps, me, "plan", planPaid[1], body, requested) });
    return true;
  }

  const planJoin = matchPath(pathname, /^\/api\/plans\/([^/]+)\/join$/);
  if (planJoin && method === "POST") {
    sendJson(res, 200, { plan: await joinPlan(deps, me, planJoin[1], requested) });
    return true;
  }

  const planLeave = matchPath(pathname, /^\/api\/plans\/([^/]+)\/leave$/);
  if (planLeave && method === "POST") {
    sendJson(res, 200, { plan: leavePlan(deps, me, planLeave[1], requested) });
    return true;
  }

  const planLive = matchPath(pathname, /^\/api\/plans\/([^/]+)\/live$/);
  if (planLive && (await handleLive(ctx, "plan", planLive[1]))) return true;

  const planRemind = matchPath(pathname, /^\/api\/plans\/([^/]+)\/remind$/);
  if (planRemind && method === "POST") {
    sendJson(res, 200, await remindPlan(deps, me, planRemind[1], requested));
    return true;
  }

  const planIcs = matchPath(pathname, /^\/api\/plans\/([^/]+)\/calendar\.ics$/);
  if (planIcs && method === "GET") {
    const file = planCalendarFile(calendarContext(req, deps), me, planIcs[1]);
    sendCalendar(res, file.body, calendarFileName(file.plan.note));
    return true;
  }
  return false;
}

export async function handlePlanShareRoutes(ctx: AuthedRouteContext): Promise<boolean> {
  const { req, res, deps, method, pathname, body, requested, me } = ctx;
  const planShare = matchPath(pathname, /^\/api\/plans\/([^/]+)\/share$/);
  if (planShare && method === "POST") {
    const circle = requireCircle(deps, me.id, requested);
    const plan = getPlan(deps.db, parseId(planShare[1]));
    if (!plan || !planInCircle(deps.db, plan.id, circle.id) || !canSeeEvent(deps.db, "plan", plan, me.id)) throw new HttpError(404, "plan not found");
    if (!isOpenPlan(plan, isoDate(deps.now(), deps.config.tz), deps.now())) throw new HttpError(410, "That plan has ended.");
    const shareId = ensureShareId(deps.db, plan.id);
    sendJson(res, 200, { shareId, url: `${requestOrigin(req, deps.config)}/p/${shareId}` });
    return true;
  }

  if (planShare && method === "DELETE") {
    const circle = requireCircle(deps, me.id, requested);
    const plan = getPlan(deps.db, parseId(planShare[1]));
    if (!plan || !planInCircle(deps.db, plan.id, circle.id) || !canSeeEvent(deps.db, "plan", plan, me.id)) throw new HttpError(404, "plan not found");
    if (plan.creator_id !== me.id) throw new HttpError(403, "Only the host can stop sharing.");
    clearPlanShareId(deps.db, plan.id);
    sendJson(res, 200, { ok: true });
    return true;
  }

  const planId = matchPath(pathname, /^\/api\/plans\/([^/]+)$/);
  if (planId && method === "PATCH") {
    sendJson(res, 200, { plan: await editPlan(deps, me, planId[1], body, requested) });
    return true;
  }
  if (planId && method === "DELETE") {
    await endPlan(deps, me, planId[1], requested);
    sendEmpty(res, 204);
    return true;
  }
  return false;
}

/** index.html with Open Graph tags: the note, then day and time. Nothing else about the plan. */
export async function serveSharePage(req: http.IncomingMessage, res: http.ServerResponse, deps: AppDeps, rawId: string): Promise<void> {
  const shareId = safeDecode(rawId);
  const today = isoDate(deps.now(), deps.config.tz);
  const plan = openSharedPlan(deps.db, shareId, today, deps.now());
  const origin = requestOrigin(req, deps.config);
  const template = await fs.promises.readFile(path.join(PUBLIC_DIR, "index.html"), "utf8");
  const html = shareHtml(template, shareMeta(plan, today), `${origin}/p/${encodeURIComponent(shareId)}`, origin);
  const data = Buffer.from(html, "utf8");
  res.writeHead(200, {
    ...staticHeaders(".html", data.length),
    "cache-control": "no-store",
    "x-robots-tag": "noindex",
  });
  if (req.method === "HEAD") res.end();
  else res.end(data);
}
