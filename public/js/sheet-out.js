/*
 * Sheets close from where they are. The app state closes at once (history, focus and the next render do not wait),
 * so the sheet that is leaving is put back as an inert copy of itself, on the body, and slides down from its own
 * offset (a drag leaves it part way down) while its scrim fades. Same length as the kit's sheet close
 * (--ak-duration-sheet). Under reduced motion it just goes.
 */

const FALLBACK_MS = 220;
/** The panel an explicit close is about to remove. Set by the close, taken by the very next render(). */
let leaving = null;

function reducedMotion() {
  return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
}

function slideMs() {
  const value = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ak-duration-sheet"));
  return value > 0 ? value : FALLBACK_MS;
}

/** A close is about to render without this panel. Only the render that follows it animates, never a later one. */
export function sheetLeaving(panel) {
  if (!panel || reducedMotion()) return;
  leaving = panel;
  queueMicrotask(() => {
    if (leaving === panel) leaving = null;
  });
}

/** render() takes the mark before it swaps the page. */
export function takeLeavingSheet() {
  const panel = leaving;
  leaving = null;
  return panel;
}

/** render() calls this after the swap: the panel that left slides the rest of the way down, then is removed. */
export function slideOutSheet(panel) {
  if (!panel || panel.isConnected) return;
  const wrapper = panel.parentElement;
  if (!wrapper || wrapper === document.body || wrapper.id === "app" || wrapper.classList.contains("phone")) return;
  const guide = panel.classList.contains("guide");
  const ms = slideMs();
  const scrim = wrapper.classList.contains("guide-scrim") ? wrapper : wrapper.querySelector(".scrim");
  wrapper.setAttribute("aria-hidden", "true");
  wrapper.setAttribute("inert", "");
  wrapper.style.pointerEvents = "none";
  // The copy must not share ids with the live page (labels, focus restore).
  wrapper.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
  panel.classList.remove("dragging", "snap-settle");
  // Start where it is: the drag offset if there was one, else rest.
  const rest = guide ? "translateY(0px)" : "translateX(-50%)";
  if (!panel.style.transform) panel.style.transform = rest;
  document.body.append(wrapper);
  void wrapper.offsetWidth;
  panel.style.transition = `transform ${ms}ms ease-in`;
  panel.style.transform = guide ? "translateY(100%)" : "translateX(-50%) translateY(100%)";
  if (scrim) {
    scrim.style.transition = `opacity ${ms}ms ease-in`;
    scrim.style.opacity = "0";
  }
  window.setTimeout(() => wrapper.remove(), ms + 40);
}
