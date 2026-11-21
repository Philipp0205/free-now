/**
 * Emoji rain in chat. Client side only: the message text is sent and shown as written.
 *  - A message with the word taco or tacos rains tacos.
 *  - A message that starts with /makeitrain rains the first emoji after it. With no emoji it rains tacos,
 *    and the text stays in the chat as sent.
 * Nothing here touches the DOM or app state until a rain starts, so the matchers load fine under node.
 */

export const DEFAULT_RAIN = "🌮";
const COMMAND = /^\s*\/makeitrain(?![\p{L}\p{N}_])([\s\S]*)$/iu;
// No lookbehind: older Safari fails to parse it, and a parse error would take the whole app down.
const TACO = /(?:^|[^\p{L}\p{N}_])tacos?(?![\p{L}\p{N}_])/iu;
/** Same bound as the server's reaction emoji (src/chat/emoji.ts). */
const EMOJI_MAX_UNITS = 32;

// RGI_Emoji (single emoji, skin tones, flags, keycaps, ZWJ sequences) needs the `v` flag, which older browsers lack.
let RGI_EMOJI;
try {
  RGI_EMOJI = new RegExp("^\\p{RGI_Emoji}$", "v");
} catch {
  RGI_EMOJI = /^(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic}[\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F\u200D\u{E0020}-\u{E007F}]*)$/u;
}
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

/** The first emoji grapheme in `text` (flags, skin tones and ZWJ sequences stay whole), or "". */
export function firstEmoji(text) {
  if (typeof text !== "string") return "";
  for (const { segment } of graphemes.segment(text)) {
    if (segment.length <= EMOJI_MAX_UNITS && RGI_EMOJI.test(segment)) return segment;
  }
  return "";
}

/** What a message rains: its emoji, tacos, or "" for no rain. /makeitrain wins over the word taco. */
export function rainFor(text) {
  if (typeof text !== "string") return "";
  const command = COMMAND.exec(text);
  if (command) return firstEmoji(command[1]) || DEFAULT_RAIN;
  return TACO.test(text) ? DEFAULT_RAIN : "";
}

/* Which messages rain, and which already did on this device. */

/** A rain missed while the chat was closed still plays on open if its message is newer than this. */
export const RAIN_CATCHUP_MS = 60 * 60 * 1000;
/** localStorage: { [messageId]: sentAt } for rains already played on this device. */
export const RAIN_PLAYED_KEY = "fn_rain_played";
/** Most ids kept. Older ones are dropped first. */
export const RAIN_PLAYED_MAX = 50;

function deviceStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The played ids as a Map of id to sent time, without the ones older than the catch-up window. Never throws. */
export function readPlayed(storage, now = Date.now()) {
  const played = new Map();
  try {
    const stored = JSON.parse(storage?.getItem(RAIN_PLAYED_KEY) || "{}");
    for (const [id, at] of Object.entries(stored || {})) {
      if (typeof at === "number" && now - at <= RAIN_CATCHUP_MS) played.set(id, at);
    }
  } catch {
    /* unreadable store: start empty */
  }
  return played;
}

/** Saves the newest RAIN_PLAYED_MAX ids. Never throws (private mode, full quota). */
export function writePlayed(storage, played) {
  const newest = [...played].sort((a, b) => b[1] - a[1]).slice(0, RAIN_PLAYED_MAX);
  try {
    storage?.setItem(RAIN_PLAYED_KEY, JSON.stringify(Object.fromEntries(newest)));
  } catch {
    /* the rain just may play again after a restart */
  }
}

/*
 * Taco hurricane: a burst of taco messages plays one bigger rain instead of the normal one.
 *  - A taco message is one whose rain is tacos (rainFor(text) === DEFAULT_RAIN): the word taco or tacos, or
 *    /makeitrain with no emoji. /makeitrain 🥚 and other rains do not count. GIF, system and Goblin lines never count.
 *    A lone 🌮 character is not a trigger (the matcher is unchanged), so it does not count either.
 *  - HURRICANE_COUNT or more taco messages, from anyone in the chat, within HURRICANE_WINDOW_MS of each other
 *    (counted back from the newest new one) start the hurricane.
 *  - Once per burst: a played hurricane covers the HURRICANE_WINDOW_MS after its newest message. Taco messages up
 *    to the end of that cover rain normally and cannot start another hurricane. A fresh set after it can.
 */
export const HURRICANE_COUNT = 3;
export const HURRICANE_WINDOW_MS = 60_000;
/** localStorage: { [chatId]: sentAt } until when a played hurricane covers that chat. */
export const HURRICANE_KEY = "fn_rain_hurricane";

/**
 * Pure rule, no DOM. `times` are the sent times of every taco message of the chat, `fresh` the ones that have not
 * rained yet, `since` the end of the last hurricane's window (older taco messages are ignored).
 * Returns the sent time of the newest message that ends a qualifying burst with a fresh message in it, or null.
 */
export function hurricaneEnd(times, fresh, since = 0) {
  const taco = (times || []).filter((at) => Number.isFinite(at) && at > since);
  const ends = (fresh || []).filter((at) => Number.isFinite(at) && at > since).sort((a, b) => b - a);
  for (const end of ends) {
    const inWindow = taco.filter((at) => at <= end && end - at <= HURRICANE_WINDOW_MS);
    if (inWindow.length >= HURRICANE_COUNT) return end;
  }
  return null;
}

function readHurricanes(storage, now) {
  const covered = {};
  try {
    const stored = JSON.parse(storage?.getItem(HURRICANE_KEY) || "{}");
    for (const [id, until] of Object.entries(stored || {})) {
      if (typeof until === "number" && now - until <= RAIN_CATCHUP_MS) covered[id] = until;
    }
  } catch {
    /* unreadable store: start empty */
  }
  return covered;
}

function writeHurricanes(storage, covered) {
  try {
    storage?.setItem(HURRICANE_KEY, JSON.stringify(covered));
  } catch {
    /* the hurricane may just play again after a restart */
  }
}

let watchId = "";
let seen = new Set();
let newestAt = 0;
/** Sent times of the taco messages this open chat has shown (played or not), for the hurricane count. */
let tacoAts = [];
/** Until when a hurricane played in this open chat covers new taco messages. */
let hurricaneUntil = 0;

/** A chat is being opened: its next thread is the first one again. */
export function forgetRain() {
  watchId = "";
  seen = new Set();
  newestAt = 0;
  tacoAts = [];
  hurricaneUntil = 0;
}

/**
 * Call with every thread the open chat receives (open, send, poll). Messages come oldest first.
 *  - The first thread of a chat (or of a different chat) is the catch-up: a trigger sent within
 *    RAIN_CATCHUP_MS that never played on this device rains. Anything older does not.
 *  - Later threads rain for new ids, unless the message is older than what was already seen
 *    (an older page prepended on scroll cannot replay).
 * Several triggers rain once, from the newest one. Every trigger considered is marked played, so it never
 * rains twice on this device. A taco burst (see HURRICANE_COUNT) rains once as a hurricane instead of the normal
 * rain, and taco messages that land later inside that hurricane's window rain normally. `now`, `storage` and
 * `start` are injectable for tests; `start(emoji)` is a normal rain and `start(emoji, true)` the hurricane.
 */
export function noteRainThread(thread, { now = Date.now(), storage = deviceStorage(), start = startRain } = {}) {
  const messages = thread?.messages;
  if (!thread?.id || !Array.isArray(messages)) return;
  const first = thread.id !== watchId;
  if (first) forgetRain();
  watchId = thread.id;
  const floor = newestAt;
  const played = readPlayed(storage, now);
  const hurricanes = readHurricanes(storage, now);
  const cover = Math.max(hurricaneUntil, hurricanes[thread.id] || 0);
  const fresh = [];
  let marked = false;
  for (const message of messages) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    const at = typeof message.at === "number" ? message.at : null;
    if (at !== null && at > newestAt) newestAt = at;
    // A GIF's or a poll's text is only a label, and Goblin and system lines are not people writing.
    if (message.gif || message.poll || message.system || message.goblin) continue;
    if (first ? at === null || now - at > RAIN_CATCHUP_MS : at !== null && at < floor) continue;
    const found = rainFor(message.text);
    if (found === DEFAULT_RAIN) tacoAts.push(at ?? now);
    if (played.has(message.id) || !found) continue;
    played.set(message.id, at ?? now);
    marked = true;
    fresh.push({ emoji: found, at: at ?? now });
  }
  if (marked) writePlayed(storage, played);
  const end = hurricaneEnd(tacoAts, fresh.filter((item) => item.emoji === DEFAULT_RAIN).map((item) => item.at), cover);
  if (end !== null) {
    hurricaneUntil = end + HURRICANE_WINDOW_MS;
    writeHurricanes(storage, { ...hurricanes, [thread.id]: hurricaneUntil });
    start(DEFAULT_RAIN, true);
    return;
  }
  // Later taco messages inside a played hurricane's window rain as usual but cannot start another hurricane.
  if (fresh.length) start(fresh[fresh.length - 1].emoji);
}

/* The overlay. */

const DROPS = 200;
/** Under reduced motion the rain still falls, but with fewer drops and no spin. */
const REDUCED_DROPS = 40;
const MAX_RAINS = 2;
const FALL_MIN_MS = 2200;
const FALL_SPREAD_MS = 600;
const DELAY_SPREAD_MS = 800;
/** Last drop starts at DELAY_SPREAD_MS and falls for at most FALL_MIN_MS + FALL_SPREAD_MS. */
const CLEANUP_MS = DELAY_SPREAD_MS + FALL_MIN_MS + FALL_SPREAD_MS + 100;
let active = 0;

function reducedMotion() {
  return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
}

/** How many drops fall, and whether they spin. Reduced motion gets a lighter rain, not no rain. */
export function rainStyle(reduced, hurricane = false) {
  if (hurricane) return hurricaneStyle(reduced);
  return reduced ? { drops: REDUCED_DROPS, spin: false } : { drops: DROPS, spin: true };
}

/** The hurricane: more drops, a swirl, about 5.5s and a short shake. Under reduced motion: a gentle sideways drift, no spin, no shake. */
const HURRICANE_DROPS = 360;
const HURRICANE_REDUCED_DROPS = 100;
const HURRICANE_FALL_MIN_MS = 3200;
const HURRICANE_FALL_SPREAD_MS = 800;
const HURRICANE_DELAY_SPREAD_MS = 1400;

function hurricaneStyle(reduced) {
  const fallMs = reduced ? FALL_MIN_MS + 600 : HURRICANE_FALL_MIN_MS;
  const spreadMs = reduced ? FALL_SPREAD_MS : HURRICANE_FALL_SPREAD_MS;
  const delayMs = reduced ? DELAY_SPREAD_MS : HURRICANE_DELAY_SPREAD_MS;
  return {
    drops: reduced ? HURRICANE_REDUCED_DROPS : HURRICANE_DROPS,
    spin: !reduced,
    hurricane: true,
    shake: !reduced,
    fallMs,
    spreadMs,
    delayMs,
    cleanupMs: delayMs + fallMs + spreadMs + 100,
  };
}

/**
 * Drops about 200 of `emoji` (fewer, without spin, under reduced motion) for about 3.5 seconds, then removes itself.
 * With `hurricane` it is the bigger taco hurricane instead (see rainStyle). Returns false when it did not start.
 */
export function startRain(emoji, hurricane = false) {
  // The cap keeps normal rains from piling up. The hurricane is rare (once per burst) and replaces the rain of its
  // newest message, so it plays even while the burst's own normal rains are still falling.
  if (active >= MAX_RAINS && !hurricane) return false;
  const style = rainStyle(reducedMotion(), hurricane);
  const { drops, spin } = style;
  const fallMs = style.fallMs ?? FALL_MIN_MS;
  const spreadMs = style.spreadMs ?? FALL_SPREAD_MS;
  const delayMs = style.delayMs ?? DELAY_SPREAD_MS;
  const layer = document.createElement("div");
  layer.className = style.shake ? "emoji-rain emoji-rain-shake" : "emoji-rain";
  layer.setAttribute("data-emoji-rain", emoji);
  layer.setAttribute("data-emoji-rain-kind", hurricane ? "hurricane" : "rain");
  layer.setAttribute("aria-hidden", "true");
  for (let i = 0; i < drops; i += 1) {
    const drop = document.createElement("span");
    drop.className = "emoji-rain-drop";
    drop.textContent = emoji;
    drop.style.setProperty("--x", `${(Math.random() * 100).toFixed(1)}%`);
    drop.style.setProperty("--size", `${Math.round(20 + Math.random() * 16)}px`);
    drop.style.setProperty("--dur", `${Math.round(fallMs + Math.random() * spreadMs)}ms`);
    drop.style.setProperty("--delay", `${Math.round(Math.random() * delayMs)}ms`);
    if (hurricane) {
      const side = Math.random() < 0.5 ? -1 : 1;
      drop.classList.add("emoji-rain-drop-hurricane");
      // Swirl width (px) and the sideways wind (vw) the drop ends up pushed by.
      drop.style.setProperty("--sway", `${Math.round((spin ? 50 : 14) + Math.random() * (spin ? 90 : 16)) * side}px`);
      drop.style.setProperty("--wind", `${Math.round((spin ? 18 : 6) + Math.random() * (spin ? 22 : 6))}vw`);
    }
    drop.style.setProperty("--spin", `${spin ? Math.round(Math.random() * (hurricane ? 1080 : 240) - (hurricane ? 540 : 120)) : 0}deg`);
    layer.append(drop);
  }
  document.body.append(layer);
  active += 1;
  setTimeout(() => {
    layer.remove();
    active -= 1;
  }, style.cleanupMs ?? CLEANUP_MS);
  return true;
}
