/**
 * The viewer's own live share. One share at a time, foreground only: the browser watch runs while the
 * page is visible and is cleared when it is hidden. Nothing here keeps running in the background.
 */
import { state } from "../state.js";
import { api } from "../session.js";
import { render } from "../render.js";
import { scheduleErrorClear } from "../lib.js";
import { LIVE_COPY } from "./live-copy.js";
import { shouldPost, waitMs } from "./live-logic.js";

/** The running share: { kind, id, watchId, last, pending, timer, sending } or null. */
let session = null;

const WATCH_OPTIONS = { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 };

/** True while this event is the one being shared. */
export function isSharing(kind, id) {
  return Boolean(session && session.kind === kind && session.id === id);
}

function say(message) {
  state.error = message;
  render();
  scheduleErrorClear();
}

/** Starts a share for one event. Asks the browser for location only now. */
export function startLive(kind, id) {
  if (!navigator.geolocation) {
    say(LIVE_COPY.unsupported);
    return false;
  }
  if (session) stopLive("", { quiet: true });
  session = { kind, id, watchId: null, last: null, pending: null, timer: 0, sending: false };
  if (!document.hidden) watch();
  render();
  return true;
}

/** Ends the share and tells the server, so the pin goes at once. A failed call is left to the 3 minute expiry. */
export function stopLive(message = LIVE_COPY.stopped, { quiet = false } = {}) {
  const ended = session;
  unwatch();
  session = null;
  if (ended && state.token) api(`/api/${ended.kind}s/${ended.id}/live`, { method: "DELETE" }).catch(() => {});
  if (quiet) return;
  if (message) say(message);
  else render();
}

function watch() {
  if (!session || session.watchId != null) return;
  session.watchId = navigator.geolocation.watchPosition(onReading, onWatchError, WATCH_OPTIONS);
}

function unwatch() {
  if (!session) return;
  clearTimeout(session.timer);
  if (session.watchId == null) return;
  navigator.geolocation.clearWatch(session.watchId);
  session.watchId = null;
}

function onWatchError(error) {
  // Only a refusal ends the share. A weak signal or a timeout just waits for the next reading.
  if (error?.code === 1) stopLive(LIVE_COPY.denied);
}

/** Keeps the newest reading and sends it when the throttle allows, so a final reading is never lost. */
function onReading(position) {
  if (!session || document.hidden) return;
  const { latitude, longitude, accuracy } = position.coords;
  session.pending = { lat: latitude, lng: longitude, accuracy };
  flush();
}

/** Sends the pending reading now, or sets a timer for when the wait is over. */
function flush() {
  const mine = session;
  if (!mine || mine.sending || document.hidden || !mine.pending) return;
  clearTimeout(mine.timer);
  const now = Date.now();
  const wait = waitMs(mine.last, now);
  if (wait > 0) {
    mine.timer = setTimeout(flush, wait);
    return;
  }
  const reading = mine.pending;
  mine.pending = null;
  if (shouldPost(mine.last, reading, now)) void post(mine, reading, now);
}

/** One post. The answer says whether the viewer arrived, which ends the share. */
async function post(mine, reading, now) {
  mine.sending = true;
  mine.last = { lat: reading.lat, lng: reading.lng, at: now };
  try {
    const result = await api(`/api/${mine.kind}s/${mine.id}/live`, { method: "POST", body: reading });
    if (session === mine && result.arrived) endArrived();
  } catch (error) {
    if (session === mine && error.status >= 400 && error.status < 500 && error.status !== 429) endRefused(error);
  } finally {
    mine.sending = false;
    flush();
  }
}

function endArrived() {
  unwatch();
  session = null;
  say(LIVE_COPY.arrived);
}

function endRefused(error) {
  unwatch();
  session = null;
  say(error.message || LIVE_COPY.stopped);
}

// The watch only runs while the page is visible. Coming back starts it again for the same share.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    unwatch();
    return;
  }
  watch();
  flush();
});
window.addEventListener("pagehide", unwatch);
