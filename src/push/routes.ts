import crypto from "node:crypto";
import {
  deletePushSubForUser,
  listCirclesForUser,
  listNotifications,
  listPersonalNotifications,
  listPushSubs,
  markNotificationsRead,
  markPersonalNotificationsRead,
  markPushDelivered,
  markPushSeen,
  unreadNotificationsByCircle,
  upsertPushSub,
} from "../db.js";
import { clientKey } from "../lib/client-key.js";
import type { AuthedRouteContext, RouteContext } from "../lib/context.js";
import { HttpError, sendEmpty, sendJson } from "../lib/http.js";
import { UUID_RE, cleanSubscription } from "../lib/validate.js";
import { notifyUsers } from "./notify.js";
import { requireCircle } from "../social/circles.js";

export async function handlePushAckRoute(ctx: RouteContext): Promise<boolean> {
  const { req, res, deps, limits, method, pathname, body } = ctx;
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
    return true;
  }
  return false;
}

export async function handlePushRoutes(ctx: AuthedRouteContext): Promise<boolean> {
  const { res, deps, method, pathname, body, requested, me } = ctx;
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
    return true;
  }

  if (method === "POST" && pathname === "/api/push/status") {
    const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
    const known = endpoint.length > 0 && listPushSubs(deps.db, me.id).some((sub) => sub.endpoint === endpoint);
    sendJson(res, 200, { known });
    return true;
  }

  if (method === "DELETE" && pathname === "/api/push/subscribe") {
    const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
    if (!endpoint) throw new HttpError(400, "endpoint is required");
    deletePushSubForUser(deps.db, me.id, endpoint);
    sendEmpty(res, 204);
    return true;
  }

  if (method === "POST" && pathname === "/api/push/test") {
    const circles = listCirclesForUser(deps.db, me.id);
    const circle = circles.length === 0 ? null : requireCircle(deps, me.id, requested);
    const subs = listPushSubs(deps.db, me.id);
    await notifyUsers(deps.db, deps.push, deps.now(), [
      {
        userId: me.id,
        title: "Spontaco",
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
    return true;
  }

  if (method === "GET" && pathname === "/api/notifications") {
    // Someone in no circle still reaches their own personal alerts. A named circle must still be theirs.
    const circle = !requested && listCirclesForUser(deps.db, me.id).length === 0 ? null : requireCircle(deps, me.id, requested);
    const rows = circle ? listNotifications(deps.db, me.id, circle.id) : listPersonalNotifications(deps.db, me.id);
    const notifications = rows.map((row) => ({
      id: row.id,
      title: row.title,
      body: row.body,
      kind: row.kind,
      refId: row.ref_id,
      circleId: row.circle_id,
      createdAt: row.created_at,
      readAt: row.read_at,
    }));
    sendJson(res, 200, { notifications, unreadByCircle: unreadNotificationsByCircle(deps.db, me.id) });
    return true;
  }

  if (method === "POST" && pathname === "/api/notifications/read") {
    const circle = !requested && listCirclesForUser(deps.db, me.id).length === 0 ? null : requireCircle(deps, me.id, requested);
    if (circle) markNotificationsRead(deps.db, me.id, circle.id, deps.now());
    else markPersonalNotificationsRead(deps.db, me.id, deps.now());
    sendEmpty(res, 204);
    return true;
  }
  return false;
}
