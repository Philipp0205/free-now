/** Native-feel glue over the app kit: large titles and screen transitions. Both do nothing when the kit is missing. */

let titleBinding = null;

/**
 * Run a screen change (usually render()) as a push or a pop. With view transitions the old screen slides
 * out and the new one in; without them, or with reduced motion, update() simply runs, in this call.
 * Change `state` before calling and put only the DOM swap in `update`: with a transition it runs a frame later.
 */
export function navigate(update, direction = "push") {
  const transition = window.AppKit?.transition;
  if (!transition || typeof transition.go !== "function") {
    update();
    return Promise.resolve();
  }
  return Promise.resolve(transition.go(update, { direction })).catch((error) => {
    console.error("screen transition failed", error);
  });
}

/**
 * Point the kit's large title at the page that was just drawn. The new bar starts out collapsed or not by where
 * the title sits now, so a redraw while scrolled (the 3s refresh) does not flash the bar before the observer reports.
 */
export function bindLargeTitle() {
  titleBinding?.destroy();
  titleBinding = null;
  const title = document.querySelector(".ak-large-title");
  const navbar = document.querySelector(".ak-navbar");
  if (!title || !navbar) return;
  navbar.classList.toggle("ak-collapsed", title.getBoundingClientRect().bottom <= navbar.offsetHeight + 1);
  titleBinding = window.AppKit?.largeTitle?.(title, { navbar }) ?? null;
}
