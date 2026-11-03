import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { deletePushSub, insertNotification, listPushSubs, withTx } from "./db.js";
import type { PushPayload, PushSender } from "./push.js";

export type Notice = {
  userId: string;
  title: string;
  body: string;
  kind: string;
  refId: string | null;
  tag: string;
  url?: string;
};

export function socialTitle(note: string): string {
  return note ? `"${note}"` : "Free now";
}

export function freePushBody(name: string, place: string, fromTime = "", shifted = false): string {
  const spot = place.trim();
  const when = fromTime.trim();
  if (when) {
    const base = shifted ? `${name} is now free from ${when}` : `${name} is free from ${when}`;
    return spot ? `${base} – meet at ${spot}` : base;
  }
  if (!spot) return `${name} is free now`;
  return `${name} is free – meet at ${spot}`;
}

export function startingNowBody(name: string, place: string): string {
  const spot = place.trim();
  return spot ? `Starting now: ${name} at ${spot}` : `Starting now: ${name}`;
}

export function replyPushBody(name: string, reply: string, etaMin: number | null): string {
  if (reply === "declined") return `${name} can't make it`;
  if (reply === "coming") return etaMin ? `${name} is on the way – ${etaMin} min` : `${name} is on the way`;
  return `${name} joined your social!`;
}

export async function notifyUsers(
  db: DatabaseSync,
  push: PushSender,
  now: number,
  notices: Notice[],
): Promise<void> {
  if (notices.length === 0) return;
  const deliveries: Array<{ userId: string; endpoint: string; p256dh: string; auth: string; payload: PushPayload }> = [];
  withTx(db, () => {
    for (const notice of notices) {
      insertNotification(db, {
        id: crypto.randomUUID(),
        userId: notice.userId,
        title: notice.title,
        body: notice.body,
        kind: notice.kind,
        refId: notice.refId,
        createdAt: now,
      });
      for (const sub of listPushSubs(db, notice.userId)) {
        deliveries.push({
          userId: notice.userId,
          endpoint: sub.endpoint,
          p256dh: sub.p256dh,
          auth: sub.auth,
          payload: {
            title: notice.title,
            body: notice.body,
            url: notice.url ?? "/",
            tag: notice.tag,
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
      if (status === 404 || status === 410) deletePushSub(db, delivery.endpoint);
    }
  }
}

function statusOf(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "statusCode" in error) {
    const code = (error as { statusCode?: unknown }).statusCode;
    if (typeof code === "number") return code;
  }
  return undefined;
}
