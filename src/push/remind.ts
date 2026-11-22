import type { DatabaseSync } from "node:sqlite";
import { listComingUserIds, listDueStartReminders, markSocialReminded } from "../db.js";
import { inviteeIds } from "../social/visibility.js";
import { eventTitle, notifyUsers, startingNowBody } from "./notify.js";
import type { PushSender } from "./push.js";

/** One reminder when a "later today" social starts, only to people who joined or are on the way. */
export async function sendStartReminders(db: DatabaseSync, push: PushSender, now: number): Promise<number> {
  const due = listDueStartReminders(db, now);
  for (const social of due) {
    // Coming people are already invitees of a private social, since a join needs to see it. The filter covers a later edit.
    const invited = inviteeIds(db, "social", social.id);
    const people = listComingUserIds(db, social.id).filter((userId) => !invited || invited.has(userId));
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
        { id: social.circle_id, name: social.circle_name },
      );
    }
    markSocialReminded(db, social.id, now);
  }
  return due.length;
}
