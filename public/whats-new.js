/**
 * What's new: pure helpers over public/whats-new.json.
 * Entries are newest first. The seen id is the newest entry the user has already seen.
 */

const ID_RE = /^[a-z0-9-]{1,64}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const SEEN_KEY = "fn_whats_new_seen";

export function validId(id) {
  return typeof id === "string" && ID_RE.test(id);
}

/** Only well-formed entries survive, so a bad edit to the JSON cannot break the app. */
export function normalizeEntries(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry) =>
      entry &&
      validId(entry.id) &&
      typeof entry.title === "string" &&
      entry.title.trim() &&
      typeof entry.date === "string" &&
      Array.isArray(entry.bullets) &&
      entry.bullets.length > 0 &&
      entry.bullets.every((bullet) => typeof bullet === "string" && bullet.trim()),
  );
}

export function latestId(entries) {
  return entries?.[0]?.id ?? null;
}

/**
 * Entries the user has not seen yet.
 * Nothing seen: all of them. An id this client does not know (a newer release): none.
 */
export function unseenEntries(entries, seenId) {
  if (!Array.isArray(entries) || !entries.length) return [];
  if (!seenId) return entries.slice();
  const index = entries.findIndex((entry) => entry.id === seenId);
  if (index < 0) return [];
  return entries.slice(0, index);
}

function rank(entries, id) {
  if (!id) return Number.POSITIVE_INFINITY;
  const index = entries.findIndex((entry) => entry.id === id);
  return index < 0 ? -1 : index;
}

/** The newer of two seen ids. Unknown ids count as newer than any known entry. */
export function newerSeen(entries, a, b) {
  const left = a || null;
  const right = b || null;
  return rank(entries, right) < rank(entries, left) ? right : left;
}

/** "2026-11-05" → "5 Nov 2026". Anything else is shown as written. */
export function formatEntryDate(date) {
  const match = DATE_RE.exec(String(date || ""));
  if (!match) return String(date || "");
  const month = MONTHS[Number(match[2]) - 1];
  if (!month) return String(date);
  return `${Number(match[3])} ${month} ${match[1]}`;
}
