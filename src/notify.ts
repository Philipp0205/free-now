import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  countCirclesForUser,
  deletePushSub,
  insertNotification,
  insertPushDelivery,
  listPushSubs,
  markPushFailed,
  withTx,
} from "./db.js";
import type { PushPayload, PushSender } from "./push.js";

const TRACKED_KINDS = new Set(["social", "plan", "chat"]);

export type Notice = {
  userId: string;
  title: string;
  body: string;
  kind: string;
  refId: string | null;
  tag: string;
  url?: string;
  skipAlert?: boolean;
  /** The body already says which circle, so no " · circle" suffix. */
  namesCircle?: boolean;
};

export function eventTitle(kind: "now" | "later" | "reply" | "time" | "start"): string {
  if (kind === "later") return "Free later";
  if (kind === "reply") return "Reply";
  if (kind === "time") return "New time";
  return "Free now";
}

/** A fallback of "near you" is the host's own sheet. Everyone else reads "nearby". */
export function audiencePlace(place: string): string {
  const spot = place.trim();
  return /^near you$/i.test(spot) ? "nearby" : spot;
}

/** How a place reads after "near" or "at", so "Near Schlossplatz" never becomes "at Near …". */
export function placeTail(place: string): string {
  const spot = place.trim();
  if (!spot || /^near you$/i.test(spot)) return "nearby";
  if (/^near\s+/i.test(spot)) return `near ${spot.replace(/^near\s+/i, "")}`;
  return `at ${spot}`;
}

export function freePushBody(name: string, place: string, fromTime = "", shifted = false, note = ""): string {
  const spot = place.trim();
  const when = fromTime.trim();
  const base = when
    ? (shifted ? `${name} is now free from ${when}` : `${name} is free from ${when}`)
    : "";
  const tail = spot ? placeTail(spot) : "";
  let line: string;
  if (!spot) line = base || `${name} is free now`;
  else if (tail === "nearby") line = base ? `${base}, nearby` : `${name} is free nearby`;
  else if (tail.startsWith("near ")) line = base ? `${base}, ${tail}` : `${name} is free ${tail}`;
  else if (base) line = `${base} – meet ${tail}`;
  else line = `${name} is free – meet ${tail}`;
  const extra = note.trim();
  return extra ? `${line} – ${extra}` : line;
}

export function startingNowBody(name: string, place: string): string {
  const spot = place.trim();
  if (!spot) return `Starting now: ${name}`;
  return `Starting now: ${name} ${placeTail(spot)}`;
}

export function planReplyBody(name: string, note: string, reply: string): string {
  const label = note.trim() || "the plan";
  if (reply === "declined") return `${name} can't make it to ${label}`;
  return `${name} is in for ${label}`;
}

export function replyPushBody(name: string, reply: string, etaMin: number | null, arriveLabel = ""): string {
  if (reply === "declined") return `${name} can't make it`;
  if (arriveLabel) return `${name} is in, arriving ${arriveLabel}`;
  if (reply === "coming" || reply === "join" || reply === "in") {
    return etaMin ? `${name} is there in ${etaMin} min` : `${name} is in`;
  }
  return `${name} is in`;
}

export async function notifyUsers(
  db: DatabaseSync,
  push: PushSender,
  now: number,
  notices: Notice[],
  circle?: { id: string; name: string } | null,
): Promise<void> {
  if (notices.length === 0) return;
  const batchId = crypto.randomUUID();
  const deliveries: Array<{
    userId: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    payload: PushPayload;
    deliveryId: string | null;
  }> = [];
  withTx(db, () => {
    for (const notice of notices) {
      const scoped = scopeNotice(db, notice, circle);
      if (!notice.skipAlert) {
        insertNotification(db, {
          id: crypto.randomUUID(),
          userId: notice.userId,
          title: notice.title,
          body: scoped.body,
          kind: notice.kind,
          refId: notice.refId,
          circleId: circle?.id ?? null,
          createdAt: now,
        });
      }
      const track = Boolean(circle && notice.refId && TRACKED_KINDS.has(notice.kind));
      for (const sub of listPushSubs(db, notice.userId)) {
        const deliveryId = crypto.randomUUID();
        let tracked = false;
        if (track && circle && notice.refId) {
          try {
            insertPushDelivery(db, {
              id: deliveryId,
              userId: notice.userId,
              subId: sub.id,
              circleId: circle.id,
              kind: notice.kind,
              refId: notice.refId,
              batchId,
              createdAt: now,
            });
            tracked = true;
          } catch {
            console.log(`push delivery user=${notice.userId} status=error`);
          }
        }
        deliveries.push({
          userId: notice.userId,
          endpoint: sub.endpoint,
          p256dh: sub.p256dh,
          auth: sub.auth,
          deliveryId: tracked ? deliveryId : null,
          payload: {
            title: notice.title,
            body: scoped.body,
            url: scoped.url,
            tag: notice.tag,
            ...(tracked ? { id: deliveryId } : {}),
          },
        });
      }
    }
  });
  for (const delivery of deliveries) {
    try {
      await push.send(
        { endpoint: delivery.endpoint, p256dh: delivery.p256dh, auth: delivery.auth },
        delivery.payload,
      );
      console.log(`push send user=${delivery.userId} status=ok`);
    } catch (error) {
      const status = statusOf(error);
      console.log(`push send user=${delivery.userId} status=${status ?? "error"}`);
      if (delivery.deliveryId) {
        try {
          markPushFailed(db, delivery.deliveryId, status ?? null);
        } catch {
          console.log(`push delivery user=${delivery.userId} status=error`);
        }
      }
      if (status === 404 || status === 410) deletePushSub(db, delivery.endpoint);
    }
  }
}

function scopeNotice(
  db: DatabaseSync,
  notice: Notice,
  circle?: { id: string; name: string } | null,
): { body: string; url: string } {
  const url = notice.url ?? "/";
  if (!circle || countCirclesForUser(db, notice.userId) <= 1) return { body: notice.body, url };
  const join = url.includes("?") ? "&" : "?";
  return {
    body: notice.namesCircle ? notice.body : `${notice.body} · ${circle.name}`,
    url: `${url}${join}circle=${encodeURIComponent(circle.id)}`,
  };
}

function statusOf(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "statusCode" in error) {
    const code = (error as { statusCode?: unknown }).statusCode;
    if (typeof code === "number") return code;
  }
  return undefined;
}
