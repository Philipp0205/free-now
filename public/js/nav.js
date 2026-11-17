import { state } from "./state.js";
import { closeMapCard, mapCardOpen, refreshPins } from "./map-card.js";
import { render } from "./render.js";
import { closePast } from "./home.js";
import { markAlertsRead } from "./alerts.js";
import { clearReply, closeChat, closeReactUi, openChat } from "./chat.js";
import { closeYouSection } from "./you.js";
import { closeBusyPreview } from "./busy-preview.js";
import { loadCalendar, refreshMapAll } from "./events.js";
import { closeSheet } from "./sheets.js";
import { closeInstallSteps, dismissJoinInstall } from "./push-install.js";

/** How many history entries the app pushed for open overlays (sheets, panels, non-home tabs). */
let overlayHistoryDepth = 0;

/** Pops we caused ourselves via history.go() and must not treat as Back. */
let ignoreSheetPop = 0;
let closingFromPop = false;

/** Tabs other than Now that Back leaves for Now. Alerts is its own layer (closeAlerts). */
const TAB_LAYERS = ["map", "circle", "you"];

/** Open layers Back can close, one history entry each (see dismissTopOverlay for order). */
function currentOverlayDepth() {
  let depth = 0;
  if (state.confirm) depth += 1;
  if (state.cardMenu) depth += 1;
  if (state.installOpen) depth += 1;
  // Onboarding waits behind an open sheet (see view), so it only counts once the sheet is gone.
  if ((state.onboarding || state.joinInstall) && !state.sheet) depth += 1;
  if (state.installSheet) depth += 1;
  if (state.installSteps) depth += 1;
  if (state.sheet) depth += 1;
  if (!shellShown()) return depth;
  if (state.circleMenu) depth += 1;
  if (state.chat) depth += 1;
  if (state.past) depth += 1;
  if (state.tab === "you" && state.youSection) depth += 1;
  if (state.tab === "you" && state.busyPreview?.open) depth += 1;
  return depth + tabLayers();
}

function plainTabLayer(tab) {
  return TAB_LAYERS.includes(tab) ? 1 : 0;
}

/** Alerts and a place's map sit on top of the tab they return to, so that tab keeps its own entry. */
function tabLayers() {
  if (state.tab === "alerts") return 1 + plainTabLayer(state.alertsReturn);
  if (state.tab === "map" && state.mapHistory) {
    const back = state.mapReturnTab;
    return 1 + (back === "alerts" ? 1 + plainTabLayer(state.alertsReturn) : plainTabLayer(back));
  }
  return plainTabLayer(state.tab);
}

function shellShown() {
  return Boolean(!state.booting && !state.sharePreview && state.token && state.me?.circle);
}

/** Closes exactly the topmost layer. Same order as currentOverlayDepth. */
function dismissTopOverlay() {
  if (state.confirm) {
    state.confirm = null;
    render();
    return;
  }
  if (state.cardMenu) {
    const key = state.cardMenu;
    state.cardMenu = null;
    render();
    // Back on the ⋯ that opened it, so the keyboard user keeps their place.
    document.querySelector(`.card-more[data-menu="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
    return;
  }
  if (state.installOpen) {
    state.installOpen = false;
    render();
    return;
  }
  if (state.joinInstall && !state.sheet) {
    dismissJoinInstall();
    return;
  }
  if (state.onboarding && !state.sheet) {
    state.onboarding = false;
    render();
    return;
  }
  if (state.installSheet) {
    state.installSheet = false;
    render();
    return;
  }
  if (state.installSteps) {
    closeInstallSteps();
    return;
  }
  if (state.sheet) {
    closeSheet();
    return;
  }
  if (!shellShown()) return;
  if (state.circleMenu) {
    state.circleMenu = false;
    render();
    return;
  }
  if (state.chat) {
    closeChat();
    return;
  }
  if (state.past) {
    closePast();
    return;
  }
  if (state.tab === "you" && state.busyPreview?.open) {
    closeBusyPreview();
    return;
  }
  if (state.tab === "you" && state.youSection) {
    closeYouSection();
    return;
  }
  if (state.tab === "alerts") {
    closeAlerts();
    return;
  }
  if (state.mapHistory && state.tab === "map") {
    state.mapHistory = false;
    state.tab = state.mapReturnTab || "home";
    state.focusPin = "";
    render();
    return;
  }
  if (TAB_LAYERS.includes(state.tab)) {
    state.tab = "home";
    state.focusPin = "";
    render();
  }
}

/** Keeps one pushed history entry per open layer so the phone's Back closes them, not the app. */
export function syncOverlayHistory() {
  // A history.go() we started has not landed yet. Pushing now would be undone by it; catch up on its popstate.
  if (ignoreSheetPop > 0) return;
  const depth = currentOverlayDepth();
  while (depth > overlayHistoryDepth) {
    overlayHistoryDepth += 1;
    history.pushState({ hangryOverlay: overlayHistoryDepth }, "");
  }
  if (depth < overlayHistoryDepth && !closingFromPop) {
    const extra = overlayHistoryDepth - depth;
    overlayHistoryDepth = depth;
    // One go(-n) fires a single popstate; back() called n times in a row is not reliable.
    ignoreSheetPop += 1;
    history.go(-extra);
  }
}

function scrollableAncestor(node) {
  let current = node instanceof Element ? node : null;
  while (current && current !== document.body) {
    const style = getComputedStyle(current);
    const overflow = style.overflowY;
    if ((overflow === "auto" || overflow === "scroll" || overflow === "overlay") && current.scrollHeight > current.clientHeight + 1) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function horizontalScroller(node) {
  let current = node instanceof Element ? node : null;
  while (current && current !== document.body) {
    const style = getComputedStyle(current);
    const overflow = style.overflowX;
    if ((overflow === "auto" || overflow === "scroll") && current.scrollWidth > current.clientWidth + 1) return current;
    current = current.parentElement;
  }
  return null;
}

/** Pull past the lowest snap by this much (px) and the sheet closes on release. Same number the kit uses. */
const CLOSE_DRAG = 72;
/** A flick is at least this fast (px per ms) after this many px of travel. Same numbers as the kit's ak-sheet. */
const FLICK_SPEED = 0.5;
const FLICK_MIN = 10;
/** The lower snap, as a fraction of the visible viewport. The upper snap is the sheet's full height. */
const HALF_FRACTION = 0.5;
/** Under this much extra height the half snap is not worth having and the sheet closes by pull only. */
const SNAP_MIN_GAP = 48;
const SETTLE_MS = 260;

/** Which snap the open sheet rests on. Survives the re-render a refresh or an edit causes. */
let snapMemo = null;

function reducedMotion() {
  return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
}

function viewportHeight() {
  return window.visualViewport?.height ?? window.innerHeight;
}

/** The sheet at its own full height: the content's height, capped by the sheet's max-height. */
function fullHeight(panel) {
  const held = panel.style.maxHeight;
  panel.style.maxHeight = "";
  const height = panel.getBoundingClientRect().height;
  panel.style.maxHeight = held;
  return height;
}

/** Snap heights low to high. One entry when the sheet is too short to have a half stop. */
function snapHeights(panel, full) {
  if (!panel.dataset.snap) return [full];
  const half = Math.round(viewportHeight() * HALF_FRACTION);
  return full - half >= SNAP_MIN_GAP ? [half, full] : [full];
}

export function bindSheetSwipe() {
  const snapKey = document.querySelector(".sheet[data-snap]")?.dataset.snap || "";
  if (!snapKey) snapMemo = null;
  else if (snapMemo?.key !== snapKey) snapMemo = { key: snapKey, half: false };
  document.querySelectorAll(".sheet, .guide").forEach((panel) => {
    let tracking = false;
    let dragging = false;
    let startY = 0;
    let drag = 0;
    let pointerId = -1;
    let startedAtTop = false;
    let snaps = [0];
    let startHeight = 0;
    let height = 0;
    let samples = [];
    const headerHit = (event) => Boolean(event.target.closest(".sheet-head, .grabber"));
    if (snapMemo?.half && panel.dataset.snap === snapMemo.key) {
      // Re-rendered while resting on the half stop: put the new panel back there, without animating.
      const stops = snapHeights(panel, fullHeight(panel));
      if (stops.length > 1) panel.style.maxHeight = `${stops[0]}px`;
    }
    const handsOff = (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return true;
      if (target.closest("input, textarea, select, button, a, .leaflet-container, .leaflet-marker-icon, .leaflet-marker-pane, .pin, [data-no-sheet-drag]")) return true;
      return Boolean(horizontalScroller(target));
    };
    const place = () => {
      const shift = drag ? `translateY(${drag}px)` : "";
      if (panel.classList.contains("guide")) panel.style.transform = shift;
      else panel.style.transform = shift ? `translateX(-50%) ${shift}` : "";
    };
    const size = (next) => {
      height = next;
      const full = snaps[snaps.length - 1];
      panel.style.maxHeight = next >= full - 0.5 ? "" : `${Math.round(next)}px`;
    };
    /** Rest on a snap height. Animated unless the user asked for less motion. */
    const settle = (next) => {
      const animate = !reducedMotion();
      if (animate) {
        panel.classList.add("snap-settle");
        window.setTimeout(() => panel.classList.remove("snap-settle"), SETTLE_MS + 40);
      }
      drag = 0;
      place();
      size(next);
      if (snapMemo && panel.dataset.snap) snapMemo.half = snaps.length > 1 && next < snaps[snaps.length - 1] - 0.5;
    };
    const speed = () => {
      const last = samples[samples.length - 1];
      const first = samples.find((sample) => last.t - sample.t <= 100) || last;
      const span = last.t - first.t;
      return span > 0 ? (last.y - first.y) / span : 0;
    };
    panel.addEventListener("pointerdown", (event) => {
      if (event.button != null && event.button !== 0) return;
      if (handsOff(event)) return;
      const header = headerHit(event);
      const scroller = scrollableAncestor(event.target);
      startedAtTop = !scroller || scroller.scrollTop <= 0;
      if (!header && !startedAtTop) return;
      tracking = true;
      dragging = header;
      startY = event.clientY;
      drag = 0;
      pointerId = event.pointerId;
      samples = [{ t: event.timeStamp, y: event.clientY }];
      snaps = snapHeights(panel, fullHeight(panel));
      startHeight = panel.getBoundingClientRect().height;
      height = startHeight;
      if (header) {
        panel.classList.remove("snap-settle");
        panel.classList.add("dragging");
        panel.setPointerCapture?.(event.pointerId);
      }
    });
    panel.addEventListener("pointermove", (event) => {
      if (!tracking || event.pointerId !== pointerId) return;
      const dy = event.clientY - startY;
      samples.push({ t: event.timeStamp, y: event.clientY });
      if (samples.length > 12) samples.shift();
      if (!dragging) {
        if (!startedAtTop || dy < -4) {
          tracking = false;
          return;
        }
        if (dy < 8) return;
        dragging = true;
        panel.classList.remove("snap-settle");
        panel.classList.add("dragging");
        panel.setPointerCapture?.(event.pointerId);
      }
      // Drag up or down between the snaps. Below the lowest one the sheet slides off instead.
      const target = startHeight - dy;
      const lowest = snaps[0];
      const full = snaps[snaps.length - 1];
      size(Math.min(full, Math.max(lowest, target)));
      drag = Math.max(0, lowest - target);
      place();
    });
    const finish = (event) => {
      if (!tracking || (event.pointerId != null && event.pointerId !== pointerId)) return;
      tracking = false;
      const wasDragging = dragging;
      dragging = false;
      panel.classList.remove("dragging");
      if (!wasDragging) {
        drag = 0;
        place();
        return;
      }
      const travelled = (event.clientY ?? samples[samples.length - 1]?.y ?? startY) - startY;
      const velocity = event.type === "pointercancel" || samples.length < 2 ? 0 : speed();
      const flicked = Math.abs(travelled) >= FLICK_MIN && Math.abs(velocity) > FLICK_SPEED;
      const nearestTo = (value) => {
        let found = 0;
        snaps.forEach((stop, index) => {
          if (Math.abs(stop - value) < Math.abs(snaps[found] - value)) found = index;
        });
        return found;
      };
      let close = false;
      let next = nearestTo(height);
      if (flicked && velocity > 0) {
        // A flick down steps to the next lower snap from where it started, and past the lowest one it closes.
        const from = nearestTo(startHeight);
        if (from === 0) close = true;
        else next = from - 1;
      } else if (flicked) {
        next = Math.min(snaps.length - 1, nearestTo(startHeight) + 1);
      } else if (drag > CLOSE_DRAG) {
        close = true;
      }
      if (close) {
        panel.style.transform = "";
        panel.style.maxHeight = "";
        drag = 0;
        dismissTopOverlay();
        return;
      }
      settle(snaps[next]);
    };
    panel.addEventListener("pointerup", finish);
    panel.addEventListener("pointercancel", finish);
    panel.addEventListener("touchmove", (event) => {
      if (!tracking || !event.touches.length) return;
      const dy = event.touches[0].clientY - startY;
      if (headerHit(event) || (dy > 0 && startedAtTop)) event.preventDefault();
    }, { passive: false });
  });
}

window.addEventListener("popstate", () => {
  if (ignoreSheetPop > 0) {
    ignoreSheetPop -= 1;
    syncOverlayHistory();
    return;
  }
  if (currentOverlayDepth() > 0) {
    overlayHistoryDepth = Math.max(0, overlayHistoryDepth - 1);
    closingFromPop = true;
    try {
      dismissTopOverlay();
    } finally {
      closingFromPop = false;
    }
    // A layer that hands back to another (map → the tab it came from) needs its entry again.
    syncOverlayHistory();
    return;
  }
  overlayHistoryDepth = 0;
});

/** This tap only put a ⋯ menu away, so a tap on the map leaves the pin card open. */
export let tapClosedMenu = false;

document.addEventListener("pointerdown", (event) => {
  tapClosedMenu = false;
  if (!state.cardMenu) return;
  const target = event.target;
  if (target && target.closest && target.closest(".card-overflow")) return;
  // Share leaves an open menu alone. A re-render here would also swallow the tap (and its user activation).
  if (target && target.closest && target.closest(".card-share")) return;
  tapClosedMenu = true;
  state.cardMenu = null;
  render();
}, true);

document.addEventListener("pointerdown", (event) => {
  if (!state.chatReactFor && !state.chatWho) return;
  const target = event.target;
  if (target && target.closest && target.closest(".react-bar, .chat-react-btn, .react-pill")) return;
  closeReactUi();
}, true);

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (state.chat && (state.chatReactFor || state.chatWho)) {
    event.preventDefault();
    const id = state.chatReactFor;
    closeReactUi();
    if (id) document.querySelector(`.chat-msg[data-id="${CSS.escape(id)}"] .chat-react-btn`)?.focus({ preventScroll: true });
    return;
  }
  // An open @ list already took this Escape in the composer. Next comes the reply preview, then the chat.
  if (state.chat && state.chatReplyTo && !state.confirm && !state.sheet) {
    event.preventDefault();
    clearReply();
    return;
  }
  // An open pin card sits above the Events tab but below every sheet, menu and chat.
  if (mapCardOnTop()) {
    event.preventDefault();
    closeMapCard();
    return;
  }
  if (currentOverlayDepth() === 0) return;
  event.preventDefault();
  dismissTopOverlay();
});

/** The pin card is the topmost thing on screen: nothing above the Events tab is open. */
function mapCardOnTop() {
  if (state.tab !== "map" || !shellShown() || !mapCardOpen()) return false;
  return currentOverlayDepth() === tabLayers();
}

const ALERTS_RETURN_TABS = ["home", "map", "circle", "you"];

/** A second tap on the bell leaves Alerts for the tab the user came from. */
export function closeAlerts() {
  state.tab = ALERTS_RETURN_TABS.includes(state.alertsReturn) ? state.alertsReturn : "home";
  state.sheet = null;
  state.focusPlan = "";
  render();
}

export async function onTab(id) {
  if (id === "chat") {
    state.sheet = null;
    await openChat({ kind: "circle" });
    return;
  }
  if (state.chat) {
    // Chat was tapped and is still loading, so the tab bar is still on screen. Drop it for this tab.
    state.chat = null;
    state.chatThread = null;
  }
  if (id === "alerts" && state.tab !== "alerts") {
    state.alertsReturn = ALERTS_RETURN_TABS.includes(state.tab) ? state.tab : "home";
  }
  state.tab = id;
  state.youSection = null;
  state.busyPreview = null;
  state.sheet = null;
  state.focusPlan = "";
  state.mapHistory = false;
  state.cardMenu = null;
  if (id === "alerts") {
    render();
    try {
      await markAlertsRead();
    } catch (error) {
      state.error = error.message;
    }
  }
  render();
  if (id === "map" && state.eventsView === "calendar") {
    await loadCalendar({ force: true });
    if (state.tab === "map") render();
    return;
  }
  if (id === "map" && state.mapAllCircles) {
    await refreshMapAll();
    if (state.tab === "map") {
      render();
      refreshPins();
    }
  }
}
