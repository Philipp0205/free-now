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

let watchId = "";
let seen = new Set();
let newestAt = 0;

/** A chat is being opened: its next thread is the first one again. */
export function forgetRain() {
  watchId = "";
  seen = new Set();
  newestAt = 0;
}

/**
 * Call with every thread the open chat receives (open, send, poll). Messages come oldest first.
 *  - The first thread of a chat (or of a different chat) is the catch-up: a trigger sent within
 *    RAIN_CATCHUP_MS that never played on this device rains. Anything older does not.
 *  - Later threads rain for new ids, unless the message is older than what was already seen
 *    (an older page prepended on scroll cannot replay).
 * Several triggers rain once, from the newest one. Every trigger considered is marked played, so it never
 * rains twice on this device. `now`, `storage` and `start` are injectable for tests.
 */
export function noteRainThread(thread, { now = Date.now(), storage = deviceStorage(), start = startRain } = {}) {
  const messages = thread?.messages;
  if (!thread?.id || !Array.isArray(messages)) return;
  const first = thread.id !== watchId;
  if (first) forgetRain();
  watchId = thread.id;
  const floor = newestAt;
  const played = readPlayed(storage, now);
  let emoji = "";
  let marked = false;
  for (const message of messages) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    const at = typeof message.at === "number" ? message.at : null;
    if (at !== null && at > newestAt) newestAt = at;
    // A GIF's text is only its label, and Goblin and system lines are not people writing.
    if (message.gif || message.system || message.goblin) continue;
    if (first ? at === null || now - at > RAIN_CATCHUP_MS : at !== null && at < floor) continue;
    if (played.has(message.id)) continue;
    const found = rainFor(message.text);
    if (!found) continue;
    played.set(message.id, at ?? now);
    marked = true;
    emoji = found;
  }
  if (marked) writePlayed(storage, played);
  if (emoji) start(emoji);
}

/* The overlay. */

const DROPS = 200;
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

/** Drops about 200 of `emoji` over the page for about 3.5 seconds, then removes itself. Returns false when it did not start. */
export function startRain(emoji) {
  if (active >= MAX_RAINS || reducedMotion()) return false;
  const layer = document.createElement("div");
  layer.className = "emoji-rain";
  layer.setAttribute("data-emoji-rain", emoji);
  layer.setAttribute("aria-hidden", "true");
  for (let i = 0; i < DROPS; i += 1) {
    const drop = document.createElement("span");
    drop.className = "emoji-rain-drop";
    drop.textContent = emoji;
    drop.style.setProperty("--x", `${(Math.random() * 100).toFixed(1)}%`);
    drop.style.setProperty("--size", `${Math.round(20 + Math.random() * 16)}px`);
    drop.style.setProperty("--dur", `${Math.round(FALL_MIN_MS + Math.random() * FALL_SPREAD_MS)}ms`);
    drop.style.setProperty("--delay", `${Math.round(Math.random() * DELAY_SPREAD_MS)}ms`);
    drop.style.setProperty("--spin", `${Math.round(Math.random() * 240 - 120)}deg`);
    layer.append(drop);
  }
  document.body.append(layer);
  active += 1;
  setTimeout(() => {
    layer.remove();
    active -= 1;
  }, CLEANUP_MS);
  return true;
}
