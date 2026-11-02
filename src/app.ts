import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import type { Config } from "./config.js";
import {
  addMember,
  addPlanJoin,
  addSocialJoin,
  countUpcomingPlans,
  deletePlan,
  deletePushSubForUser,
  deleteSocial,
  getActiveSocialByCreator,
  getCircleByCode,
  getCircleForUser,
  getPlan,
  getSocial,
  getUserByBuzzToken,
  getUserByTokenHash,
  hasPlanJoin,
  hasSocialJoin,
  insertCircle,
  insertPlan,
  insertSocial,
  insertUser,
  listActiveSocials,
  listMembers,
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
  rotateSession,
  updateSocial,
  updateUserName,
  upsertPushSub,
  type CircleRow,
  type PlanRow,
  type SocialRow,
  type UserRow,
} from "./db.js";
import { notifyUsers, socialTitle } from "./notify.js";
import type { PushSender } from "./push.js";
import { addDays, isoDate, whenLabel } from "./time.js";

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

async function handle(req: http.IncomingMessage, res: http.ServerResponse, deps: AppDeps): Promise<void> {
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
    });
    return;
  }

  if (method === "POST" && pathname === "/api/auth/start") {
    const name = cleanLabel(body.name, "name", 24);
    const now = deps.now();
    const token = randomToken();
    const buzzToken = randomToken();
    const id = crypto.randomUUID();
    insertUser(deps.db, {
      id,
      name,
      token_hash: sha256(token),
      buzz_token: buzzToken,
      created_at: now,
    });
    sendJson(res, 201, { token, buzzToken, user: { id, name } });
    return;
  }

  if (method === "POST" && pathname === "/api/auth/recover") {
    const secret = typeof body.token === "string" ? body.token.trim() : "";
    const existing = secret ? getUserByBuzzToken(deps.db, secret) : undefined;
    if (!existing) throw new HttpError(401, "unknown recovery code");
    const token = randomToken();
    rotateSession(deps.db, existing.id, sha256(token));
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
    const result = await publishSocial(deps, buzzer, note);
    sendJson(res, result.created ? 201 : 200, { social: result.social });
    return;
  }

  const me = requireUser(user);

  if (method === "POST" && pathname === "/api/auth/logout") {
    rotateSession(deps.db, me.id, sha256(randomToken()));
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
    const buzzToken = randomToken();
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
    const circle = getCircleByCode(deps.db, code);
    if (!circle) throw new HttpError(404, "invite not found");
    const current = getCircleForUser(deps.db, me.id);
    if (current && current.id !== circle.id) throw new HttpError(409, "you are already in a circle");
    if (!current) addMember(deps.db, circle.id, me.id, deps.now());
    sendJson(res, 200, { circle: circlePayload(deps, req, circle) });
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
    const result = await publishSocial(deps, me, note);
    sendJson(res, result.created ? 201 : 200, { social: result.social });
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
    sendJson(res, 201, { plan: await publishPlan(deps, me, note) });
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
  if (planId && method === "DELETE") {
    const id = parseId(planId[1]);
    const changes = deletePlan(deps.db, id, me.id);
    if (!changes) throw new HttpError(404, "plan not found");
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
    sendJson(res, 204, {});
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

async function publishSocial(
  deps: AppDeps,
  user: UserRow,
  note: string | undefined,
): Promise<{ created: boolean; social: ReturnType<typeof socialPayload> }> {
  const circle = requireCircle(deps, user.id);
  const now = deps.now();
  const existing = getActiveSocialByCreator(deps.db, user.id, now);
  let created = false;
  let socialId: string;
  let shouldNotify = true;
  // A missing note on a live social keeps the current text. The original
  // createdAt stays put; expiry moves to now + TTL so the window is a full
  // TTL from this buzz and the two timestamps still describe one social.
  const nextNote = note === undefined ? (existing?.note ?? "") : note;
  if (!existing) {
    created = true;
    socialId = crypto.randomUUID();
    insertSocial(deps.db, {
      id: socialId,
      circleId: circle.id,
      creatorId: user.id,
      note: nextNote,
      createdAt: now,
      expiresAt: now + deps.config.socialTtlMs,
    });
  } else {
    socialId = existing.id;
    const gap = now - existing.last_notified_at;
    const noteChanged = existing.note !== nextNote;
    shouldNotify = noteChanged ? gap >= 15_000 : gap >= deps.config.renotifyMs;
    updateSocial(
      deps.db,
      existing.id,
      nextNote,
      now + deps.config.socialTtlMs,
      shouldNotify ? now : existing.last_notified_at,
    );
  }
  if (shouldNotify) {
    const title = socialTitle(nextNote);
    const recipients = listMembers(deps.db, circle.id).filter((member) => member.id !== user.id);
    await notifyUsers(
      deps.db,
      deps.push,
      now,
      recipients.map((member) => ({
        userId: member.id,
        title,
        body: `${user.name} is free now`,
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
        title: socialTitle(social.note),
        body: `${user.name} joined your social!`,
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

async function publishPlan(deps: AppDeps, user: UserRow, note: string) {
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
  });
  const recipients = listMembers(deps.db, circle.id).filter((member) => member.id !== user.id);
  await notifyUsers(
    deps.db,
    deps.push,
    now,
    recipients.map((member) => ({
      userId: member.id,
      title: "Tomorrow",
      body: `${user.name}: ${note}`,
      kind: "plan",
      refId: id,
      tag: `plan:${id}`,
    })),
  );
  const plan = getPlan(deps.db, id);
  if (!plan) throw new HttpError(500, "plan missing");
  return planPayload(deps.db, plan, today, tomorrow);
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
  if (!hasPlanJoin(deps.db, plan.id, user.id)) {
    addPlanJoin(deps.db, plan.id, user.id, now);
    await notifyUsers(deps.db, deps.push, now, [
      {
        userId: plan.creator_id,
        title: socialTitle(plan.note),
        body: `${user.name} joined your plan`,
        kind: "plan-join",
        refId: plan.id,
        tag: `plan-join:${plan.id}:${user.id}`,
      },
    ]);
  }
  const fresh = getPlan(deps.db, plan.id);
  if (!fresh) throw new HttpError(500, "plan missing");
  return planPayload(deps.db, fresh, today, tomorrow);
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
    expiresAt: social.expires_at,
    creator: { id: social.creator_id, name: social.creator_name },
    joined: listSocialJoins(db, social.id).map((join) => ({
      id: join.id,
      name: join.name,
      joinedAt: join.joined_at,
    })),
  };
}

function planPayload(db: DatabaseSync, plan: PlanRow, today: string, tomorrow: string) {
  return {
    id: plan.id,
    note: plan.note,
    forDate: plan.for_date,
    whenLabel: whenLabel(plan.for_date, today, tomorrow),
    createdAt: plan.created_at,
    creator: { id: plan.creator_id, name: plan.creator_name },
    joined: listPlanJoins(db, plan.id).map((join) => ({
      id: join.id,
      name: join.name,
      joinedAt: join.joined_at,
    })),
  };
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
