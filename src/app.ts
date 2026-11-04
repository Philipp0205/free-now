import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import type { Config } from "./config.js";
import {
  addMember,
  addSocialJoin,
  blockPlanGuest,
  blockSocialGuest,
  clearRemoval,
  removalBlocksJoin,
  deletePlanById,
  deletePushSubForUser,
  deleteSocialById,
  getCircleByCode,
  getCircleForUser,
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
  listVisiblePlans,
  markNotificationsRead,
  removeMember,
  removePlanJoin,
  removeSocialJoin,
  rotateBuzzToken,
  rotateInvite,
  deleteSessionByHash,
  insertSession,
  updateUserName,
  upsertPushSub,
  type CircleRow,
  type PlanRow,
  type SocialRow,
  type UserRow,
} from "./db.js";
import { reverseLookup, searchPlaces } from "./geocode.js";
import { extractBuzzSecret, humanCode } from "./code.js";
import { eventTitle, notifyUsers } from "./notify.js";
import type { PushSender } from "./push.js";
import { addDays, isoDate, whenLabel, zonedDateTime } from "./time.js";
import { publishSocial, replySocial } from "./socials.js";
import { joinPlan, publishPlan, replyPlan } from "./plans.js";

export type AppDeps = {
  db: DatabaseSync;
  push: PushSender;
  config: Config;
  now: () => number;
};

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
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

export function createApp(deps: AppDeps): http.RequestListener {
  return (req, res) => {
    void handle(req, res, deps).catch((error: unknown) => {
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.message });
        return;
      }
      console.error(error);
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
    });
  };
}

const LEGACY_HOST = "hangry-production-64c4.up.railway.app";

async function handle(req: http.IncomingMessage, res: http.ServerResponse, deps: AppDeps): Promise<void> {
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
      user: { id, name },
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
      user: { id: existing.id, name: existing.name },
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
    const result = await publishSocial(deps, buzzer, note, readPoint(body), readPlace(body), readStart(body, deps.now(), deps.config.tz));
    sendJson(res, result.created ? 201 : 200, { social: result.social });
    return;
  }

  const me = requireUser(user);

  if (method === "GET" && pathname === "/api/geocode") {
    const q = url.searchParams.get("q")?.trim() ?? "";
    const lat = Number(url.searchParams.get("lat"));
    const lng = Number(url.searchParams.get("lng"));
    if (q) {
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
    sendJson(res, 200, mePayload(deps, req, me));
    return;
  }

  if (method === "PATCH" && pathname === "/api/me") {
    const name = cleanLabel(body.name, "name", 24);
    updateUserName(deps.db, me.id, name);
    const updated = { ...me, name };
    sendJson(res, 200, mePayload(deps, req, updated));
    return;
  }

  if (method === "POST" && pathname === "/api/me/buzz-token") {
    const buzzToken = humanCode();
    rotateBuzzToken(deps.db, me.id, buzzToken);
    sendJson(res, 200, { buzzToken });
    return;
  }

  if (method === "POST" && pathname === "/api/circles") {
    if (getCircleForUser(deps.db, me.id)) throw new HttpError(409, "you are already in a circle");
    const name = body.name == null || body.name === "" ? "friends" : cleanLabel(body.name, "circle name", 32);
    const now = deps.now();
    const circle = createCircle(deps, me.id, name, now);
    sendJson(res, 201, { circle: circlePayload(deps, req, circle, me.id) });
    return;
  }

  if (method === "POST" && pathname === "/api/circles/join") {
    const code = cleanCode(body.code);
    const circle = requireLiveInvite(deps.db, code, deps.now());
    const current = getCircleForUser(deps.db, me.id);
    if (current && current.id !== circle.id) throw new HttpError(409, "you are already in a circle");
    if (!current && removalBlocksJoin(deps.db, circle.id, me.id, circle.invite_code)) {
      throw new HttpError(403, "An admin removed you from this circle.");
    }
    if (!current) addMember(deps.db, circle.id, me.id, deps.now());
    sendJson(res, 200, { circle: circlePayload(deps, req, circle, me.id) });
    return;
  }

  if (method === "POST" && pathname === "/api/circles/invite") {
    const circle = requireCircle(deps, me.id);
    const now = deps.now();
    rotateInvite(deps.db, circle.id, inviteCode(), now + INVITE_TTL_MS);
    const fresh = getCircleForUser(deps.db, me.id);
    if (!fresh) throw new HttpError(500, "circle missing");
    sendJson(res, 200, { circle: circlePayload(deps, req, fresh, me.id) });
    return;
  }

  const removal = matchPath(pathname, /^\/api\/circles\/removals\/([^/]+)$/);
  if (removal && method === "DELETE") {
    const circle = requireCircle(deps, me.id);
    requireAdmin(deps, circle.id, me.id);
    clearRemoval(deps.db, circle.id, parseId(removal[1]));
    sendEmpty(res, 204);
    return;
  }

  if (method === "POST" && pathname === "/api/circles/leave") {
    const circle = getCircleForUser(deps.db, me.id);
    if (!circle) throw new HttpError(409, "join a circle first");
    removeMember(deps.db, circle.id, me.id);
    sendJson(res, 200, mePayload(deps, req, me));
    return;
  }

  const circleMember = matchPath(pathname, /^\/api\/circles\/members\/([^/]+)$/);
  if (circleMember && (method === "POST" || method === "DELETE")) {
    const circle = requireCircle(deps, me.id);
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
    const fresh = getCircleForUser(deps.db, me.id);
    if (!fresh) throw new HttpError(500, "circle missing");
    sendJson(res, 200, { circle: circlePayload(deps, req, fresh, me.id) });
    return;
  }

  if (method === "GET" && pathname === "/api/socials") {
    const circle = requireCircle(deps, me.id);
    const socials = listActiveSocials(deps.db, circle.id, deps.now()).map((row) => socialPayload(deps.db, row, me.id));
    sendJson(res, 200, { socials });
    return;
  }

  if (method === "POST" && pathname === "/api/socials") {
    const note = cleanNote(body.note, false);
    const result = await publishSocial(deps, me, note, readPoint(body), readPlace(body), readStart(body, deps.now(), deps.config.tz));
    sendJson(res, result.created ? 201 : 200, { social: result.social });
    return;
  }

  const socialPerson = matchPath(pathname, /^\/api\/socials\/([^/]+)\/people\/([^/]+)$/);
  if (socialPerson && method === "DELETE") {
    await removeSocialGuest(deps, me, socialPerson[1], socialPerson[2]);
    sendEmpty(res, 204);
    return;
  }

  const socialReply = matchPath(pathname, /^\/api\/socials\/([^/]+)\/reply$/);
  if (socialReply && method === "POST") {
    sendJson(res, 200, { social: await replySocial(deps, me, socialReply[1], body) });
    return;
  }

  const socialJoin = matchPath(pathname, /^\/api\/socials\/([^/]+)\/join$/);
  if (socialJoin && method === "POST") {
    sendJson(res, 200, { social: await joinSocial(deps, me, socialJoin[1]) });
    return;
  }

  const socialLeave = matchPath(pathname, /^\/api\/socials\/([^/]+)\/leave$/);
  if (socialLeave && method === "POST") {
    sendJson(res, 200, { social: leaveSocial(deps, me, socialLeave[1]) });
    return;
  }

  const socialId = matchPath(pathname, /^\/api\/socials\/([^/]+)$/);
  if (socialId && method === "PATCH") {
    sendJson(res, 200, { social: await editSocial(deps, me, socialId[1], body) });
    return;
  }
  if (socialId && method === "DELETE") {
    await endSocial(deps, me, socialId[1]);
    sendEmpty(res, 204);
    return;
  }

  if (method === "GET" && pathname === "/api/plans") {
    const circle = requireCircle(deps, me.id);
    const now = deps.now();
    const today = isoDate(now, deps.config.tz);
    const tomorrow = addDays(today, 1);
    const plans = listVisiblePlans(deps.db, circle.id, today, tomorrow).map((row) =>
      planPayload(deps.db, row, today, tomorrow, me.id),
    );
    sendJson(res, 200, { plans });
    return;
  }

  if (method === "POST" && pathname === "/api/plans") {
    const note = cleanNote(body.note, true);
    const place = cleanPlace(body.place);
    sendJson(res, 201, { plan: await publishPlan(deps, me, note, place, readPoint(body)) });
    return;
  }

  const planPerson = matchPath(pathname, /^\/api\/plans\/([^/]+)\/people\/([^/]+)$/);
  if (planPerson && method === "DELETE") {
    await removePlanGuest(deps, me, planPerson[1], planPerson[2]);
    sendEmpty(res, 204);
    return;
  }

  const planReply = matchPath(pathname, /^\/api\/plans\/([^/]+)\/reply$/);
  if (planReply && method === "POST") {
    sendJson(res, 200, { plan: await replyPlan(deps, me, planReply[1], body) });
    return;
  }

  const planJoin = matchPath(pathname, /^\/api\/plans\/([^/]+)\/join$/);
  if (planJoin && method === "POST") {
    sendJson(res, 200, { plan: await joinPlan(deps, me, planJoin[1]) });
    return;
  }

  const planLeave = matchPath(pathname, /^\/api\/plans\/([^/]+)\/leave$/);
  if (planLeave && method === "POST") {
    sendJson(res, 200, { plan: leavePlan(deps, me, planLeave[1]) });
    return;
  }

  const planId = matchPath(pathname, /^\/api\/plans\/([^/]+)$/);
  if (planId && method === "PATCH") {
    sendJson(res, 200, { plan: await editPlan(deps, me, planId[1], body) });
    return;
  }
  if (planId && method === "DELETE") {
    await endPlan(deps, me, planId[1]);
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
    ]);
    sendJson(res, 200, {
      inApp: true,
      subscriptions: subs.length,
      webPush: Boolean(deps.config.vapid),
    });
    return;
  }

  if (method === "GET" && pathname === "/api/notifications") {
    const notifications = listNotifications(deps.db, me.id).map((row) => ({
      id: row.id,
      title: row.title,
      body: row.body,
      kind: row.kind,
      refId: row.ref_id,
      createdAt: row.created_at,
      readAt: row.read_at,
    }));
    sendJson(res, 200, { notifications });
    return;
  }

  if (method === "POST" && pathname === "/api/notifications/read") {
    markNotificationsRead(deps.db, me.id, deps.now());
    sendEmpty(res, 204);
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

async function joinSocial(deps: AppDeps, user: UserRow, rawId: string) {
  const id = parseId(rawId);
  const circle = requireCircle(deps, user.id);
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
    ]);
  }
  const fresh = getSocial(deps.db, social.id);
  if (!fresh) throw new HttpError(500, "social missing");
  return socialPayload(deps.db, fresh);
}

function leaveSocial(deps: AppDeps, user: UserRow, rawId: string) {
  const id = parseId(rawId);
  const circle = requireCircle(deps, user.id);
  const social = getSocial(deps.db, id);
  if (!social || social.circle_id !== circle.id) throw new HttpError(404, "social not found");
  if (social.expires_at <= deps.now()) throw new HttpError(410, "that social has ended");
  removeSocialJoin(deps.db, social.id, user.id);
  return socialPayload(deps.db, social);
}

function leavePlan(deps: AppDeps, user: UserRow, rawId: string) {
  const id = parseId(rawId);
  const circle = requireCircle(deps, user.id);
  const plan = getPlan(deps.db, id);
  if (!plan || plan.circle_id !== circle.id) throw new HttpError(404, "plan not found");
  removePlanJoin(deps.db, plan.id, user.id);
  const now = deps.now();
  const today = isoDate(now, deps.config.tz);
  return planPayload(deps.db, plan, today, addDays(today, 1));
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

function mePayload(deps: AppDeps, req: http.IncomingMessage, user: UserRow) {
  const circle = getCircleForUser(deps.db, user.id);
  return {
    user: { id: user.id, name: user.name, buzzToken: user.buzz_token },
    circle: circle ? circlePayload(deps, req, circle, user.id) : null,
  };
}

async function removeSocialGuest(deps: AppDeps, user: UserRow, rawSocialId: string, rawUserId: string): Promise<void> {
  const socialId = parseId(rawSocialId);
  const guestId = parseId(rawUserId);
  const circle = requireCircle(deps, user.id);
  const social = getSocial(deps.db, socialId);
  if (!social || social.circle_id !== circle.id) throw new HttpError(404, "social not found");
  if (guestId === social.creator_id) throw new HttpError(400, "you started this one");
  assertEventHost(deps, user, circle.id, social.creator_id);
  const guest = listMembers(deps.db, circle.id).find((member) => member.id === guestId);
  if (!guest) throw new HttpError(404, "member not found");
  blockSocialGuest(deps.db, social.id, guestId, deps.now(), user.name);
  const eventName = social.note.trim() || "Free now";
  await notifyUsers(deps.db, deps.push, deps.now(), [
    {
      userId: guestId,
      title: "Removed",
      body: `${user.name} removed you from ${eventName}`,
      kind: "removed",
      refId: social.id,
      tag: `removed:social:${social.id}:${guestId}`,
    },
  ]);
}

async function removePlanGuest(deps: AppDeps, user: UserRow, rawPlanId: string, rawUserId: string): Promise<void> {
  const planId = parseId(rawPlanId);
  const guestId = parseId(rawUserId);
  const circle = requireCircle(deps, user.id);
  const plan = getPlan(deps.db, planId);
  if (!plan || plan.circle_id !== circle.id) throw new HttpError(404, "plan not found");
  if (guestId === plan.creator_id) throw new HttpError(400, "you made this plan");
  assertEventHost(deps, user, circle.id, plan.creator_id);
  const guest = listMembers(deps.db, circle.id).find((member) => member.id === guestId);
  if (!guest) throw new HttpError(404, "member not found");
  blockPlanGuest(deps.db, plan.id, guestId, deps.now(), user.name);
  await notifyUsers(deps.db, deps.push, deps.now(), [
    {
      userId: guestId,
      title: "Removed",
      body: `${user.name} removed you from ${plan.note}`,
      kind: "removed",
      refId: plan.id,
      tag: `removed:plan:${plan.id}:${guestId}`,
    },
  ]);
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

async function endSocial(deps: AppDeps, user: UserRow, rawId: string): Promise<void> {
  const id = parseId(rawId);
  const circle = requireCircle(deps, user.id);
  const social = getSocial(deps.db, id);
  if (!social || social.circle_id !== circle.id) throw new HttpError(404, "social not found");
  assertEventHost(deps, user, circle.id, social.creator_id);
  if (!deleteSocialById(deps.db, social.id)) throw new HttpError(404, "social not found");
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
    ]);
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
  })));
}

async function editSocial(deps: AppDeps, user: UserRow, rawId: string, body: Record<string, unknown>) {
  const id = parseId(rawId);
  const circle = requireCircle(deps, user.id);
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
    const coming = listSocialJoins(deps.db, social.id).filter((join) => isInReply(join.reply) && join.id !== user.id);
    const label = note.trim() || "Free now";
    await pushEdit(
      deps,
      deps.now(),
      coming.map((join) => join.id),
      `Updated: ${label}`,
      changeBody(changes),
      social.id,
      `/?social=${social.id}`,
    );
  }
  const fresh = getSocial(deps.db, social.id);
  if (!fresh) throw new HttpError(500, "social missing");
  return socialPayload(deps.db, fresh);
}

async function endPlan(deps: AppDeps, user: UserRow, rawId: string): Promise<void> {
  const id = parseId(rawId);
  const circle = requireCircle(deps, user.id);
  const plan = getPlan(deps.db, id);
  if (!plan || plan.circle_id !== circle.id) throw new HttpError(404, "plan not found");
  assertEventHost(deps, user, circle.id, plan.creator_id);
  if (!deletePlanById(deps.db, plan.id)) throw new HttpError(404, "plan not found");
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
    ]);
  }
}

async function editPlan(deps: AppDeps, user: UserRow, rawId: string, body: Record<string, unknown>) {
  const id = parseId(rawId);
  const circle = requireCircle(deps, user.id);
  const plan = getPlan(deps.db, id);
  if (!plan || plan.circle_id !== circle.id) throw new HttpError(404, "plan not found");
  assertEventHost(deps, user, circle.id, plan.creator_id);
  const now = deps.now();
  const today = isoDate(now, deps.config.tz);
  if (plan.for_date < today) throw new HttpError(410, "That plan has ended.");
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
  const noteChanged = note !== plan.note;
  const placeChanged = place !== (plan.place ?? "") || lat !== plan.lat || lng !== plan.lng;
  const timeChanged = atTime !== plan.at_time;
  patchPlanDetails(deps.db, plan.id, note, place, lat, lng, atTime);
  const changes = [];
  if (noteChanged) changes.push({ name: "Note", next: note });
  if (timeChanged) changes.push({ name: "Time", next: atTime ?? "" });
  if (placeChanged) changes.push({ name: "Place", next: place ? audiencePlace(place) : "" });
  if (changes.length) {
    const coming = listPlanJoins(deps.db, plan.id).filter((join) => isInReply(join.reply) && join.id !== user.id);
    await pushEdit(
      deps,
      now,
      coming.map((join) => join.id),
      `Plan changed: ${note}`,
      changeBody(changes),
      plan.id,
      `/?plan=${plan.id}`,
    );
  }
  const fresh = getPlan(deps.db, plan.id);
  if (!fresh) throw new HttpError(500, "plan missing");
  return planPayload(deps.db, fresh, today, addDays(today, 1));
}

function circlePayload(deps: AppDeps, req: http.IncomingMessage, circle: CircleRow, viewerId: string | null = null) {
  const members = listMembers(deps.db, circle.id);
  return {
    id: circle.id,
    name: circle.name,
    inviteCode: circle.invite_code,
    inviteUrl: `${requestOrigin(req, deps.config)}/join/${circle.invite_code}`,
    youAreAdmin: Boolean(viewerId && members.some((member) => member.id === viewerId && member.is_admin)),
    members: members.map((member) => ({ id: member.id, name: member.name, admin: Boolean(member.is_admin) })),
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
    creator: { id: social.creator_id, name: social.creator_name },
    removedBy: removedByName(viewerId ? getSocialReply(db, social.id, viewerId) : undefined),
    joined: listSocialJoins(db, social.id).map((join) => ({
      id: join.id,
      name: join.name,
      joinedAt: join.joined_at,
      reply: join.reply ?? "join",
      etaMin: join.eta_min ?? null,
      arriveAt: join.arrive_at ?? null,
    })),
  };
}

export function planPayload(db: DatabaseSync, plan: PlanRow, today: string, tomorrow: string, viewerId: string | null = null) {
  return {
    id: plan.id,
    note: plan.note,
    place: plan.place ?? "",
    forDate: plan.for_date,
    whenLabel: whenLabel(plan.for_date, today, tomorrow),
    time: plan.at_time,
    createdAt: plan.created_at,
    location: pointPayload(plan.lat, plan.lng),
    creator: { id: plan.creator_id, name: plan.creator_name },
    removedBy: removedByName(viewerId ? getPlanReply(db, plan.id, viewerId) : undefined),
    joined: listPlanJoins(db, plan.id).map((join) => ({
      id: join.id,
      name: join.name,
      joinedAt: join.joined_at,
      reply: join.reply ?? "coming",
      arriveAt: join.arrive_at ?? null,
    })),
  };
}

function requireUser(user: UserRow | undefined): UserRow {
  if (!user) throw new HttpError(401, "sign in required");
  return user;
}

export function requireCircle(deps: AppDeps, userId: string): CircleRow {
  const circle = getCircleForUser(deps.db, userId);
  if (!circle) throw new HttpError(409, "join a circle first");
  return circle;
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
  if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) throw new HttpError(400, "Pick a time later today.");
  const hour = Number(value.slice(0, 2));
  const minute = Number(value.slice(3, 5));
  if (hour > 23 || minute > 59) throw new HttpError(400, "Pick a time later today.");
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
