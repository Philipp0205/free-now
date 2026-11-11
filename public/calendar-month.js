/**
 * Month grid helpers for the Calendar view on the Map tab. Days are YYYY-MM-DD in the app
 * timezone; nothing here reads the browser clock or zone, so the rules can be tested.
 */
import { goingCrowd } from "./map-pin.js";
import { addDays } from "./when.js";

/** Monday first, short English names like the rest of the app. */
export const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Calm colours that read on the dark glass. A circle keeps its colour on every device. */
export const CIRCLE_COLORS = ["#ff4d8d", "#5ac8fa", "#ffd60a", "#30d158", "#bf5af2", "#ff9f0a", "#64d2ff", "#ff6961"];

/** The first of the month a day is in. */
export function monthStart(iso) {
  return `${String(iso).slice(0, 7)}-01`;
}

/** The first of the month `delta` months from `first`. */
export function shiftMonth(first, delta) {
  const [year, month] = first.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1 + delta, 1)).toISOString().slice(0, 10);
}

/** "November 2026". */
export function monthTitle(first) {
  const [year, month] = first.split("-").map(Number);
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

/** 0 for Monday through 6 for Sunday. */
export function weekdayIndex(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  return (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
}

/** Whole weeks, Monday to Sunday, that cover the month. Days of the months either side are padding. */
export function monthGrid(first) {
  const start = addDays(first, -weekdayIndex(first));
  const last = addDays(shiftMonth(first, 1), -1);
  const end = addDays(last, 6 - weekdayIndex(last));
  const prefix = first.slice(0, 7);
  const days = [];
  for (let day = start; day <= end; day = addDays(day, 1)) days.push({ day, inMonth: day.startsWith(prefix) });
  return days;
}

/** The first and last day the grid shows, which is what the month fetch asks for. */
export function gridRange(first) {
  const days = monthGrid(first);
  return { from: days[0].day, to: days[days.length - 1].day };
}

/** FNV-1a over the circle id, onto the palette. */
export function circleColor(id) {
  let hash = 0x811c9dc5;
  for (const char of String(id ?? "")) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return CIRCLE_COLORS[hash % CIRCLE_COLORS.length];
}


/** First letter of a name, upper case, for a face without a photo. */
export function initialOf(name) {
  return (Array.from(String(name || "?").trim())[0] || "?").toUpperCase();
}

/**
 * Who is in on one event, as faces for a small stack: the host, then everyone In (not maybe,
 * not Can't), each once, like a map pin crowd. A face has a photo when the person has avatarRev.
 */
export function eventCrowd(item, cap = 3) {
  const crowd = goingCrowd(item?.creator, item?.joined, cap);
  return {
    faces: crowd.faces.map((person) => ({ person, initial: initialOf(person.name), photo: Boolean(person.avatarRev) })),
    more: crowd.more,
    total: crowd.total,
  };
}

/**
 * Friends who are free on `day` but not on any of its events. A later change fills this in;
 * for now nobody is listed, so the calendar shows nothing extra.
 */
export function freeOnDay(day, events, friends) {
  void day;
  void events;
  void friends;
  return [];
}
