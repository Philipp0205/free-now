import http from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { AGENT_TOKEN_LIMIT } from "./admin/agent-tokens.js";
import { FEEDBACK_LIMIT } from "./admin/feedback.js";
import { llmsTxt } from "./admin/llms-txt.js";
import { AGENT_ROUTES_ERROR, isAgentAllowed, openapiJson } from "./admin/openapi.js";
import { handleAdminRoutes } from "./admin/routes.js";
import { FEED_LIMIT } from "./calendar/calendar.js";
import type { CalendarNet } from "./calendar/freebusy.js";
import {
  handleCalendarMonthRoute,
  handleCalendarRoutes,
  handleGoogleCallbackRoute,
  isFeedPath,
  redactFeedToken,
  serveFeed,
} from "./calendar/routes.js";
import { ChatError } from "./chat/chat.js";
import { handleChatRoutes } from "./chat/routes.js";
import { type Config, MAP_PMTILES_ATTRIBUTION, MAP_PMTILES_URL } from "./config.js";
import { ACCOUNT_LIMIT } from "./accounts/accounts.js";
import type { Mailer } from "./app-kit/mailer.ts";
import { healthHandler } from "./app-kit/health.ts";
import type { UserRow } from "./db.js";
import { authFromRequest, requireUser } from "./lib/auth.js";
import { clientKey } from "./lib/client-key.js";
import type { AuthedRouteContext, Limits, RouteContext } from "./lib/context.js";
import { HttpError, matchPath, readJson, sendJson, sendPublic } from "./lib/http.js";
import { createRateLimiter } from "./lib/rate-limit.js";
import { servePrivacy, serveStatic, serveWelcome } from "./lib/static.js";
import { isAllCircles, readRequestedCircle } from "./lib/validate.js";
import { pmtilesHeadBytes } from "./map/pmtiles.js";
import { MAX_RANGE_BYTES, serveRangeFile } from "./map/range-file.js";
import { archiveCheckFor, handleMapRoutes } from "./map/routes.js";
import type { PushSender } from "./push/push.js";
import { handlePushAckRoute, handlePushRoutes } from "./push/routes.js";
import { handleAuthRoutes } from "./social/auth-routes.js";
import { handleCircleRoutes } from "./social/circle-routes.js";
import { handleAvatar, handleMeRoutes } from "./social/me-routes.js";
import { handlePlanRoutes, handlePlanShareRoutes, handleSocialRoutes, serveSharePage } from "./social/routes.js";

export type AppDeps = {
  db: DatabaseSync;
  push: PushSender;
  config: Config;
  now: () => number;
  /** Tests swap DNS and the HTTP client for the calendar availability import. */
  calendarNet?: CalendarNet;
  /** Sends the confirm and lost-code links. Undefined: no mail goes out (see createMailer). */
  mailer?: Mailer;
};

export { HttpError } from "./lib/http.js";
export { parseId } from "./lib/validate.js";
export { requireCircle } from "./social/circles.js";
export { socialPayload, planPayload } from "./social/payload.js";
export { CALENDAR_MAX_DAYS, CALENDAR_MAX_EVENTS, redactFeedToken } from "./calendar/routes.js";

const LEGACY_HOST = "hangry-production-64c4.up.railway.app";

/** Service worker acks per client (see clientKey). A phone back online can flush a burst at once. */
export const ACK_LIMIT = { limit: 120, windowMs: 60_000 };
/** Plan share links per client. Enough for a chat full of previews, not for guessing. */
export const SHARE_LIMIT = { limit: 60, windowMs: 60_000 };

/** Calendar link connects and refreshes per person. Each one fetches a remote file. */
export const CALENDAR_SYNC_LIMIT = { limit: 10, windowMs: 60_000 };

export function createApp(deps: AppDeps): http.RequestListener {
  const limits: Limits = {
    ack: createRateLimiter(ACK_LIMIT),
    feedback: createRateLimiter(FEEDBACK_LIMIT),
    share: createRateLimiter(SHARE_LIMIT),
    feed: createRateLimiter(FEED_LIMIT),
    calendarSync: createRateLimiter(CALENDAR_SYNC_LIMIT),
    agent: createRateLimiter(AGENT_TOKEN_LIMIT),
    accounts: createRateLimiter(ACCOUNT_LIMIT),
  };
  return (req, res) => {
    void handle(req, res, deps, limits).catch((error: unknown) => {
      if (error instanceof HttpError) {
        sendJson(res, error.status, { ...error.extra, error: error.message }, error.headers);
        return;
      }
      if (error instanceof ChatError) {
        sendJson(res, error.status, { error: error.message });
        return;
      }
      if (isFeedPath(req.url)) console.error("feed error", redactFeedToken(errorText(error), req.url));
      else console.error(error);
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
    });
  };
}

/**
 * Accounts from before email was required can only read themselves, sign out and add an address.
 * Everything else answers 403 until they do. The public routes (sign up, recover, buzz) never get here.
 */
function requireEmail(me: UserRow, method: string, pathname: string): void {
  if (me.email) return;
  if (method === "GET" && pathname === "/api/me") return;
  if (method === "POST" && (pathname === "/api/auth/logout" || pathname === "/api/auth/email")) return;
  throw new HttpError(403, "add an email first");
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.stack || error.message;
  return String(error);
}

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
    if (pathname === "/llms.txt") {
      sendPublic(req, res, "text/plain; charset=utf-8", llmsTxt);
      return;
    }
    const sharePage = matchPath(pathname, /^\/p\/([^/]+)\/?$/);
    if (sharePage) {
      if (!limits.share.hit(clientKey(req), deps.now())) throw new HttpError(429, "too many requests");
      await serveSharePage(req, res, deps, sharePage[1]);
      return;
    }
    if (pathname === "/welcome" || pathname === "/welcome/") {
      await serveWelcome(req, res);
      return;
    }
    if (pathname === "/privacy" || pathname === "/privacy/") {
      await servePrivacy(req, res);
      return;
    }
    const feed = matchPath(pathname, /^\/cal\/([^/]+)\.ics$/);
    if (feed) {
      if (!limits.feed.hit(clientKey(req), deps.now())) throw new HttpError(429, "too many requests");
      serveFeed(req, res, deps, feed[1]);
      return;
    }
    // Fixed route, path only from env: no part of the request reaches the filesystem here.
    if (pathname === MAP_PMTILES_URL && deps.config.mapPmtiles) {
      await serveRangeFile(req, res, deps.config.mapPmtiles.path, {
        contentType: "application/vnd.pmtiles",
        maxRangeBytes: MAX_RANGE_BYTES,
        check: archiveCheckFor(deps.config.mapPmtiles),
        head: pmtilesHeadBytes(deps.config.mapPmtiles),
      });
      return;
    }
    if (pathname.startsWith("/tiles/")) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    await serveStatic(req, res, pathname);
    return;
  }

  if (healthHandler(req, res)) return;

  if (pathname === "/api/openapi.json" && (method === "GET" || method === "HEAD")) {
    sendPublic(req, res, "application/json; charset=utf-8", openapiJson);
    return;
  }

  const auth = authFromRequest(req, deps);
  const user = auth?.user;
  if (auth?.kind === "agent") {
    const now = deps.now();
    if (!limits.agent.hit(auth.agentTokenId ?? "", now)) {
      const retryAfter = Math.max(1, Math.ceil(limits.agent.resetIn(auth.agentTokenId ?? "", now) / 1000));
      throw new HttpError(429, "too many requests", {}, { "retry-after": String(retryAfter) });
    }
    if (!isAgentAllowed(method, pathname)) throw new HttpError(403, AGENT_ROUTES_ERROR);
  }
  if (pathname === "/api/me/avatar" || /^\/api\/users\/[^/]+\/avatar$/.test(pathname)) {
    const caller = requireUser(user);
    requireEmail(caller, method, pathname);
    await handleAvatar(req, res, deps, method, pathname, caller);
    return;
  }
  const body =
    method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE"
      ? await readJson(req)
      : {};
  // Feedback reads its own circle and ignores a bad one instead of failing the send.
  // ?all=1 reads every circle the caller is in, so any requested circle is ignored.
  const requested = pathname === "/api/feedback" || isAllCircles(method, pathname, url) ? null : readRequestedCircle(req, url, body);

  if (method === "GET" && pathname === "/api/meta") {
    sendJson(res, 200, {
      vapidPublicKey: deps.config.vapid?.publicKey ?? null,
      publicBaseUrl: deps.config.publicBaseUrl,
      socialTtlMs: deps.config.socialTtlMs,
      tz: deps.config.tz,
      devMode: !deps.config.vapid,
      mapTileUrl: deps.config.mapTileUrl,
      mapTileAttribution: deps.config.mapTileAttribution,
      ...(deps.config.mapPmtiles
        ? {
            mapPmtilesUrl: MAP_PMTILES_URL,
            mapPmtilesAttribution: MAP_PMTILES_ATTRIBUTION,
            mapPmtilesBounds: deps.config.mapPmtiles.bounds,
            mapPmtilesMinZoom: deps.config.mapPmtiles.minzoom,
            mapPmtilesMaxZoom: deps.config.mapPmtiles.maxzoom,
            mapPmtilesHead: pmtilesHeadBytes(deps.config.mapPmtiles),
          }
        : {}),
    });
    return;
  }

  const ctx: RouteContext = { req, res, deps, limits, url, method, pathname, user, auth, body, requested };

  if (await handleAuthRoutes(ctx)) return;
  if (await handleAdminRoutes(ctx)) return;
  if (await handlePushAckRoute(ctx)) return;
  if (await handleGoogleCallbackRoute(ctx)) return;

  const me = requireUser(user);
  requireEmail(me, method, pathname);
  const agent = auth?.kind === "agent";
  const authed: AuthedRouteContext = { ...ctx, me, agent };

  if (await handleChatRoutes(authed)) return;
  if (await handleMapRoutes(authed)) return;
  if (await handleMeRoutes(authed)) return;
  if (await handleCircleRoutes(authed)) return;
  if (await handleCalendarMonthRoute(authed)) return;
  if (await handleSocialRoutes(authed)) return;
  if (await handlePlanRoutes(authed)) return;
  if (await handleCalendarRoutes(authed)) return;
  if (await handlePlanShareRoutes(authed)) return;
  if (await handlePushRoutes(authed)) return;

  sendJson(res, 404, { error: "not found" });
}
