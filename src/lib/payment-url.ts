import type { DatabaseSync } from "node:sqlite";
import { HttpError } from "./http.js";

export const PAYMENT_URL_MAX = 200;
const BAD_LINK = "Use a paypal.me link, for example https://paypal.me/yourname";

/**
 * A paypal.me profile link, normalized, or null for an empty value (clear).
 * Wero is not allowed: it has no permanent personal link, only short-lived collect links.
 */
export function cleanPaymentUrl(value: unknown): string | null {
  if (typeof value !== "string") throw new HttpError(400, BAD_LINK);
  const text = value.trim();
  if (!text) return null;
  if (text.length > PAYMENT_URL_MAX) throw new HttpError(400, "Link is too long");
  if (!/^https:\/\//i.test(text)) throw new HttpError(400, "Links must start with https://");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new HttpError(400, BAD_LINK);
  }
  // url.port is empty for an explicit :443, so look at the text before the first path, query or hash.
  const hasPort = /^https:\/\/[^/\\?#]*:\d*(?:[/\\?#]|$)/i.test(text);
  if (url.protocol !== "https:" || url.username || url.password || url.port || hasPort) throw new HttpError(400, BAD_LINK);
  const host = url.hostname.toLowerCase();
  const path = host === "www.paypal.com" ? /^\/paypalme\/[^/]/ : /^\/[^/]/;
  if (!["paypal.me", "www.paypal.me", "www.paypal.com"].includes(host) || !path.test(url.pathname)) {
    throw new HttpError(400, BAD_LINK);
  }
  return url.href;
}

/** Payment links the viewer may see: their own, and anyone sharing a circle with them. No viewer, none. */
export function visiblePaymentUrls(db: DatabaseSync, viewerId: string | null): Map<string, string> {
  const map = new Map<string, string>();
  if (!viewerId) return map;
  const rows = db.prepare(
    `SELECT u.id, u.payment_url FROM users u
     WHERE u.payment_url IS NOT NULL
       AND (u.id = ? OR EXISTS (
         SELECT 1 FROM memberships mine JOIN memberships theirs ON theirs.circle_id = mine.circle_id
         WHERE mine.user_id = ? AND theirs.user_id = u.id
       ))`,
  ).all(viewerId, viewerId) as Array<{ id: string; payment_url: string }>;
  for (const row of rows) map.set(row.id, row.payment_url);
  return map;
}
