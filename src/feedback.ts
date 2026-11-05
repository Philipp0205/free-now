import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

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

export function updateFeedback(
  db: DatabaseSync,
  id: string,
  patch: { status?: FeedbackStatus; prUrl?: string | null; note?: string | null },
  at: number,
): FeedbackView | undefined {
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
  const changed = db.prepare(`UPDATE feedback SET ${sets.join(", ")} WHERE id = ?`).run(...params, id).changes;
  if (!Number(changed)) return undefined;
  return getFeedback(db, id);
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
