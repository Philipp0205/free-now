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

export async function notifyUsers(
  db: DatabaseSync,
  push: PushSender,
  now: number,
  notices: Notice[],
): Promise<void> {
  if (notices.length === 0) return;
  const deliveries: Array<{ endpoint: string; p256dh: string; auth: string; payload: PushPayload }> = [];
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
    } catch (error) {
      const status = statusOf(error);
      if (status === 404 || status === 410) {
        deletePushSub(db, delivery.endpoint);
      } else {
        console.error("web push failed", status ?? error);
      }
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
