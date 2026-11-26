/**
 * Pure rules for the Joining only filter: the saved choice and which events it keeps.
 * No DOM and no app state; the viewer's user id is passed in.
 */
import { isGoing } from "../map-pin.js";

/** "1" when this device hides events the person is not joining; anything else, or nothing, shows all. */
export const JOINING_ONLY_KEY = "fn_joining_only";

function deviceStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** True when the filter is on. A missing or unreadable store means off. */
export function readJoiningOnly(storage = deviceStorage()) {
  try {
    return storage?.getItem(JOINING_ONLY_KEY) === "1";
  } catch {
    return false;
  }
}

/** Remembers the choice on this device. A store that cannot be written is skipped. */
export function writeJoiningOnly(on, storage = deviceStorage()) {
  try {
    storage?.setItem(JOINING_ONLY_KEY, on ? "1" : "0");
  } catch {
    /* storage off */
  }
}

/** Keep what the person hosts, said In to, or marked Maybe. No reply and Can't join are hidden. */
export function isJoining(item, userId) {
  if (!userId) return true;
  if (item?.creator?.id === userId) return true;
  const mine = (item?.joined || []).find((person) => person?.id === userId);
  return isGoing(mine) || mine?.reply === "maybe";
}

/** The items to show: all of them while the filter is off, else only the ones the person is joining. */
export function filterJoining(items, on, userId) {
  return on ? items.filter((item) => isJoining(item, userId)) : items;
}
