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
  countUpcomingPlans,
  deleteComment,
  deletePhoto,
  deletePlan,
  deletePushSubForUser,
  deleteSocial,
  getActiveSocialByCreator,
  getCircleByCode,
  getCircleForUser,
  getComment,
  getPhoto,
  getPhotoData,
  getPlan,
  getPlanReply,
  getSocial,
  getSocialReply,
  getUserByBuzzToken,
  getUserByTokenHash,
  hasSocialJoin,
  insertCircle,
  insertComment,
  insertPhoto,
  insertPlan,
  insertSocial,
  insertUser,
  listActiveSocials,
  listCommenterIds,
  listComments,
  listMembers,
  listNotifications,
  listPhotos,
  listPlanJoins,
  listPushSubs,
  listReactions,
  listSocialJoins,
  listVisiblePlans,
  markNotificationsRead,
  removeMember,
  removePlanJoin,
  removeSocialJoin,
  setPlanReply,
  setSocialReply,
  rotateBuzzToken,
  rotateInvite,
  deleteSessionByHash,
  insertSession,
  toggleReaction,
  updateComment,
  updatePlan,
  updateSocial,
  updateUserName,
  upsertPushSub,
  type CircleRow,
  type CommentRow,
  type PlanRow,
  type SocialRow,
  type UserRow,
} from "./db.js";
import { reversePlace, searchPlaces } from "./geocode.js";
import { extractBuzzSecret, humanCode } from "./code.js";
import { audiencePlace, eventTitle, freePushBody, notifyUsers, planReplyBody, replyPushBody, socialTitle } from "./notify.js";
import { cancelReplyPush, scheduleReplyPush } from "./reply-push.js";
import type { PushSender } from "./push.js";
import { addDays, clockLabel, isoDate, whenLabel, zonedDateTime } from "./time.js";

export type AppDeps = {
  db: DatabaseSync;
  push: PushSender;
  config: Config;
  now: () => number;
};

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/** A small fixed set keeps reactions readable on a card and stops arbitrary strings from being stored. */
export const REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🔥", "☕", "🍷"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The app shrinks a gallery photo to a ~1600 px JPEG first, so this is a generous ceiling. */
const PHOTO_MAX_BYTES = 3 * 1024 * 1024;
const PHOTOS_PER_EVENT = 1;

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

  // Photos arrive as raw image bytes, not JSON, so they are matched before the body is parsed.
  const photoUpload = matchPath(pathname, /^\/api\/(socials|plans)\/([^/]+)\/photos$/);
  if (photoUpload && method === "POST") {
    const me = requireUser(user);
    const event = requireOwnEvent(deps, me, photoUpload[1], photoUpload[2]);
    const data = await readImage(req);
    if (listPhotos(deps.db, event.ref).length >= PHOTOS_PER_EVENT) {
      throw new HttpError(409, "a social or plan has one photo");
    }
    insertPhoto(deps.db, {
      id: crypto.randomUUID(),
      socialId: event.ref.socialId ?? null,
      planId: event.ref.planId ?? null,
      mime: data.mime,
      data: data.bytes,
      createdAt: deps.now(),
    });
    sendJson(res, 201, { photos: photosPayload(deps.db, event.ref) });
    return;
  }

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
      circle: invited ? circlePayload(deps, req, invited) : null,
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
      sendJson(res, 200, { place: await reversePlace(lat, lng) });
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
    sendJson(res, 201, { circle: circlePayload(deps, req, circle) });
    return;
  }

  if (method === "POST" && pathname === "/api/circles/join") {
    const code = cleanCode(body.code);
    const circle = requireLiveInvite(deps.db, code, deps.now());
    const current = getCircleForUser(deps.db, me.id);
    if (current && current.id !== circle.id) throw new HttpError(409, "you are already in a circle");
    if (!current) addMember(deps.db, circle.id, me.id, deps.now());
    sendJson(res, 200, { circle: circlePayload(deps, req, circle) });
    return;
  }

  if (method === "POST" && pathname === "/api/circles/invite") {
    const circle = requireCircle(deps, me.id);
    const now = deps.now();
    rotateInvite(deps.db, circle.id, inviteCode(), now + INVITE_TTL_MS);
    const fresh = getCircleForUser(deps.db, me.id);
    if (!fresh) throw new HttpError(500, "circle missing");
    sendJson(res, 200, { circle: circlePayload(deps, req, fresh) });
    return;
  }

  if (method === "POST" && pathname === "/api/circles/leave") {
    const circle = getCircleForUser(deps.db, me.id);
    if (!circle) throw new HttpError(409, "join a circle first");
    removeMember(deps.db, circle.id, me.id);
    sendJson(res, 200, mePayload(deps, req, me));
    return;
  }

  if (method === "GET" && pathname === "/api/socials") {
    const circle = requireCircle(deps, me.id);
    const socials = listActiveSocials(deps.db, circle.id, deps.now()).map((row) => socialPayload(deps.db, row));
    sendJson(res, 200, { socials });
    return;
  }

  if (method === "POST" && pathname === "/api/socials") {
    const note = cleanNote(body.note, false);
    const result = await publishSocial(deps, me, note, readPoint(body), readPlace(body), readStart(body, deps.now(), deps.config.tz));
    sendJson(res, result.created ? 201 : 200, { social: result.social });
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

  const socialComments = matchPath(pathname, /^\/api\/socials\/([^/]+)\/comments$/);
  if (socialComments && method === "POST") {
    sendJson(res, 201, { social: await commentOnSocial(deps, me, socialComments[1], body) });
    return;
  }

  const socialId = matchPath(pathname, /^\/api\/socials\/([^/]+)$/);
  if (socialId && method === "DELETE") {
    const id = parseId(socialId[1]);
    const changes = deleteSocial(deps.db, id, me.id);
    if (!changes) throw new HttpError(404, "social not found");
    sendEmpty(res, 204);
    return;
  }

  if (method === "GET" && pathname === "/api/plans") {
    const circle = requireCircle(deps, me.id);
    const now = deps.now();
    const today = isoDate(now, deps.config.tz);
    const tomorrow = addDays(today, 1);
    const plans = listVisiblePlans(deps.db, circle.id, today, tomorrow).map((row) =>
      planPayload(deps.db, row, today, tomorrow),
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

  const planComments = matchPath(pathname, /^\/api\/plans\/([^/]+)\/comments$/);
  if (planComments && method === "POST") {
    sendJson(res, 201, { plan: await commentOnPlan(deps, me, planComments[1], body) });
    return;
  }

  const planId = matchPath(pathname, /^\/api\/plans\/([^/]+)$/);
  if (planId && method === "PATCH") {
    const note = cleanNote(body.note, true);
    const place = cleanPlace(body.place);
    sendJson(res, 200, { plan: await editPlan(deps, me, planId[1], note, place, readPoint(body)) });
    return;
  }

  if (planId && method === "DELETE") {
    const id = parseId(planId[1]);
    const changes = deletePlan(deps.db, id, me.id);
    if (!changes) throw new HttpError(404, "plan not found");
    sendEmpty(res, 204);
    return;
  }

  const commentReactions = matchPath(pathname, /^\/api\/comments\/([^/]+)\/reactions$/);
  if (commentReactions && method === "POST") {
    sendJson(res, 200, { comment: reactToComment(deps, me, commentReactions[1], body) });
    return;
  }

  const commentId = matchPath(pathname, /^\/api\/comments\/([^/]+)$/);
  if (commentId && method === "PATCH") {
    sendJson(res, 200, { comment: editComment(deps, me, commentId[1], body) });
    return;
  }
  if (commentId && method === "DELETE") {
    const comment = openComment(deps, me, commentId[1]);
    if (comment.author_id !== me.id) throw new HttpError(403, "only the author can delete a comment");
    deleteComment(deps.db, comment.id, me.id);
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

  const photoDelete = matchPath(pathname, /^\/api\/(socials|plans)\/([^/]+)\/photos\/([^/]+)$/);
  if (photoDelete && method === "DELETE") {
    const event = requireOwnEvent(deps, me, photoDelete[1], photoDelete[2]);
    const photo = getPhoto(deps.db, parseId(photoDelete[3]));
    const owned = photo && (photo.social_id ?? photo.plan_id) === (event.ref.socialId ?? event.ref.planId);
    if (!photo || !owned) throw new HttpError(404, "photo not found");
    deletePhoto(deps.db, photo.id);
    sendJson(res, 200, { photos: photosPayload(deps.db, event.ref) });
    return;
  }

  const photoFile = matchPath(pathname, /^\/api\/photos\/([^/]+)$/);
  if (photoFile && method === "GET") {
    const circle = requireCircle(deps, me.id);
    const photo = getPhoto(deps.db, parseId(photoFile[1]));
    const owner = photo?.social_id ? getSocial(deps.db, photo.social_id) : photo?.plan_id ? getPlan(deps.db, photo.plan_id) : undefined;
    const data = photo && owner?.circle_id === circle.id ? getPhotoData(deps.db, photo.id) : undefined;
    if (!photo || !data) throw new HttpError(404, "photo not found");
    // A photo id never points at different bytes, so the browser may keep it.
    res.writeHead(200, {
      "content-type": photo.mime,
      "content-length": data.byteLength,
      "cache-control": "private, max-age=86400, immutable",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
    });
    res.end(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
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

async function publishSocial(
  deps: AppDeps,
  user: UserRow,
  note: string | undefined,
  point?: { lat: number; lng: number } | null,
  place?: string,
  start?: number | null,
): Promise<{ created: boolean; social: ReturnType<typeof socialPayload> }> {
  const circle = requireCircle(deps, user.id);
  const now = deps.now();
  const existing = getActiveSocialByCreator(deps.db, user.id, now);
  let created = false;
  let socialId: string;
  let shouldNotify = true;
  let shifted = false;
  // A missing note on a live social keeps the current text. The original
  // createdAt stays put; expiry moves to now + TTL so the window is a full
  // TTL from this buzz and the two timestamps still describe one social.
  // A missing place and missing coordinates keep the saved meetup.
  // A missing start keeps a scheduled time. A later-today social lasts TTL from that time.
  const nextNote = note === undefined ? (existing?.note ?? "") : note;
  const keepWhere = place === undefined && point === undefined;
  const nextPlace = place === undefined ? (existing?.place ?? "") : place;
  const nextPoint = point === undefined
    ? (existing?.lat == null || existing?.lng == null ? null : { lat: existing.lat, lng: existing.lng })
    : point;
  const nextStart = start === undefined ? (existing?.starts_at ?? null) : start;
  const anchor = nextStart != null && nextStart > now ? nextStart : now;
  const expiresAt = anchor + deps.config.socialTtlMs;
  const fromTime = nextStart != null && nextStart > now ? clockLabel(nextStart, deps.config.tz) : "";
  const schedule = {
    startsAt: nextStart,
    remindedAt: nextStart != null && nextStart > now ? null : now,
  };
  if (!existing) {
    created = true;
    socialId = crypto.randomUUID();
    insertSocial(deps.db, {
      id: socialId,
      circleId: circle.id,
      creatorId: user.id,
      note: nextNote,
      createdAt: now,
      expiresAt,
      lat: nextPoint?.lat ?? null,
      lng: nextPoint?.lng ?? null,
      place: nextPlace,
      startsAt: nextStart,
    });
  } else {
    socialId = existing.id;
    const gap = now - existing.last_notified_at;
    const noteChanged = existing.note !== nextNote;
    const whereChanged = !keepWhere && (existing.place !== nextPlace || existing.lat !== (nextPoint?.lat ?? null) || existing.lng !== (nextPoint?.lng ?? null));
    const startChanged = (existing.starts_at ?? null) !== nextStart;
    shifted = startChanged;
    shouldNotify = startChanged || (noteChanged || whereChanged ? gap >= 15_000 : gap >= deps.config.renotifyMs);
    updateSocial(
      deps.db,
      existing.id,
      nextNote,
      expiresAt,
      shouldNotify ? now : existing.last_notified_at,
      keepWhere ? undefined : { point: nextPoint, place: nextPlace },
      start === undefined && !startChanged ? undefined : schedule,
    );
  }
  if (shouldNotify) {
    const title = shifted ? eventTitle("time") : fromTime ? eventTitle("later") : eventTitle("now");
    const recipients = listMembers(deps.db, circle.id).filter((member) => member.id !== user.id);
    await notifyUsers(
      deps.db,
      deps.push,
      now,
      recipients.map((member) => ({
        userId: member.id,
        title,
        body: freePushBody(user.name, nextPlace, fromTime, shifted, nextNote),
        url: `/?social=${socialId}`,
        kind: "social",
        refId: socialId,
        tag: `social:${socialId}`,
      })),
    );
  }
  const social = getSocial(deps.db, socialId);
  if (!social) throw new HttpError(500, "social missing");
  return { created, social: socialPayload(deps.db, social) };
}

async function joinSocial(deps: AppDeps, user: UserRow, rawId: string) {
  const id = parseId(rawId);
  const circle = requireCircle(deps, user.id);
  const social = getSocial(deps.db, id);
  if (!social || social.circle_id !== circle.id) throw new HttpError(404, "social not found");
  const now = deps.now();
  if (social.expires_at <= now) throw new HttpError(410, "that social has ended");
  if (social.creator_id === user.id) throw new HttpError(400, "you started this one");
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

function normalizeReply(value: unknown): "coming" | "declined" {
  if (value === "declined" || value === "cant" || value === "can't") return "declined";
  if (value === "coming" || value === "join" || value === "in") return "coming";
  throw new HttpError(400, "reply must be in or can't");
}

async function replySocial(deps: AppDeps, user: UserRow, rawId: string, body: Record<string, unknown>) {
  const id = parseId(rawId);
  const circle = requireCircle(deps, user.id);
  const social = getSocial(deps.db, id);
  if (!social || social.circle_id !== circle.id) throw new HttpError(404, "social not found");
  const now = deps.now();
  if (social.expires_at <= now) throw new HttpError(410, "that social has ended");
  if (social.creator_id === user.id) throw new HttpError(400, "you started this one");
  const reply = normalizeReply(body.reply);
  const live = social.starts_at == null || social.starts_at <= now;
  let eta: number | null = null;
  let arriveAt: number | null = null;
  if (reply === "coming" && body.arriveAt != null && body.arriveAt !== "") {
    const windowStart = live ? now : (social.starts_at ?? now);
    arriveAt = readArriveAt(body.arriveAt, now, deps.config.tz, windowStart, social.expires_at);
  } else if (reply === "coming" && live && body.eta != null) {
    const minutes = Number(body.eta);
    if (![5, 10, 20].includes(minutes)) throw new HttpError(400, "eta must be 5, 10, or 20");
    eta = minutes;
  }
  const previous = getSocialReply(deps.db, social.id, user.id);
  const changed = !previous || previous.reply !== reply || (previous.eta_min ?? null) !== eta || (previous.arrive_at ?? null) !== arriveAt;
  setSocialReply(deps.db, social.id, user.id, now, reply, eta, arriveAt);
  const key = `${social.id}:${user.id}`;
  const becameComing = reply === "coming" && previous?.reply !== "coming";
  const arriveChanged = reply === "coming" && (previous?.arrive_at ?? null) !== arriveAt && arriveAt != null;
  const etaOnly = previous?.reply === "coming" && reply === "coming" && !arriveChanged;
  const held = cancelReplyPush(key);
  const arriveLabel = arriveAt ? clockLabel(arriveAt, deps.config.tz) : "";
  const notice = () => notifyUsers(deps.db, deps.push, now, [
    {
      userId: social.creator_id,
      title: eventTitle("reply"),
      body: replyPushBody(user.name, reply, eta, arriveLabel),
      kind: "reply",
      refId: social.id,
      tag: `reply:${social.id}:${user.id}`,
      url: `/?social=${social.id}`,
    },
  ]);
  if (held || (becameComing && (eta != null || arriveAt != null))) {
    await notice();
  } else if (becameComing) {
    scheduleReplyPush(key, notice);
  } else if (arriveChanged) {
    await notice();
  } else if (etaOnly) {
    /* The host already got the coming push. A 5/10/20 chip a moment later stays on the card. */
  } else if (changed) {
    await notice();
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

async function publishPlan(
  deps: AppDeps,
  user: UserRow,
  note: string,
  place: string,
  point?: { lat: number; lng: number } | null,
) {
  const circle = requireCircle(deps, user.id);
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
  });
  const recipients = listMembers(deps.db, circle.id).filter((member) => member.id !== user.id);
  await notifyUsers(
    deps.db,
    deps.push,
    now,
    recipients.map((member) => ({
      userId: member.id,
      title: "Tomorrow",
      body: place ? `${user.name}: ${note} · ${audiencePlace(place)}` : `${user.name}: ${note}`,
      kind: "plan",
      refId: id,
      tag: `plan:${id}`,
      url: `/?plan=${id}`,
    })),
  );
  const plan = getPlan(deps.db, id);
  if (!plan) throw new HttpError(500, "plan missing");
  return planPayload(deps.db, plan, today, tomorrow);
}

/** Only the host edits a plan. Friends who said they're coming hear about a change. */
async function editPlan(
  deps: AppDeps,
  user: UserRow,
  rawId: string,
  note: string,
  place: string,
  point?: { lat: number; lng: number } | null,
) {
  const id = parseId(rawId);
  const circle = requireCircle(deps, user.id);
  const plan = getPlan(deps.db, id);
  if (!plan || plan.circle_id !== circle.id) throw new HttpError(404, "plan not found");
  if (plan.creator_id !== user.id) throw new HttpError(403, "only the host can edit this plan");
  const now = deps.now();
  const today = isoDate(now, deps.config.tz);
  const tomorrow = addDays(today, 1);
  if (plan.for_date < today) throw new HttpError(410, "that plan has ended");
  updatePlan(deps.db, plan.id, note, place, point);
  if (plan.note !== note || plan.place !== place) {
    const coming = listPlanJoins(deps.db, plan.id).filter((join) => join.reply === "coming");
    await notifyUsers(
      deps.db,
      deps.push,
      now,
      coming.map((join) => ({
        userId: join.id,
        title: "Plan changed",
        body: place ? `${user.name}: ${note} · ${audiencePlace(place)}` : `${user.name}: ${note}`,
        kind: "plan",
        refId: plan.id,
        tag: `plan:${plan.id}`,
        url: `/?plan=${plan.id}`,
      })),
    );
  }
  const fresh = getPlan(deps.db, plan.id);
  if (!fresh) throw new HttpError(500, "plan missing");
  return planPayload(deps.db, fresh, today, tomorrow);
}

async function joinPlan(deps: AppDeps, user: UserRow, rawId: string) {
  const id = parseId(rawId);
  const circle = requireCircle(deps, user.id);
  const plan = getPlan(deps.db, id);
  if (!plan || plan.circle_id !== circle.id) throw new HttpError(404, "plan not found");
  const now = deps.now();
  const today = isoDate(now, deps.config.tz);
  const tomorrow = addDays(today, 1);
  if (plan.for_date < today) throw new HttpError(410, "that plan has ended");
  if (plan.creator_id === user.id) throw new HttpError(400, "you made this plan");
  await setPlanComing(deps, user, plan, now);
  const fresh = getPlan(deps.db, plan.id);
  if (!fresh) throw new HttpError(500, "plan missing");
  return planPayload(deps.db, fresh, today, tomorrow);
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
  await notifyPlanReply(deps, user, plan, now, "coming");
}

async function replyPlan(deps: AppDeps, user: UserRow, rawId: string, body: Record<string, unknown>) {
  const id = parseId(rawId);
  const circle = requireCircle(deps, user.id);
  const plan = getPlan(deps.db, id);
  if (!plan || plan.circle_id !== circle.id) throw new HttpError(404, "plan not found");
  const now = deps.now();
  const today = isoDate(now, deps.config.tz);
  if (plan.for_date < today) throw new HttpError(410, "that plan has ended");
  if (plan.creator_id === user.id) throw new HttpError(400, "you made this plan");
  const reply = normalizeReply(body.reply);
  if (reply === "coming") {
    const previous = getPlanReply(deps.db, plan.id, user.id);
    let arriveAt: number | null = previous?.reply === "coming" ? (previous.arrive_at ?? null) : null;
    if (body.arriveAt) arriveAt = readPlanArrive(body.arriveAt, plan.for_date, now, deps.config.tz);
    const became = previous?.reply !== "coming";
    const arriveChanged = (previous?.arrive_at ?? null) !== arriveAt && arriveAt != null;
    setPlanReply(deps.db, plan.id, user.id, now, "coming", arriveAt);
    if (became || arriveChanged) {
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
      ]);
    }
  } else {
    const previous = getPlanReply(deps.db, plan.id, user.id);
    if (previous?.reply !== "declined") {
      setPlanReply(deps.db, plan.id, user.id, now, "declined", null);
      await notifyPlanReply(deps, user, plan, now, "declined");
    }
  }
  const fresh = getPlan(deps.db, plan.id);
  if (!fresh) throw new HttpError(500, "plan missing");
  return planPayload(deps.db, fresh, today, addDays(today, 1));
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
  ]);
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

async function commentOnSocial(deps: AppDeps, user: UserRow, rawId: string, body: Record<string, unknown>) {
  const id = parseId(rawId);
  const circle = requireCircle(deps, user.id);
  const social = getSocial(deps.db, id);
  if (!social || social.circle_id !== circle.id) throw new HttpError(404, "social not found");
  const now = deps.now();
  if (social.expires_at <= now) throw new HttpError(410, "that social has ended");
  const text = cleanComment(body.body);
  insertComment(deps.db, { id: crypto.randomUUID(), socialId: social.id, planId: null, authorId: user.id, body: text, createdAt: now });
  await notifyComment(deps, user, now, text, {
    creatorId: social.creator_id,
    commenterIds: listCommenterIds(deps.db, { socialId: social.id }),
    title: socialTitle(social.note),
    refId: social.id,
    url: `/?social=${social.id}`,
  });
  return socialPayload(deps.db, social);
}

async function commentOnPlan(deps: AppDeps, user: UserRow, rawId: string, body: Record<string, unknown>) {
  const id = parseId(rawId);
  const circle = requireCircle(deps, user.id);
  const plan = getPlan(deps.db, id);
  if (!plan || plan.circle_id !== circle.id) throw new HttpError(404, "plan not found");
  const now = deps.now();
  const today = isoDate(now, deps.config.tz);
  if (plan.for_date < today) throw new HttpError(410, "that plan has ended");
  const text = cleanComment(body.body);
  insertComment(deps.db, { id: crypto.randomUUID(), socialId: null, planId: plan.id, authorId: user.id, body: text, createdAt: now });
  await notifyComment(deps, user, now, text, {
    creatorId: plan.creator_id,
    commenterIds: listCommenterIds(deps.db, { planId: plan.id }),
    title: `"${plan.note}"`,
    refId: plan.id,
    url: `/?plan=${plan.id}`,
  });
  return planPayload(deps.db, plan, today, addDays(today, 1));
}

/** The host and everyone who already commented hear about a new comment. Reactions stay quiet. */
async function notifyComment(
  deps: AppDeps,
  author: UserRow,
  now: number,
  text: string,
  event: { creatorId: string; commenterIds: string[]; title: string; refId: string; url: string },
): Promise<void> {
  const recipients = new Set([event.creatorId, ...event.commenterIds]);
  recipients.delete(author.id);
  const snippet = text.length > 80 ? `${text.slice(0, 79)}…` : text;
  await notifyUsers(
    deps.db,
    deps.push,
    now,
    [...recipients].map((userId) => ({
      userId,
      title: event.title,
      body: `${author.name}: ${snippet.replace(/\s+/g, " ")}`,
      kind: "comment",
      refId: event.refId,
      tag: `comment:${event.refId}`,
      url: event.url,
    })),
  );
}

/** A comment is reachable while its social or plan is still on in the viewer's circle. */
function openComment(deps: AppDeps, user: UserRow, rawId: string): CommentRow {
  const comment = getComment(deps.db, parseId(rawId));
  if (!comment) throw new HttpError(404, "comment not found");
  const circle = requireCircle(deps, user.id);
  const now = deps.now();
  if (comment.social_id) {
    const social = getSocial(deps.db, comment.social_id);
    if (!social || social.circle_id !== circle.id) throw new HttpError(404, "comment not found");
    if (social.expires_at <= now) throw new HttpError(410, "that social has ended");
  } else {
    const plan = comment.plan_id ? getPlan(deps.db, comment.plan_id) : undefined;
    if (!plan || plan.circle_id !== circle.id) throw new HttpError(404, "comment not found");
    if (plan.for_date < isoDate(now, deps.config.tz)) throw new HttpError(410, "that plan has ended");
  }
  return comment;
}

function editComment(deps: AppDeps, user: UserRow, rawId: string, body: Record<string, unknown>) {
  const comment = openComment(deps, user, rawId);
  if (comment.author_id !== user.id) throw new HttpError(403, "only the author can edit a comment");
  const text = cleanComment(body.body);
  if (text !== comment.body) updateComment(deps.db, comment.id, user.id, text, deps.now());
  const fresh = getComment(deps.db, comment.id);
  if (!fresh) throw new HttpError(500, "comment missing");
  return commentPayload(deps.db, fresh);
}

function reactToComment(deps: AppDeps, user: UserRow, rawId: string, body: Record<string, unknown>) {
  const comment = openComment(deps, user, rawId);
  if (typeof body.emoji !== "string" || !REACTIONS.includes(body.emoji)) {
    throw new HttpError(400, `emoji must be one of ${REACTIONS.join(" ")}`);
  }
  toggleReaction(deps.db, comment.id, user.id, body.emoji, deps.now());
  return commentPayload(deps.db, comment);
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
    circle: circle ? circlePayload(deps, req, circle) : null,
  };
}

function circlePayload(deps: AppDeps, req: http.IncomingMessage, circle: CircleRow) {
  return {
    id: circle.id,
    name: circle.name,
    inviteCode: circle.invite_code,
    inviteUrl: `${requestOrigin(req, deps.config)}/join/${circle.invite_code}`,
    members: listMembers(deps.db, circle.id).map((member) => ({ id: member.id, name: member.name })),
  };
}

function socialPayload(db: DatabaseSync, social: SocialRow) {
  return {
    id: social.id,
    note: social.note,
    createdAt: social.created_at,
    startsAt: social.starts_at,
    expiresAt: social.expires_at,
    place: social.place ?? "",
    location: pointPayload(social.lat, social.lng),
    photos: photosPayload(db, { socialId: social.id }),
    creator: { id: social.creator_id, name: social.creator_name },
    joined: listSocialJoins(db, social.id).map((join) => ({
      id: join.id,
      name: join.name,
      joinedAt: join.joined_at,
      reply: join.reply ?? "join",
      etaMin: join.eta_min ?? null,
      arriveAt: join.arrive_at ?? null,
    })),
    comments: listComments(db, { socialId: social.id }).map((comment) => commentPayload(db, comment)),
  };
}

function planPayload(db: DatabaseSync, plan: PlanRow, today: string, tomorrow: string) {
  return {
    id: plan.id,
    note: plan.note,
    place: plan.place ?? "",
    forDate: plan.for_date,
    whenLabel: whenLabel(plan.for_date, today, tomorrow),
    createdAt: plan.created_at,
    location: pointPayload(plan.lat, plan.lng),
    photos: photosPayload(db, { planId: plan.id }),
    creator: { id: plan.creator_id, name: plan.creator_name },
    joined: listPlanJoins(db, plan.id).map((join) => ({
      id: join.id,
      name: join.name,
      joinedAt: join.joined_at,
      reply: join.reply ?? "coming",
      arriveAt: join.arrive_at ?? null,
    })),
    comments: listComments(db, { planId: plan.id }).map((comment) => commentPayload(db, comment)),
  };
}

/** Reactions carry the user ids so each viewer can tell which ones are theirs. */
function commentPayload(db: DatabaseSync, comment: CommentRow) {
  const reactions = new Map<string, string[]>();
  for (const row of listReactions(db, comment.id)) {
    reactions.set(row.emoji, [...(reactions.get(row.emoji) ?? []), row.user_id]);
  }
  return {
    id: comment.id,
    author: { id: comment.author_id, name: comment.author_name },
    body: comment.body,
    createdAt: comment.created_at,
    editedAt: comment.edited_at,
    reactions: REACTIONS.filter((emoji) => reactions.has(emoji)).map((emoji) => ({ emoji, userIds: reactions.get(emoji) ?? [] })),
  };
}

function photosPayload(db: DatabaseSync, ref: { socialId?: string; planId?: string }) {
  return listPhotos(db, ref).map((photo) => ({ id: photo.id }));
}

/** Only the person who made a social or plan can add or remove its photos, and only while it is still on. */
function requireOwnEvent(
  deps: AppDeps,
  user: UserRow,
  kind: string,
  rawId: string,
): { ref: { socialId?: string; planId?: string } } {
  const id = parseId(rawId);
  const circle = requireCircle(deps, user.id);
  if (kind === "socials") {
    const social = getSocial(deps.db, id);
    if (!social || social.circle_id !== circle.id) throw new HttpError(404, "social not found");
    if (social.creator_id !== user.id) throw new HttpError(403, "only the host can change photos");
    if (social.expires_at <= deps.now()) throw new HttpError(410, "that social has ended");
    return { ref: { socialId: social.id } };
  }
  const plan = getPlan(deps.db, id);
  if (!plan || plan.circle_id !== circle.id) throw new HttpError(404, "plan not found");
  if (plan.creator_id !== user.id) throw new HttpError(403, "only the host can change photos");
  if (plan.for_date < isoDate(deps.now(), deps.config.tz)) throw new HttpError(410, "that plan has ended");
  return { ref: { planId: plan.id } };
}

function requireUser(user: UserRow | undefined): UserRow {
  if (!user) throw new HttpError(401, "sign in required");
  return user;
}

function requireCircle(deps: AppDeps, userId: string): CircleRow {
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

function parseId(value: string): string {
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

function readArriveAt(value: unknown, now: number, tz: string, start: number, end: number): number {
  if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) {
    throw new HttpError(400, "Pick a time you can arrive.");
  }
  const hour = Number(value.slice(0, 2));
  const minute = Number(value.slice(3, 5));
  if (hour > 23 || minute > 59) throw new HttpError(400, "Pick a time you can arrive.");
  const day = isoDate(Math.max(start, now), tz);
  let at: number;
  try {
    at = zonedDateTime(day, value, tz);
    if (at < start) {
      const next = zonedDateTime(addDays(day, 1), value, tz);
      if (next <= end) at = next;
    }
  } catch {
    throw new HttpError(400, "Pick a time you can arrive.");
  }
  if (at <= now || at < start || at > end) throw new HttpError(400, "Pick a time you can arrive.");
  return at;
}

function readPlanArrive(value: unknown, day: string, now: number, tz: string): number {
  const start = zonedDateTime(day, "06:00", tz);
  const end = zonedDateTime(day, "23:59", tz);
  return readArriveAt(value, now, tz, start, end);
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

/** Line breaks survive so a longer thought can breathe. Runs of blank lines do not. */
function cleanComment(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "comment is required");
  const text = value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text.length < 1) throw new HttpError(400, "comment is required");
  if (text.length > 500) throw new HttpError(400, "comment is too long (500)");
  return text;
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

async function readImage(req: http.IncomingMessage): Promise<{ mime: string; bytes: Uint8Array }> {
  const declared = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (!declared.startsWith("image/")) throw new HttpError(415, "send the photo as an image");
  const bytes = await readRaw(req, PHOTO_MAX_BYTES, "photo is too large");
  // Trust the bytes, not the header, so nothing but a picture is ever served back.
  const mime = sniffImage(bytes);
  if (!mime) throw new HttpError(415, "that file is not a JPEG, PNG, or WebP photo");
  return { mime, bytes };
}

function sniffImage(bytes: Uint8Array): string | null {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length > 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}

function readRaw(req: http.IncomingMessage, limit: number, tooLarge: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, tooLarge));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    req.on("error", reject);
  });
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
