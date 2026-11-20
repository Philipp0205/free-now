/**
 * Pure rules for what a map pin shows: is a social live now, the day label under a
 * pin for later, and who is in the crowd on a plan pin. No DOM, no app state, so the
 * rules can be tested with a frozen clock.
 */
import { clockText, dayLabel, shortDate, zonedParts } from "./when.js";

/** "now" while a free-now social runs, "later" before it starts, "ended" once it is past. */
export function socialPinState(social, now = Date.now()) {
  if (!social || !(Number(social.expiresAt) > now)) return "ended";
  if (social.startsAt && social.startsAt > now) return "later";
  return "now";
}

/** The map's now rule for any event: a live social is now, a plan never is. Cards and compact rows use this. */
export function eventIsNow(kind, item, now = Date.now()) {
  return kind === "social" && socialPinState(item, now) === "now";
}

/**
 * The label under a pin, in words the app already uses: "Later today 19:00" while the
 * time is still ahead, "Today" once it has passed, "Tomorrow", then "Sat 14 Nov".
 * "" for a day already past. Days follow the app timezone, not the phone's.
 */
export function pinWhenLabel(day, time, now = Date.now(), tz = "Europe/Berlin") {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || "")) return "";
  const today = zonedParts(now, tz);
  if (day < today.day) return "";
  if (day === today.day) {
    const clock = /^\d{2}:\d{2}$/.test(time || "") ? time : "";
    return clock && clock > clockText(today.hour, today.minute) ? `Later today ${clock}` : "Today";
  }
  const label = dayLabel(day, today.day);
  return label === "Tomorrow" ? label : shortDate(day, today.day);
}

/** Plans keep their day label. A social that has not started shows when it starts; a live one shows none. */
export function pinLabel(kind, item, now = Date.now(), tz = "Europe/Berlin") {
  if (kind === "plan") return pinWhenLabel(item?.forDate, item?.time, now, tz);
  if (socialPinState(item, now) !== "later") return "";
  const start = zonedParts(item.startsAt, tz);
  return pinWhenLabel(start.day, clockText(start.hour, start.minute), now, tz);
}

/** Only In counts as going. Maybe and Can't stay off the pin. */
export function isGoing(person) {
  return person?.reply === "coming" || person?.reply === "join" || person?.reply === "in";
}

/** Host first, then everyone In, each person once. `faces` is capped; `more` is the rest. */
export function goingCrowd(host, joined = [], cap = 3) {
  const people = [];
  const seen = new Set();
  for (const person of [host, ...(joined || []).filter(isGoing)]) {
    if (!person?.id || seen.has(person.id)) continue;
    seen.add(person.id);
    people.push(person);
  }
  const faces = people.slice(0, cap);
  return { faces, more: people.length - faces.length, total: people.length };
}

/**
 * Who an event card shows versus the details. The card is about who's in: `stack` is the
 * host, then everyone In or Maybe, each once, capped at `cap` faces with `more` for the rest.
 * `listed` is the replies the card lists (In and Maybe). `cant` is who said Can't, for the
 * details only.
 */
export function cardCrowd(host, joined = [], cap = 6) {
  const people = [];
  const listed = [];
  const cant = [];
  const seen = new Set();
  for (const person of [host, ...(joined || [])]) {
    if (!person?.id || seen.has(person.id)) continue;
    seen.add(person.id);
    if (person !== host && person.reply === "declined") {
      cant.push(person);
      continue;
    }
    people.push(person);
    if (person !== host && (isGoing(person) || person.reply === "maybe")) listed.push(person);
  }
  const stack = people.slice(0, cap);
  return { people, stack, more: people.length - stack.length, listed, cant };
}
