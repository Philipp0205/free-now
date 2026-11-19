/**
 * Picks up a new Hangry build while the app stays open. sw/sw.js already skipWaiting()s and claim()s, so a new worker
 * takes over by itself, but the page keeps running the old JS until it reloads. This module asks the browser to look
 * for a new worker (a pull to refresh, or coming back to the app at most once a minute) and reloads into it once
 * that is safe: not while a field has focus, and not while the composer or a sheet holds text that was not sent.
 * Nothing here touches the DOM or the app state at import, so the unit tests can load it in node.
 */

/** Coming back to the app checks for a new build at most this often (ms). A pull always checks. */
export const UPDATE_CHECK_MS = 60_000;
/** A pull waits this long (ms) for a found build to install before it lets the spinner go. */
export const UPDATE_WAIT_MS = 5000;
/** A reload that was held back looks again this often (ms). */
export const UPDATE_RETRY_MS = 1000;

const NOT_TEXT = new Set(["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"]);

/** A field the person types into: a text-like input, a textarea or an editable element. */
export function isTypingTarget(node) {
  if (!node) return false;
  const tag = String(node.tagName || "").toUpperCase();
  if (tag === "TEXTAREA") return true;
  if (tag === "INPUT") return !NOT_TEXT.has(String(node.type || "text").toLowerCase());
  return Boolean(node.isContentEditable);
}

/** Text in the composer or a sheet that was not sent or saved, or a chat message still waiting to go out. */
export function hasUnsentInput({ drafts = [], queued = false } = {}) {
  return Boolean(queued) || drafts.some((value) => String(value ?? "").trim() !== "");
}

/** A reload is safe when nobody is typing and nothing unsent would be lost. */
export function canReloadNow({ typing = false, unsent = false } = {}) {
  return !typing && !unsent;
}

/** Time for another service worker check: never done yet, or the window has passed (or the clock went back). */
export function shouldCheckNow(lastCheckAt, now, everyMs = UPDATE_CHECK_MS) {
  if (lastCheckAt === null || lastCheckAt === undefined) return true;
  return now < lastCheckAt || now - lastCheckAt >= everyMs;
}

/** One reload per page load: take() is true the first time and false after that. */
export function createReloadOnce() {
  let used = false;
  return {
    take() {
      if (used) return false;
      used = true;
      return true;
    },
    get used() {
      return used;
    },
  };
}

/** What the page holds right now: is a field focused, and is there text that would be lost on a reload. */
export function readGuard(state, doc = document) {
  const sheetFields = [...doc.querySelectorAll(".sheet input, .sheet textarea")].filter((field) => isTypingTarget(field) && !field.readOnly);
  return {
    typing: isTypingTarget(doc.activeElement),
    unsent: hasUnsentInput({
      drafts: [state.chatDraft, doc.getElementById("chat-input")?.value, ...sheetFields.map((field) => field.value)],
      queued: Boolean(state.chatQueue),
    }),
  };
}

/**
 * The update flow over injected parts, so it runs in node with fakes.
 *   sw        navigator.serviceWorker (controller, getRegistration, controllerchange)
 *   register  () => Promise of the registration
 *   guard     () => { typing, unsent }
 *   reload    reloads the page
 */
export function createUpdater({
  sw,
  register,
  guard,
  reload,
  now = () => Date.now(),
  later = (fn, ms) => setTimeout(fn, ms),
  everyMs = UPDATE_CHECK_MS,
  waitMs = UPDATE_WAIT_MS,
  retryMs = UPDATE_RETRY_MS,
}) {
  const once = createReloadOnce();
  let registration = null;
  let lastCheckAt = null;
  let controlled = Boolean(sw.controller);
  let pending = false;
  let holds = 0;
  let retrying = false;
  let inflight = null;

  /** Reload if a new build took over and it is safe. Otherwise try again soon, until the reload has started. */
  function apply() {
    if (!pending || holds > 0 || once.used) return false;
    if (!canReloadNow(guard())) {
      if (!retrying) {
        retrying = true;
        later(() => {
          retrying = false;
          apply();
        }, retryMs);
      }
      return false;
    }
    if (!once.take()) return false;
    reload();
    return true;
  }

  // The first worker claiming a page that had none is an install, not an update: there is nothing newer to load.
  sw.addEventListener("controllerchange", () => {
    const wasControlled = controlled;
    controlled = true;
    if (!wasControlled) return;
    pending = true;
    apply();
  });

  /** Resolves true once the new worker is active, false if it failed or took too long. */
  function untilActive(worker) {
    return new Promise((resolve) => {
      const look = () => {
        if (worker.state === "activated") resolve(true);
        else if (worker.state === "redundant") resolve(false);
      };
      worker.addEventListener("statechange", look);
      later(() => resolve(false), waitMs);
      look();
    });
  }

  async function check() {
    try {
      const current = registration || (await sw.getRegistration());
      if (!current) return false;
      // A dead connection must not hold a pull's spinner: give up after waitMs.
      await Promise.race([current.update(), new Promise((resolve) => later(resolve, waitMs))]);
      const worker = current.installing || current.waiting;
      return worker ? await untilActive(worker) : false;
    } catch {
      return false;
    }
  }

  return {
    register() {
      return Promise.resolve()
        .then(register)
        .then((found) => {
          registration = found;
          lastCheckAt = now();
          return found;
        })
        .catch(() => null);
    },
    /** Ask for a new worker. Throttled to everyMs unless force. Never rejects. Resolves true when a new build is active. */
    checkNow({ force = false } = {}) {
      if (inflight) return inflight;
      const at = now();
      if (!force && !shouldCheckNow(lastCheckAt, at, everyMs)) return Promise.resolve(false);
      lastCheckAt = at;
      inflight = check().finally(() => {
        inflight = null;
      });
      return inflight;
    },
    /** Keep a found build from reloading the page until the returned function is called (a pull holds its spinner). */
    holdReload() {
      holds += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds -= 1;
        apply();
      };
    },
    /** A safe moment may have come (a field lost focus, text was sent): reload now if one is waiting. */
    retry: apply,
    get pending() {
      return pending;
    },
  };
}

let updater = null;

/** Register the worker and start watching for new builds. getState returns the app's state object. */
export function initAppUpdates(getState) {
  if (updater || !("serviceWorker" in navigator)) return;
  updater = createUpdater({
    sw: navigator.serviceWorker,
    register: () => navigator.serviceWorker.register("/sw.js"),
    guard: () => readGuard(getState()),
    reload: () => location.reload(),
  });
  void updater.register();
  // A field losing focus is a safe moment. Focus moves after focusout, so look a tick later.
  document.addEventListener("focusout", () => setTimeout(() => updater?.retry(), 50));
}

/** Check for a new build. Coming back to the app passes no options and is throttled; a pull passes force. */
export function checkForUpdate(options) {
  return updater ? updater.checkNow(options) : Promise.resolve(false);
}

/** Hold a found build's reload until the returned function is called. A no-op without a worker. */
export function holdUpdateReload() {
  return updater ? updater.holdReload() : () => {};
}
