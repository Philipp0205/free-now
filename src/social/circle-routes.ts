import {
  addMember,
  clearRemoval,
  deleteCircle,
  getCircleById,
  isCircleAdmin,
  kickMember,
  listCirclesForUser,
  listMembers,
  removalBlocksJoin,
  removeMember,
  rotateInvite,
  setCircleAdmin,
  updateCircleName,
} from "../db.js";
import type { AuthedRouteContext } from "../lib/context.js";
import { HttpError, matchPath, sendEmpty, sendJson } from "../lib/http.js";
import { cleanCode, cleanLabel, parseId } from "../lib/validate.js";
import {
  INVITE_TTL_MS,
  circlePayload,
  createCircle,
  inviteCode,
  mePayload,
  notifyCircleDeleted,
  notifyMemberJoined,
  requireAdmin,
  requireCircle,
  requireLiveInvite,
} from "./circles.js";
import { pastDays } from "./past.js";
import { sweepOrphanPhotos } from "./event-photo.js";

export async function handleCircleRoutes(ctx: AuthedRouteContext): Promise<boolean> {
  const { req, res, deps, method, pathname, body, requested, me, agent } = ctx;
  if (method === "POST" && pathname === "/api/circles") {
    const name = body.name == null || body.name === "" ? "friends" : cleanLabel(body.name, "circle name", 32);
    const now = deps.now();
    const circle = createCircle(deps, me.id, name, now);
    sendJson(res, 201, { circle: circlePayload(deps, req, circle, me.id) });
    return true;
  }

  if (method === "POST" && pathname === "/api/circles/join") {
    const code = cleanCode(body.code);
    const circle = requireLiveInvite(deps.db, code, deps.now());
    const already = listCirclesForUser(deps.db, me.id).some((item) => item.id === circle.id);
    if (!already && removalBlocksJoin(deps.db, circle.id, me.id, circle.invite_code)) {
      throw new HttpError(403, "An admin removed you from this circle.");
    }
    if (!already) {
      addMember(deps.db, circle.id, me.id, deps.now());
      await notifyMemberJoined(deps, circle, me);
    }
    sendJson(res, 200, { circle: circlePayload(deps, req, circle, me.id) });
    return true;
  }

  if (method === "POST" && pathname === "/api/circles/invite") {
    const circle = requireCircle(deps, me.id, requested);
    const now = deps.now();
    rotateInvite(deps.db, circle.id, inviteCode(), now + INVITE_TTL_MS);
    const fresh = getCircleById(deps.db, circle.id);
    if (!fresh) throw new HttpError(500, "circle missing");
    sendJson(res, 200, { circle: circlePayload(deps, req, fresh, me.id) });
    return true;
  }

  const removal = matchPath(pathname, /^\/api\/circles\/removals\/([^/]+)$/);
  if (removal && method === "DELETE") {
    const circle = requireCircle(deps, me.id, requested);
    requireAdmin(deps, circle.id, me.id);
    clearRemoval(deps.db, circle.id, parseId(removal[1]));
    sendEmpty(res, 204);
    return true;
  }

  if (method === "PATCH" && pathname === "/api/circles") {
    const circle = requireCircle(deps, me.id, requested);
    if (!isCircleAdmin(deps.db, circle.id, me.id)) throw new HttpError(403, "Only an admin can do that.");
    const name = cleanLabel(body.name, "circle name", 32);
    updateCircleName(deps.db, circle.id, name);
    const fresh = getCircleById(deps.db, circle.id);
    if (!fresh) throw new HttpError(500, "circle missing");
    sendJson(res, 200, { circle: circlePayload(deps, req, fresh, me.id) });
    return true;
  }

  if (method === "DELETE" && pathname === "/api/circles") {
    const circle = requireCircle(deps, me.id, requested);
    requireAdmin(deps, circle.id, me.id);
    const members = listMembers(deps.db, circle.id);
    const removed = deleteCircle(deps.db, circle.id);
    if (!removed) throw new HttpError(404, "not found");
    await sweepOrphanPhotos(deps.db, deps.config.eventPhotosDir);
    await notifyCircleDeleted(deps, removed.circle, me, members);
    sendJson(res, 200, mePayload(deps, req, me, null, agent));
    return true;
  }

  if (method === "POST" && pathname === "/api/circles/leave") {
    const circle = requireCircle(deps, me.id, requested);
    removeMember(deps.db, circle.id, me.id);
    await sweepOrphanPhotos(deps.db, deps.config.eventPhotosDir);
    sendJson(res, 200, mePayload(deps, req, me, null, agent));
    return true;
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
      await sweepOrphanPhotos(deps.db, deps.config.eventPhotosDir);
      sendEmpty(res, 204);
      return true;
    }
    if (typeof body.admin !== "boolean") throw new HttpError(400, "admin must be true or false");
    const result = setCircleAdmin(deps.db, circle.id, memberId, body.admin);
    if (result === "missing") throw new HttpError(404, "member not found");
    if (result === "last") throw new HttpError(409, "A circle needs an admin.");
    const fresh = getCircleById(deps.db, circle.id);
    if (!fresh) throw new HttpError(500, "circle missing");
    sendJson(res, 200, { circle: circlePayload(deps, req, fresh, me.id) });
    return true;
  }

  if (method === "GET" && pathname === "/api/past") {
    const circle = requireCircle(deps, me.id, requested);
    sendJson(res, 200, { days: pastDays(deps, circle.id, me.id) });
    return true;
  }
  return false;
}
