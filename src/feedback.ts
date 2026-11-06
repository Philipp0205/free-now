import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { withTx } from "./db.js";

export const FEEDBACK_MAX = 2000;
export const FEEDBACK_NOTE_MAX = 2000;
export const FEEDBACK_PR_URL_MAX = 500;
export const FEEDBACK_VERSION_MAX = 64;
export const FEEDBACK_LIST_CAP = 500;
/** Per client (see clientKey): five sends in ten minutes. */
export const FEEDBACK_LIMIT = { limit: 5, windowMs: 10 * 60_000 };
export const FEEDBACK_STATUSES = ["new", "planned", "in_progress", "done", "rejected"] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

export type FeedbackView = {
  id: string;
  userId: string;
  userName: string | null;
  circleId: string | null;
  circleName: string | null;
  text: string;
  appVersion: string | null;
  createdAt: number;
  status: FeedbackStatus;
  prUrl: string | null;
  note: string | null;
};

type FeedbackJoined = {
  id: string;
  user_id: string;
  user_name: string | null;
  circle_id: string | null;
  circle_name: string | null;
  text: string;
  app_version: string | null;
  created_at: number;
  status: string;
  pr_url: string | null;
  note: string | null;
};

const SELECT = `
  SELECT f.id, f.user_id, u.name AS user_name, f.circle_id, c.name AS circle_name,
         f.text, f.app_version, f.created_at, f.status, f.pr_url, f.note
  FROM feedback f
  LEFT JOIN users u ON u.id = f.user_id
  LEFT JOIN circles c ON c.id = f.circle_id
`;

export function isFeedbackStatus(value: unknown): value is FeedbackStatus {
  return typeof value === "string" && (FEEDBACK_STATUSES as readonly string[]).includes(value);
}

/** Line breaks and tabs survive; other control characters go. Null when empty or too long. */
export function cleanFeedbackText(value: unknown, max = FEEDBACK_MAX): string | null {
  if (typeof value !== "string") return null;
  const text = value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .trim();
  if (text.length < 1 || text.length > max) return null;
  return text;
}

/** Optional client build label, for example "hangry-v13". Anything odd is dropped, not rejected. */
export function cleanAppVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[^\x20-\x7e]/g, "").trim().slice(0, FEEDBACK_VERSION_MAX);
  return text || null;
}

/** Empty clears it. Otherwise an http(s) URL. Undefined means invalid. */
export function cleanPrUrl(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text) return null;
  if (text.length > FEEDBACK_PR_URL_MAX) return undefined;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  } catch {
    return undefined;
  }
  return text;
}

/** Empty clears it. Undefined means invalid. */
export function cleanFeedbackNote(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  if (!value.trim()) return null;
  return cleanFeedbackText(value, FEEDBACK_NOTE_MAX) ?? undefined;
}

export function insertFeedback(
  db: DatabaseSync,
  row: { userId: string; circleId: string | null; text: string; appVersion: string | null; createdAt: number },
): string {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO feedback (id, user_id, circle_id, text, app_version, created_at, status)
     VALUES (?, ?, ?, ?, ?, ?, 'new')`,
  ).run(id, row.userId, row.circleId, row.text, row.appVersion, row.createdAt);
  return id;
}

export function listFeedback(db: DatabaseSync, status: FeedbackStatus | null): FeedbackView[] {
  const where = status ? "WHERE f.status = ?" : "";
  const params = status ? [status] : [];
  const rows = db
    .prepare(`${SELECT} ${where} ORDER BY f.created_at DESC, f.rowid DESC LIMIT ${FEEDBACK_LIST_CAP}`)
    .all(...params) as FeedbackJoined[];
  return rows.map(view);
}

export function getFeedback(db: DatabaseSync, id: string): FeedbackView | undefined {
  const row = db.prepare(`${SELECT} WHERE f.id = ?`).get(id) as FeedbackJoined | undefined;
  return row ? view(row) : undefined;
}

export const FEEDBACK_DONE_KIND = "feedback-done";
export const FEEDBACK_DONE_TITLE = "Your suggestion is live";
export const FEEDBACK_EXCERPT_MAX = 80;

/**
 * A short, single-line quote of the feedback for the submitter's own alert.
 * Control, zero-width, and bidi characters go, whitespace collapses, and it is cut on a code point.
 * The client renders it as text, never HTML.
 */
export function feedbackExcerpt(text: string, max = FEEDBACK_EXCERPT_MAX): string {
  const flat = text
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(flat);
  if (chars.length <= max) return flat;
  return `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

export function feedbackDoneBody(text: string): string {
  const excerpt = feedbackExcerpt(text);
  return excerpt ? `You suggested: "${excerpt}". It is in the app now. Thanks!` : "It is in the app now. Thanks!";
}

/** What the done transition did about the submitter's alert. Never shown to app users. */
export type DoneAlert = "sent" | "already" | "no-user" | "none";

export function updateFeedback(
  db: DatabaseSync,
  id: string,
  patch: { status?: FeedbackStatus; prUrl?: string | null; note?: string | null },
  at: number,
): (FeedbackView & { doneAlert: DoneAlert }) | undefined {
  const sets: string[] = [];
  const params: Array<string | number | null> = [];
  if (patch.status !== undefined) {
    sets.push("status = ?");
    params.push(patch.status);
  }
  if (patch.prUrl !== undefined) {
    sets.push("pr_url = ?");
    params.push(patch.prUrl);
  }
  if (patch.note !== undefined) {
    sets.push("note = ?");
    params.push(patch.note);
  }
  sets.push("updated_at = ?");
  params.push(at);
  let found = false;
  let alert: DoneAlert = "none";
  // One transaction: the status write, the marker claim, and the alert insert land together or not at all.
  withTx(db, () => {
    const changed = db.prepare(`UPDATE feedback SET ${sets.join(", ")} WHERE id = ?`).run(...params, id).changes;
    found = Number(changed) > 0;
    if (found && patch.status === "done") alert = deliverDoneAlert(db, id, at);
  });
  if (!found) return undefined;
  const updated = getFeedback(db, id);
  return updated ? { ...updated, doneAlert: alert } : undefined;
}

/**
 * Claims feedback.done_alert (NULL only) and inserts one personal alert for the submitter.
 * The marker is never cleared, so reopening and marking done again does not send a second one,
 * and rows marked "legacy" by the migration never send at all. Call inside a transaction.
 */
function deliverDoneAlert(db: DatabaseSync, feedbackId: string, at: number): DoneAlert {
  const row = db
    .prepare(
      `SELECT f.text, f.done_alert, u.id AS user_id FROM feedback f
       LEFT JOIN users u ON u.id = f.user_id
       WHERE f.id = ? AND f.status = 'done'`,
    )
    .get(feedbackId);
  if (!row) return "none";
  const marker = row.done_alert;
  if (marker !== null) return "already";
  const userId = typeof row.user_id === "string" ? row.user_id : null;
  const text = typeof row.text === "string" ? row.text : "";
  if (!userId) {
    db.prepare("UPDATE feedback SET done_alert = 'no-user' WHERE id = ? AND done_alert IS NULL").run(feedbackId);
    return "no-user";
  }
  const noteId = crypto.randomUUID();
  const claimed = db
    .prepare("UPDATE feedback SET done_alert = ? WHERE id = ? AND done_alert IS NULL")
    .run(noteId, feedbackId).changes;
  if (!Number(claimed)) return "already";
  const inserted = db
    .prepare(
      `INSERT OR IGNORE INTO notifications (id, user_id, title, body, kind, ref_id, circle_id, created_at, read_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
    )
    .run(noteId, userId, FEEDBACK_DONE_TITLE, feedbackDoneBody(text), FEEDBACK_DONE_KIND, feedbackId, at).changes;
  return Number(inserted) ? "sent" : "already";
}

function view(row: FeedbackJoined): FeedbackView {
  return {
    id: row.id,
    userId: row.user_id,
    userName: row.user_name ?? null,
    circleId: row.circle_id ?? null,
    circleName: row.circle_name ?? null,
    text: row.text,
    appVersion: row.app_version ?? null,
    createdAt: Number(row.created_at),
    status: isFeedbackStatus(row.status) ? row.status : "new",
    prUrl: row.pr_url ?? null,
    note: row.note ?? null,
  };
}
