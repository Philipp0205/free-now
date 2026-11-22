/**
 * Pure rules for the compact view of the Now list: the saved choice, the who-line and the date.
 * No DOM and no app state, so the rules can be tested with a plain storage object and a frozen clock.
 */
import { cardCrowd } from "./map-pin.js";
import { clockText, dayLabel, zonedParts } from "./when.js";
import { MAYBE_COPY } from "./plans/maybe-copy.js";

/** "1" when this device shows the Now list as one line per event; anything else, or nothing, is the cards. */
export const COMPACT_HOME_KEY = "fn_compact_home";

/** Names shown in a compact line before "+N". */
export const COMPACT_WHO_CAP = 3;

function deviceStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** True for the compact list. A missing or unreadable store means the cards. */
export function readCompactHome(storage = deviceStorage()) {
  try {
    return storage?.getItem(COMPACT_HOME_KEY) === "1";
  } catch {
    return false;
  }
}

/** Remembers the choice on this device. A store that cannot be written is skipped; the choice then lasts until reload. */
export function writeCompactHome(on, storage = deviceStorage()) {
  try {
    storage?.setItem(COMPACT_HOME_KEY, on ? "1" : "0");
  } catch {
    /* storage off */
  }
}

/**
 * Who is going, for one line: the host, then everyone In (same people as the card's faces).
 * `shown` is the first few people, `names` their names, `more` how many are left, and `text` reads
 * as "Hana, Alex, Bea and 2 more". A person without a name shows as "Someone". `maybe` counts the
 * Maybe replies on their own; they are never in `shown`, and `text` ends with ", 2 maybe" for them.
 */
export function compactWho(host, joined = [], cap = COMPACT_WHO_CAP) {
  const crowd = cardCrowd(host, joined);
  const shown = crowd.people.slice(0, cap);
  const names = shown.map((person) => String(person?.name ?? "").trim() || "Someone");
  const more = crowd.people.length - shown.length;
  const maybe = crowd.maybe.length;
  const going = more > 0 ? `${names.join(", ")} and ${more} more` : names.join(", ");
  const text = maybe > 0 ? [going, MAYBE_COPY.count(maybe)].filter(Boolean).join(", ") : going;
  return { shown, names, more, maybe, text };
}

/** The line's title, same words as the card's heading. */
export function compactTitle(kind, item, now = Date.now()) {
  if (kind === "plan") return item?.note || "Plan";
  return item?.note || (item?.startsAt && item.startsAt > now ? "Free later" : "Free now");
}

/**
 * The line's date: "Today 19:00", "Tomorrow", "Sat 14 Nov 19:00" for a plan; "Now" for a live
 * free post and "Today 19:00" for one that starts later. Days follow the app timezone.
 */
export function compactWhen(kind, item, now = Date.now(), tz = "Europe/Berlin") {
  const today = zonedParts(now, tz).day;
  if (kind === "plan") {
    return [dayLabel(item?.forDate, today) || item?.whenLabel || "", item?.time || ""].filter(Boolean).join(" ");
  }
  if (!(item?.startsAt && item.startsAt > now)) return "Now";
  const start = zonedParts(item.startsAt, tz);
  return `${dayLabel(start.day, today)} ${clockText(start.hour, start.minute)}`;
}
