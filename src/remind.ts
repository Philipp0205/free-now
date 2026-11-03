import type { DatabaseSync } from "node:sqlite";
import { listComingUserIds } from "./db.js";
import { freePushBody, notifyUsers, socialTitle } from "./notify.js";
import type { PushSender } from "./push.js";

type DueSocial = {
  id: string;
  note: string;
  place: string;
  creator_name: string;
};

/** One reminder when a "later today" social starts, only to people who joined or are on the way. */
export async function sendStartReminders(db: DatabaseSync, push: PushSender, now: number): Promise<number> {
  const due = db.prepare(
    `SELECT s.id, s.note, s.place, u.name AS creator_name
     FROM socials s
     JOIN users u ON u.id = s.creator_id
     WHERE s.starts_at IS NOT NULL AND s.starts_at <= ? AND s.reminded_at IS NULL AND s.expires_at > ?`,
  ).all(now, now) as DueSocial[];
  for (const social of due) {
    const people = listComingUserIds(db, social.id);
    if (people.length) {
      await notifyUsers(
        db,
        push,
        now,
        people.map((userId) => ({
          userId,
          title: socialTitle(social.note),
          body: freePushBody(social.creator_name, social.place ?? ""),
          url: `/?social=${social.id}`,
          kind: "social-start",
          refId: social.id,
          tag: `social-start:${social.id}`,
        })),
      );
    }
    db.prepare("UPDATE socials SET reminded_at = ? WHERE id = ?").run(now, social.id);
  }
  return due.length;
}
