/** The short "lizard" clip played with a buzz. It fails silently: the overlay never depends on it. */

export const LIZARD_SRC = "/sounds/lizard.m4a";

/** Plays the clip from the start. A blocked play() (no user gesture yet) or any other failure is ignored. */
export function playLizard(make = () => new Audio(LIZARD_SRC)) {
  try {
    const started = make().play();
    if (started && typeof started.catch === "function") started.catch(() => {});
  } catch {
    /* no sound is fine */
  }
}
