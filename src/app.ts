import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import {
  AdminQueryFailed,
  AdminQueryTimeout,
  adminFailureKey,
  adminFailuresOpen,
  adminTokensMatch,
  bearerToken,
  clearAdminFailures,
  noteAdminFailure,
  readSchema,
  runReadQuery,
} from "./admin-query.js";
import type { Config } from "./config.js";
import {
  addMember,
  addSocialJoin,
  blockPlanGuest,
  blockSocialGuest,
  clearRemoval,
  removalBlocksJoin,
  deleteCircle,
  deletePushSubForUser,
  finishPlan,
  finishSocial,
  listPastPlans,
  listPastSocials,
  getCircleByCode,
  getCircleById,
  getUserById,
  listCirclesForUser,
  isCircleAdmin,
  kickMember,
  getPlan,
  getPlanReply,
  getSocial,
  getSocialReply,
  getUserByBuzzToken,
  getUserByTokenHash,
  hasSocialJoin,
  insertCircle,
  patchPlanDetails,
  patchSocialDetails,
  insertUser,
  listActiveSocials,
  listMembers,
  setCircleAdmin,
  listNotifications,
  listPlanJoins,
  listPushSubs,
  listSocialJoins,
  markPushDelivered,
  markPushSeen,
  recordDisplay,
  setWhatsNewSeen,
  listVisiblePlans,
  markNotificationsRead,
  removeMember,
  removePlanJoin,
  removeSocialJoin,
  rotateBuzzToken,
  rotateInvite,
  deleteSessionByHash,
  insertSession,
  updateCircleName,
  updateUserName,
  upsertPushSub,
  type CircleRow,
  type PlanRow,
  type SocialRow,
  type UserRow,
} from "./db.js";
import { isMapsLinkInput, looksLikeUrl, resolveMapsLink, reverseLookup, searchPlaces } from "./geocode.js";
import { extractBuzzSecret, humanCode } from "./code.js";
import { audiencePlace, eventTitle, notifyUsers } from "./notify.js";
import type { PushSender } from "./push.js";
import { pushSummaryForViewer, reachForCircle } from "./push-status.js";
import { clientKey } from "./client-key.js";
import { createRateLimiter, type RateLimiter } from "./rate-limit.js";
import {
  FEEDBACK_LIMIT,
  cleanAppVersion,
  cleanFeedbackNote,
  cleanFeedbackText,
  cleanPrUrl,
  insertFeedback,
  isFeedbackStatus,
  listFeedback,
  updateFeedback,
  type FeedbackStatus,
} from "./feedback.js";
import { ChatError, closeEventChat, recordEventLine, replyLogText, routeChat } from "./chat.js";
import { colorHex } from "./chat-color.js";
import { addDays, clockLabel, dayLabel, isoDate, noticeDay, zonedDateTime } from "./time.js";
import { publishSocial, replySocial } from "./socials.js";
import { assertPlanClock, joinPlan, PLAN_DAYS_AHEAD, publishPlan, readPlanDate, replyPlan } from "./plans.js";

export type AppDeps = {
  db: DatabaseSync;
  push: PushSender;
  config: Config;
  now: () => number;
};

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const WHATS_NEW_ID_RE = /^[a-z0-9-]{1,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Service worker acks per client (see clientKey). A phone back online can flush a burst at once. */
export const ACK_LIMIT = { limit: 120, windowMs: 60_000 };

type Limits = { ack: RateLimiter; feedback: RateLimiter };

export function createApp(deps: AppDeps): http.RequestListener {
  const limits: Limits = { ack: createRateLimiter(ACK_LIMIT), feedback: createRateLimiter(FEEDBACK_LIMIT) };
  return (req, res) => {
    void handle(req, res, deps, limits).catch((error: unknown) => {
      if (error instanceof HttpError || error instanceof ChatError) {
        sendJson(res, error.status, { error: error.message });
        return;
      }
      console.error(error);
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
    });
  };
}

const LEGACY_HOST = "hangry-production-64c4.up.railway.app";

async function handle(req: http.IncomingMessage, res: http.ServerResponse, deps: AppDeps, limits: Limits): Promise<void> {
  const host = String(req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
  if (host === LEGACY_HOST && deps.config.publicBaseUrl) {
    const dest = new URL(req.url ?? "/", deps.config.publicBaseUrl);
    res.writeHead(301, { location: dest.toString() });
    res.end();
    return;
  }
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  if (!pathname.startsWith("/api/")) {
    if (method !== "GET" && method !== "HEAD") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    await serveStatic(req, res, pathname);
    return;
  }

  const user = userFromRequest(req, deps.db);
  const body =
    method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE"
      ? await readJson(req)
      : {};
  // Feedback reads its own circle and ignores a bad one instead of failing the send.
  const requested = pathname === "/api/feedback" ? null : readRequestedCircle(req, url, body);

  if (method === "GET" && pathname === "/api/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === "GET" && pathname === "/api/meta") {
    sendJson(res, 200, {
      vapidPublicKey: deps.config.vapid?.publicKey ?? null,
      publicBaseUrl: deps.config.publicBaseUrl,
      socialTtlMs: deps.config.socialTtlMs,
      tz: deps.config.tz,
      devMode: !deps.config.vapid,
      mapTileUrl: deps.config.mapTileUrl,
      mapTileAttribution: deps.config.mapTileAttribution,
    });
    return;
  }

  if (method === "POST" && pathname === "/api/auth/start") {
    const name = cleanLabel(body.name, "name", 24);
    const now = deps.now();
    const rawCode = body.code == null || body.code === "" ? "" : cleanCode(body.code);
    const invited = rawCode ? requireLiveInvite(deps.db, rawCode, now) : undefined;
    const token = randomToken();
    const buzzToken = humanCode();
    const id = crypto.randomUUID();
    insertUser(deps.db, {
      id,
      name,
      token_hash: sha256(token),
      buzz_token: buzzToken,
      created_at: now,
    });
    if (invited) addMember(deps.db, invited.id, id, now);
    sendJson(res, 201, {
      token,
      buzzToken,
      user: { id, name, color: colorHex(id, getUserById(deps.db, id)?.color), whatsNewSeen: null },
      circle: invited ? circlePayload(deps, req, invited, id) : null,
    });
    return;
  }

  const invitePreview = matchPath(pathname, /^\/api\/invites\/([^/]+)$/);
  if (invitePreview && method === "GET") {
    const circle = requireLiveInvite(deps.db, decodeURIComponent(invitePreview[1]), deps.now());
    sendJson(res, 200, { name: circle.name });
    return;
  }

  if (method === "POST" && pathname === "/api/auth/recover") {
    const secret = extractBuzzSecret(typeof body.token === "string" ? body.token : "");
    const existing = secret ? getUserByBuzzToken(deps.db, secret) : undefined;
    if (!existing) throw new HttpError(401, "unknown recovery code");
    const token = randomToken();
    insertSession(deps.db, crypto.randomUUID(), existing.id, sha256(token), deps.now());
    sendJson(res, 200, {
      token,
      buzzToken: existing.buzz_token,
      user: { id: existing.id, name: existing.name, color: colorHex(existing.id, existing.color) },
    });
    return;
  }

  if (pathname.startsWith("/api/buzz/")) {
    if (method !== "POST") throw new HttpError(405, "method not allowed");
    let token = pathname.slice("/api/buzz/".length);
    try {
      token = decodeURIComponent(token);
    } catch {
      throw new HttpError(404, "unknown token");
    }
    const buzzer = token ? getUserByBuzzToken(deps.db, token) : undefined;
    if (!buzzer) throw new HttpError(404, "unknown token");
    // A bare buzz keeps the live note. Only a note field in the body replaces it.
    const note = Object.prototype.hasOwnProperty.call(body, "note") ? cleanNote(body.note, false) : undefined;
    const result = await publishSocial(deps, buzzer, note, readPoint(body), readPlace(body), readStart(body, deps.now(), deps.config.tz), requested ?? buzzCircle(deps, buzzer.id));
    sendJson(res, result.created ? 201 : 200, { social: result.social });
    return;
  }

  if (isOperatorPath(pathname)) {
    await handleAdmin(req, res, deps, method, pathname, body);
    return;
  }

  if (method === "POST" && pathname === "/api/push/ack") {
    if (!limits.ack.hit(clientKey(req), deps.now())) throw new HttpError(429, "too many requests");
    const id = typeof body.id === "string" ? body.id : "";
    if (!UUID_RE.test(id)) throw new HttpError(400, "invalid id");
    try {
      markPushDelivered(deps.db, id);
    } catch {
      /* The push already went out. The service worker can retry the ack. */
    }
    console.log("push ack status=ok");
    sendEmpty(res, 204);
    return;
  }

  const me = requireUser(user);

  const chat = await routeChat(deps, me, method, pathname, body, requested);
  if (chat) {
    if (chat.body == null) sendEmpty(res, chat.status);
    else sendJson(res, chat.status, chat.body);
    return;
  }

  if (method === "GET" && pathname === "/api/geocode") {
    const q = url.searchParams.get("q")?.trim() ?? "";
    const lat = Number(url.searchParams.get("lat"));
    const lng = Number(url.searchParams.get("lng"));
    if (q) {
      if (isMapsLinkInput(q)) {
        if (q.length > 2000) throw new HttpError(400, "query is too long");
        sendJson(res, 200, { results: await resolveMapsLink(q) });
        return;
      }
      if (looksLikeUrl(q)) {
        sendJson(res, 200, { results: [] });
        return;
      }
      if (q.length > 80) throw new HttpError(400, "query is too long");
      const nearLat = Number(url.searchParams.get("lat"));
      const nearLng = Number(url.searchParams.get("lng"));
      const bias = url.searchParams.has("lat") && url.searchParams.has("lng")
        && Number.isFinite(nearLat) && Number.isFinite(nearLng)
        ? { lat: nearLat, lng: nearLng }
        : null;
      sendJson(res, 200, { results: await searchPlaces(q, bias) });
      return;
    }
    if (url.searchParams.has("lat") || url.searchParams.has("lng")) {
      sendJson(res, 200, await reverseLookup(lat, lng));
      return;
    }
    throw new HttpError(400, "query is required");
  }

  if (method === "POST" && pathname === "/api/auth/logout") {
    const header = req.headers.authorization;
    const match = /^Bearer\s+(\S+)$/i.exec(Array.isArray(header) ? header[0] : header ?? "");
    if (match) deleteSessionByHash(deps.db, sha256(match[1]));
    sendEmpty(res, 204);
    return;
  }

  if (method === "GET" && pathname === "/api/me") {
    sendJson(res, 200, mePayload(deps, req, me, requested));
    return;
  }

  if (method === "PATCH" && pathname === "/api/me") {
    const name = cleanLabel(body.name, "name", 24);
    updateUserName(deps.db, me.id, name);
    const updated = { ...me, name };
    sendJson(res, 200, mePayload(deps, req, updated, requested));
    return;
  }

  if (method === "POST" && pathname === "/api/me/display") {
    if (typeof body.standalone !== "boolean") throw new HttpError(400, "standalone is required");
    recordDisplay(deps.db, me.id, body.standalone, deps.now());
    sendEmpty(res, 204);
    return;
  }

  if (method === "POST" && pathname === "/api/me/whats-new") {
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!WHATS_NEW_ID_RE.test(id)) throw new HttpError(400, "id is required");
    setWhatsNewSeen(deps.db, me.id, id);
    sendJson(res, 200, { whatsNewSeen: id });
    return;
  }

  if (method === "POST" && pathname === "/api/feedback") {
    const text = cleanFeedbackText(body.text);
    if (!text) throw new HttpError(400, "feedback must be 1–2000 characters");
    if (!limits.feedback.hit(clientKey(req), deps.now())) throw new HttpError(429, "too many requests");
    const id = insertFeedback(deps.db, {
      userId: me.id,
      circleId: feedbackCircle(deps, req, me.id, body),
      text,
      appVersion: cleanAppVersion(body.appVersion),
      createdAt: deps.now(),
    });
    console.log("feedback ok");
    sendJson(res, 201, { ok: true, id });
    return;
  }

  if (method === "POST" && pathname === "/api/me/buzz-token") {
    const buzzToken = humanCode();
    rotateBuzzToken(deps.db, me.id, buzzToken);
    sendJson(res, 200, { buzzToken });
    return;
  }

  if (method === "POST" && pathname === "/api/circles") {
    const name = body.name == null || body.name === "" ? "friends" : cleanLabel(body.name, "circle name", 32);
    const now = deps.now();
    const circle = createCircle(deps, me.id, name, now);
    sendJson(res, 201, { circle: circlePayload(deps, req, circle, me.id) });
    return;
  }

  if (method === "POST" && pathname === "/api/circles/join") {
    const code = cleanCode(body.code);
    const circle = requireLiveInvite(deps.db, code, deps.now());
    const already = listCirclesForUser(deps.db, me.id).some((item) => item.id === circle.id);
    if (!already && removalBlocksJoin(deps.db, circle.id, me.id, circle.invite_code)) {
      throw new HttpError(403, "An admin removed you from this circle.");
    }
    if (!already) addMember(deps.db, circle.id, me.id, deps.now());
    sendJson(res, 200, { circle: circlePayload(deps, req, circle, me.id) });
    return;
  }

  if (method === "POST" && pathname === "/api/circles/invite") {
    const circle = requireCircle(deps, me.id, requested);
    const now = deps.now();
    rotateInvite(deps.db, circle.id, inviteCode(), now + INVITE_TTL_MS);
    const fresh = getCircleById(deps.db, circle.id);
    if (!fresh) throw new HttpError(500, "circle missing");
    sendJson(res, 200, { circle: circlePayload(deps, req, fresh, me.id) });
    return;
  }

  const removal = matchPath(pathname, /^\/api\/circles\/removals\/([^/]+)$/);
  if (removal && method === "DELETE") {
    const circle = requireCircle(deps, me.id, requested);
    requireAdmin(deps, circle.id, me.id);
    clearRemoval(deps.db, circle.id, parseId(removal[1]));
    sendEmpty(res, 204);
    return;
  }

  if (method === "PATCH" && pathname === "/api/circles") {
    const circle = requireCircle(deps, me.id, requested);
    if (!isCircleAdmin(deps.db, circle.id, me.id)) throw new HttpError(403, "Only an admin can do that.");
    const name = cleanLabel(body.name, "circle name", 32);
    updateCircleName(deps.db, circle.id, name);
    const fresh = getCircleById(deps.db, circle.id);
    if (!fresh) throw new HttpError(500, "circle missing");
    sendJson(res, 200, { circle: circlePayload(deps, req, fresh, me.id) });
    return;
  }

  if (method === "DELETE" && pathname === "/api/circles") {
    const circle = requireCircle(deps, me.id, requested);
    requireAdmin(deps, circle.id, me.id);
    const members = listMembers(deps.db, circle.id);
    const removed = deleteCircle(deps.db, circle.id);
    if (!removed) throw new HttpError(404, "not found");
    await notifyCircleDeleted(deps, removed.circle, me, members);
    sendJson(res, 200, mePayload(deps, req, me, null));
    return;
  }

  if (method === "POST" && pathname === "/api/circles/leave") {
    const circle = requireCircle(deps, me.id, requested);
    removeMember(deps.db, circle.id, me.id);
    sendJson(res, 200, mePayload(deps, req, me, null));
    return;
  }

  const circleMember = matchPath(pathname, /^\/api\/circles\/members\/([^/]+)$/);
  if (circleMember && (method === "POST" || method === "DELETE")) {
    const circle = requireCircle(deps, me.id, requested);
    requireAdmin(deps, circle.id, me.id);
    const memberId = parseId(circleMember[1]);
    if (method === "DELETE") {
      const result = kickMember(deps.db, circle.id, memberId);
      if (result === "missing") throw new HttpError(404, "member not found");
      if (result === "last") throw new HttpError(409, "A circle needs an admin.");
      sendEmpty(res, 204);
      return;
    }
    if (typeof body.admin !== "boolean") throw new HttpError(400, "admin must be true or false");
    const result = setCircleAdmin(deps.db, circle.id, memberId, body.admin);
    if (result === "missing") throw new HttpError(404, "member not found");
    if (result === "last") throw new HttpError(409, "A circle needs an admin.");
    const fresh = getCircleById(deps.db, circle.id);
    if (!fresh) throw new HttpError(500, "circle missing");
    sendJson(res, 200, { circle: circlePayload(deps, req, fresh, me.id) });
    return;
  }

  if (method === "GET" && pathname === "/api/past") {
    const circle = requireCircle(deps, me.id, requested);
    sendJson(res, 200, { days: pastDays(deps, circle.id, me.id) });
    return;
  }

  if (method === "GET" && pathname === "/api/socials") {
    const circle = requireCircle(deps, me.id, requested);
    const socials = listActiveSocials(deps.db, circle.id, deps.now()).map((row) => socialPayload(deps.db, row, me.id));
    sendJson(res, 200, { socials });
    return;
  }

  if (method === "POST" && pathname === "/api/socials") {
    const note = cleanNote(body.note, false);
    const result = await publishSocial(deps, me, note, readPoint(body), readPlace(body), readStart(body, deps.now(), deps.config.tz), requested);
    sendJson(res, result.created ? 201 : 200, { social: result.social });
    return;
  }

  const socialPerson = matchPath(pathname, /^\/api\/socials\/([^/]+)\/people\/([^/]+)$/);
  if (socialPerson && method === "DELETE") {
    await removeSocialGuest(deps, me, socialPerson[1], socialPerson[2], requested);
    sendEmpty(res, 204);
    return;
  }

  const socialReply = matchPath(pathname, /^\/api\/socials\/([^/]+)\/reply$/);
  if (socialReply && method === "POST") {
    sendJson(res, 200, { social: await replySocial(deps, me, socialReply[1], body, requested) });
    return;
  }

  const socialJoin = matchPath(pathname, /^\/api\/socials\/([^/]+)\/join$/);
  if (socialJoin && method === "POST") {
    sendJson(res, 200, { social: await joinSocial(deps, me, socialJoin[1], requested) });
    return;
  }

  const socialLeave = matchPath(pathname, /^\/api\/socials\/([^/]+)\/leave$/);
  if (socialLeave && method === "POST") {
    sendJson(res, 200, { social: leaveSocial(deps, me, socialLeave[1], requested) });
    return;
  }

  const socialId = matchPath(pathname, /^\/api\/socials\/([^/]+)$/);
  if (socialId && method === "PATCH") {
    sendJson(res, 200, { social: await editSocial(deps, me, socialId[1], body, requested) });
    return;
  }
  if (socialId && method === "DELETE") {
    await endSocial(deps, me, socialId[1], requested);
    sendEmpty(res, 204);
    return;
  }

  if (method === "GET" && pathname === "/api/plans") {
    const circle = requireCircle(deps, me.id, requested);
    const now = deps.now();
    const today = isoDate(now, deps.config.tz);
    const plans = listVisiblePlans(deps.db, circle.id, today, addDays(today, PLAN_DAYS_AHEAD)).map((row) =>
      planPayload(deps.db, row, today, me.id),
    );
    sendJson(res, 200, { plans });
    return;
  }

  if (method === "POST" && pathname === "/api/plans") {
    const note = cleanNote(body.note, true);
    const place = cleanPlace(body.place);
    const time = Object.prototype.hasOwnProperty.call(body, "time") ? readClock(body.time) : null;
    sendJson(res, 201, { plan: await publishPlan(deps, me, note, place, readPoint(body), time, requested, body.date) });
    return;
  }

  const planPerson = matchPath(pathname, /^\/api\/plans\/([^/]+)\/people\/([^/]+)$/);
  if (planPerson && method === "DELETE") {
    await removePlanGuest(deps, me, planPerson[1], planPerson[2], requested);
    sendEmpty(res, 204);
    return;
  }

  const planReply = matchPath(pathname, /^\/api\/plans\/([^/]+)\/reply$/);
  if (planReply && method === "POST") {
    sendJson(res, 200, { plan: await replyPlan(deps, me, planReply[1], body, requested) });
    return;
  }

  const planJoin = matchPath(pathname, /^\/api\/plans\/([^/]+)\/join$/);
  if (planJoin && method === "POST") {
    sendJson(res, 200, { plan: await joinPlan(deps, me, planJoin[1], requested) });
    return;
  }

  const planLeave = matchPath(pathname, /^\/api\/plans\/([^/]+)\/leave$/);
  if (planLeave && method === "POST") {
    sendJson(res, 200, { plan: leavePlan(deps, me, planLeave[1], requested) });
    return;
  }

  const planId = matchPath(pathname, /^\/api\/plans\/([^/]+)$/);
  if (planId && method === "PATCH") {
    sendJson(res, 200, { plan: await editPlan(deps, me, planId[1], body, requested) });
    return;
  }
  if (planId && method === "DELETE") {
    await endPlan(deps, me, planId[1], requested);
    sendEmpty(res, 204);
    return;
  }

  if (method === "POST" && pathname === "/api/push/subscribe") {
    const sub = cleanSubscription(body);
    upsertPushSub(deps.db, {
      id: crypto.randomUUID(),
      userId: me.id,
      endpoint: sub.endpoint,
      p256dh: sub.p256dh,
      auth: sub.auth,
      createdAt: deps.now(),
    });
    markPushSeen(deps.db, me.id, deps.now());
    console.log(`push subscribe user=${me.id} status=ok`);
    sendEmpty(res, 204);
    return;
  }

  if (method === "POST" && pathname === "/api/push/status") {
    const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
    const known = endpoint.length > 0 && listPushSubs(deps.db, me.id).some((sub) => sub.endpoint === endpoint);
    sendJson(res, 200, { known });
    return;
  }

  if (method === "DELETE" && pathname === "/api/push/subscribe") {
    const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
    if (!endpoint) throw new HttpError(400, "endpoint is required");
    deletePushSubForUser(deps.db, me.id, endpoint);
    sendEmpty(res, 204);
    return;
  }

  if (method === "POST" && pathname === "/api/push/test") {
    const circles = listCirclesForUser(deps.db, me.id);
    const circle = circles.length === 0 ? null : requireCircle(deps, me.id, requested);
    const subs = listPushSubs(deps.db, me.id);
    await notifyUsers(deps.db, deps.push, deps.now(), [
      {
        userId: me.id,
        title: "Hangry",
        body: "Push works",
        kind: "test",
        refId: null,
        tag: `test:${me.id}`,
      },
    ], circle);
    sendJson(res, 200, {
      inApp: true,
      subscriptions: subs.length,
      webPush: Boolean(deps.config.vapid),
    });
    return;
  }

  if (method === "GET" && pathname === "/api/notifications") {
    const circle = requireCircle(deps, me.id, requested);
    const notifications = listNotifications(deps.db, me.id, circle.id).map((row) => ({
      id: row.id,
      title: row.title,
      body: row.body,
      kind: row.kind,
      refId: row.ref_id,
      circleId: row.circle_id,
      createdAt: row.created_at,
      readAt: row.read_at,
    }));
    sendJson(res, 200, { notifications });
    return;
  }

  if (method === "POST" && pathname === "/api/notifications/read") {
    const circle = requireCircle(deps, me.id, requested);
    markNotificationsRead(deps.db, me.id, circle.id, deps.now());
    sendEmpty(res, 204);
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

async function joinSocial(deps: AppDeps, user: UserRow, rawId: string, requested: string | null = null) {
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
  return socialPayload(deps.db, fresh, user.id);
}

function leaveSocial(deps: AppDeps, user: UserRow, rawId: string, requested: string | null = null) {
  const id = parseId(rawId);
  const circle = requireCircle(deps, user.id, requested);
  const social = getSocial(deps.db, id);
  if (!social || social.circle_id !== circle.id) throw new HttpError(404, "social not found");
  if (social.expires_at <= deps.now()) throw new HttpError(410, "that social has ended");
  removeSocialJoin(deps.db, social.id, user.id);
  return socialPayload(deps.db, social, user.id);
}

function leavePlan(deps: AppDeps, user: UserRow, rawId: string, requested: string | null = null) {
  const id = parseId(rawId);
  const circle = requireCircle(deps, user.id, requested);
  const plan = getPlan(deps.db, id);
  if (!plan || plan.circle_id !== circle.id) throw new HttpError(404, "plan not found");
  removePlanJoin(deps.db, plan.id, user.id);
  const now = deps.now();
  const today = isoDate(now, deps.config.tz);
  return planPayload(deps.db, plan, today, user.id);
}

function createCircle(deps: AppDeps, userId: string, name: string, now: number): CircleRow {
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

function mePayload(deps: AppDeps, req: http.IncomingMessage, user: UserRow, requested: string | null = null) {
  const circles = listCirclesForUser(deps.db, user.id);
  let active: CircleRow | undefined;
  if (requested) {
    active = circles.find((circle) => circle.id === requested);
    if (!active) throw new HttpError(404, "not found");
  } else {
    active = circles[0];
  }
  return {
    user: {
      id: user.id,
      name: user.name,
      color: colorHex(user.id, getUserById(deps.db, user.id)?.color),
      buzzToken: user.buzz_token,
      whatsNewSeen: user.whats_new_seen ?? null,
    },
    circles: circles.map((circle) => ({
      id: circle.id,
      name: circle.name,
      admin: isCircleAdmin(deps.db, circle.id, user.id),
    })),
    circle: active ? circlePayload(deps, req, active, user.id) : null,
  };
}

async function removeSocialGuest(deps: AppDeps, user: UserRow, rawSocialId: string, rawUserId: string, requested: string | null = null): Promise<void> {
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

async function removePlanGuest(deps: AppDeps, user: UserRow, rawPlanId: string, rawUserId: string, requested: string | null = null): Promise<void> {
  const planId = parseId(rawPlanId);
  const guestId = parseId(rawUserId);
  const circle = requireCircle(deps, user.id, requested);
  const plan = getPlan(deps.db, planId);
  if (!plan || plan.circle_id !== circle.id) throw new HttpError(404, "plan not found");
  if (guestId === plan.creator_id) throw new HttpError(400, "you made this plan");
  assertEventHost(deps, user, circle.id, plan.creator_id);
  const guest = listMembers(deps.db, circle.id).find((member) => member.id === guestId);
  if (!guest) throw new HttpError(404, "member not found");
  blockPlanGuest(deps.db, plan.id, guestId, deps.now(), user.name);
  recordEventLine(deps.db, {
    circleId: circle.id,
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
  ], circle);
}

function removedMessage(actor: string | null | undefined): string {
  const name = actor?.trim() || "Someone";
  return `${name} removed you from this.`;
}

function requireAdmin(deps: AppDeps, circleId: string, userId: string): void {
  if (!isCircleAdmin(deps.db, circleId, userId)) throw new HttpError(403, "Only an admin can do that.");
}

/** Host of the event, or an admin of its circle. */
function assertEventHost(deps: AppDeps, user: UserRow, circleId: string, hostId: string): void {
  if (user.id === hostId || isCircleAdmin(deps.db, circleId, user.id)) return;
  throw new HttpError(403, "Only the host can do that.");
}

async function endSocial(deps: AppDeps, user: UserRow, rawId: string, requested: string | null = null): Promise<void> {
  const id = parseId(rawId);
  const circle = requireCircle(deps, user.id, requested);
  const social = getSocial(deps.db, id);
  if (!social || social.circle_id !== circle.id) throw new HttpError(404, "social not found");
  assertEventHost(deps, user, circle.id, social.creator_id);
  closeEventChat(deps.db, circle.id, "social", social.id, deps.now());
  if (!finishSocial(deps.db, social.id, deps.now())) throw new HttpError(404, "social not found");
  if (social.creator_id !== user.id) {
    const label = social.note.trim() || "your free post";
    await notifyUsers(deps.db, deps.push, deps.now(), [
      {
        userId: social.creator_id,
        title: "Ended",
        body: `${user.name} ended ${label}`,
        kind: "ended",
        refId: social.id,
        tag: `ended:social:${social.id}`,
      },
    ], circle);
  }
}

function isInReply(reply: string | null | undefined): boolean {
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

async function editSocial(deps: AppDeps, user: UserRow, rawId: string, body: Record<string, unknown>, requested: string | null = null) {
  const id = parseId(rawId);
  const circle = requireCircle(deps, user.id, requested);
  const social = getSocial(deps.db, id);
  if (!social || social.circle_id !== circle.id) throw new HttpError(404, "social not found");
  if (social.expires_at <= deps.now()) throw new HttpError(410, "That post has ended.");
  assertEventHost(deps, user, circle.id, social.creator_id);
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
  return socialPayload(deps.db, fresh, user.id);
}

async function endPlan(deps: AppDeps, user: UserRow, rawId: string, requested: string | null = null): Promise<void> {
  const id = parseId(rawId);
  const circle = requireCircle(deps, user.id, requested);
  const plan = getPlan(deps.db, id);
  if (!plan || plan.circle_id !== circle.id) throw new HttpError(404, "plan not found");
  assertEventHost(deps, user, circle.id, plan.creator_id);
  closeEventChat(deps.db, circle.id, "plan", plan.id, deps.now());
  if (!finishPlan(deps.db, plan.id, deps.now())) throw new HttpError(404, "plan not found");
  if (plan.creator_id !== user.id) {
    await notifyUsers(deps.db, deps.push, deps.now(), [
      {
        userId: plan.creator_id,
        title: "Ended",
        body: `${user.name} ended ${plan.note}`,
        kind: "ended",
        refId: plan.id,
        tag: `ended:plan:${plan.id}`,
      },
    ], circle);
  }
}

async function editPlan(deps: AppDeps, user: UserRow, rawId: string, body: Record<string, unknown>, requested: string | null = null) {
  const id = parseId(rawId);
  const circle = requireCircle(deps, user.id, requested);
  const plan = getPlan(deps.db, id);
  if (!plan || plan.circle_id !== circle.id) throw new HttpError(404, "plan not found");
  assertEventHost(deps, user, circle.id, plan.creator_id);
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
  const noteChanged = note !== plan.note;
  const placeChanged = place !== (plan.place ?? "") || lat !== plan.lat || lng !== plan.lng;
  const description = Object.prototype.hasOwnProperty.call(body, "description")
    ? cleanDescription(body.description)
    : (plan.description ?? "");
  patchPlanDetails(deps.db, plan.id, note, place, lat, lng, atTime, forDate, description || null);
  // Description is left out on purpose: changing only it pings no one.
  const changes = [];
  if (noteChanged) changes.push({ name: "Note", next: note });
  if (dateChanged) changes.push({ name: "Day", next: noticeDay(forDate, today) });
  if (timeChanged) changes.push({ name: "Time", next: atTime ?? "" });
  if (placeChanged) changes.push({ name: "Place", next: place ? audiencePlace(place) : "" });
  if (changes.length) {
    const coming = listPlanJoins(deps.db, plan.id).filter((join) => isInReply(join.reply) && join.id !== user.id && join.id !== plan.creator_id);
    await pushEdit(
      deps,
      now,
      coming.map((join) => join.id),
      `Plan changed: ${note}`,
      changeBody(changes),
      plan.id,
      `/?plan=${plan.id}`,
      circle,
    );
    if (user.id !== plan.creator_id) {
      await pushEdit(
        deps,
        now,
        [plan.creator_id],
        `${user.name} edited your plan: ${note}`,
        changeBody(changes),
        plan.id,
        `/?plan=${plan.id}`,
        circle,
      );
    }
  }
  const fresh = getPlan(deps.db, plan.id);
  if (!fresh) throw new HttpError(500, "plan missing");
  return planPayload(deps.db, fresh, today, user.id);
}

type PastEvent = {
  kind: "social" | "plan";
  id: string;
  note: string;
  day: string;
  at: number;
  time: string;
  place: string;
  host: { id: string; name: string; color: string };
  people: Array<{ id: string; name: string; color: string; arriveAt: number | null }>;
};

function pastDays(deps: AppDeps, circleId: string, viewerId: string) {
  const now = deps.now();
  const today = isoDate(now, deps.config.tz);
  const events: PastEvent[] = [];
  for (const social of listPastSocials(deps.db, circleId, now)) {
    if (getSocialReply(deps.db, social.id, viewerId)?.blocked) continue;
    const at = social.starts_at ?? social.created_at;
    events.push({
      kind: "social",
      id: social.id,
      note: social.note,
      day: isoDate(at, deps.config.tz),
      at,
      time: clockLabel(at, deps.config.tz),
      place: social.place ?? "",
      host: { id: social.creator_id, name: social.creator_name, color: colorHex(social.creator_id, social.creator_color) },
      people: listSocialJoins(deps.db, social.id)
        .filter((join) => isInReply(join.reply))
        .map((join) => ({ id: join.id, name: join.name, color: colorHex(join.id, join.color), arriveAt: join.arrive_at })),
    });
  }
  for (const plan of listPastPlans(deps.db, circleId, today)) {
    if (getPlanReply(deps.db, plan.id, viewerId)?.blocked) continue;
    const at = plan.ended_at ?? plan.created_at;
    const day = plan.for_date < today ? plan.for_date : isoDate(at, deps.config.tz);
    events.push({
      kind: "plan",
      id: plan.id,
      note: plan.note,
      day,
      at,
      time: plan.at_time ?? "",
      place: plan.place ?? "",
      host: { id: plan.creator_id, name: plan.creator_name, color: colorHex(plan.creator_id, plan.creator_color) },
      people: listPlanJoins(deps.db, plan.id)
        .filter((join) => isInReply(join.reply))
        .map((join) => ({ id: join.id, name: join.name, color: colorHex(join.id, join.color), arriveAt: join.arrive_at })),
    });
  }
  events.sort((a, b) => b.day.localeCompare(a.day) || b.at - a.at || b.id.localeCompare(a.id));
  const days: Array<{ day: string; label: string; events: PastEvent[] }> = [];
  for (const event of events) {
    const last = days.at(-1);
    if (!last || last.day !== event.day) {
      days.push({ day: event.day, label: pastDayLabel(event.day, today), events: [event] });
    } else last.events.push(event);
  }
  return days;
}

function pastDayLabel(day: string, today: string): string {
  if (day === today) return "Today";
  if (day === addDays(today, -1)) return "Yesterday";
  const month = Number(day.slice(5, 7));
  const date = Number(day.slice(8, 10));
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${date} ${names[month - 1] ?? ""}`.trim();
}

function circlePayload(deps: AppDeps, req: http.IncomingMessage, circle: CircleRow, viewerId: string | null = null) {
  const members = listMembers(deps.db, circle.id);
  const reach = reachForCircle(deps.db, circle.id);
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
      admin: Boolean(member.is_admin),
      reach: reach.get(member.id) ?? "off",
    })),
  };
}

function removedByName(reply: { blocked: number; removed_by: string | null } | undefined): string | null {
  if (!reply?.blocked) return null;
  return reply.removed_by?.trim() || "Someone";
}

export function socialPayload(db: DatabaseSync, social: SocialRow, viewerId: string | null = null) {
  return {
    id: social.id,
    note: social.note,
    createdAt: social.created_at,
    startsAt: social.starts_at,
    expiresAt: social.expires_at,
    place: social.place ?? "",
    location: pointPayload(social.lat, social.lng),
    creator: { id: social.creator_id, name: social.creator_name, color: colorHex(social.creator_id, social.creator_color) },
    removedBy: removedByName(viewerId ? getSocialReply(db, social.id, viewerId) : undefined),
    joined: listSocialJoins(db, social.id).map((join) => ({
      id: join.id,
      name: join.name,
      color: colorHex(join.id, join.color),
      joinedAt: join.joined_at,
      reply: join.reply ?? "join",
      etaMin: join.eta_min ?? null,
      arriveAt: join.arrive_at ?? null,
    })),
    ...pushField(db, social.circle_id, "social", social.id, social.creator_id, viewerId),
  };
}

export function planPayload(db: DatabaseSync, plan: PlanRow, today: string, viewerId: string | null = null) {
  return {
    id: plan.id,
    note: plan.note,
    description: plan.description ?? "",
    place: plan.place ?? "",
    forDate: plan.for_date,
    whenLabel: dayLabel(plan.for_date, today),
    time: plan.at_time,
    createdAt: plan.created_at,
    location: pointPayload(plan.lat, plan.lng),
    creator: { id: plan.creator_id, name: plan.creator_name, color: colorHex(plan.creator_id, plan.creator_color) },
    removedBy: removedByName(viewerId ? getPlanReply(db, plan.id, viewerId) : undefined),
    joined: listPlanJoins(db, plan.id).map((join) => ({
      id: join.id,
      name: join.name,
      color: colorHex(join.id, join.color),
      joinedAt: join.joined_at,
      reply: join.reply ?? "coming",
      arriveAt: join.arrive_at ?? null,
    })),
    ...pushField(db, plan.circle_id, "plan", plan.id, plan.creator_id, viewerId),
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
  const push = pushSummaryForViewer(db, circleId, kind, refId, hostId, viewerId);
  return push ? { push } : {};
}

async function handleAdmin(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: AppDeps,
  method: string,
  pathname: string,
  body: Record<string, unknown>,
): Promise<void> {
  const expected = deps.config.adminToken;
  if (!expected) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const key = adminFailureKey(req);
  const now = deps.now();
  const given = bearerToken(req.headers.authorization);
  if (!given || !adminTokensMatch(given, expected)) {
    if (!adminFailuresOpen(key, now)) {
      console.log("admin query denied");
      sendJson(res, 404, { error: "not found" });
      return;
    }
    noteAdminFailure(key, now);
    console.log("admin query denied");
    sendJson(res, 404, { error: "not found" });
    return;
  }
  clearAdminFailures(key);
  if (method === "POST" && /^\/api\/admin\/circles\/[^/]+\/delete$/.test(pathname)) {
    deleteCircleAsOperator(res, deps, pathname);
    return;
  }
  if (method === "POST" && /^\/api\/admin\/circles\/[^/]+\/members\/[^/]+\/admin$/.test(pathname)) {
    setMemberAdminAsOperator(res, deps, pathname, body);
    return;
  }
  if (method === "GET" && pathname === "/api/admin/feedback") {
    listFeedbackAsOperator(req, res, deps);
    return;
  }
  if (method === "POST" && /^\/api\/admin\/feedback\/[^/]+$/.test(pathname)) {
    updateFeedbackAsOperator(res, deps, pathname, body);
    return;
  }
  try {
    if (method === "POST" && pathname === "/api/admin/query") {
      const sql = body.sql;
      const params = body.params === undefined ? [] : body.params;
      if (typeof sql !== "string" || !Array.isArray(params)) {
        console.log("admin query denied");
        sendJson(res, 400, { error: "query is not allowed" });
        return;
      }
      const result = await runReadQuery(deps.config.dbPath, sql, params);
      console.log(`admin query ok rows=${result.rows.length}`);
      sendJson(res, 200, { columns: result.columns, rows: result.rows, truncated: result.truncated });
      return;
    }
    if (method === "GET" && pathname === "/api/admin/schema") {
      const tables = await readSchema(deps.config.dbPath);
      console.log(`admin query ok rows=${tables.length}`);
      sendJson(res, 200, { tables });
      return;
    }
  } catch (error) {
    if (error instanceof AdminQueryTimeout) {
      console.log("admin query timeout");
      sendJson(res, 408, { error: "timeout" });
      return;
    }
    if (error instanceof AdminQueryFailed) {
      console.log("admin query error");
      sendJson(res, 400, { error: "query is not allowed" });
      return;
    }
    console.log("admin query denied");
    sendJson(res, 400, { error: "query is not allowed" });
    return;
  }
  console.log("admin query denied");
  sendJson(res, 404, { error: "not found" });
}

function isOperatorPath(pathname: string): boolean {
  return pathname === "/api/admin/query"
    || pathname === "/api/admin/schema"
    || /^\/api\/admin\/circles\/[^/]+\/delete$/.test(pathname)
    || /^\/api\/admin\/circles\/[^/]+\/members\/[^/]+\/admin$/.test(pathname)
    || pathname === "/api/admin/feedback"
    || /^\/api\/admin\/feedback\/[^/]+$/.test(pathname);
}

function listFeedbackAsOperator(req: http.IncomingMessage, res: http.ServerResponse, deps: AppDeps): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const raw = url.searchParams.get("status");
  let status: FeedbackStatus | null = null;
  if (raw !== null && raw !== "") {
    if (!isFeedbackStatus(raw)) {
      console.log("admin feedback denied");
      sendJson(res, 400, { error: "invalid status" });
      return;
    }
    status = raw;
  }
  const feedback = listFeedback(deps.db, status);
  console.log(`admin feedback ok rows=${feedback.length}`);
  sendJson(res, 200, { feedback });
}

function updateFeedbackAsOperator(
  res: http.ServerResponse,
  deps: AppDeps,
  pathname: string,
  body: Record<string, unknown>,
): void {
  const match = /^\/api\/admin\/feedback\/([^/]+)$/.exec(pathname);
  let id = "";
  try {
    id = parseId(match?.[1] ?? "");
  } catch {
    console.log("admin feedback denied");
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const patch: { status?: FeedbackStatus; prUrl?: string | null; note?: string | null } = {};
  const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key);
  if (has("status")) {
    if (!isFeedbackStatus(body.status)) {
      console.log("admin feedback denied");
      sendJson(res, 400, { error: "invalid status" });
      return;
    }
    patch.status = body.status;
  }
  if (has("prUrl")) {
    const prUrl = cleanPrUrl(body.prUrl);
    if (prUrl === undefined) {
      console.log("admin feedback denied");
      sendJson(res, 400, { error: "invalid prUrl" });
      return;
    }
    patch.prUrl = prUrl;
  }
  if (has("note")) {
    const note = cleanFeedbackNote(body.note);
    if (note === undefined) {
      console.log("admin feedback denied");
      sendJson(res, 400, { error: "invalid note" });
      return;
    }
    patch.note = note;
  }
  if (patch.status === undefined && patch.prUrl === undefined && patch.note === undefined) {
    console.log("admin feedback denied");
    sendJson(res, 400, { error: "nothing to update" });
    return;
  }
  const updated = updateFeedback(deps.db, id, patch, deps.now());
  if (!updated) {
    console.log("admin feedback denied");
    sendJson(res, 404, { error: "not found" });
    return;
  }
  console.log(`admin feedback update ok id=${updated.id} status=${updated.status}`);
  sendJson(res, 200, { feedback: updated });
}

function deleteCircleAsOperator(res: http.ServerResponse, deps: AppDeps, pathname: string): void {
  const match = /^\/api\/admin\/circles\/([^/]+)\/delete$/.exec(pathname);
  let circleId = "";
  try {
    circleId = parseId(match?.[1] ?? "");
  } catch {
    console.log("admin circle delete denied");
    sendJson(res, 404, { error: "not found" });
    return;
  }
  try {
    const removed = deleteCircle(deps.db, circleId);
    if (!removed) {
      console.log("admin circle delete denied");
      sendJson(res, 404, { error: "not found" });
      return;
    }
    console.log(`admin circle delete ok id=${removed.circle.id}`);
    sendJson(res, 200, { deleted: true, circle: removed.circle, counts: removed.counts });
  } catch {
    console.log("admin circle delete denied");
    sendJson(res, 404, { error: "not found" });
  }
}

function setMemberAdminAsOperator(
  res: http.ServerResponse,
  deps: AppDeps,
  pathname: string,
  body: Record<string, unknown>,
): void {
  const match = /^\/api\/admin\/circles\/([^/]+)\/members\/([^/]+)\/admin$/.exec(pathname);
  let circleId = "";
  let userId = "";
  try {
    circleId = parseId(match?.[1] ?? "");
    userId = parseId(match?.[2] ?? "");
  } catch {
    console.log("admin member admin denied");
    sendJson(res, 404, { error: "not found" });
    return;
  }
  if (typeof body.admin !== "boolean") {
    console.log("admin member admin denied");
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const circle = getCircleById(deps.db, circleId);
  if (!circle) {
    console.log("admin member admin denied");
    sendJson(res, 404, { error: "not found" });
    return;
  }
  // Same path an admin uses in the app: setCircleAdmin refuses to leave zero admins.
  const result = setCircleAdmin(deps.db, circle.id, userId, body.admin);
  if (result === "last") {
    console.log("admin member admin denied");
    sendJson(res, 409, { error: "A circle needs an admin." });
    return;
  }
  if (result !== "ok") {
    console.log("admin member admin denied");
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const user = getUserById(deps.db, userId);
  if (!user) {
    console.log("admin member admin denied");
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const admin = isCircleAdmin(deps.db, circle.id, user.id);
  console.log(`admin member admin ok circle=${circle.id} user=${user.id} admin=${admin}`);
  sendJson(res, 200, {
    ok: true,
    circle: { id: circle.id, name: circle.name },
    user: { id: user.id, name: user.name },
    admin,
  });
}

async function notifyCircleDeleted(
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

function requireUser(user: UserRow | undefined): UserRow {
  if (!user) throw new HttpError(401, "sign in required");
  return user;
}

function readRequestedCircle(req: http.IncomingMessage, url: URL, body: Record<string, unknown>): string | null {
  const header = firstHeader(req.headers["x-circle"]);
  const fromBody = typeof body.circleId === "string" ? body.circleId : "";
  const raw = (header || url.searchParams.get("circle") || fromBody).trim();
  if (!raw) return null;
  return parseId(raw);
}

/** The circle feedback was sent from, if the sender is a member. Anything else is dropped, not rejected. */
function feedbackCircle(deps: AppDeps, req: http.IncomingMessage, userId: string, body: Record<string, unknown>): string | null {
  const raw = (typeof body.circleId === "string" && body.circleId.trim()) || firstHeader(req.headers["x-circle"]).trim();
  if (!raw) return null;
  let id = "";
  try {
    id = parseId(raw);
  } catch {
    return null;
  }
  return listCirclesForUser(deps.db, userId).some((circle) => circle.id === id) ? id : null;
}

/** A buzz with no circle posts to the circle joined last, so the bare link still works. */
function buzzCircle(deps: AppDeps, userId: string): string | null {
  const circles = listCirclesForUser(deps.db, userId);
  if (circles.length <= 1) return null;
  return circles[circles.length - 1].id;
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

function userFromRequest(req: http.IncomingMessage, db: DatabaseSync): UserRow | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(Array.isArray(header) ? header[0] : header);
  if (!match) return undefined;
  const token = match[1];
  if (token.length < 20 || token.length > 256) return undefined;
  return getUserByTokenHash(db, sha256(token));
}

function requestOrigin(req: http.IncomingMessage, config: Config): string {
  if (config.publicBaseUrl) return config.publicBaseUrl;
  const forwardedProto = firstHeader(req.headers["x-forwarded-proto"]);
  const forwardedHost = firstHeader(req.headers["x-forwarded-host"]);
  const proto = forwardedProto === "https" ? "https" : "http";
  const host = safeHost(forwardedHost || firstHeader(req.headers.host) || "localhost");
  return `${proto}://${host}`;
}

function firstHeader(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function safeHost(host: string): string {
  const trimmed = host.split(",")[0]?.trim() ?? "";
  if (/^[A-Za-z0-9.-]+(?::\d+)?$/.test(trimmed)) return trimmed;
  return "localhost";
}

export function parseId(value: string): string {
  const id = decodeURIComponent(value).toLowerCase();
  if (!UUID_RE.test(id)) throw new HttpError(404, "not found");
  return id;
}

function matchPath(pathname: string, pattern: RegExp): RegExpExecArray | null {
  return pattern.exec(pathname);
}

function cleanLabel(value: unknown, label: string, max: number): string {
  if (typeof value !== "string") throw new HttpError(400, `${label} is required`);
  const text = value.replace(/[\u0000-\u001f]/g, "").trim();
  if (text.length < 1 || text.length > max) {
    throw new HttpError(400, `${label} must be 1–${max} characters`);
  }
  return text;
}

function pointPayload(lat: number | null, lng: number | null): { lat: number; lng: number } | null {
  if (lat == null || lng == null) return null;
  return { lat, lng };
}

/** ~100 m for a GPS reading. An explicitly chosen place keeps finer coordinates. Undefined means the client did not mention location. */
function readPoint(body: Record<string, unknown>): { lat: number; lng: number } | null | undefined {
  const hasLat = Object.prototype.hasOwnProperty.call(body, "lat");
  const hasLng = Object.prototype.hasOwnProperty.call(body, "lng");
  if (!hasLat && !hasLng) return undefined;
  if (body.lat == null && body.lng == null) return null;
  if (!hasLat || !hasLng || body.lat == null || body.lng == null) {
    throw new HttpError(400, "lat and lng are both required");
  }
  const precise = body.precise === true;
  const lat = roundCoord(body.lat, "lat", precise ? 6 : 3);
  const lng = roundCoord(body.lng, "lng", precise ? 6 : 3);
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) throw new HttpError(400, "location is out of range");
  return { lat, lng };
}

const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function liveInvite(db: DatabaseSync, code: string, now: number): CircleRow | undefined {
  try {
    return requireLiveInvite(db, code, now);
  } catch {
    return undefined;
  }
}

function requireLiveInvite(db: DatabaseSync, code: string, now: number): CircleRow {
  const circle = getCircleByCode(db, cleanCode(code));
  if (!circle || circle.invite_expires_at == null) throw new HttpError(404, "invite not found");
  if (circle.invite_expires_at <= now) throw new HttpError(410, "invite expired");
  return circle;
}

/** Undefined keeps a scheduled start. Null means free right now. A clock time is later today in APP_TZ. */
function readStart(body: Record<string, unknown>, now: number, tz: string): number | null | undefined {
  if (body.later === true && body.startsAt == null && body.startsInMin == null) {
    throw new HttpError(400, "Pick a time later today.");
  }
  if (!Object.prototype.hasOwnProperty.call(body, "startsAt") && !Object.prototype.hasOwnProperty.call(body, "startsInMin")) {
    return undefined;
  }
  if (body.startsInMin != null) {
    const minutes = Number(body.startsInMin);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 18 * 60) {
      throw new HttpError(400, "Pick a time later today.");
    }
    return assertLaterToday(now + minutes * 60 * 1000, now, tz);
  }
  if (body.startsAt == null) return null;
  if (typeof body.startsAt === "string") {
    if (!/^\d{2}:\d{2}$/.test(body.startsAt)) throw new HttpError(400, "Pick a time later today.");
    try {
      return assertLaterToday(zonedDateTime(isoDate(now, tz), body.startsAt, tz), now, tz);
    } catch {
      throw new HttpError(400, "Pick a time later today.");
    }
  }
  const instant = Number(body.startsAt);
  if (!Number.isFinite(instant)) throw new HttpError(400, "Pick a time later today.");
  return assertLaterToday(instant, now, tz);
}

function readClock(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) throw new HttpError(400, "Pick a valid time, like 19:30");
  const hour = Number(value.slice(0, 2));
  const minute = Number(value.slice(3, 5));
  if (hour > 23 || minute > 59) throw new HttpError(400, "Pick a valid time, like 19:30");
  return value;
}

function assertLaterToday(instant: number, now: number, tz: string): number {
  if (instant <= now) throw new HttpError(400, "Pick a time later today.");
  if (isoDate(instant, tz) !== isoDate(now, tz)) throw new HttpError(400, "Pick a time later today.");
  return instant;
}

function readPlace(body: Record<string, unknown>): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(body, "place")) return undefined;
  return cleanPlace(body.place);
}

function roundCoord(value: unknown, label: string, digits: number): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) throw new HttpError(400, `${label} is not a number`);
  const scale = 10 ** digits;
  return Math.round(number * scale) / scale;
}

function cleanPlace(value: unknown): string {
  if (value == null || value === "") return "";
  if (typeof value !== "string") throw new HttpError(400, "place must be a string");
  const place = value.replace(/[\r\n\t]+/g, " ").replace(/[\u0000-\u001f]/g, "").trim();
  if (place.length > 80) throw new HttpError(400, "place is too long (80)");
  return place;
}

function cleanNote(value: unknown, required: boolean): string {
  if (value == null || value === "") {
    if (required) throw new HttpError(400, "note is required");
    return "";
  }
  if (typeof value !== "string") throw new HttpError(400, "note must be a string");
  const note = value.replace(/[\r\n\t]+/g, " ").replace(/[\u0000-\u001f]/g, "").trim();
  if (note.length > 80) throw new HttpError(400, "note is too long (80)");
  if (required && note.length === 0) throw new HttpError(400, "note is required");
  return note;
}

/** Plain text, one line, at most 280 characters. Longer text is cut, not refused. */
function cleanDescription(value: unknown): string {
  if (value == null || value === "") return "";
  if (typeof value !== "string") throw new HttpError(400, "description must be a string");
  const text = value.replace(/[\r\n\t]+/g, " ").replace(/[\u0000-\u001f\u007f]/g, "").replace(/ {2,}/g, " ").trim();
  return text.slice(0, 280).trim();
}

function cleanCode(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "invite code is required");
  const code = value.toUpperCase().replace(/[^A-Z2-9]/g, "");
  if (code.length < 4 || code.length > 12) throw new HttpError(400, "invite code is not valid");
  return code;
}

function cleanSubscription(body: Record<string, unknown>): { endpoint: string; p256dh: string; auth: string } {
  if (typeof body.endpoint !== "string" || body.endpoint.length > 2000) {
    throw new HttpError(400, "invalid push endpoint");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(body.endpoint);
  } catch {
    throw new HttpError(400, "invalid push endpoint");
  }
  const local = endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1";
  if (endpoint.protocol !== "https:" && !local) throw new HttpError(400, "push endpoint must be https");
  const keys = body.keys;
  if (!keys || typeof keys !== "object") throw new HttpError(400, "invalid push keys");
  const p256dh = (keys as { p256dh?: unknown }).p256dh;
  const auth = (keys as { auth?: unknown }).auth;
  if (
    typeof p256dh !== "string" ||
    typeof auth !== "string" ||
    p256dh.length < 1 ||
    auth.length < 1 ||
    p256dh.length > 256 ||
    auth.length > 256
  ) {
    throw new HttpError(400, "invalid push keys");
  }
  return { endpoint: body.endpoint, p256dh, auth };
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const text = await readBody(req);
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "expected a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 32_768) {
        reject(new HttpError(413, "body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  if (status === 204) {
    sendEmpty(res, 204);
    return;
  }
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
  });
  res.end(json);
}

function sendEmpty(res: http.ServerResponse, status: number): void {
  res.writeHead(status, {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
  });
  res.end();
}

async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<void> {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendJson(res, 400, { error: "bad path" });
    return;
  }
  if (decoded.includes("\0")) {
    sendJson(res, 400, { error: "bad path" });
    return;
  }
  const rel = decoded.replace(/^\/+/, "");
  const filePath = path.resolve(PUBLIC_DIR, rel);
  const relative = path.relative(PUBLIC_DIR, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const ext = path.extname(relative);
  if (ext) {
    try {
      const data = await fs.promises.readFile(filePath);
      if (req.method === "HEAD") {
        res.writeHead(200, staticHeaders(ext, data.length));
        res.end();
        return;
      }
      res.writeHead(200, staticHeaders(ext, data.length));
      res.end(data);
    } catch {
      sendJson(res, 404, { error: "not found" });
    }
    return;
  }
  try {
    const data = await fs.promises.readFile(path.join(PUBLIC_DIR, "index.html"));
    res.writeHead(200, staticHeaders(".html", data.length));
    if (req.method === "HEAD") res.end();
    else res.end(data);
  } catch {
    sendJson(res, 404, { error: "not found" });
  }
}

function staticHeaders(ext: string, length: number): http.OutgoingHttpHeaders {
  return {
    "content-type": MIME[ext] ?? "application/octet-stream",
    "content-length": length,
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
  };
}

function randomToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function inviteCode(): string {
  const bytes = crypto.randomBytes(8);
  let code = "";
  for (let i = 0; i < 8; i += 1) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return code;
}

function isUnique(error: unknown): boolean {
  return error instanceof Error && /UNIQUE/i.test(error.message);
}
