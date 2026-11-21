/** The lizard clip played with a buzz. It fails silently: the overlay never depends on it. */

export const LIZARD_SRC = "/sounds/lizard.m4a";

/** iOS only lets an element play later if it was started inside one of these (touchend and click, not pointerdown). */
const GESTURES = ["click", "touchend", "keydown"];

/**
 * One shared clip element. The first user gesture unlocks it (play, pause, rewind), so a buzz that arrives
 * from the poll can play on iOS. A blocked play() or any other failure is ignored.
 */
export function createLizard({ make = () => new Audio(LIZARD_SRC), doc = typeof document === "undefined" ? null : document } = {}) {
  let audio = null;
  let armed = false;
  let watching = false;
  const element = () => (audio ??= make());

  /** Runs inside a gesture: start the shared clip and stop it at once, which is what iOS counts as the unlock. */
  function unlock() {
    disarm();
    try {
      const clip = element();
      if (clip.paused === false) return; // a buzz is sounding right now: leave it alone
      quiet(clip.play());
      clip.pause();
      rewind(clip);
    } catch {
      /* the next gesture or the next backgrounding tries again */
    }
  }

  /** Listens for the first gesture, in the capture phase so a tap on a button still counts. */
  function arm() {
    if (!doc || armed) return;
    armed = true;
    for (const type of GESTURES) doc.addEventListener(type, unlock, true);
  }

  function disarm() {
    if (!doc || !armed) return;
    armed = false;
    for (const type of GESTURES) doc.removeEventListener(type, unlock, true);
  }

  /** Safe to call twice. Unlocks on the first gesture, and again on the first gesture after the app was in the background. */
  function install() {
    if (!doc) return;
    arm();
    if (watching) return;
    watching = true;
    doc.addEventListener("visibilitychange", () => {
      if (doc.visibilityState === "visible") arm();
    });
  }

  /** Plays the clip from the start. A blocked play() asks for another unlock and is otherwise ignored. */
  function play() {
    try {
      const clip = element();
      rewind(clip);
      quiet(clip.play(), arm);
    } catch {
      /* no sound is fine */
    }
  }

  return { play, install };
}

function rewind(clip) {
  try {
    clip.currentTime = 0;
  } catch {
    /* metadata is not loaded yet */
  }
}

/** Swallows a rejected play() promise. `onBlocked` runs when it was rejected. */
function quiet(started, onBlocked) {
  if (started && typeof started.catch === "function") started.catch(() => onBlocked?.());
}

const lizard = createLizard();

export const playLizard = lizard.play;
export const installLizardUnlock = lizard.install;

installLizardUnlock();
