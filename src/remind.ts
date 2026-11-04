import type { DatabaseSync } from "node:sqlite";
import { listComingUserIds, listDueStartReminders, markSocialReminded } from "./db.js";
import { eventTitle, notifyUsers, startingNowBody } from "./notify.js";
import type { PushSender } from "./push.js";

/** One reminder when a "later today" social starts, only to people who joined or are on the way. */
export async function sendStartReminders(db: DatabaseSync, push: PushSender, now: number): Promise<number> {
  const due = listDueStartReminders(db, now);
  for (const social of due) {
    const people = listComingUserIds(db, social.id);
    if (people.length) {
      await notifyUsers(
        db,
        push,
        now,
        people.map((userId) => ({
          userId,
          title: eventTitle("start"),
          body: startingNowBody(social.creator_name, social.place ?? ""),
          url: `/?social=${social.id}`,
          kind: "social-start",
          refId: social.id,
          tag: `social-start:${social.id}`,
        })),
      );
    }
    markSocialReminded(db, social.id, now);
  }
  return due.length;
}
