import http from "node:http";
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
import {
  type FeedbackStatus,
  cleanFeedbackNote,
  cleanPrUrl,
  isFeedbackStatus,
  listFeedback,
  updateFeedback,
} from "./feedback.js";
import type { AppDeps } from "../app.js";
import { deleteCircle, getCircleById, getUserById, isCircleAdmin, listUserAvatarRevs, setBuzzAnimation, setCircleAdmin } from "../db.js";
import { avatarFile } from "../lib/avatar.js";
import type { RouteContext } from "../lib/context.js";
import { sendJson } from "../lib/http.js";
import { UUID_RE, parseId } from "../lib/validate.js";
import { parseBuzzAnimation } from "../social/buzz-animation.js";

export async function handleAdminRoutes(ctx: RouteContext): Promise<boolean> {
  const { req, res, deps, method, pathname, body } = ctx;
  if (isOperatorPath(pathname)) {
    await handleAdmin(req, res, deps, method, pathname, body);
    return true;
  }
  return false;
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
  if (method === "POST" && /^\/api\/admin\/users\/[^/]+\/buzz-animation$/.test(pathname)) {
    setBuzzAnimationAsOperator(res, deps, pathname, body);
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
  if (method === "GET" && pathname === "/api/admin/avatars") {
    await listAvatarsAsOperator(res, deps);
    return;
  }
  if ((method === "GET" || method === "HEAD") && /^\/api\/admin\/avatars\/[^/]*$/.test(pathname)) {
    await sendAvatarAsOperator(res, deps, method, pathname);
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
    || /^\/api\/admin\/users\/[^/]+\/buzz-animation$/.test(pathname)
    || pathname === "/api/admin/feedback"
    || /^\/api\/admin\/feedback\/[^/]+$/.test(pathname)
    || pathname === "/api/admin/avatars"
    || /^\/api\/admin\/avatars\/[^/]*$/.test(pathname);
}

/** Backup inventory: only users whose photo file is readable. Ids and file facts, no profile fields. */
async function listAvatarsAsOperator(res: http.ServerResponse, deps: AppDeps): Promise<void> {
  const avatars: Array<{ id: string; avatarRev: number | null; mime: string; bytes: number }> = [];
  for (const row of listUserAvatarRevs(deps.db)) {
    if (!UUID_RE.test(row.id)) continue;
    const file = await avatarFile(deps.config.avatarDir, row.id);
    if (!file) continue;
    avatars.push({ id: row.id, avatarRev: row.avatar_rev ?? null, mime: file.mime, bytes: file.data.length });
  }
  console.log(`admin avatars ok rows=${avatars.length}`);
  sendJson(res, 200, { avatars });
}

/** Raw photo bytes for a one-shot backup. Read only, never cached. */
async function sendAvatarAsOperator(
  res: http.ServerResponse,
  deps: AppDeps,
  method: string,
  pathname: string,
): Promise<void> {
  const match = /^\/api\/admin\/avatars\/([^/]*)$/.exec(pathname);
  let id = "";
  try {
    id = parseId(match?.[1] ?? "");
  } catch {
    console.log("admin avatar denied");
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const file = getUserById(deps.db, id) ? await avatarFile(deps.config.avatarDir, id) : null;
  if (!file) {
    console.log("admin avatar denied");
    sendJson(res, 404, { error: "not found" });
    return;
  }
  console.log(`admin avatar ok bytes=${file.data.length}`);
  res.writeHead(200, {
    "content-type": file.mime,
    "content-length": file.data.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  if (method === "HEAD") res.end();
  else res.end(file.data);
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
  const { doneAlert, ...feedback } = updated;
  console.log(`admin feedback update ok id=${feedback.id} status=${feedback.status} alert=${doneAlert}`);
  sendJson(res, 200, { feedback, doneAlert });
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

/** Sets ("birthday") or clears (null) the special buzzer animation for one user. Unknown user 404, any other value 400. */
function setBuzzAnimationAsOperator(
  res: http.ServerResponse,
  deps: AppDeps,
  pathname: string,
  body: Record<string, unknown>,
): void {
  const match = /^\/api\/admin\/users\/([^/]+)\/buzz-animation$/.exec(pathname);
  let userId = "";
  try {
    userId = parseId(match?.[1] ?? "");
  } catch {
    console.log("admin buzz animation denied");
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const user = getUserById(deps.db, userId);
  if (!user) {
    console.log("admin buzz animation denied");
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const animation = parseBuzzAnimation(body.buzzAnimation);
  if (animation === undefined) {
    console.log("admin buzz animation denied");
    sendJson(res, 400, { error: "invalid buzzAnimation" });
    return;
  }
  setBuzzAnimation(deps.db, user.id, animation);
  console.log(`admin buzz animation ok user=${user.id} animation=${animation}`);
  sendJson(res, 200, { ok: true, user: { id: user.id, name: user.name }, buzzAnimation: animation });
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
