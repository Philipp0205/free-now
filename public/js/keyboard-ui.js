import { keyboardOffset, KEYBOARD_OFFSET_MIN, keyboardIsOpen, tabbarOverlapsKeyboard, FIELD_REVEAL_MS } from "./keyboard.js";
import { state } from "./state.js";
import { isTyping } from "./lib.js";
import { stickChatLog } from "./chat.js";
import { liftSheetToast } from "./sheets.js";

let restingHeight = 0;
let restingWidth = 0;
let revealTimer = 0;

function isTextField(node) {
  return node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement;
}

export function prefersTouchUi() {
  if (window.matchMedia?.("(pointer: coarse)")?.matches) return true;
  return navigator.maxTouchPoints > 0 && !!window.matchMedia?.("(hover: none)")?.matches;
}

function readVirtualKeyboard() {
  const empty = { height: 0, top: null, bottom: null };
  if (!prefersTouchUi()) return empty;
  const rect = navigator.virtualKeyboard?.boundingRect;
  if (!rect || !Number.isFinite(rect.height) || rect.height <= 0) return empty;
  return { height: rect.height, top: rect.top, bottom: rect.bottom };
}

function syncKeyboardInset() {
  const vv = window.visualViewport;
  const layoutHeight = window.innerHeight;
  if (!vv) {
    document.documentElement.style.setProperty("--kb-offset", "0px");
    document.documentElement.style.setProperty("--vv-height", `${layoutHeight}px`);
    document.documentElement.classList.remove("kb-open");
    return;
  }
  const viewportHeight = vv.height;
  const offset = keyboardOffset(layoutHeight, viewportHeight, vv.offsetTop);
  const focused = isTyping();
  const width = window.innerWidth;
  if (!restingHeight) {
    restingHeight = viewportHeight;
    restingWidth = width;
  } else if (Math.abs(width - restingWidth) > 80) {
    restingHeight = viewportHeight;
    restingWidth = width;
  } else if (!focused && offset < KEYBOARD_OFFSET_MIN && viewportHeight >= restingHeight - 40) {
    restingHeight = viewportHeight;
    restingWidth = width;
  }
  const touchUi = prefersTouchUi();
  const vk = readVirtualKeyboard();
  const open = keyboardIsOpen({
    offset,
    focused,
    restingHeight,
    viewportHeight,
    virtualKeyboardHeight: vk.height,
    touchUi,
  });
  document.documentElement.style.setProperty("--kb-offset", `${offset}px`);
  document.documentElement.style.setProperty("--vv-top", `${Math.max(0, Math.round(vv.offsetTop || 0))}px`);
  document.documentElement.style.setProperty("--vv-height", `${Math.max(0, Math.round(viewportHeight))}px`);
  if (state.chat) stickChatLog();
  const bar = document.querySelector(".tabbar");
  const rect = bar?.getBoundingClientRect();
  const overlaps = rect
    ? tabbarOverlapsKeyboard({
        barTop: rect.top,
        barBottom: rect.bottom,
        layoutHeight,
        offset,
        shrunk: restingHeight - viewportHeight,
        virtualKeyboardTop: vk.top,
        virtualKeyboardBottom: vk.bottom,
      })
    : false;
  document.documentElement.classList.toggle("kb-open", open && overlaps);
}

/** Pull a sheet down when bottom offset and a resized visual viewport both lift it. */
export function anchorOpenSheet() {
  const sheet = document.querySelector(".sheet");
  const vv = window.visualViewport;
  if (!sheet || !vv) return;
  const gap = vv.height - sheet.getBoundingClientRect().bottom;
  if (gap <= 1) return;
  const current = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--kb-offset")) || 0;
  const next = Math.max(0, Math.round(current - gap));
  if (Math.abs(next - current) <= 1) return;
  document.documentElement.style.setProperty("--kb-offset", `${next}px`);
}

document.addEventListener("touchmove", (event) => {
  if (!document.documentElement.classList.contains("sheet-open")) return;
  const target = event.target;
  if (target instanceof Element && target.closest(".sheet, .guide, .sheet-scroll, .where-results")) return;
  event.preventDefault();
}, { passive: false });

function scheduleReveal(node) {
  window.clearTimeout(revealTimer);
  revealTimer = window.setTimeout(() => revealField(node), FIELD_REVEAL_MS);
}

function revealField(node) {
  if (!node.isConnected || document.activeElement !== node) return;
  if (node.id === "where-query") {
    scrollFieldAboveDock(node);
    revealWhereResults();
    return;
  }
  if (node.closest(".sheet")) {
    node.scrollIntoView({ block: "nearest", inline: "nearest" });
    scrollFieldAboveDock(node);
    return;
  }
  const form = node.closest("form");
  if (form) {
    scrollBottomIntoView(form);
    return;
  }
  node.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/** The caption sitting on this field, not a label further up the same group. */
function captionLabel(node) {
  const label = node.closest(".sheet-group")?.querySelector(".sheet-label");
  if (!label) return null;
  const gap = node.getBoundingClientRect().top - label.getBoundingClientRect().bottom;
  if (gap < 0 || gap > 36) return null;
  return label;
}

/** Keep a focused sheet field above the pinned action bar and the keyboard.
 * The field's own label stays below the sheet intro, so help text does not cover it. */
function scrollFieldAboveDock(node) {
  const sheet = node.closest(".sheet");
  const dock = sheet?.querySelector(".sheet-dock");
  const head = sheet?.querySelector(".sheet-head");
  const scroller = sheet?.querySelector(".sheet-scroll") || scrollParent(node);
  const view = window.visualViewport;
  const viewTop = view?.offsetTop ?? 0;
  const viewBottom = viewTop + (view?.height ?? window.innerHeight);
  const margin = 12;
  const label = captionLabel(node);
  for (let pass = 0; pass < 2; pass += 1) {
    const dockTop = dock?.getBoundingClientRect().top ?? viewBottom;
    const headBottom = head?.getBoundingClientRect().bottom ?? viewTop;
    const limit = Math.min(dockTop, viewBottom) - margin;
    const floor = Math.max(viewTop + margin, headBottom + 12);
    const rect = node.getBoundingClientRect();
    const anchorTop = (label || node).getBoundingClientRect().top;
    let delta = 0;
    if (rect.bottom > limit) delta += rect.bottom - limit;
    if (anchorTop - delta < floor) delta -= floor - (anchorTop - delta);
    if (Math.abs(delta) <= 1) break;
    scroller.scrollBy({ top: delta, left: 0 });
  }
}

/** Minimum scroll so the form's bottom edge, including its submit button, clears the keyboard. */
function scrollBottomIntoView(element) {
  const viewHeight = window.visualViewport?.height ?? window.innerHeight;
  const overflow = element.getBoundingClientRect().bottom - (viewHeight - 12);
  if (overflow <= 1) return;
  scrollParent(element).scrollBy({ top: overflow, left: 0 });
}

/** Keep the Where? hit list above the dock and the keyboard, without pushing the search field under the sheet head. */
export function revealWhereResults() {
  const list = document.querySelector(".where-results");
  if (!list?.isConnected) return;
  const sheet = list.closest(".sheet");
  const dock = sheet?.querySelector(".sheet-dock");
  const head = sheet?.querySelector(".sheet-head");
  const query = document.getElementById("where-query");
  const view = window.visualViewport;
  const viewTop = view?.offsetTop ?? 0;
  const viewBottom = viewTop + (view?.height ?? window.innerHeight);
  const margin = 12;
  const limit = Math.min(dock?.getBoundingClientRect().top ?? viewBottom, viewBottom) - margin;
  const floor = Math.max(viewTop + margin, (head?.getBoundingClientRect().bottom ?? viewTop) + margin);
  const rect = list.getBoundingClientRect();
  const parent = sheet?.querySelector(".sheet-scroll") || scrollParent(list);
  if (rect.bottom > limit) {
    const anchor = (query || list).getBoundingClientRect().top;
    const delta = Math.min(rect.bottom - limit, anchor - floor);
    if (delta > 1) parent.scrollBy({ top: delta, left: 0 });
  } else if (rect.top < floor) {
    parent.scrollBy({ top: rect.top - floor, left: 0 });
  }
}

function scrollParent(element) {
  let node = element.parentElement;
  while (node) {
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight + 1) return node;
    node = node.parentElement;
  }
  return document.scrollingElement || document.documentElement;
}

function onViewportResize() {
  syncKeyboardInset();
  anchorOpenSheet();
  liftSheetToast();
  const active = document.activeElement;
  if (isTextField(active)) scheduleReveal(active);
}

function onViewportScroll() {
  syncKeyboardInset();
}

export function bindKeyboard() {
  document.addEventListener("focusin", (event) => {
    if (isTextField(event.target)) scheduleReveal(event.target);
  });
  document.addEventListener("focusout", () => {
    window.setTimeout(syncKeyboardInset, 60);
  });
  const vv = window.visualViewport;
  if (vv) {
    vv.addEventListener("resize", onViewportResize);
    vv.addEventListener("scroll", onViewportScroll, { passive: true });
  }
  window.addEventListener("resize", onViewportResize);
  window.addEventListener("orientationchange", () => {
    restingHeight = 0;
    syncKeyboardInset();
  });
  // Optional. overlaysContent stays off so interactive-widget=resizes-content can still shrink the layout.
  const vk = navigator.virtualKeyboard;
  if (vk?.addEventListener) vk.addEventListener("geometrychange", onViewportResize);
  syncKeyboardInset();
}
