import http from "node:http";
import {
  AGENT_NAME_MAX,
  MAX_AGENT_TOKENS,
  issueAgentToken,
  listAgentTokensFor,
  revokeAgentToken,
} from "../admin/agent-tokens.js";
import { cleanAppVersion, cleanFeedbackText, insertFeedback } from "../admin/feedback.js";
import type { AppDeps } from "../app.js";
import {
  type UserRow,
  bumpAvatarRev,
  clearAvatarRev,
  clearBusyHours,
  clearUserStatus,
  countAgentTokens,
  deleteSessionByHash,
  getBusyHours,
  getUserById,
  listCirclesForUser,
  recordDisplay,
  rotateBuzzToken,
  setBuzzCircle,
  setPaymentUrl,
  setWhatsNewSeen,
  sharesCircle,
  updateUserName,
} from "../db.js";
import { sha256 } from "../lib/auth.js";
import {
  AVATAR_MAX_BYTES,
  avatarFile,
  avatarMime,
  readAvatarBody,
  removeAvatarFile,
  writeAvatarFile,
} from "../lib/avatar.js";
import { clientKey } from "../lib/client-key.js";
import type { AuthedRouteContext } from "../lib/context.js";
import { HttpError, firstHeader, matchPath, safeDecode, sendEmpty, sendJson } from "../lib/http.js";
import { cleanPaymentUrl } from "../lib/payment-url.js";
import { cleanLabel, parseId } from "../lib/validate.js";
import { BUZZ_PRESSES, buzzCirclesFor, mePayload, requireCircle } from "./circles.js";
import { humanCode } from "./code.js";
import { StatusError, ownStatus, saveBusyHours, saveStatus } from "./status.js";

export async function handleMeRoutes(ctx: AuthedRouteContext): Promise<boolean> {
  const { req, res, deps, limits, method, pathname, body, requested, me, agent } = ctx;
  if (method === "POST" && pathname === "/api/auth/logout") {
    const header = req.headers.authorization;
    const match = /^Bearer\s+(\S+)$/i.exec(Array.isArray(header) ? header[0] : header ?? "");
    if (match) deleteSessionByHash(deps.db, sha256(match[1]));
    sendEmpty(res, 204);
    return true;
  }

  if (method === "GET" && pathname === "/api/me") {
    sendJson(res, 200, mePayload(deps, req, me, requested, agent));
    return true;
  }

  if (method === "PATCH" && pathname === "/api/me") {
    const hasPayment = body.paymentUrl !== undefined;
    // Validate everything before writing, so a bad value changes nothing. Name stays required unless only paymentUrl is sent.
    const name = hasPayment && body.name === undefined ? me.name : cleanLabel(body.name, "name", 24);
    const paymentUrl = hasPayment ? cleanPaymentUrl(body.paymentUrl) : undefined;
    updateUserName(deps.db, me.id, name);
    if (paymentUrl !== undefined) setPaymentUrl(deps.db, me.id, paymentUrl);
    const updated = { ...me, name };
    sendJson(res, 200, mePayload(deps, req, updated, requested, agent));
    return true;
  }

  if (pathname === "/api/me/status") {
    const now = deps.now();
    if (method === "GET") {
      sendJson(res, 200, { status: ownStatus(deps.db, me.id, now) });
      return true;
    }
    if (method === "PUT" || method === "PATCH") {
      try {
        saveStatus(deps.db, me.id, body, now);
      } catch (error) {
        if (error instanceof StatusError) throw new HttpError(400, error.message);
        throw error;
      }
    } else if (method === "DELETE") {
      clearUserStatus(deps.db, me.id);
    } else {
      throw new HttpError(405, "method not allowed");
    }
    sendJson(res, 200, mePayload(deps, req, me, requested, agent));
    return true;
  }

  if (pathname === "/api/me/busy-hours") {
    if (method === "GET") {
      sendJson(res, 200, { schedule: getBusyHours(deps.db, me.id) });
      return true;
    }
    if (method === "PUT" || method === "PATCH") {
      try {
        sendJson(res, 200, { schedule: saveBusyHours(deps.db, me.id, body, deps.now()) });
      } catch (error) {
        if (error instanceof StatusError) throw new HttpError(400, error.message);
        throw error;
      }
      return true;
    }
    if (method === "DELETE") {
      clearBusyHours(deps.db, me.id);
      sendJson(res, 200, { schedule: null });
      return true;
    }
    throw new HttpError(405, "method not allowed");
  }

  if (method === "POST" && pathname === "/api/me/display") {
    if (typeof body.standalone !== "boolean") throw new HttpError(400, "standalone is required");
    recordDisplay(deps.db, me.id, body.standalone, deps.now());
    sendEmpty(res, 204);
    return true;
  }

  if (method === "POST" && pathname === "/api/me/whats-new") {
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!WHATS_NEW_ID_RE.test(id)) throw new HttpError(400, "id is required");
    setWhatsNewSeen(deps.db, me.id, id);
    sendJson(res, 200, { whatsNewSeen: id });
    return true;
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
    return true;
  }

  if (method === "POST" && pathname === "/api/me/buzz-token") {
    const buzzToken = humanCode();
    rotateBuzzToken(deps.db, me.id, buzzToken);
    sendJson(res, 200, { buzzToken });
    return true;
  }

  if (method === "PUT" && pathname === "/api/me/buzz-circles") {
    // Check every circle first so one bad id writes nothing.
    const next = BUZZ_PRESSES.map((press) => {
      const value = body[press];
      if (value == null) return [press, null] as const;
      if (typeof value !== "string" || !value) throw new HttpError(400, `${press} must be a circle id or null`);
      return [press, requireCircle(deps, me.id, value).id] as const;
    });
    for (const [press, circleId] of next) setBuzzCircle(deps.db, me.id, press, circleId);
    sendJson(res, 200, { buzzCircles: buzzCirclesFor(deps.db, me.id) });
    return true;
  }

  if (pathname === "/api/me/agent-tokens") {
    if (method === "GET") {
      sendJson(res, 200, { tokens: listAgentTokensFor(deps.db, me.id) });
      return true;
    }
    if (method === "POST") {
      const name = cleanLabel(body.name, "name", AGENT_NAME_MAX);
      if (countAgentTokens(deps.db, me.id) >= MAX_AGENT_TOKENS) {
        throw new HttpError(409, `You already have ${MAX_AGENT_TOKENS} agent tokens. Revoke one first.`);
      }
      sendJson(res, 201, issueAgentToken(deps.db, me.id, name, deps.now()));
      return true;
    }
    throw new HttpError(405, "method not allowed");
  }

  const agentTokenRoute = matchPath(pathname, /^\/api\/me\/agent-tokens\/([^/]+)$/);
  if (agentTokenRoute && method === "DELETE") {
    if (!revokeAgentToken(deps.db, me.id, safeDecode(agentTokenRoute[1]))) throw new HttpError(404, "not found");
    sendEmpty(res, 204);
    return true;
  }
  return false;
}

const WHATS_NEW_ID_RE = /^[a-z0-9-]{1,64}$/;

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

export async function handleAvatar(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: AppDeps,
  method: string,
  pathname: string,
  me: UserRow,
): Promise<void> {
  const dir = deps.config.avatarDir;
  if (pathname === "/api/me/avatar") {
    if (method === "PUT") {
      const data = await readAvatarBody(req, AVATAR_MAX_BYTES);
      if (!data) throw new HttpError(413, "That photo is too big.");
      const kind = avatarMime(data);
      if (!kind) throw new HttpError(400, "Send a WebP or JPEG photo.");
      await writeAvatarFile(dir, me.id, data);
      bumpAvatarRev(deps.db, me.id, deps.now());
    } else if (method === "DELETE") {
      await removeAvatarFile(dir, me.id);
      clearAvatarRev(deps.db, me.id);
    } else {
      throw new HttpError(405, "method not allowed");
    }
    const fresh = getUserById(deps.db, me.id) ?? me;
    sendJson(res, 200, mePayload(deps, req, { ...me, avatar_rev: fresh.avatar_rev ?? null }, null));
    return;
  }
  if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "method not allowed");
  const match = /^\/api\/users\/([^/]+)\/avatar$/.exec(pathname);
  const id = parseId(match?.[1] ?? "");
  // A stranger gets the same 404 as "no photo", so they learn nothing.
  const target = sharesCircle(deps.db, me.id, id) ? getUserById(deps.db, id) : undefined;
  const rev = target?.avatar_rev ?? 0;
  const file = rev ? await avatarFile(dir, id) : null;
  if (!file) throw new HttpError(404, "not found");
  const etag = `"${rev}"`;
  const headers: http.OutgoingHttpHeaders = {
    "content-type": file.mime,
    "cache-control": "private, max-age=31536000, immutable",
    etag,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
  if (firstHeader(req.headers["if-none-match"]) === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(200, { ...headers, "content-length": file.data.length });
  if (method === "HEAD") res.end();
  else res.end(file.data);
}
