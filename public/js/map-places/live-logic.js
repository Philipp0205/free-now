/**
 * Pure rules for live location: when to post a reading, which friend points are still fresh,
 * and the last-seen wording. No DOM, no browser APIs, so the numbers can be tested.
 */
import { haversine } from "../place.js";

/** Never post more often than this. */
export const POST_MIN_MS = 8000;
/** A reading this far from the last posted one may be posted once POST_MIN_MS has passed. */
export const POST_MIN_MOVE_M = 25;
/** A still phone posts again after this long, so the friend's pin does not age out. */
export const POST_HEARTBEAT_MS = 30000;
/** A friend point older than this is dropped. The server uses the same 3 minutes. */
export const LIVE_FRESH_MS = 3 * 60 * 1000;

/** Milliseconds until the next post is allowed. Zero when nothing was sent yet or the wait is over. */
export function waitMs(last, now) {
  return last ? Math.max(0, POST_MIN_MS - (now - last.at)) : 0;
}

/** True when this reading is worth sending, given the last one that was sent ({ lat, lng, at } or null). */
export function shouldPost(last, reading, now) {
  if (!last) return true;
  const elapsed = now - last.at;
  if (elapsed < POST_MIN_MS) return false;
  if (elapsed >= POST_HEARTBEAT_MS) return true;
  return haversine(last, reading) >= POST_MIN_MOVE_M;
}

/** The server sends `live` only to the host and people who are in, while the event is open and has a pin. */
export function canShareLive(item) {
  return Array.isArray(item?.live);
}

/** The friends' live points that are still fresh, never the viewer's own. */
export function freshLive(list, viewerId, now) {
  if (!Array.isArray(list)) return [];
  return list.filter((point) => point.id !== viewerId && now - point.updatedAt <= LIVE_FRESH_MS);
}

function minutesSince(updatedAt, now) {
  return Math.floor(Math.max(0, now - updatedAt) / 60000);
}

/** Short age for the pin: "just now" or "2m ago". */
export function seenShort(updatedAt, now) {
  const minutes = minutesSince(updatedAt, now);
  return minutes < 1 ? "just now" : `${minutes}m ago`;
}

/** Age for the card: "just now" or "last seen 2m ago". */
export function lastSeenText(updatedAt, now) {
  const minutes = minutesSince(updatedAt, now);
  return minutes < 1 ? "just now" : `last seen ${minutes}m ago`;
}
