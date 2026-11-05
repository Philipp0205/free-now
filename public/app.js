import { installGuide, installPrompt, installReminderDue, needsInstallForPush, pushReminder, pushTestMessage, readInstallSignals } from "./install-guide.js";
import { FIELD_REVEAL_MS, KEYBOARD_OFFSET_MIN, keyboardIsOpen, keyboardOffset, tabbarOverlapsKeyboard } from "./keyboard.js";
import { clockText, dayLabel, isLaterToday, minLaterClock, nextLaterDay, nextLaterSlot, planDayChoice, planDayDate, planDayRange, zonedParts } from "./when.js";
import { audiencePlace, formatDistance, haversine, isMapsLink, looksLikeUrl } from "./place.js";
import { bindMap } from "./map.js";
import { nextPushDetail, pushTitle } from "./push-sheet.js";
import { SEEN_KEY, formatEntryDate, latestId, newerSeen, normalizeEntries, unseenEntries } from "./whats-new.js";

const TOKEN_KEY = "fn_token";
const CIRCLE_KEY = "fn_circle";
const SHARE_KEY = "fn_share_location";
const INSTALLED_KEY = "fn_installed";
const INSTALL_LATER_KEY = "fn_install_later";
/** Same label as CACHE in sw.js. Sent with feedback so a report names the build it came from. */
const APP_VERSION = "hangry-v14";
const FEEDBACK_MAX = 2000;
const BACKGROUNDS = ["/backgrounds/dusk.png", "/backgrounds/dinner.png", "/backgrounds/walk.png", "/backgrounds/roof.png"];

let sheetHistoryPushed = false;
let ignoreSheetPop = false;
let closingFromPop = false;

const state = {
  booting: true,
  token: localStorage.getItem(TOKEN_KEY),
  meta: null,
  me: null,
  socials: [],
  plans: [],
  notifications: [],
  tab: "home",
  sheet: null,
  pushDetail: null,
  noteDraft: "",
  nameDraft: "",
  circleDraft: "friends",
  codeDraft: "",
  pendingCode: "",
  error: "",
  banner: null,
  bannerTimer: 0,
  iosHintOpen: false,
  confirm: null,
  latestNotifId: null,
  bootstrappedNotifs: false,
  focusSheet: false,
  installEvent: null,
  installOpen: false,
  pushBusy: false,
  pushReminder: null,
  pushSnooze: false,
  installSheet: false,
  installPillHidden: false,
  onboarding: false,
  pushOn: false,
  advanced: false,
  shareLocation: localStorage.getItem(SHARE_KEY) === "1",
  placeDraft: "",
  planTime: "",
  planDay: "tomorrow",
  planDate: "",
  planWhere: emptyWhereSession(),
  viewerLocation: null,
  mapCenter: null,
  mapCard: null,
  where: emptyWhere(),
  whereOpen: false,
  whereQuery: "",
  whereAutofill: false,
  whereResults: [],
  whereSearching: false,
  whereHint: "",
  whereMap: false,
  focusSocial: "",
  deepLink: null,
  statusMessage: "",
  whereArea: "",
  whereFallback: "",
  invitePreview: null,
  inviteError: "",
  whenMode: "now",
  startChoice: "",
  etaFor: "",
  chat: null,
  openDescriptions: new Set(),
  chatQueue: null,
  chatThread: null,
  chatReturn: "home",
  chatDraft: "",
  chatStick: false,
  chatSummary: { circle: { unread: 0, muted: false }, events: [], unreadByCircle: {} },
  past: false,
  pastDays: null,
  circleId: localStorage.getItem(CIRCLE_KEY) || "",
  circleMenu: false,
  newCircleName: "",
  whatsNew: null,
  whatsNewView: null,
  whatsNewChecked: false,
  feedbackDraft: "",
  feedbackError: "",
  feedbackBusy: false,
  feedbackSent: false,
};

const deepLinkParams = new URLSearchParams(location.search);
const planFocus = deepLinkParams.get("plan");
const socialFocus = deepLinkParams.get("social");
const chatFocus = deepLinkParams.get("chat");
const circleFocus = deepLinkParams.get("circle");
if (circleFocus) rememberCircle(circleFocus);
if (chatFocus) state.deepLink = { kind: "chat", id: chatFocus };
else if (planFocus) state.deepLink = { kind: "plan", id: planFocus };
else if (socialFocus) state.deepLink = { kind: "social", id: socialFocus };
if (state.deepLink || circleFocus) {
  const url = new URL(location.href);
  url.searchParams.delete("social");
  url.searchParams.delete("plan");
  url.searchParams.delete("chat");
  url.searchParams.delete("circle");
  history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}` || "/");
}
const joinPath = location.pathname.match(/^\/join\/([A-Za-z0-9]+)/);
if (joinPath) state.pendingCode = joinPath[1].toUpperCase();
state.codeDraft = state.pendingCode;

const ICONS = {
  home: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4.2 10.6 12 4l7.8 6.6V20a1 1 0 0 1-1 1h-4.6v-6.2H9.8V21H5.2a1 1 0 0 1-1-1z"/></svg>',
  compass: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="8.25" stroke="currentColor" stroke-width="1.8"/><path d="m14.8 9.2-1.3 4.3-4.3 1.3 1.3-4.3z" fill="currentColor"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="5" stroke="currentColor" stroke-width="1.8"/><path d="M12 8.2v7.6M8.2 12h7.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6.2 16.5h11.6l-1.1-1.6a6.8 6.8 0 0 1-1-3.5V9.6a3.7 3.7 0 0 0-7.4 0v1.8c0 1.3-.3 2.5-1 3.5z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M10 17.2a2 2 0 0 0 4 0" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  person: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="8.2" r="3.1" stroke="currentColor" stroke-width="1.8"/><path d="M5.6 19.2c.8-2.8 3.2-4.2 6.4-4.2s5.6 1.4 6.4 4.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  add: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  map: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 21s6-5.2 6-10a6 6 0 1 0-12 0c0 4.8 6 10 6 10z" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="11" r="2.1" fill="currentColor"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 6.5 15 12l-6 5.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7.2 16.2 5 19.2c-.3.4.1 1 .6.8l3.2-.9A7.2 7.2 0 1 0 7.2 16.2Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
};

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  state.installEvent = event;
  render();
});

window.addEventListener("appinstalled", () => {
  localStorage.setItem(INSTALLED_KEY, "1");
  state.installEvent = null;
  state.installSheet = false;
  void considerReminders();
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

const FINDING_PLACE = "Finding address…";
const URL_HINT = "Paste a Google Maps link or type a place";
const { mountMap, mountWhereMap, destroyLiveMap, destroyWhereMap } = bindMap({
  state,
  whereTarget: () => whereBag(),
  collectPins,
  mapCard,
  paintSummary,
  scheduleReverse,
  recentPlace,
  FINDING_PLACE,
});

boot();
setInterval(() => {
  if (!document.hidden && state.token) {
    refresh().catch((error) => {
      if (error?.status === 401) return;
      noteConnectionProblem(error);
      render();
    });
  }
}, 3000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh().catch(() => {});
});

render();

async function boot() {
  try {
    state.meta = await api("/api/meta", { token: null });
    if (state.pendingCode) {
      try {
        state.invitePreview = await api(`/api/invites/${state.pendingCode}`, { token: null });
      } catch (error) {
        state.inviteError = error.status === 410 ? "expired" : "invalid";
      }
    }
    if (state.token) {
      try {
        state.me = await api("/api/me");
      } catch (error) {
        if (error.status === 404 && state.circleId) {
          rememberCircle("");
          state.me = await api("/api/me");
        } else if (error.status !== 401) throw error;
        else clearSession();
      }
    }
    if (state.me) adoptCircle(state.me);
    if (state.token && state.me && state.pendingCode && !state.inviteError) {
      try {
        const joined = await api("/api/circles/join", { method: "POST", body: { code: state.pendingCode } });
        rememberCircle(joined.circle.id);
        state.me = await api("/api/me");
        history.replaceState(null, "", "/");
        state.pendingCode = "";
      } catch (error) {
        state.error = error.message;
      }
    }
  } catch (error) {
    if (state.token && error.status !== 401) {
      restoreCachedState();
      noteConnectionProblem(error);
      scheduleOfflineRetry(1000);
    } else {
      state.error = friendlyMessage(error.message, error.status);
    }
  } finally {
    state.booting = false;
    if (state.me && !state.me.circle && state.circleDraft === "friends") {
      state.circleDraft = `${state.me.user.name}'s circle`;
    }
    render();
    if (!state.offline) {
      reportDisplay();
      refresh({ initial: true }).catch(() => {});
      rememberViewerLocation();
      void considerReminders();
    }
    if (state.focusSocial) history.replaceState(null, "", "/");
  }
}

function persistCachedState() {
  if (!state.token || !state.me) return;
  try {
    localStorage.setItem("fn_state", JSON.stringify({
      me: state.me,
      socials: state.socials,
      plans: state.plans,
      notifications: state.notifications,
    }));
  } catch {
    /* storage can be full */
  }
}

function restoreCachedState() {
  try {
    const saved = JSON.parse(localStorage.getItem("fn_state") || "null");
    if (!saved?.me) return false;
    state.me = saved.me;
    state.socials = saved.socials || [];
    state.plans = saved.plans || [];
    state.notifications = saved.notifications || [];
    return true;
  } catch {
    return false;
  }
}

function isNetworkFailure(error) {
  const status = error?.status;
  return status == null || status === 0;
}

function noteConnectionProblem(error) {
  state.offline = isNetworkFailure(error);
  state.statusMessage = state.offline
    ? "You're offline. Retrying…"
    : error.status >= 500
      ? "Something went wrong. Retrying…"
      : state.statusMessage;
}

function scheduleOfflineRetry(delay) {
  clearTimeout(state.offlineTimer);
  state.offlineTimer = setTimeout(async () => {
    try {
      if (!state.meta) state.meta = await api("/api/meta", { token: null });
      if (state.token) state.me = await api("/api/me");
      state.offline = false;
      state.statusMessage = "";
      render();
      refresh({ initial: true }).catch(() => {});
      void flushChatQueue();
      void considerReminders();
    } catch (error) {
      if (error.status === 401) return;
      if (error.status === 404 && state.circleId) {
        const moved = await releaseMissingCircle();
        if (moved) return;
      }
      noteConnectionProblem(error);
      render();
      scheduleOfflineRetry(Math.min(delay * 2, 30000));
    }
  }, delay);
}

const RETRY_NOTE = new Set(["You're offline. Retrying…", "Something went wrong. Retrying…"]);

function friendlyMessage(raw, status) {
  const text = String(raw || "");
  const lower = text.toLowerCase();
  if (status >= 500) return "Something went wrong. Retrying…";
  if (status === 429) return "That's a lot at once. Try again in a few minutes.";
  if (!text || lower.includes("failed to fetch") || status === 0) return "You're offline. Retrying…";
  if (lower.includes("unknown recovery")) return "That code didn't work. Check it and try again.";
  if (lower.includes("feedback")) return `Write 1–${FEEDBACK_MAX} characters.`;
  if (lower.includes("must be 1")) return "Use 1–24 characters for your name.";
  if (lower.includes("plan has ended")) return "That plan has ended.";
  if (lower.includes("post has ended") || lower.includes("hangout has ended")) return "That post has ended.";
  if (status === 410 || lower.includes("expired")) return "This invite has expired. Ask for a new link.";
  if (lower.includes("invite")) return "This invite isn't valid. Ask for a new link.";
  if (lower.includes("you can arrive")) return "Pick a time you can arrive.";
  if (lower.includes("only an admin")) return "Only an admin can do that.";
  if (lower.includes("valid time")) return "Pick a valid time, like 19:30";
  if (lower.includes("pick a date") || lower.includes("date doesn't exist")) return text;
  if (lower.includes("pick a time")) return "Pick a time later today.";
  if (lower.includes("already in a circle")) return "You're already in a circle.";
  if (lower.includes("removed you from this circle")) return "An admin removed you from this circle.";
  if (lower.includes("removed you")) {
    const named = text.match(/^(.+) removed you from this\.?$/i);
    if (named && named[1].toLowerCase() !== "the host") return text.endsWith(".") ? text : `${text}.`;
    return "The host removed you from this.";
  }
  if (lower.includes("chat is closed")) return "This chat is closed.";
  if (lower.includes("1000")) return "Keep it under 1000 characters.";
  if (lower.includes("write a message")) return "Write a message.";
  if (lower.includes("can't delete")) return "You can't delete that.";
  if (lower.includes("were removed")) return "You were removed from this event.";
  if (lower.includes("only the host")) return "Only the host can do that.";
  if (status === 403 || lower.includes("only an admin")) return "Only an admin can do that.";
  if (lower.includes("needs an admin")) return "A circle needs an admin.";
  if (status === 401) return "Please sign in again.";
  return "Something went wrong. Try again.";
}

async function refresh({ initial = false } = {}) {
  if (!state.token || !state.me?.circle) return;
  let socials;
  let plans;
  let notifications;
  let me;
  let summary;
  let thread;
  try {
    [socials, plans, notifications, me, summary, thread] = await Promise.all([
      api("/api/socials"),
      api("/api/plans"),
      api("/api/notifications"),
      api("/api/me"),
      api("/api/chats"),
      state.chat ? api(chatTargetUrl(state.chat)) : Promise.resolve(null),
    ]);
  } catch (error) {
    if (error.status === 401) return;
    if (error.status === 404 && state.circleId) {
      const moved = await releaseMissingCircle();
      if (moved) return;
    }
    if (isNetworkFailure(error) || error.status >= 500) {
      noteConnectionProblem(error);
      render();
      scheduleOfflineRetry(1000);
    }
    return;
  }
  state.socials = socials.socials;
  state.plans = plans.plans;
  state.notifications = notifications.notifications;
  state.me = me;
  state.chatSummary = summary;
  if (state.chat) forgetOpenUnread(state.chat);
  if (thread?.chat) state.chatThread = thread.chat;
  const newest = state.notifications[0];
  if (!state.bootstrappedNotifs) {
    state.latestNotifId = newest?.id ?? null;
    state.bootstrappedNotifs = true;
  } else if (newest && newest.id !== state.latestNotifId) {
    state.banner = newest;
    state.latestNotifId = newest.id;
    clearTimeout(state.bannerTimer);
    state.bannerTimer = setTimeout(() => {
      state.banner = null;
      state.signature = "";
      render();
    }, 6500);
  }
  const signature = JSON.stringify({
    socials: state.socials,
    plans: state.plans,
    notifications: state.notifications.map((note) => [note.id, note.readAt]),
    members: state.me?.circle?.members ?? null,
    banner: state.banner?.id ?? null,
    chats: state.chatSummary,
    thread: state.chatThread?.messages?.map((message) => message.id) ?? null,
  });
  persistCachedState();
  const hadStatus = Boolean(state.statusMessage);
  state.offline = false;
  state.statusMessage = "";
  if (consumeDeepLink()) return;
  if (!state.whatsNewChecked) void considerWhatsNew();
  if (signature === state.signature && !hadStatus) return;
  state.signature = signature;
  if (syncPushDetail() && !state.confirm && !state.installOpen && !isTyping()) {
    render();
    return;
  }
  if (state.sheet || state.installOpen || isTyping()) return;
  const y = document.scrollingElement?.scrollTop ?? 0;
  render();
  if (!initial && document.scrollingElement) document.scrollingElement.scrollTop = y;
}

async function releaseMissingCircle() {
  const previous = state.circleId;
  rememberCircle("");
  let me;
  try {
    me = await api("/api/me");
  } catch (error) {
    rememberCircle(previous);
    if (error.status === 401) return true;
    return false;
  }
  const stillThere = (me.circles || []).some((circle) => circle.id === previous);
  if (stillThere) {
    rememberCircle(previous);
    return false;
  }
  state.me = me;
  adoptCircle(me);
  state.socials = [];
  state.plans = [];
  state.notifications = [];
  state.chat = null;
  state.chatThread = null;
  state.past = false;
  state.pastDays = null;
  state.sheet = null;
  state.confirm = null;
  state.circleMenu = false;
  state.tab = "home";
  state.signature = "";
  state.offline = false;
  state.statusMessage = "";
  if (!me.circle) useNamedCircleDefault();
  render();
  if (me.circle) refresh({ initial: true }).catch(() => {});
  return true;
}

function isTyping() {
  const tag = document.activeElement?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA";
}

let restingHeight = 0;
let restingWidth = 0;
let revealTimer = 0;

function isTextField(node) {
  return node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement;
}

function prefersTouchUi() {
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
function anchorOpenSheet() {
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
function revealWhereResults() {
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

function bindKeyboard() {
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

bindKeyboard();

function rememberCircle(id) {
  state.circleId = id || "";
  if (state.circleId) localStorage.setItem(CIRCLE_KEY, state.circleId);
  else localStorage.removeItem(CIRCLE_KEY);
}

function adoptCircle(me) {
  const ids = (me?.circles || []).map((circle) => circle.id);
  if (state.circleId && ids.includes(state.circleId)) return;
  rememberCircle(me?.circle?.id || ids[0] || "");
}

function circleHeader(path, options) {
  if (!state.circleId || options.circle === null || options.token === null) return {};
  if (/^\/api\/(meta|auth\/|invites\/|buzz\/)/.test(path)) return {};
  return { "x-circle": state.circleId };
}

async function api(path, options = {}) {
  const token = options.token === undefined ? state.token : options.token;
  let response;
  try {
    response = await fetch(path, {
    method: options.method ?? "GET",
    headers: {
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...circleHeader(path, options),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  } catch {
    const error = new Error("You're offline. Retrying…");
    error.status = 0;
    throw error;
  }
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }
  if (!response.ok) {
    if (response.status === 401 && token && token === state.token) {
      clearSession();
      state.tab = "home";
      state.sheet = null;
      state.confirm = null;
      state.onboarding = false;
      state.installSheet = false;
      state.pushReminder = null;
      if (!state.booting) render();
    }
    const error = new Error(friendlyMessage(data?.error, response.status));
    error.status = response.status;
    throw error;
  }
  return data;
}

function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  // What's new is per person. The next account on this phone starts from its own server value.
  localStorage.removeItem(SEEN_KEY);
  state.whatsNewChecked = false;
  rememberCircle("");
  state.token = null;
  state.displayReported = false;
  state.me = null;
  state.socials = [];
  state.plans = [];
  state.notifications = [];
  state.bootstrappedNotifs = false;
  state.past = false;
  state.pastDays = null;
}

function render() {
  const activeId = state.focusSheet ? null : document.activeElement?.id || null;
  const caret = document.activeElement?.selectionStart ?? null;
  const y = document.scrollingElement?.scrollTop ?? 0;
  const sheetY = document.querySelector(".sheet-scroll")?.scrollTop ?? 0;
  const chatLog = document.querySelector(".chat-log");
  const chatY = chatLog?.scrollTop ?? 0;
  const chatNearEnd = chatLog ? chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 48 : true;
  document.getElementById("app").replaceChildren(view());
  const sheetScroll = document.querySelector(".sheet-scroll");
  if (sheetScroll) sheetScroll.scrollTop = sheetY;
  const nextLog = document.querySelector(".chat-log");
  if (nextLog) nextLog.scrollTop = state.chatStick || chatNearEnd ? nextLog.scrollHeight : chatY;
  state.chatStick = false;
  if (state.chat) stickChatLog();
  if (state.focusSheet) {
    state.focusSheet = false;
    document.getElementById("sheet-note")?.focus({ preventScroll: true });
  } else if (activeId) {
    const node = document.getElementById(activeId);
    if (node) {
      node.focus({ preventScroll: true });
      if (caret != null && node.setSelectionRange) {
        try {
          node.setSelectionRange(caret, caret);
        } catch {
          /* number inputs and buttons */
        }
      }
    }
  }
  if (!state.sheet && document.scrollingElement) document.scrollingElement.scrollTop = y;
  if (state.tab === "map") queueMicrotask(() => { mountMap().catch(() => {}); });
  const picking = state.sheet === "free" || state.sheet === "plan" || state.sheet === "admin-edit";
  const bag = whereBag();
  if (bag.whereMap && picking) {
    queueMicrotask(() => {
      mountWhereMap().then(() => {
        const node = document.querySelector(".sheet-scroll");
        if (node) node.scrollTop = sheetY;
      }).catch((error) => console.error("where map failed", error));
    });
  }
  if (bag.whereResults.length && picking) queueMicrotask(() => revealWhereResults());
  document.documentElement.classList.toggle("sheet-open", sheetIsOpen());
  anchorOpenSheet();
  bindSheetSwipe();
  liftSheetToast();
  syncSheetHistory();
  if (state.focusSocial) {
    const id = state.focusSocial;
    queueMicrotask(() => {
      document.querySelector(`[data-social="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "center" });
    });
  }
}

function view() {
  const root = el("div", {});
  if (state.booting) {
    root.append(el("div", { class: "boot" }, [el("div", { class: "orb live", "aria-label": "Loading" })]));
    return root;
  }
  if (state.offline && state.token && !state.me) {
    root.append(el("div", { class: "boot" }, [
      el("div", { class: "orb live", "aria-hidden": "true" }),
      el("p", { class: "lede", text: "You're offline. Retrying…" }),
    ]));
    if (state.error) root.append(el("div", { class: "toast", role: "status", text: state.error }));
    return root;
  }
  if (!state.token || !state.me) {
    root.append(welcome());
  } else if (!state.me.circle) {
    root.append(setup());
  } else {
    root.append(shell());
  }
  if (state.installOpen) root.append(installGuideView());
  if (state.onboarding && !state.sheet && !state.confirm && !state.installOpen) {
    root.append(onboardingSheet());
  }
  if (state.banner) root.append(banner(state.banner));
  if (state.confirm) root.append(confirmSheet());
  if (state.error && state.error !== TIME_LATER_ERROR && !RETRY_NOTE.has(state.error)) {
    root.append(el("div", { class: "toast", role: "status", text: state.error }));
  }
  return root;
}

function welcome() {
  const recovering = state.sheet === "recover";
  return el("section", { class: "gate" }, [
    el("div", { class: "hero" }, [
      el("button", { class: "orb small", type: "button", "aria-hidden": "true", tabindex: "-1" }),
      el("h1", { class: "wordmark", text: "Hangry" }),
      el("p", {
        class: "lede",
        text: state.invitePreview?.name
          ? `Join ${state.invitePreview.name}`
          : state.inviteError === "expired"
            ? "This invite has expired. Ask for a new link."
            : state.inviteError === "invalid"
              ? "This invite isn't valid. Ask for a new link."
              : "A private circle. Tap when you're free.",
      }),
    ]),
    recovering
      ? el("form", { class: "stack", onsubmit: onRecover }, [
          field("Recovery code", "recover-code", state.codeDraft, (value) => {
            state.codeDraft = value;
          }),
          el("button", { class: "btn", type: "submit", text: "Sign back in" }),
          el("button", {
            class: "btn ghost",
            type: "button",
            text: "Back",
            onclick: () => {
              state.sheet = null;
              state.codeDraft = "";
              state.error = "";
              render();
            },
          }),
        ])
      : el("form", { class: "stack", onsubmit: onStart }, [
          field("Your name", "name", state.nameDraft, (value) => {
            state.nameDraft = value;
          }, { placeholder: "Alex", maxlength: "24", autocomplete: "nickname" }),
          el("button", {
            class: "btn",
            type: "submit",
            text: state.invitePreview?.name ? `Join ${state.invitePreview.name}` : "Continue",
            disabled: Boolean(state.inviteError),
          }),
          state.inviteError
            ? el("button", {
                class: "btn secondary",
                type: "button",
                text: "Start my own circle",
                onclick: () => {
                  state.inviteError = "";
                  state.invitePreview = null;
                  state.pendingCode = "";
                  state.codeDraft = "";
                  history.replaceState(null, "", "/");
                  render();
                },
              })
            : null,
          el("button", {
            class: "btn ghost",
            type: "button",
            text: "I have a recovery code",
            onclick: () => {
              state.sheet = "recover";
              state.codeDraft = "";
              state.error = "";
              render();
            },
          }),
        ]),
  ]);
}

function useNamedCircleDefault() {
  const name = state.me?.user?.name?.trim();
  if (name && (state.circleDraft === "friends" || !state.circleDraft.trim())) {
    state.circleDraft = `${name}'s circle`;
  }
}

function setup() {
  return el("section", { class: "gate" }, [
    el("div", { class: "hero" }, [
      el("h1", { class: "wordmark", text: `Hi ${state.me.user.name}` }),
      el("p", { class: "lede", text: "Start a circle, or join one with an invite code." }),
    ]),
    el("form", { class: "stack", onsubmit: onCreateCircle }, [
      field("Circle name", "circle-name", state.circleDraft, (value) => {
        state.circleDraft = value;
      }, { maxlength: "32" }),
      el("button", { class: "btn", type: "submit", text: "Create circle" }),
    ]),
    el("div", { class: "or", text: "or" }),
    el("form", { class: "stack", onsubmit: onJoinCircle }, [
      field("Invite code", "invite-code", state.codeDraft, (value) => {
        state.codeDraft = value.toUpperCase();
      }, { placeholder: "AB12CD34", maxlength: "12", autocapitalize: "characters", spellcheck: "false" }),
      el("button", { class: "btn secondary", type: "submit", text: "Join circle" }),
    ]),
  ]);
}

function shell() {
  const phone = el("div", { class: "phone" });
  if (state.chat) {
    phone.append(chatScreen());
    return phone;
  }
  if (state.past) {
    phone.append(pastScreen());
    return phone;
  }
  if (state.statusMessage) phone.append(el("p", { class: "status-banner", role: "status", text: state.statusMessage }));
  if (state.tab === "home") phone.append(home());
  if (state.tab === "map") phone.append(mapScreen());
  if (state.tab === "circle") phone.append(circleScreen());
  if (state.tab === "alerts") phone.append(alertsScreen());
  if (state.tab === "you") phone.append(youScreen());
  phone.append(tabbar());
  if (state.sheet) phone.append(sheet());
  return phone;
}

function screenHeader(title) {
  const unread = state.notifications.filter((note) => !note.readAt).length;
  const titleEl = el("h1", { class: "screen-title", text: title });
  const bell = el("button", {
      class: state.tab === "alerts" ? "icon-btn on" : "icon-btn",
      type: "button",
      "aria-label": unread ? `Alerts, ${unread} unread` : "Alerts",
      onclick: () => { void onTab("alerts"); },
    }, [
      icon("bell"),
      unread ? el("span", { class: "badge", text: unread > 9 ? "9+" : String(unread) }) : null,
    ]);
  const switcher = circleSwitcher();
  if (!switcher) return el("header", { class: "screen-head" }, [titleEl, bell]);
  return el("header", { class: "screen-head" }, [
    el("div", { class: "head-copy" }, [switcher, titleEl]),
    bell,
  ]);
}

function circleSwitcher() {
  const circles = state.me?.circles || [];
  const current = state.me?.circle;
  if (!current || circles.length < 2) return null;
  return el("div", { class: "circle-switch" }, [
    el("button", {
      class: "circle-switch-btn",
      type: "button",
      "aria-label": "Switch circle",
      "aria-expanded": state.circleMenu ? "true" : "false",
      onclick: () => {
        state.circleMenu = !state.circleMenu;
        render();
      },
    }, [
      el("span", { text: current.name }),
      icon("chevron"),
      anyCircleUnread() ? el("span", { class: "unread-dot", "aria-hidden": "true" }) : null,
    ]),
    state.circleMenu ? el("div", { class: "circle-menu" }, [
      ...circles.map((circle) => el("button", {
        type: "button",
        class: circle.id === current.id ? "on" : "",
        onclick: () => { void switchCircle(circle.id); },
      }, [
        el("span", { text: circle.name }),
        circleHasUnread(circle.id) ? el("span", { class: "unread-dot", "aria-hidden": "true" }) : null,
      ])),
      el("button", { type: "button", text: "Join with link", onclick: () => openCircleSheet("join-circle") }),
      el("button", { type: "button", text: "New circle", onclick: () => openCircleSheet("new-circle") }),
    ]) : null,
  ]);
}

function openCircleSheet(kind) {
  state.circleMenu = false;
  state.newCircleName = "";
  state.codeDraft = "";
  state.sheet = kind;
  render();
}

async function switchCircle(id) {
  if (!id || id === state.circleId) {
    state.circleMenu = false;
    render();
    return;
  }
  state.circleMenu = false;
  state.sheet = null;
  state.chat = null;
  state.past = false;
  state.pastDays = null;
  rememberCircle(id);
  await run(async () => {
    await refresh({ initial: true });
  });
}

function home() {
  const mine = mySocial();
  const parts = [homeChatBanner(), screenHeader("Now")];
  parts.push(
    el("div", { class: "now-row" }, [
      el("button", {
        class: mine && isLiveSocial(mine) ? "orb live" : "orb",
        type: "button",
        "aria-label": "Let friends know you're free now",
        "aria-pressed": mine ? "true" : "false",
        onclick: () => openSheet("free"),
      }),
      mine
        ? el("p", { class: "hint" }, [
            el("strong", { text: mine.startsAt && mine.startsAt > Date.now() ? `Free from ${clock(mine.startsAt)}` : "You're free now" }),
            document.createTextNode(mine.note || "Friends have been told"),
          ])
        : el("p", { class: "hint" }, [
            document.createTextNode("Tap to let friends"),
            el("br"),
            document.createTextNode("know you're free now"),
          ]),
    ]),
  );
  parts.push(
    el("button", {
      class: "invite-chip",
      type: "button",
      text: "Share invite",
      onclick: () => shareInvite(),
    }),
  );
  const live = state.socials.filter((social) => isLiveSocial(social) || social.creator.id === state.me.user.id);
  const later = state.socials.filter((social) => !isLiveSocial(social) && social.creator.id !== state.me.user.id);
  if (live.length) {
    parts.push(el("div", { class: "section" }, [el("div", { class: "cards" }, live.map(socialCard))]));
  }
  if (later.length) {
    parts.push(el("section", { class: "section" }, [
      el("h2", { text: "Later today" }),
      el("div", { class: "cards" }, later.map(socialCard)),
    ]));
  }
  const { tomorrow: nextDay } = planDayRange(Date.now(), appTz());
  const soon = state.plans.filter((plan) => plan.forDate <= nextDay);
  const upcoming = state.plans.filter((plan) => plan.forDate > nextDay);
  const tomorrow = el("section", { class: "section" }, [
    el("div", { class: "section-row" }, [
      el("h2", { text: "Today & tomorrow" }),
      el("button", { class: "text-btn", type: "button", text: "Plan", onclick: () => openSheet("plan") }),
    ]),
    el("div", { class: "cards" }, soon.length
      ? soon.map(planCard)
      : [
          el("button", {
            class: "empty",
            type: "button",
            text: "Nothing planned yet",
            onclick: () => openSheet("plan"),
          }),
        ]),
  ]);
  parts.push(tomorrow);
  if (upcoming.length) {
    parts.push(el("section", { class: "section" }, [
      el("h2", { text: "Upcoming" }),
      el("div", { class: "cards" }, upcoming.map(planCard)),
    ]));
  }
  parts.push(el("div", { class: "past-entry" }, [
    el("button", { class: "text-btn", type: "button", text: "Past events", onclick: () => { void openPast(); } }),
  ]));
  return el("div", {}, parts);
}

async function openPast() {
  state.past = true;
  state.sheet = null;
  state.pastDays = null;
  render();
  await run(async () => {
    state.pastDays = (await api("/api/past")).days;
  });
}

function closePast() {
  state.past = false;
  state.pastDays = null;
  render();
}

function pastScreen() {
  const days = state.pastDays;
  return el("section", { class: "past-screen", "aria-label": "Past events" }, [
    el("header", { class: "chat-head" }, [
      el("button", { class: "text-btn chat-back", type: "button", text: "Back", onclick: closePast }),
      el("h1", { text: "Past events" }),
    ]),
    days == null
      ? el("p", { class: "help past-empty", text: "Loading…" })
      : days.length
        ? el("div", { class: "past-list" }, days.map(pastDay))
        : el("p", { class: "help past-empty", text: "Nothing here yet. Ended hangouts stay for 90 days." }),
  ]);
}

function pastDay(day) {
  return el("section", { class: "past-day" }, [
    el("h2", { text: day.label }),
    ...day.events.map(pastCard),
  ]);
}

function pastCard(event) {
  const bits = [event.host.name];
  if (event.time) bits.push(event.time);
  if (event.place) bits.push(event.place);
  const people = event.people.map((person) => (
    person.arriveAt ? `${person.name}, arriving ${clock(person.arriveAt)}` : person.name
  ));
  return el("article", { class: "past-card" }, [
    el("h3", { text: event.note || (event.kind === "plan" ? "Plan" : "Free now") }),
    el("p", { text: bits.join(" · ") }),
    people.length ? el("p", { text: people.join(" · ") }) : null,
    chatChip(event.kind, event.id),
  ]);
}

function socialCard(social) {
  const mine = social.creator.id === state.me.user.id;
  const people = [social.creator, ...social.joined.filter((person) => person.reply !== "declined")];
  const upcoming = social.startsAt && social.startsAt > Date.now();
  return el("article", {
    class: state.focusSocial === social.id ? "card card-now focused" : upcoming ? "card card-now later" : "card card-now",
    "data-social": social.id,
  }, [
    el("div", { class: "card-bg" }),
    eventTools("social", social),
    el("div", { class: "card-copy" }, [
      el("div", { class: "avatars" }, people.map((person) => avatar(person))),
      el("h3", { text: social.note || (upcoming ? "Free later" : "Free now") }),
      el("p", { text: upcoming ? `${social.creator.name} · from ${clock(social.startsAt)}` : `${social.creator.name} · ${remaining(social.expiresAt)}` }),
      placeLine(social.location, social.place, { kind: "social", id: social.id }),
      replySummary(social),
      mine ? null : removedNote(social) || replyActions(social),
      deliveryLine("social", social),
      chatEntry("social", social),
    ]),
  ]);
}

function planCard(plan) {
  const mine = plan.creator.id === state.me.user.id;
  const people = [plan.creator, ...plan.joined];
  return el("article", { class: "card card-photo card-plan", style: `--photo:url("${bgFor(plan.id)}")` }, [
    el("div", { class: "card-bg" }),
    eventTools("plan", plan),
    el("div", { class: "card-copy" }, [
      el("div", { class: "avatars" }, people.map((person) => avatar(person))),
      el("h3", { text: plan.note }),
      el("p", { text: `${plan.whenLabel}${plan.time ? ` · ${plan.time}` : ""} · ${plan.creator.name}` }),
      planDescription(plan),
      placeLine(plan.location, plan.place, { kind: "plan", id: plan.id }),
      planReplySummary(plan),
      mine ? null : removedNote(plan) || planReplyButtons(plan),
      deliveryLine("plan", plan),
      chatEntry("plan", plan),
    ]),
  ]);
}

/** Two lines until tapped. Tap again to fold it back. Links stay tappable. */
function planDescription(plan) {
  const text = (plan?.description || "").trim();
  if (!text) return null;
  const open = state.openDescriptions.has(plan.id);
  const toggle = (event) => {
    if (event.target.closest("a")) return;
    const next = !state.openDescriptions.has(plan.id);
    if (next) state.openDescriptions.add(plan.id);
    else state.openDescriptions.delete(plan.id);
    document.querySelectorAll(`.plan-desc[data-plan="${plan.id}"]`).forEach((node) => {
      node.classList.toggle("open", next);
      node.setAttribute("aria-expanded", String(next));
    });
  };
  return el("p", {
    class: open ? "plan-desc open" : "plan-desc",
    "data-plan": plan.id,
    role: "button",
    tabindex: "0",
    "aria-expanded": String(open),
    onclick: toggle,
    onkeydown: (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggle(event);
    },
  }, linkify(text));
}

/** Plain text with http(s) links made tappable. Built as nodes, so nothing is parsed as HTML. */
function linkify(text) {
  const parts = [];
  let last = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s<>"]+/g)) {
    const url = match[0].replace(/[.,!?;:)\]]+$/, "");
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(el("a", { href: url, target: "_blank", rel: "noopener noreferrer", text: url }));
    last = match.index + url.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function circleScreen() {
  const circle = state.me.circle;
  return el("div", {}, [
    screenHeader("Circle"),
    el("div", { class: "panel" }, [
      el("h3", { text: circle.name }),
      youAreAdmin()
        ? el("form", { class: "stack", onsubmit: onRenameCircle }, [
            field("Circle name", "circle-rename", circle.name, () => {}, { maxlength: "32" }),
            el("button", { class: "btn secondary", type: "submit", text: "Save circle name" }),
          ])
        : null,
      el("div", { class: "code-block", text: circle.inviteCode }),
      el("p", { class: "help", text: "Share the link. It lasts 14 days. New invite link turns the old one off." }),
      el("div", { class: "stack" }, [
        el("button", {
          class: "btn",
          type: "button",
          text: "Share invite",
          onclick: () => shareInvite(),
        }),
        el("button", {
          class: "text-btn",
          type: "button",
          text: "New link",
          onclick: () => rotateInvite(),
        }),
        el("button", {
          class: "text-btn",
          type: "button",
          text: "New circle",
          onclick: () => openCircleSheet("new-circle"),
        }),
        el("button", {
          class: "text-btn",
          type: "button",
          text: "Join with link",
          onclick: () => openCircleSheet("join-circle"),
        }),
      ]),
    ]),
    el("div", { class: "list" }, [
      el("h2", { class: "members-title", text: "Members" }),
      ...circle.members.map((member) => memberRow(member)),
    ]),
    youAreAdmin()
      ? el("div", { class: "panel stack" }, [
          el("button", { class: "btn danger", type: "button", text: "Delete circle", onclick: onDeleteCircle }),
        ])
      : null,
  ]);
}

function homeChatBanner() {
  const n = circleUnread();
  if (!n || state.chat) return null;
  const name = state.me?.circle?.name || "your circle";
  const messages = n === 1 ? "1 new message" : `${n} new messages`;
  return el("button", {
    class: "chat-banner",
    type: "button",
    text: `${messages} in ${name}`,
    onclick: () => { void openChat({ kind: "circle" }); },
  });
}

function circleUnread() {
  return state.chatSummary?.circle?.unread || 0;
}

function circleHasUnread(id) {
  return (state.chatSummary?.unreadByCircle?.[id] || 0) > 0;
}

function anyCircleUnread() {
  const totals = state.chatSummary?.unreadByCircle || {};
  return Object.values(totals).some((count) => count > 0);
}

function forgetOpenUnread(target) {
  const summary = state.chatSummary;
  if (!summary || !target) return;
  const circleId = state.me?.circle?.id;
  let cleared = 0;
  if (target.kind === "circle") {
    cleared = summary.circle?.unread || 0;
    if (summary.circle) summary.circle.unread = 0;
  } else {
    const row = summary.events?.find((item) => item.kind === target.kind && item.id === target.id);
    cleared = row?.unread || 0;
    if (row) row.unread = 0;
  }
  if (circleId && summary.unreadByCircle && cleared) {
    summary.unreadByCircle[circleId] = Math.max(0, (summary.unreadByCircle[circleId] || 0) - cleared);
  }
}

function eventUnread(kind, id) {
  return state.chatSummary?.events?.find((row) => row.kind === kind && row.id === id)?.unread || 0;
}

function chatTargetUrl(target) {
  if (target.kind === "circle") return "/api/circles/chat";
  return `/api/${target.kind}s/${target.id}/chat`;
}

async function openChat(target) {
  state.chatReturn = state.tab;
  state.chat = target;
  state.chatStick = true;
  forgetOpenUnread(target);
  await run(async () => {
    state.chatThread = (await api(chatTargetUrl(target))).chat;
  });
}

function closeChat() {
  state.chat = null;
  state.chatThread = null;
  state.chatDraft = "";
  state.tab = state.chatReturn || "home";
  render();
}

function chatScreen() {
  const thread = state.chatThread;
  const title = thread?.title || "Chat";
  return     el("section", { class: "chat-screen", "aria-label": title }, [
    state.statusMessage ? el("p", { class: "status-banner", role: "status", text: state.statusMessage }) : null,
    el("header", { class: "chat-head" }, [
      el("button", { class: "text-btn chat-back", type: "button", text: "Back", onclick: closeChat }),
      el("h1", { text: title }),
      thread
        ? el("button", {
            class: "text-btn",
            type: "button",
            text: thread.muted ? "Unmute" : "Mute",
            onclick: () => { void toggleMute(); },
          })
        : null,
    ]),
    el("div", { class: "chat-log", id: "chat-log" }, thread
      ? thread.messages.map((message) => message.system ? systemLine(message) : messageRow(message))
      : [el("p", { class: "help", text: "Loading…" })]),
    thread?.removed
      ? el("p", { class: "chat-closed", text: "You were removed from this event." })
      : thread?.closed
      ? el("p", { class: "chat-closed", text: "This chat is closed." })
      : el("form", { class: "chat-compose", onsubmit: sendChat }, [
          el("input", {
            id: "chat-input",
            class: "sheet-control",
            type: "text",
            maxlength: "1000",
            placeholder: "Message",
            value: state.chatDraft,
            autocomplete: "off",
            oninput: (event) => { state.chatDraft = event.target.value; },
          }),
          el("button", { class: "btn chat-send", type: "submit", text: "Send" }),
        ]),
  ]);
}

function systemLine(message) {
  return el("p", { class: "chat-system" }, [
    el("span", { text: message.text }),
    el("time", { text: messageWhen(message.at) }),
  ]);
}

function messageRow(message) {
  const accent = message.system ? "" : message.color || "";
  return el("article", {
    class: message.mine ? "chat-msg mine" : "chat-msg",
    "data-color": accent || null,
    style: accent ? `--person:${accent}` : null,
  }, [
    el("header", {}, [
      el("strong", { text: message.mine ? "You" : message.name }),
      el("time", { text: messageWhen(message.at) }),
    ]),
    el("p", { text: message.text }),
    message.canDelete
      ? el("button", { class: "text-btn", type: "button", text: "Delete", onclick: () => confirmDeleteMessage(message) })
      : null,
  ]);
}

function messageWhen(ms) {
  const part = zonedParts(ms);
  const today = zonedParts(Date.now());
  const hm = clockText(part.hour, part.minute);
  if (part.day === today.day) return hm;
  return `${part.day.slice(5)} ${hm}`;
}

function stickChatLog() {
  const log = document.querySelector(".chat-log");
  const bar = document.querySelector(".chat-compose, .chat-closed");
  if (!log) return;
  const view = window.visualViewport;
  const viewBottom = (view?.offsetTop ?? 0) + (view?.height ?? window.innerHeight);
  const limit = Math.min(viewBottom, bar?.getBoundingClientRect().top ?? viewBottom) - 8;
  const last = log.lastElementChild;
  if (!last) return;
  const box = last.getBoundingClientRect();
  if (box.bottom > limit) log.scrollTop += box.bottom - limit;
}

function unsentTail(typed, sent) {
  if (!sent || typed === sent) return typed === sent ? "" : typed;
  if (typed.startsWith(sent)) return typed.slice(sent.length).replace(/^\s+/, "");
  return typed;
}

async function sendChat(event) {
  event.preventDefault();
  if (!state.chat || state.chatQueue) return;
  const text = state.chatDraft.trim();
  if (!text) return;
  const target = { kind: state.chat.kind, id: state.chat.id };
  state.chatQueue = { target, text };
  try {
    state.chatThread = (await api(chatTargetUrl(target), { method: "POST", body: { text } })).chat;
    state.chatQueue = null;
    state.chatDraft = unsentTail(state.chatDraft, text);
    state.statusMessage = "";
    state.chatStick = true;
  } catch (error) {
    if (error.status === 401) return;
    if (isNetworkFailure(error) || error.status >= 500) {
      noteConnectionProblem(error);
      scheduleOfflineRetry(1000);
    } else {
      state.chatQueue = null;
      state.error = error.message || "Something went wrong";
    }
  }
  render();
}

async function flushChatQueue() {
  const queued = state.chatQueue;
  if (!queued) return;
  try {
    const thread = (await api(chatTargetUrl(queued.target), { method: "POST", body: { text: queued.text } })).chat;
    state.chatQueue = null;
    state.chatDraft = unsentTail(state.chatDraft, queued.text);
    state.statusMessage = "";
    if (state.chat && state.chat.kind === queued.target.kind && state.chat.id === queued.target.id) {
      state.chatThread = thread;
    }
    state.chatStick = true;
    render();
  } catch (error) {
    if (error.status !== 401 && (isNetworkFailure(error) || error.status >= 500)) noteConnectionProblem(error);
  }
}

async function toggleMute() {
  if (!state.chat || !state.chatThread) return;
  const muted = !state.chatThread.muted;
  await run(async () => {
    await api(`/api/chats/${state.chatThread.id}/mute`, { method: "POST", body: { muted } });
    state.chatThread = (await api(chatTargetUrl(state.chat))).chat;
  });
}

function confirmDeleteMessage(message) {
  state.confirm = {
    title: "Delete this message?",
    body: "It's removed for everyone in the chat.",
    confirmLabel: "Delete",
    action: async () => {
      await run(async () => {
        await api(`/api/messages/${message.id}`, { method: "DELETE" });
        if (state.chat) state.chatThread = (await api(chatTargetUrl(state.chat))).chat;
      });
    },
  };
  render();
}

function chatChip(kind, id) {
  const unread = eventUnread(kind, id);
  return el("button", {
    class: "chip chat-chip",
    type: "button",
    "aria-label": unread ? `Chat, ${unread} unread` : "Chat",
    onclick: () => { void openChat({ kind, id }); },
  }, [
    icon("chat"),
    el("span", { text: "Chat" }),
    unread ? el("span", { class: "badge", text: unread > 9 ? "9+" : String(unread) }) : null,
  ]);
}

function chatEntry(kind, item) {
  return chatChip(kind, item.id);
}

function alertsScreen() {
  const items = state.notifications.length
    ? state.notifications.map((note) =>
        el("button", {
          class: "alert-card",
          type: "button",
          onclick: () => openNotification(note),
        }, [
          note.readAt ? null : el("span", { class: "unread", "aria-label": "Unread" }),
          el("div", { class: "grow" }, [
            el("div", { class: "alert-top" }, [
              el("h3", { text: note.title }),
              el("span", { class: "time", text: ago(note.createdAt) }),
            ]),
            el("p", { text: note.body }),
          ]),
        ]),
      )
    : [el("p", { class: "help", style: "padding: 8px 20px", text: "When a friend is free, it shows up here." })];
  const dev = state.meta?.devMode
    ? el("p", {
        class: "help",
        style: "padding: 4px 20px 0",
        text: "This server has no VAPID keys, so these in-app alerts stand in for push notifications.",
      })
    : null;
  return el("div", {}, [
    screenHeader("Alerts"),
    dev,
    el("div", { class: "list" }, items),
  ]);
}

function buzzNote(code) {
  const circles = state.me?.circles || [];
  const current = state.me?.circle;
  if (circles.length < 2 || !current) return null;
  const last = circles[circles.length - 1];
  const link = `${location.origin}/api/buzz/${encodeURIComponent(code)}?circle=${encodeURIComponent(current.id)}`;
  return el("div", {}, [
    el("p", {
      class: "help",
      text: `This link posts to ${current.name}. A buzz with only the code posts to ${last.name}.`,
    }),
    el("p", { class: "code-block", text: link }),
  ]);
}

function youScreen() {
  const code = state.me.user.buzzToken;
  return el("div", {}, [
    screenHeader("You"),
    el("div", { class: "profile-hero" }, [
      avatar(state.me.user, 72, "lg"),
      el("strong", { text: state.me.user.name }),
    ]),
    el("form", { class: "panel stack", onsubmit: onRename }, [
      field("Your name", "rename", state.me.user.name, () => {}, { maxlength: "24" }),
      el("button", { class: "btn secondary", type: "submit", text: "Save name" }),
      el("p", { class: "help", text: "Friends see this name on your cards." }),
    ]),
    el("div", { class: "panel" }, [
      el("button", {
        class: "row notif-row",
        type: "button",
        onclick: openNotifications,
      }, [
        el("div", { class: "grow" }, [
          el("h3", { text: "Notifications" }),
          el("p", { text: notificationStatusLabel() }),
        ]),
      ]),
      state.meta?.vapidPublicKey
        ? el("button", {
            class: "btn ghost",
            type: "button",
            text: "Send a test push",
            onclick: onTestPush,
          })
        : null,
      state.installEvent
        ? el("button", { class: "btn secondary", type: "button", text: "Install app", onclick: onInstall })
        : null,
    ]),
    el("div", { class: "panel panel-rows" }, [
      el("button", { class: "row nav-row", type: "button", onclick: () => { void openWhatsNewList(); } }, [
        el("div", { class: "grow" }, [
          el("h3", { text: "What's new" }),
          el("p", { text: "Recent changes to Hangry" }),
        ]),
        icon("chevron"),
      ]),
      el("button", { class: "row nav-row", type: "button", onclick: openFeedback }, [
        el("div", { class: "grow" }, [
          el("h3", { text: "Send feedback" }),
          el("p", { text: "Ideas, bugs, anything" }),
        ]),
        icon("chevron"),
      ]),
    ]),
    el("div", { class: "panel" }, [
      el("button", {
        class: "text-btn",
        type: "button",
        text: state.showRecovery ? "Hide recovery code" : "Show recovery code",
        onclick: () => {
          state.showRecovery = !state.showRecovery;
          render();
        },
      }),
      state.showRecovery
        ? el("div", {}, [
            el("p", { class: "code-block", text: code }),
            el("p", { class: "help", text: "Save this. It is how you sign back in on another phone." }),
            buzzNote(code),
            el("div", { class: "stack" }, [
              el("button", {
                class: "btn secondary",
                type: "button",
                text: "Copy",
                onclick: () => copyText(code, "Recovery code copied"),
              }),
              el("button", {
                class: "btn ghost",
                type: "button",
                text: "New code",
                onclick: onRotateBuzz,
              }),
            ]),
          ])
        : null,
    ]),
    el("div", { class: "panel stack" }, [
      el("button", { class: "btn danger", type: "button", text: "Leave circle", onclick: onLeave }),
      el("button", { class: "btn ghost", type: "button", text: "Sign out", onclick: onLogout }),
    ]),
  ]);
}

function tabbar() {
  const tabs = [
    ["home", "Now", "home"],
    ["map", "Map", "map"],
    ["chat", "Chat", "chat"],
    ["circle", "Circle", "compass"],
    ["you", "You", "person"],
  ];
  const unread = circleUnread();
  return el("nav", { class: "tabbar" }, tabs.map(([id, label, glyph]) => {
    const current = state.tab === id;
    const name = id === "chat" && unread ? `Chat, ${unread} unread` : label;
    return el("button", {
      class: "tab",
      type: "button",
      "aria-label": name,
      "aria-current": current ? "page" : null,
      onclick: () => onTab(id),
    }, [
      icon(glyph),
      el("span", { class: "tab-label", text: label }),
      id === "chat" && unread ? el("span", { class: "badge", text: unread > 9 ? "9+" : String(unread) }) : null,
    ]);
  }));
}

function notificationStatusLabel() {
  if ("Notification" in window && Notification.permission === "denied") return "Blocked";
  if (state.pushOn) return "On";
  return "Off";
}

function openNotifications() {
  if ("Notification" in window && Notification.permission === "denied") {
    openInstallGuide();
    return;
  }
  state.sheet = "notifications";
  render();
}

function notificationsSheet() {
  return el("div", {}, [
    el("button", { class: "scrim", type: "button", "aria-label": "Close", onclick: closeSheet }),
    el("div", { class: "sheet", role: "dialog", "aria-label": "Notifications" }, [
      el("div", { class: "sheet-head" }, [
        el("div", { class: "grabber" }),
        el("h2", { text: "Notifications" }),
        el("p", {
          class: "help",
          text: state.pushOn
            ? "Notifications are on."
            : "Allow notifications so a friend can reach this phone.",
        }),
      ]),
      state.pushOn
        ? null
        : el("button", {
            class: "btn",
            type: "button",
            text: state.pushBusy ? "Waiting…" : "Turn on notifications",
            disabled: state.pushBusy,
            onclick: () => { void onEnablePush(); },
          }),
    ]),
  ]);
}

function youAreAdmin() {
  return Boolean(state.me?.circle?.youAreAdmin);
}

function reachText(reach) {
  if (reach === "on") return "Notifications on";
  if (reach === "off") return "Notifications off";
  if (reach === "not_installed") return "Not installed";
  return "";
}

function memberRow(member) {
  const self = member.id === state.me.user.id;
  const reach = reachText(member.reach);
  const line = [self ? "You" : "", reach].filter(Boolean).join(" · ");
  return el("div", { class: "row member-row" }, [
    avatar(member, 40),
    el("div", { class: "grow" }, [
      el("h3", {}, [
        el("span", { text: member.name }),
        member.admin ? el("span", { class: "admin-badge", text: "Admin" }) : null,
      ]),
      line ? el("p", { text: line }) : null,
    ]),
    youAreAdmin() && !self
      ? el("button", {
          class: "text-btn",
          type: "button",
          text: "Manage",
          "aria-label": `Manage ${member.name}`,
          onclick: () => openMemberMenu(member),
        })
      : null,
  ]);
}

function openMemberMenu(member) {
  state.memberMenu = member;
  state.sheet = "member";
  render();
}

function memberSheet() {
  const member = state.memberMenu;
  if (!member) return el("div");
  return el("div", {}, [
    el("button", { class: "scrim", type: "button", "aria-label": "Close", onclick: closeSheet }),
    el("div", { class: "sheet", role: "dialog", "aria-label": member.name }, [
      el("div", { class: "sheet-head" }, [
        el("div", { class: "grabber" }),
        el("h2", { text: member.name }),
        el("p", { class: "help", text: [member.admin ? "Admin" : "Member", reachText(member.reach)].filter(Boolean).join(" · ") }),
      ]),
      el("div", { class: "actions" }, [
        member.admin
          ? el("button", { class: "action", type: "button", text: "Remove admin", onclick: () => setMemberAdmin(member, false) })
          : el("button", { class: "action", type: "button", text: "Make admin", onclick: () => setMemberAdmin(member, true) }),
        el("button", {
          class: "action",
          type: "button",
          text: "Remove from circle",
          onclick: () => confirmRemoveMember(member),
        }),
      ]),
    ]),
  ]);
}

async function setMemberAdmin(member, admin) {
  await run(async () => {
    const data = await api(`/api/circles/members/${member.id}`, { method: "POST", body: { admin } });
    state.me = { ...state.me, circle: data.circle };
    state.sheet = null;
  });
}

function confirmRemoveMember(member) {
  state.sheet = null;
  state.confirm = {
    title: `Remove ${member.name}?`,
    body: "They lose access right away. Their free posts and plans in this circle end.",
    confirmLabel: "Remove",
    action: async () => {
      await run(async () => {
        await api(`/api/circles/members/${member.id}`, { method: "DELETE" });
        await refresh({ initial: true });
      });
    },
  };
  render();
}

function canManageEvent(item) {
  return Boolean(item?.creator) && (item.creator.id === state.me.user.id || youAreAdmin());
}

function eventTools(kind, item) {
  if (!canManageEvent(item)) return null;
  const label = item.note || (kind === "plan" ? "plan" : "free post");
  return el("div", { class: "card-tools" }, [
    el("button", { class: "text-btn event-tool", type: "button", text: "Edit", "aria-label": `Edit ${label}`, onclick: () => openAdminEdit(kind, item) }),
    el("button", { class: "text-btn event-tool", type: "button", text: "End", "aria-label": `End ${label}`, onclick: () => endManaged(kind, item) }),
  ]);
}

function openAdminEdit(kind, item) {
  const time = kind === "social" ? (item.startsAt ? clock(item.startsAt) : "") : (item.time || "");
  const session = emptyWhereSession();
  const place = item.place || "";
  const lat = item.location?.lat ?? null;
  const lng = item.location?.lng ?? null;
  if (place || lat != null || lng != null) {
    session.where = { mode: "place", place, lat, lng, precise: lat != null && lng != null };
    session.whereQuery = place;
  }
  const day = kind === "plan" ? planDayChoice(item.forDate, Date.now(), appTz()) : "";
  state.adminEdit = {
    kind,
    id: item.id,
    note: item.note || "",
    description: item.description || "",
    time,
    day,
    date: item.forDate || "",
    ...session,
  };
  state.sheet = "admin-edit";
  render();
}

function adminEditSheet() {
  const edit = state.adminEdit;
  if (!edit) return el("div");
  return el("div", {}, [
    el("button", { class: "scrim", type: "button", "aria-label": "Close", onclick: closeSheet }),
    el("form", { class: "sheet", role: "dialog", "aria-label": "Edit", onsubmit: saveAdminEdit }, [
      el("div", { class: "sheet-head" }, [
        el("div", { class: "grabber" }),
        el("h2", { text: "Edit" }),
        el("p", { class: "help", text: "This updates it for everyone in the circle." }),
      ]),
      el("div", { class: "sheet-scroll" }, [
        el("div", { class: "sheet-form" }, [
          sheetField("Note", "admin-note", edit.note, (value) => { edit.note = value; }, { maxlength: "80" }),
          edit.kind === "plan" ? descriptionField(edit) : null,
          edit.kind === "plan" ? planDayBlock(edit, "admin") : null,
          el("label", { class: "sheet-group" }, [
            el("span", { class: "sheet-label", text: edit.kind === "plan" ? "Time" : "Time (empty means now)" }),
            el("input", {
              id: "admin-time",
              class: "sheet-control",
              type: "time",
              value: edit.time,
              oninput: (event) => { edit.time = event.target.value; },
            }),
            edit.kind === "plan" ? planTimeError() : null,
          ]),
          whereBlock(edit),
        ]),
      ]),
      el("div", { class: "sheet-dock" }, [
        el("button", { class: "btn", type: "submit", text: "Save" }),
      ]),
    ]),
  ]);
}

function descriptionField(edit) {
  const area = el("textarea", {
    id: "admin-description",
    class: "sheet-control sheet-textarea",
    rows: "3",
    maxlength: "280",
    placeholder: "Optional",
    oninput: (event) => { edit.description = event.target.value; },
  });
  area.value = edit.description;
  return el("label", { class: "sheet-group" }, [
    el("span", { class: "sheet-label", text: "Description" }),
    area,
  ]);
}

async function saveAdminEdit(event) {
  event.preventDefault();
  const edit = state.adminEdit;
  if (!edit) return;
  const note = document.getElementById("admin-note")?.value ?? edit.note;
  const description = document.getElementById("admin-description")?.value ?? edit.description;
  const picked = wherePayload(edit);
  const time = document.getElementById("admin-time")?.value || null;
  const date = edit.kind === "plan" ? planDayDate(edit.day, edit.date, Date.now(), appTz()) : "";
  if (edit.kind === "plan" && !date) {
    state.error = PICK_DATE_ERROR;
    render();
    return;
  }
  await run(async () => {
    const body = edit.kind === "social"
      ? { note, place: picked.place, startsAt: time, lat: picked.lat, lng: picked.lng }
      : { note, description, place: picked.place, time, date, lat: picked.lat, lng: picked.lng };
    if (picked.lat != null && picked.lng != null) body.precise = Boolean(picked.precise);
    await api(`/api/${edit.kind}s/${edit.id}`, { method: "PATCH", body });
    state.sheet = null;
    await refresh({ initial: true });
  });
}

function endManaged(kind, item) {
  const own = item.creator?.id === state.me.user.id;
  const who = item.creator?.name || "They";
  state.confirm = {
    title: "End this?",
    body: own ? "Friends will no longer see it." : `${who} will be told this ended.`,
    confirmLabel: "End",
    action: async () => {
      await run(async () => {
        await api(`/api/${kind}s/${item.id}`, { method: "DELETE" });
        await refresh({ initial: true });
      });
    },
  };
  render();
}

function deliveryLine(kind, item) {
  const push = item.push;
  if (!push || !push.total) return null;
  return el("button", {
    class: "text-btn push-line",
    type: "button",
    text: `Delivered to ${push.delivered} of ${push.total}`,
    onclick: () => openPushSheet(kind, item),
  });
}

function openPushSheet(kind, item) {
  state.pushDetail = { kind, id: item.id, title: pushTitle(kind, item), push: item.push };
  state.sheet = "push";
  render();
}

/** Point the open push sheet at fresh poll data. True when it changed and needs a render. */
function syncPushDetail() {
  if (state.sheet !== "push") return false;
  const next = nextPushDetail(state.pushDetail, state.socials, state.plans);
  if (!next) return false;
  state.pushDetail = next;
  return true;
}

function pushStatusText(person) {
  if (person.status === "delivered") return "Delivered";
  if (person.status === "sent") return "Sent, not confirmed";
  if (person.status === "failed") return person.httpStatus ? `Failed · ${person.httpStatus}` : "Failed";
  if (person.status === "not_sent") return "Notifications on · not sent for this event";
  if (person.status === "not_installed") return "Not installed";
  return "Notifications off";
}

function pushSheet() {
  const detail = state.pushDetail;
  if (!detail?.push) return el("div");
  return el("div", {}, [
    el("button", { class: "scrim", type: "button", "aria-label": "Close", onclick: closeSheet }),
    el("div", { class: "sheet", role: "dialog", "aria-label": "Push delivery" }, [
      el("div", { class: "sheet-head" }, [
        el("div", { class: "grabber" }),
        el("h2", { text: "Push" }),
        el("p", {
          class: "help",
          text: `${detail.title} · Delivered to ${detail.push.delivered} of ${detail.push.total}`,
        }),
      ]),
      el("div", { class: "sheet-scroll" }, [
        el("div", { class: "list" }, detail.push.people.map((person) => el("div", { class: "row" }, [
          avatar(person, 40),
          el("div", { class: "grow" }, [
            el("h3", { text: person.name }),
            el("p", { text: pushStatusText(person) }),
          ]),
        ]))),
      ]),
    ]),
  ]);
}

let whatsNewLoad = null;

/** The changelog, fetched once per page. Null while offline with nothing cached, so the next check retries. */
async function loadWhatsNew() {
  if (state.whatsNew) return state.whatsNew;
  if (!whatsNewLoad) {
    whatsNewLoad = fetch("/whats-new.json", { cache: "no-cache" })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("whats-new"))))
      .then((raw) => {
        state.whatsNew = normalizeEntries(raw);
        return state.whatsNew;
      })
      .catch(() => {
        whatsNewLoad = null;
        return null;
      });
  }
  return whatsNewLoad;
}

function readSeen() {
  try {
    return localStorage.getItem(SEEN_KEY) || null;
  } catch {
    return null;
  }
}

function writeSeen(id) {
  try {
    localStorage.setItem(SEEN_KEY, id);
  } catch {
    /* storage can be full */
  }
}

/** This phone and the account both remember it, so a second phone does not show it again. */
async function markSeen(id) {
  if (!id) return;
  writeSeen(id);
  if (state.me?.user) state.me.user.whatsNewSeen = id;
  try {
    await api("/api/me/whats-new", { method: "POST", body: { id } });
  } catch {
    /* The local copy holds. The next check sends it again. */
  }
}

async function markNewAccountSeen() {
  const id = latestId(await loadWhatsNew());
  if (id) await markSeen(id);
}

function canShowWhatsNew() {
  return Boolean(state.me?.circle)
    && !state.sheet
    && !state.confirm
    && !state.onboarding
    && !state.installOpen
    && !state.installSheet
    && !state.chat
    && !state.past
    && !state.offline
    && !isTyping();
}

/** Once per page: catch this phone and the account up, then show anything new. */
async function considerWhatsNew() {
  if (state.whatsNewChecked || !state.me?.user) return;
  state.whatsNewChecked = true;
  const entries = await loadWhatsNew();
  if (!entries || !state.me?.user) {
    state.whatsNewChecked = false;
    return;
  }
  if (!entries.length) return;
  const local = readSeen();
  const server = state.me.user.whatsNewSeen ?? null;
  const seen = newerSeen(entries, local, server);
  if (seen && seen !== local) writeSeen(seen);
  if (seen && seen !== server) void markSeen(seen);
  const fresh = unseenEntries(entries, seen);
  if (!fresh.length) return;
  if (!canShowWhatsNew()) {
    // Something else is open. Try again on the next poll.
    state.whatsNewChecked = false;
    return;
  }
  state.whatsNewView = { mode: "popup", entries: fresh };
  state.sheet = "whats-new";
  render();
  void markSeen(latestId(entries));
}

async function openWhatsNewList() {
  const entries = await loadWhatsNew();
  if (!entries) {
    state.error = "You're offline. Try again.";
    render();
    scheduleErrorClear();
    return;
  }
  state.error = "";
  state.whatsNewView = { mode: "list", entries };
  state.sheet = "whats-new";
  render();
  const local = readSeen();
  const next = newerSeen(entries, local, latestId(entries));
  if (next && next !== local) void markSeen(next);
}

function whatsNewEntry(entry) {
  return el("article", { class: "whats-new-entry" }, [
    el("p", { class: "whats-new-date", text: formatEntryDate(entry.date) }),
    el("h3", { text: entry.title }),
    el("ul", {}, entry.bullets.map((bullet) => el("li", { text: bullet }))),
  ]);
}

function whatsNewSheet() {
  const popup = state.whatsNewView?.mode === "popup";
  const entries = state.whatsNewView?.entries || state.whatsNew || [];
  return el("div", {}, [
    el("button", { class: "scrim", type: "button", "aria-label": "Close", onclick: closeSheet }),
    el("div", { class: "sheet whats-new", role: "dialog", "aria-label": "What's new" }, [
      el("div", { class: "sheet-head" }, [
        el("div", { class: "grabber" }),
        el("h2", { text: "What's new" }),
        el("p", { class: "help", text: popup ? "Since you last opened Hangry." : "Recent changes to Hangry." }),
      ]),
      el("div", { class: "sheet-scroll" }, [
        entries.length
          ? el("div", { class: "whats-new-list" }, entries.map(whatsNewEntry))
          : el("p", { class: "help", text: "Nothing here yet." }),
      ]),
      el("div", { class: "sheet-dock" }, [
        el("button", { class: "btn", type: "button", text: popup ? "Got it" : "Done", onclick: closeSheet }),
      ]),
    ]),
  ]);
}

function resetFeedback() {
  state.feedbackDraft = "";
  state.feedbackError = "";
  state.feedbackBusy = false;
  state.feedbackSent = false;
}

function openFeedback() {
  if (state.feedbackSent) resetFeedback();
  state.feedbackError = "";
  state.error = "";
  state.sheet = "feedback";
  render();
}

/** Count and error update in place, so typing never re-renders the sheet. */
function paintFeedbackMeta() {
  const count = document.getElementById("feedback-count");
  if (count) count.textContent = `${state.feedbackDraft.length}/${FEEDBACK_MAX}`;
  if (!state.feedbackError) {
    document.getElementById("feedback-error")?.remove();
    document.getElementById("feedback-text")?.removeAttribute("aria-invalid");
  }
}

function feedbackSheet() {
  const scrim = el("button", { class: "scrim", type: "button", "aria-label": "Close", onclick: closeSheet });
  if (state.feedbackSent) {
    return el("div", {}, [
      scrim,
      el("div", { class: "sheet feedback-done", role: "dialog", "aria-label": "Feedback sent" }, [
        el("div", { class: "sheet-head" }, [
          el("div", { class: "grabber" }),
          el("h2", { text: "Thanks!" }),
          el("p", { class: "help", text: "We read every message. When it turns into a change, you'll see it in What's new." }),
        ]),
        el("div", { class: "sheet-dock" }, [
          el("button", { class: "btn", type: "button", text: "Done", onclick: closeSheet }),
        ]),
      ]),
    ]);
  }
  return el("div", {}, [
    scrim,
    el("form", { class: "sheet", role: "dialog", "aria-label": "Send feedback", novalidate: "", onsubmit: onSendFeedback }, [
      el("div", { class: "sheet-head" }, [
        el("div", { class: "grabber" }),
        el("h2", { text: "Send feedback" }),
        el("p", { class: "help", text: "Ideas, bugs, anything. Your name and circle are sent with it." }),
      ]),
      el("div", { class: "sheet-scroll" }, [
        el("div", { class: "sheet-form" }, [
          el("label", { class: "sheet-group" }, [
            el("span", { class: "sheet-label", text: "Your feedback" }),
            el("textarea", {
              id: "feedback-text",
              class: "sheet-control",
              rows: "6",
              maxlength: String(FEEDBACK_MAX),
              placeholder: "What should we change?",
              "aria-describedby": "feedback-count",
              "aria-invalid": state.feedbackError ? "true" : null,
              oninput: (event) => {
                state.feedbackDraft = event.target.value;
                state.feedbackError = "";
                paintFeedbackMeta();
              },
            }, [state.feedbackDraft]),
            el("div", { class: "feedback-meta" }, [
              state.feedbackError
                ? el("p", { class: "time-error", id: "feedback-error", role: "alert", text: state.feedbackError })
                : null,
              el("span", { class: "feedback-count", id: "feedback-count", text: `${state.feedbackDraft.length}/${FEEDBACK_MAX}` }),
            ]),
          ]),
        ]),
      ]),
      el("div", { class: "sheet-dock" }, [
        el("button", {
          class: "btn",
          type: "submit",
          text: state.feedbackBusy ? "Sending…" : "Send",
          disabled: state.feedbackBusy,
        }),
      ]),
    ]),
  ]);
}

async function onSendFeedback(event) {
  event.preventDefault();
  if (state.feedbackBusy) return;
  const raw = document.getElementById("feedback-text")?.value ?? state.feedbackDraft;
  state.feedbackDraft = raw;
  const text = raw.trim();
  if (!text || text.length > FEEDBACK_MAX) {
    state.feedbackError = text ? `Keep it under ${FEEDBACK_MAX} characters.` : "Write something first.";
    render();
    return;
  }
  state.feedbackBusy = true;
  state.feedbackError = "";
  render();
  try {
    await api("/api/feedback", {
      method: "POST",
      body: { text, circleId: state.me?.circle?.id || undefined, appVersion: APP_VERSION },
    });
    state.feedbackSent = true;
    state.feedbackDraft = "";
  } catch (error) {
    state.feedbackError = isNetworkFailure(error) ? "You're offline. Try again." : error.message;
  } finally {
    state.feedbackBusy = false;
    if (state.sheet === "feedback") render();
  }
}

function sheet() {
  if (state.sheet === "new-circle") return circleNameSheet();
  if (state.sheet === "join-circle") return joinLinkSheet();
  if (state.sheet === "notifications") return notificationsSheet();
  if (state.sheet === "member") return memberSheet();
  if (state.sheet === "admin-edit") return adminEditSheet();
  if (state.sheet === "push") return pushSheet();
  if (state.sheet === "whats-new") return whatsNewSheet();
  if (state.sheet === "feedback") return feedbackSheet();
  if (state.sheet === "action") {
    return el("div", {}, [
      el("button", { class: "scrim", type: "button", "aria-label": "Close", onclick: closeSheet }),
      el("div", { class: "sheet", role: "dialog", "aria-label": "Create" }, [
        el("div", { class: "sheet-head" }, [el("div", { class: "grabber" })]),
        el("div", { class: "actions" }, [
          el("button", { class: "action", type: "button", text: "I'm free now", onclick: () => openSheet("free") }),
          el("button", { class: "action", type: "button", text: "Plan", onclick: () => openSheet("plan") }),
          el("button", { class: "action", type: "button", text: "Cancel", onclick: closeSheet }),
        ]),
      ]),
    ]);
  }
  const planning = state.sheet === "plan";
  const editing = !planning && Boolean(mySocial());
  const later = !planning && state.whenMode === "later";
  const ttl = ttlLabel(state.meta?.socialTtlMs ?? 7200000);
  return el("div", {}, [
    el("button", { class: "scrim", type: "button", "aria-label": "Close", onclick: closeSheet }),
    el("form", { class: "sheet", role: "dialog", onsubmit: planning ? onCreatePlan : onFree }, [
      el("div", { class: "sheet-head" }, [
        el("div", { class: "grabber" }),
        el("div", { class: "sheet-intro" }, [
          el("h2", { text: planning ? planHeading() : editing ? "Update" : later ? (offeringTomorrow() ? "Free tomorrow" : "Free later today") : "Free now" }),
          el("p", {
            class: "help",
            text: planning
              ? `Friends can join. It stays up through ${planThrough()}.`
              : later
                ? `Friends get a push now, and a reminder when it starts. It then lasts ${ttl}.`
                : `Friends in your circle get a push. This lasts ${ttl}.`,
          }),
          !planning && (state.me?.circles || []).length > 1
            ? el("p", { class: "posting-to", text: `Posting to ${state.me.circle?.name || "this circle"}` })
            : null,
        ]),
      ]),
      el("div", { class: "sheet-scroll" }, [
        el("div", { class: "sheet-form" }, [
          planning ? null : whenBlock(),
          planning ? null : timeBlock(),
          sheetField(planning ? "Plan" : "Note (optional)", "sheet-note", state.noteDraft, (value) => {
            state.noteDraft = value;
            paintSummary();
          }, {
            placeholder: planning ? "Walk and dinner with Alvin?" : "Rooftop coffee??",
            maxlength: "80",
          }),
          planning ? planDayBlock(state, "plan") : null,
          planning ? el("label", { class: "sheet-group" }, [
            el("span", { class: "sheet-label", text: "Time (optional)" }),
            el("input", {
              id: "plan-time",
              class: "sheet-control",
              type: "time",
              value: state.planTime,
              oninput: (event) => { state.planTime = event.target.value; },
            }),
            planTimeError(),
          ]) : null,
          whereBlock(planning ? state.planWhere : state),
          planning ? shareToggle("Use my location") : null,
        ]),
      ]),
      el("div", { class: "sheet-dock stack" }, [
        planning ? null : el("p", { class: "sheet-summary", text: friendsSummary() }),
        el("button", {
          class: "btn",
          type: "submit",
          text: planning ? "Add plan" : editing ? "Update" : later ? "I'm free later" : "I'm free",
          disabled: later && !laterTimeChosen(),
        }),
        !planning && mySocial()
          ? el("button", { class: "btn ghost", type: "button", text: "End", onclick: () => endSocial(mySocial()) })
          : null,
      ]),
    ]),
  ]);
}

function banner(note) {
  return el("button", { class: "banner", type: "button", onclick: () => {
    state.banner = null;
    state.tab = "home";
    render();
  } }, [
    el("img", { src: "/icons/icon-192.png", alt: "" }),
    el("span", { class: "copy" }, [el("strong", { text: note.title }), el("span", { text: note.body })]),
  ]);
}

function currentSignals() {
  const standalone = window.matchMedia("(display-mode: standalone)").matches
    || window.matchMedia("(display-mode: fullscreen)").matches
    || window.navigator.standalone === true;
  const notificationPermission = "Notification" in window ? Notification.permission : "unsupported";
  return readInstallSignals({
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints || 0,
    standalone,
    notificationPermission,
  });
}

function currentGuide() {
  return installGuide(currentSignals());
}

function notificationStatus() {
  const guide = currentGuide();
  if (guide.status === "on") return el("p", { class: "status-on", text: "Notifications on" });
  if (guide.status === "denied") return el("p", { class: "status-off", text: "Notifications blocked" });
  return null;
}

function openInstallGuide() {
  state.installOpen = true;
  state.error = "";
  render();
}

function closeInstallGuide() {
  state.installOpen = false;
  render();
}

function installGuideView() {
  const guide = currentGuide();
  const signals = currentSignals();
  const actions = [];
  if (state.installEvent && !signals.standalone) {
    actions.push(el("button", { class: "btn", type: "button", text: "Install app", onclick: onInstall }));
  }
  if (canEnableNotifications(signals, guide)) {
    actions.push(el("button", {
      class: "btn",
      type: "button",
      text: state.pushBusy ? "Waiting…" : "Enable notifications",
      disabled: state.pushBusy,
      onclick: onEnablePush,
    }));
  }
  if (guide.offerCopyLink) {
    actions.unshift(el("button", {
      class: "btn",
      type: "button",
      text: "Copy link",
      onclick: () => copyText(location.href, "Link copied. Open it in Chrome."),
    }));
  }
  actions.push(el("button", { class: "btn ghost", type: "button", text: "Close", onclick: closeInstallGuide }));
  return el("div", { class: "guide-scrim" }, [
    el("section", { class: "guide", role: "dialog", "aria-modal": "true", "aria-labelledby": "install-title" }, [
      el("div", { class: "guide-head sheet-head" }, [
        el("div", { class: "grabber" }),
        el("h2", {
          id: "install-title",
          text: guide.status === "on" || guide.status === "denied" ? "Notifications" : guide.headline,
        }),
      ]),
      guide.status === "on" ? el("p", { class: "status-on", text: "Notifications on" }) : null,
      guide.status === "denied" ? el("p", { class: "status-off", text: "Notifications blocked" }) : null,
      el("p", { class: "lede", text: guide.lede }),
      ...guide.groups.map((group) => el("section", { class: "guide-group" }, [
        group.label ? el("h3", { text: group.label }) : null,
        group.steps.length
          ? el("ol", { class: "guide-steps" }, group.steps.map((item, index) => el("li", { class: item.done ? "done" : "" }, [
              el("span", { class: "n", text: item.done ? "✓" : String(index + 1) }),
              el("div", {}, [
                el("strong", { text: item.title }),
                el("p", { text: item.detail }),
              ]),
            ])))
          : null,
        group.reenable.length
          ? el("ol", { class: "guide-reenable" }, group.reenable.map((line) => el("li", { text: line })))
          : null,
        group.note ? el("p", { class: "guide-note", text: group.note }) : null,
      ])),
      el("div", { class: "stack" }, actions),
    ]),
  ]);
}

function canEnableNotifications(signals, guide) {
  if (!state.meta?.vapidPublicKey) return false;
  if (guide.status === "on" || guide.status === "denied" || guide.status === "wrong-browser") return false;
  if (signals.permission !== "default") return false;
  if (signals.platform === "ios") return signals.standalone && signals.safari;
  if (signals.platform === "android") return !signals.inApp;
  return false;
}

function mapScreen() {
  const pins = collectPins();
  if (!pins.length) {
    destroyLiveMap();
    mapWrap = null;
    return el("div", { class: "map-screen" }, [
      screenHeader("Map"),
      el("div", { class: "map-empty" }, [
        el("h2", { text: "No places yet" }),
        el("p", { text: "When a friend shares where they are, or a plan has a spot on the map, it shows up here." }),
      ]),
    ]);
  }
  if (!mapWrap) {
    mapWrap = el("div", { class: "map-wrap" }, [
      el("div", { id: "hangry-map", class: "hangry-map" }),
      el("div", { id: "map-card-host" }),
    ]);
  }
  return el("div", { class: "map-screen" }, [
    screenHeader("Map"),
    mapWrap,
  ]);
}

function collectPins() {
  const pins = [];
  for (const social of state.socials) {
    if (!social.location) continue;
    const mine = social.creator.id === state.me.user.id;
    const place = audiencePlace(social.place);
    pins.push({
      kind: "social",
      id: social.id,
      lat: social.location.lat,
      lng: social.location.lng,
      title: social.creator.name,
      initial: initial(social.creator.name),
      color: colorFor(social.creator),
      note: place
        ? (social.note ? `${social.note} · ${place}` : place)
        : (social.note || "Free now"),
      time: remaining(social.expiresAt),
      own: mine,
    });
  }
  for (const plan of state.plans) {
    if (!plan.location) continue;
    const mine = plan.creator.id === state.me.user.id;
    const place = audiencePlace(plan.place);
    pins.push({
      kind: "plan",
      id: plan.id,
      lat: plan.location.lat,
      lng: plan.location.lng,
      title: plan.creator.name,
      initial: initial(plan.creator.name),
      color: colorFor(plan.creator),
      note: place ? `${plan.note} · ${place}` : plan.note,
      time: plan.time ? `${plan.whenLabel} · ${plan.time}` : plan.whenLabel,
      own: mine,
    });
  }
  return pins;
}

let mapWrap = null;
let whereTimer = 0;
let skipWhereInput = false;
let reverseTimer = 0;

function emptyWhere() {
  return { mode: "none", place: "", lat: null, lng: null, precise: false };
}

function emptyWhereSession() {
  return {
    where: emptyWhere(),
    whereOpen: false,
    whereQuery: "",
    whereAutofill: false,
    whereResults: [],
    whereSearching: false,
    whereHint: "",
    whereMap: false,
    whereArea: "",
    whereFallback: "",
  };
}

function whereBag() {
  if (state.sheet === "plan" && state.planWhere) return state.planWhere;
  if (state.sheet === "admin-edit" && state.adminEdit?.where) return state.adminEdit;
  return state;
}

function whereFromSocial(social) {
  if (!social || (!social.place && !social.location)) return emptyWhere();
  if (social.location && !social.place) {
    return { mode: "here", place: "", lat: social.location.lat, lng: social.location.lng, precise: false };
  }
  return {
    mode: "place",
    place: social.place || "",
    lat: social.location?.lat ?? null,
    lng: social.location?.lng ?? null,
    precise: Boolean(social.location),
  };
}

function namedPlace(value) {
  const text = String(value || "").trim();
  if (!text || text === FINDING_PLACE || looksLikeUrl(text)) return "";
  return text;
}

function whereLabel(bag = state) {
  if (bag.where.mode === "here" && /^near you$/i.test(bag.where.place || "")) return "Current location";
  if (bag.where.place) return bag.where.place;
  if (bag.where.mode === "here") return "Current location";
  if (bag.where.lat != null) return FINDING_PLACE;
  return "Pick a place";
}

function whereIsEmpty(bag = state) {
  return whereLabel(bag) === "Pick a place";
}

function isLiveSocial(social) {
  return !social?.startsAt || social.startsAt <= Date.now();
}

function clock(ms) {
  const tz = state.meta?.tz || "Europe/Berlin";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(ms));
}

function whenBlock() {
  return el("div", { class: "sheet-group" }, [
    el("span", { class: "sheet-label", id: "when-label", text: "When" }),
    el("div", { class: "segment", role: "group", "aria-labelledby": "when-label" }, [
      whenChoice("now", "Now"),
      whenChoice("later", offeringTomorrow() ? "Tomorrow" : "Later today"),
    ]),
  ]);
}

function whenChoice(mode, text) {
  const on = state.whenMode === mode;
  return el("button", {
    type: "button",
    class: on ? "on" : "",
    "aria-pressed": on ? "true" : "false",
    text,
    onclick: () => {
      state.whenMode = mode;
      if (mode === "now") {
        state.startChoice = "";
        if (state.error === TIME_LATER_ERROR) state.error = "";
      } else ensureLaterTime();
      render();
    },
  });
}

const TIME_LATER_ERROR = "Pick a time later today.";
const PICK_DATE_ERROR = "Pick a date from today on.";

function appTz() {
  return state.meta?.tz || "Europe/Berlin";
}

/** Today, Tomorrow, or Pick a date. `bag` is state for a new plan, or the edit session. */
function planDayBlock(bag, prefix) {
  const dayKey = prefix === "plan" ? "planDay" : "day";
  const dateKey = prefix === "plan" ? "planDate" : "date";
  const range = planDayRange(Date.now(), appTz());
  const choice = (value, text) => {
    const on = bag[dayKey] === value;
    return el("button", {
      type: "button",
      class: on ? "on" : "",
      "aria-pressed": on ? "true" : "false",
      text,
      onclick: () => {
        bag[dayKey] = value;
        if (value === "pick" && !bag[dateKey]) bag[dateKey] = addDaysIso(range.today, 7);
        if (state.error === PICK_DATE_ERROR || state.error === TIME_LATER_ERROR) state.error = "";
        render();
      },
    });
  };
  return el("div", { class: "sheet-group" }, [
    el("span", { class: "sheet-label", id: `${prefix}-day-label`, text: "Day" }),
    el("div", { class: "segment segment-3", role: "group", "aria-labelledby": `${prefix}-day-label` }, [
      choice("today", "Today"),
      choice("tomorrow", "Tomorrow"),
      choice("pick", "Pick a date"),
    ]),
    bag[dayKey] === "pick"
      ? el("input", {
          id: `${prefix}-date`,
          class: "sheet-control",
          type: "date",
          "aria-label": "Date",
          min: range.min,
          max: range.max,
          value: bag[dateKey] || "",
          onchange: (event) => {
            bag[dateKey] = event.target.value;
            render();
          },
        })
      : null,
  ]);
}

function addDaysIso(iso, days) {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function planTimeError() {
  return state.error === TIME_LATER_ERROR ? el("p", { class: "time-error", text: TIME_LATER_ERROR }) : null;
}

function chosenPlanDay() {
  return planDayDate(state.planDay, state.planDate, Date.now(), appTz());
}

function planHeading() {
  const day = chosenPlanDay();
  return day ? dayLabel(day, planDayRange(Date.now(), appTz()).today) : "Plan";
}

function planThrough() {
  const label = planHeading();
  if (label === "Plan") return "that day";
  return label === "Today" || label === "Tomorrow" ? label.toLowerCase() : label;
}

function offeringTomorrow(now = Date.now()) {
  return nextLaterDay(now, state.meta?.tz || "Europe/Berlin") === "tomorrow";
}

function ensureLaterTime() {
  const tz = state.meta?.tz || "Europe/Berlin";
  const now = Date.now();
  if (!isLaterToday(state.startChoice, now, tz)) state.startChoice = nextLaterSlot(now, tz);
  if (state.error === TIME_LATER_ERROR && (isLaterToday(state.startChoice, now, tz) || offeringTomorrow(now))) state.error = "";
}

function timeBlock() {
  if (state.whenMode !== "later") return null;
  const tz = state.meta?.tz || "Europe/Berlin";
  const min = minLaterClock(Date.now(), tz);
  return el("div", { class: "sheet-group" }, [
    el("label", { class: "sheet-label", for: "later-time", text: "Time" }),
    el("input", {
      id: "later-time",
      class: "sheet-control",
      type: "time",
      min: min || null,
      value: /^\d{2}:\d{2}$/.test(state.startChoice) ? state.startChoice : "",
      oninput: (event) => {
        state.startChoice = event.target.value;
        const zone = state.meta?.tz || "Europe/Berlin";
        const now = Date.now();
        const tomorrowDefault = offeringTomorrow(now) && state.startChoice === nextLaterSlot(now, zone);
        if (state.startChoice && !isLaterToday(state.startChoice, now, zone) && !tomorrowDefault) state.error = TIME_LATER_ERROR;
        else if (state.error === TIME_LATER_ERROR) state.error = "";
        render();
      },
    }),
    state.error === TIME_LATER_ERROR ? el("p", { class: "time-error", text: TIME_LATER_ERROR }) : null,
  ]);
}

function pushLine(name, place, fromTime, note) {
  const spot = place.trim();
  const when = fromTime.trim();
  const base = when ? `${name} is free from ${when}` : "";
  const nearYou = /^near you$/i.test(spot);
  const near = /^near\s+/i.test(spot) ? `near ${spot.replace(/^near\s+/i, "")}` : "";
  let line;
  if (!spot) line = base || `${name} is free now`;
  else if (nearYou) line = base ? `${base}, nearby` : `${name} is free nearby`;
  else if (near) line = base ? `${base}, ${near}` : `${name} is free ${near}`;
  else if (base) line = `${base} – meet at ${spot}`;
  else line = `${name} is free – meet at ${spot}`;
  return note ? `${line} – ${note}` : line;
}

function friendsSummary() {
  const name = state.me?.user?.name?.trim() || "You";
  const place = (wherePayload().place || "").trim();
  const note = state.noteDraft.trim();
  const later = state.whenMode === "later";
  const tz = state.meta?.tz || "Europe/Berlin";
  const now = Date.now();
  const clock = later && /^\d{2}:\d{2}$/.test(state.startChoice) ? state.startChoice : "";
  const tomorrow = Boolean(clock) && offeringTomorrow(now) && state.startChoice === nextLaterSlot(now, tz);
  const time = tomorrow ? `${clock} tomorrow` : clock;
  if (later && !time) {
    const when = offeringTomorrow(now) ? "tomorrow" : "later today";
    const line = note ? `${name} is free ${when} – ${note}` : `${name} is free ${when}`;
    return `Friends get: ${line}`;
  }
  return `Friends get: ${pushLine(name, place, time, note)}`;
}

function paintSummary() {
  const node = document.querySelector(".sheet-summary");
  if (node) node.textContent = friendsSummary();
}

function sheetField(label, id, value, onValue, attrs = {}) {
  return el("label", { class: "sheet-group" }, [
    el("span", { class: "sheet-label", text: label }),
    el("input", {
      id,
      class: "sheet-control",
      type: "text",
      value,
      autocomplete: "off",
      ...attrs,
      oninput: (event) => onValue(event.target.value),
    }),
  ]);
}

function laterTimeChosen() {
  return isLaterToday(state.startChoice, Date.now(), state.meta?.tz || "Europe/Berlin");
}

function startPayload() {
  if (state.whenMode !== "later") return { startsAt: null };
  if (state.startChoice === "+60") return { later: true, startsInMin: 60 };
  if (/^\d{2}:\d{2}$/.test(state.startChoice)) return { later: true, startsAt: state.startChoice };
  return { later: true };
}

function inReply(person) {
  return person.reply === "coming" || person.reply === "join" || person.reply === "in";
}

function arriveClock(person) {
  return person?.arriveAt ? clock(person.arriveAt) : "";
}

function replyLine(person, social) {
  const upcoming = social.startsAt && social.startsAt > Date.now();
  const eta = !upcoming && person.etaMin && !person.arriveAt ? person.etaMin : null;
  const arriving = arriveClock(person);
  const mine = person.id === state.me.user.id;
  if (person.reply === "declined") return mine ? "You can't make it" : `${person.name} can't`;
  if (arriving) return mine ? "You're in" : `${person.name} is in, arriving ${arriving}`;
  if (mine) return eta ? `You're in · ${eta} min` : "You're in";
  return eta ? `${person.name} · there in ${eta} min` : `${person.name} is in`;
}

function replySummary(social) {
  const people = social.joined.filter((person) => inReply(person) || person.reply === "declined");
  if (!people.length) return el("p", { text: "Waiting for friends" });
  return el("div", {}, people.map((person) => guestLine(replyLine(person, social), person, "social", social)));
}

function replyActions(social) {
  return replyControls("social", social);
}

function replyControls(kind, item) {
  const mine = item.joined.find((person) => person.id === state.me.user.id);
  const inNow = Boolean(mine) && inReply(mine) && mine.reply !== "declined";
  const declined = mine?.reply === "declined";
  const chosen = arriveClock(mine);
  const preset = arrivalDefault(kind, item);
  return el("div", { class: "reply-actions" }, [
    el("div", { class: "reply-row" }, [
      el("button", {
        class: inNow ? "chip on" : "chip",
        type: "button",
        text: "I'm in",
        onclick: () => sendReply(kind, item, "in"),
      }),
      el("button", {
        class: declined ? "chip on" : "chip",
        type: "button",
        text: "Can't",
        onclick: () => sendReply(kind, item, "declined"),
      }),
    ]),
    timeChip(kind, item, chosen || preset, Boolean(chosen)),
  ]);
}

function timeChip(kind, item, value, chosen) {
  const label = chosen ? `Arriving ${value}` : "Pick time";
  return el("label", { class: "chip time-chip" }, [
    el("span", { text: label }),
    el("input", {
      type: "time",
      step: "60",
      value: /^\d{2}:\d{2}$/.test(value) ? value : "",
      "aria-label": label,
      onchange: (event) => chooseArrival(kind, item, event.target.value),
    }),
  ]);
}

function chooseArrival(kind, item, value) {
  if (!/^\d{2}:\d{2}$/.test(value)) return;
  if (!arrivalAllowed(kind, item, value)) {
    state.error = "Pick a time you can arrive.";
    render();
    scheduleErrorClear();
    return;
  }
  void sendReply(kind, item, "in", value);
}

async function sendReply(kind, item, reply, arriveAt = null) {
  await run(async () => {
    const body = { reply };
    if (arriveAt) body.arriveAt = arriveAt;
    await api(`/api/${kind}s/${item.id}/reply`, { method: "POST", body });
    await refresh({ initial: true });
  });
}

function arrivalDefault(kind, item) {
  const bounds = arrivalBounds(kind, item);
  if (kind === "plan") {
    let value = "18:00";
    if (bounds.sameDay && bounds.min && value < bounds.min) value = bounds.min;
    if (bounds.sameDay && bounds.max && value > bounds.max) value = bounds.max;
    return value;
  }
  const scheduled = item.startsAt && item.startsAt > Date.now() ? clock(item.startsAt) : "";
  if (scheduled && (!bounds.sameDay || (!bounds.min || scheduled >= bounds.min) && (!bounds.max || scheduled <= bounds.max))) {
    return scheduled;
  }
  return bounds.min || clock(Date.now());
}

function arrivalAllowed(kind, item, hhmm) {
  const bounds = arrivalBounds(kind, item);
  if (!bounds.sameDay || !bounds.min || !bounds.max) return true;
  return hhmm >= bounds.min && hhmm <= bounds.max;
}

function arrivalBounds(kind, item) {
  const now = Date.now();
  const tz = state.meta?.tz || "Europe/Berlin";
  const start = kind === "plan"
    ? clockInstant(item.forDate, "06:00")
    : (item.startsAt && item.startsAt > now ? item.startsAt : now);
  const end = kind === "plan" ? clockInstant(item.forDate, "23:59") : item.expiresAt;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { min: "", max: "", sameDay: false };
  const earliest = Math.max(Math.floor(start / 60000) * 60000, Math.floor(now / 60000) * 60000);
  if (earliest > end) return { min: "", max: "", sameDay: false };
  const sameDay = zonedParts(earliest, tz).day === zonedParts(end, tz).day;
  return { min: clock(earliest), max: clock(end), sameDay };
}

function clockInstant(day, hhmm) {
  const tz = state.meta?.tz || "Europe/Berlin";
  const match = /^(\d{2}):(\d{2})$/.exec(hhmm || "");
  if (!match || !/^\d{4}-\d{2}-\d{2}$/.test(day || "")) return NaN;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const [year, month, date] = day.split("-").map(Number);
  let utc = Date.UTC(year, month - 1, date, hour, minute);
  for (let i = 0; i < 4; i += 1) {
    const got = zonedParts(utc, tz);
    const [gy, gm, gd] = got.day.split("-").map(Number);
    const delta = Date.UTC(year, month - 1, date, hour, minute) - Date.UTC(gy, gm - 1, gd, got.hour, got.minute);
    if (delta === 0) break;
    utc += delta;
  }
  return utc;
}

async function shareInvite() {
  const circle = state.me?.circle;
  if (!circle) return;
  const payload = { title: "Hangry", text: `Join ${circle.name} on Hangry`, url: circle.inviteUrl };
  if (navigator.share) {
    try {
      await navigator.share(payload);
      return;
    } catch (error) {
      if (error?.name === "AbortError") return;
    }
  }
  await copyText(circle.inviteUrl, "Invite link copied");
}

async function rotateInvite() {
  await run(async () => {
    const data = await api("/api/circles/invite", { method: "POST", body: {} });
    state.me = { ...state.me, circle: data.circle };
    state.error = "New invite link ready. The old one no longer works.";
  });
}

function pinnedSpot(lat, lng) {
  const digits = (value) => (Math.round(value * 10000) / 10000).toFixed(4);
  return `Pinned spot (${digits(lat)}, ${digits(lng)})`;
}

function droppedPinName(area, lat, lng) {
  const district = String(area || "").replace(/\s+/g, " ").trim();
  if (district) return `Dropped pin near ${district}`.slice(0, 80);
  return pinnedSpot(lat, lng);
}

function wherePayload(bag = state) {
  const where = bag.where;
  const typed = namedPlace(bag.whereQuery || where.place || "");
  const named = typed || (where.lat != null && where.lng != null ? droppedPinName(bag.whereArea, where.lat, where.lng) : "");
  if (where.mode === "here" && where.lat != null && where.lng != null) {
    return { place: namedPlace(where.place) || "near you", lat: where.lat, lng: where.lng, precise: false };
  }
  if ((where.mode === "place" || named) && (named || where.lat != null)) {
    return {
      place: named,
      lat: where.lat,
      lng: where.lng,
      precise: Boolean(where.precise && where.lat != null && where.lng != null),
    };
  }
  return { place: "", lat: null, lng: null, precise: false };
}

function whereBlock(bag = state) {
  const value = whereLabel(bag);
  const empty = whereIsEmpty(bag);
  return el("div", { class: "where sheet-group" }, [
    el("span", { class: "sheet-label", id: "where-label", text: "Where" }),
    el("div", { class: empty ? "where-field" : "where-field has-value" }, [
      el("button", {
        class: "where-row",
        type: "button",
        "aria-labelledby": "where-label",
        "aria-expanded": bag.whereOpen ? "true" : "false",
        onclick: () => {
          bag.whereOpen = !bag.whereOpen;
          if (!bag.whereOpen) bag.whereMap = false;
          render();
          if (bag.whereOpen) queueMicrotask(() => document.getElementById("where-query")?.focus());
        },
      }, [
        el("span", { class: empty ? "where-v is-placeholder" : "where-v", text: value }),
        icon("chevron"),
      ]),
      empty
        ? null
        : el("button", {
            class: "where-clear",
            type: "button",
            text: "Clear",
            onclick: (event) => {
              event.preventDefault();
              event.stopPropagation();
              clearWhereSelection(bag, bag.whereOpen);
            },
          }),
    ]),
    bag.whereOpen ? wherePicker(bag) : null,
  ]);
}

function wherePicker(bag = state) {
  return el("div", { class: "where-picker" }, [
    el("input", {
      id: "where-query",
      class: "sheet-control",
      type: "text",
      value: bag.whereQuery,
      placeholder: "Search for a place or paste a Maps link",
      maxlength: "2000",
      autocomplete: "off",
      enterkeyhint: "search",
      onbeforeinput: (event) => onWhereBeforeInput(bag, event),
      oninput: (event) => onWhereInput(bag, event),
    }),
    bag.whereHint ? el("p", { class: "where-hint", role: "status", text: bag.whereHint }) : null,
    !bag.whereHint && bag.whereSearching ? el("p", { class: "where-hint", text: "Searching…" }) : null,
    bag.whereResults.length
      ? el("div", { class: "where-results" }, bag.whereResults.map((hit) => el("button", {
          class: "where-hit",
          type: "button",
          onclick: () => chooseWhereHit(bag, hit),
        }, [
          el("span", { class: "where-hit-name", text: hit.name }),
          hitMeta(hit) ? el("span", { class: "where-hit-meta", text: hitMeta(hit) }) : null,
        ])))
      : null,
    el("button", {
      class: "where-action",
      type: "button",
      text: "Use my current location",
      onclick: () => { void useCurrentWhere(bag); },
    }),
    el("button", {
      class: "where-action",
      type: "button",
      text: bag.whereMap ? "Hide map" : "Pick on map",
      onclick: () => {
        bag.whereMap = !bag.whereMap;
        render();
      },
    }),
    bag.whereMap ? el("div", { id: "where-map", class: "where-map", "data-no-sheet-drag": "1" }) : null,
  ]);
}

function hitMeta(hit) {
  const distance = Number.isFinite(hit.distanceM) ? formatDistance(hit.distanceM) : "";
  return [distance, hit.address].filter(Boolean).join(" · ");
}

function searchOrigin() {
  if (state.viewerLocation) return state.viewerLocation;
  if (state.mapCenter) return state.mapCenter;
  return recentPlace();
}

function recentPlace() {
  for (const social of state.socials || []) {
    if (social.location) return social.location;
  }
  for (const plan of state.plans || []) {
    if (plan.location) return plan.location;
  }
  return null;
}

function chooseWhereHit(bag, hit) {
  bag.whereAutofill = false;
  bag.where = { mode: "place", place: hit.name, lat: hit.lat, lng: hit.lng, precise: true };
  bag.whereQuery = hit.name;
  bag.whereResults = [];
  bag.whereSearching = false;
  bag.whereHint = "";
  render();
}

function clearWhereSelection(bag, keepOpen) {
  if (typeof bag === "boolean") {
    keepOpen = bag;
    bag = state;
  }
  bag.whereAutofill = false;
  bag.where = emptyWhere();
  bag.whereQuery = "";
  bag.whereResults = [];
  bag.whereSearching = false;
  bag.whereHint = "";
  bag.whereMap = false;
  bag.whereOpen = Boolean(keepOpen);
  clearTimeout(whereTimer);
  render();
  paintSummary();
  if (keepOpen) queueMicrotask(() => document.getElementById("where-query")?.focus());
}

function swallowNextWhereInput() {
  skipWhereInput = true;
  queueMicrotask(() => { skipWhereInput = false; });
}

function onWhereBeforeInput(bag, event) {
  if (!bag.whereAutofill) return;
  const type = event.inputType || "";
  if (type.startsWith("delete")) {
    event.preventDefault();
    swallowNextWhereInput();
    clearWhereSelection(bag, true);
    return;
  }
  if (type.startsWith("insert") && typeof event.data === "string") {
    event.preventDefault();
    swallowNextWhereInput();
    commitTypedWhere(bag, event.data);
  }
}

function onWhereInput(bag, event) {
  if (skipWhereInput) {
    skipWhereInput = false;
    event.target.value = bag.whereQuery;
    const end = bag.whereQuery.length;
    try { event.target.setSelectionRange(end, end); } catch { /* the caret can stay */ }
    return;
  }
  if (bag.whereAutofill) {
    const next = event.target.value;
    const previous = bag.whereQuery;
    if (next.length < previous.length) {
      clearWhereSelection(bag, true);
      return;
    }
    if (next !== previous && next.startsWith(previous)) {
      commitTypedWhere(bag, next.slice(previous.length));
      return;
    }
    if (next !== previous) {
      commitTypedWhere(bag, next);
      return;
    }
  }
  applyWhereQuery(bag, event.target.value);
}

function commitTypedWhere(bag, text) {
  bag.whereAutofill = false;
  bag.where = {
    mode: text.trim() ? "place" : "none",
    place: text,
    lat: null,
    lng: null,
    precise: false,
  };
  bag.whereQuery = text;
  const input = document.getElementById("where-query");
  if (input) {
    input.value = text;
    const end = text.length;
    try { input.setSelectionRange(end, end); } catch { /* keep the caret where the field left it */ }
  }
  const label = document.querySelector(".where-v");
  if (label) {
    label.textContent = text.trim() || "Pick a place";
    label.classList.toggle("is-placeholder", !text.trim());
  }
  paintSummary();
  scheduleWhereSearch(bag);
}

function applyWhereQuery(bag, value) {
  const limited = limitWhereQuery(value);
  const input = document.getElementById("where-query");
  if (input && input.value !== limited) input.value = limited;
  bag.whereAutofill = false;
  bag.whereQuery = limited;
  const typed = limited.trim();
  bag.where.mode = typed ? "place" : "none";
  bag.where.place = typed;
  bag.where.lat = null;
  bag.where.lng = null;
  bag.where.precise = false;
  const label = document.querySelector(".where-v");
  if (label) {
    label.textContent = typed || "Pick a place";
    label.classList.toggle("is-placeholder", !typed);
  }
  paintSummary();
  scheduleWhereSearch(bag);
}

function rerenderWhere() {
  const input = document.activeElement?.id === "where-query" ? document.activeElement : null;
  const caret = input ? input.selectionStart : null;
  render();
  if (!input) return;
  queueMicrotask(() => {
    const next = document.getElementById("where-query");
    if (!next) return;
    next.focus();
    if (caret != null) {
      try { next.setSelectionRange(caret, caret); } catch { /* the field keeps its own caret */ }
    }
  });
}

function limitWhereQuery(value) {
  const text = String(value ?? "");
  const trimmed = text.trim();
  if (looksLikeUrl(trimmed)) return trimmed.slice(0, 2000);
  return text.slice(0, 80);
}

function searchQuery(value) {
  return limitWhereQuery(value).trim();
}

function scheduleWhereSearch(bag = state) {
  clearTimeout(whereTimer);
  const query = searchQuery(bag.whereQuery);
  const maps = isMapsLink(query);
  const hint = looksLikeUrl(query) && !maps ? URL_HINT : "";
  if ((bag.whereHint || "") !== hint) {
    bag.whereHint = hint;
    if (hint) bag.whereResults = [];
    rerenderWhere();
  }
  if (hint || (!maps && query.length < 2)) {
    bag.whereResults = [];
    bag.whereSearching = false;
    return;
  }
  whereTimer = setTimeout(() => {
    bag.whereSearching = true;
    const origin = searchOrigin();
    const near = origin && !maps ? `&lat=${encodeURIComponent(origin.lat)}&lng=${encodeURIComponent(origin.lng)}` : "";
    api(`/api/geocode?q=${encodeURIComponent(query)}${near}`).then((data) => {
      if (searchQuery(bag.whereQuery) !== query) return;
      bag.whereResults = data.results || [];
      bag.whereSearching = false;
      rerenderWhere();
    }).catch(() => {
      bag.whereSearching = false;
      bag.whereResults = [];
      rerenderWhere();
    });
  }, 400);
}

async function defaultCurrentWhere() {
  if (!navigator.geolocation || !navigator.permissions?.query) return;
  try {
    const status = await navigator.permissions.query({ name: "geolocation" });
    if (status.state !== "granted") return;
  } catch {
    return;
  }
  if (state.sheet === "free" && state.where.mode === "none") await useCurrentWhere(state);
}

async function useCurrentWhere(bag = state) {
  if (!navigator.geolocation) {
    state.error = "This browser can't share location. The rest still works.";
    render();
    scheduleErrorClear();
    return;
  }
  try {
    const pos = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: false,
        timeout: 8000,
        maximumAge: 0,
      });
    });
    state.viewerLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    bag.whereAutofill = true;
    bag.where = { mode: "here", place: "near you", lat: pos.coords.latitude, lng: pos.coords.longitude, precise: false };
    bag.whereQuery = "Current location";
    bag.whereResults = [];
    state.error = "";
    const keepFocus = document.activeElement?.id === "where-query";
    render();
    if (keepFocus) queueMicrotask(() => document.getElementById("where-query")?.focus());
    const named = await api(`/api/geocode?lat=${encodeURIComponent(pos.coords.latitude)}&lng=${encodeURIComponent(pos.coords.longitude)}`).catch(() => null);
    if (bag.where.mode === "here" && bag.where.lat === pos.coords.latitude && bag.whereAutofill) {
      const place = named?.place && !/^near you$/i.test(named.place) ? named.place : "near you";
      bag.where.place = place;
      bag.whereQuery = place === "near you" ? "Current location" : place;
      const stillFocused = document.activeElement?.id === "where-query";
      render();
      if (stillFocused) queueMicrotask(() => document.getElementById("where-query")?.focus());
    }
  } catch {
    state.error = "Location stayed off. Everything else still works.";
    render();
    scheduleErrorClear();
  }
}

function paintChosenPlace(name) {
  const bag = whereBag();
  bag.where.place = name;
  bag.whereQuery = name;
  bag.where.mode = "place";
  bag.whereAutofill = false;
  const label = document.querySelector(".where-v");
  const query = document.getElementById("where-query");
  if (label) {
    label.textContent = name;
    label.classList.remove("is-placeholder");
  }
  if (query && document.activeElement !== query) query.value = name;
  paintSummary();
  if (!label && !query) rerenderWhere();
}

function scheduleReverse(lat, lng, replace = false) {
  clearTimeout(reverseTimer);
  const stamp = {};
  reverseTimer = stamp;
  let finished = false;
  const bag = whereBag();
  const still = () => reverseTimer === stamp && bag.where.lat === lat && bag.where.lng === lng;
  const accept = (name, area) => {
    if (!still()) return;
    const current = bag.where.place;
    const open = !current || current === FINDING_PLACE || current === bag.whereFallback;
    if (!open) return;
    if (!replace && bag.whereQuery.trim() && bag.whereQuery !== FINDING_PLACE && current !== bag.whereFallback) return;
    if (area) bag.whereArea = area;
    bag.whereFallback = name.startsWith("Pinned spot (") || name.startsWith("Dropped pin near ") ? name : "";
    paintChosenPlace(name);
  };
  const giveUp = () => accept(droppedPinName(bag.whereArea, lat, lng), bag.whereArea);
  setTimeout(() => {
    if (!finished) giveUp();
  }, 4000);
  api(`/api/geocode?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}`).then((data) => {
    if (!still()) return;
    finished = true;
    const place = String(data?.place || "").trim();
    const area = String(data?.area || "").trim();
    if (place) accept(place, area);
    else accept(droppedPinName(area, lat, lng), area);
  }).catch((error) => {
    console.error("reverse geocode failed", error);
    finished = true;
    giveUp();
  });
}

function openNotification(note) {
  if (note.kind === "chat" && note.refId) {
    if (note.refId === "circle") void openChat({ kind: "circle" });
    else {
      const [kind, id] = note.refId.split(":");
      if ((kind === "social" || kind === "plan") && id) void openChat({ kind, id });
    }
    return;
  }
  const social = note.refId ? state.socials.find((item) => item.id === note.refId) : null;
  const plan = !social && note.refId ? state.plans.find((item) => item.id === note.refId) : null;
  const kind = social ? "social" : plan ? "plan" : "";
  const item = social || plan;
  if (item?.location) {
    showOnMap(kind, item.id);
    return;
  }
  if (item || note.kind === "social" || note.kind === "plan" || note.kind === "plan-reply" || note.kind === "reply" || note.kind === "join") {
    state.tab = "map";
    state.sheet = null;
    state.focusSocial = "";
  }
  render();
}

function clearDeepLinkQuery() {
  const url = new URL(location.href);
  if (!url.searchParams.has("social") && !url.searchParams.has("plan")) return;
  url.searchParams.delete("social");
  url.searchParams.delete("plan");
  const next = `${url.pathname}${url.search}${url.hash}` || "/";
  history.replaceState(history.state, "", next);
}

function consumeDeepLink() {
  if (!state.deepLink) return false;
  if (state.deepLink.kind === "chat") {
    const raw = state.deepLink.id;
    state.deepLink = null;
    if (raw === "circle") void openChat({ kind: "circle" });
    else {
      const [kind, id] = String(raw).split(":");
      if ((kind === "social" || kind === "plan") && id) void openChat({ kind, id });
    }
    return true;
  }
  const { kind, id } = state.deepLink;
  const list = kind === "plan" ? state.plans : state.socials;
  const item = list.find((entry) => entry.id === id);
  state.deepLink = null;
  clearDeepLinkQuery();
  if (!item) return false;
  if (item.location) {
    showOnMap(kind, item.id);
    return true;
  }
  state.tab = "map";
  state.sheet = null;
  return false;
}

function mapCard(pin) {
  const distance = state.viewerLocation ? formatDistance(haversine(state.viewerLocation, pin)) : "";
  const social = pin.kind === "social"
    ? state.socials.find((item) => item.id === pin.id) || { id: pin.id, startsAt: null, joined: [] }
    : null;
  const plan = pin.kind === "plan"
    ? state.plans.find((item) => item.id === pin.id) || { id: pin.id, joined: [] }
    : null;
  const tools = social?.creator ? eventTools("social", social) : plan?.creator ? eventTools("plan", plan) : null;
  return el("article", { class: "map-card" }, [
    el("div", { class: "map-card-head" }, [
      el("strong", { text: pin.title }),
      tools,
    ]),
    el("p", { text: pin.note }),
    el("p", { class: "map-card-time", text: distance ? `${pin.time} · ${distance}` : pin.time }),
    plan ? planDescription(plan) : null,
    social && !pin.own ? replySummary(social) : null,
    social && !pin.own ? removedNote(social) || replyActions(social) : null,
    plan && !pin.own ? planPinActions(plan) : null,
    el("div", { class: "map-card-actions" }, [
      mapsLink(pin.lat, pin.lng, pin.note, "Open in Maps"),
    ]),
  ]);
}

function planReplyLine(person) {
  const mine = person.id === state.me.user.id;
  const arriving = arriveClock(person);
  if (person.reply === "declined") return mine ? "You can't make it" : `${person.name} can't`;
  if (arriving) return mine ? "You're in" : `${person.name} is in, arriving ${arriving}`;
  return mine ? "You're in" : `${person.name} is in`;
}

function planReplySummary(plan) {
  const people = plan.joined.filter((person) => person.reply === "declined" || inReply(person));
  if (!people.length) return el("p", { text: "Waiting for friends" });
  return el("div", {}, people.map((person) => guestLine(planReplyLine(person), person, "plan", plan)));
}

function canRemoveGuest(event) {
  return Boolean(event?.creator) && (event.creator.id === state.me.user.id || youAreAdmin());
}

function guestLine(text, person, kind, event) {
  const line = el("p", { class: "reply-line", text });
  if (!canRemoveGuest(event) || !inReply(person) || person.id === state.me.user.id) return line;
  return el("div", { class: "guest-row" }, [
    line,
    el("button", {
      class: "text-btn",
      type: "button",
      text: "Remove",
      "aria-label": `Remove ${person.name}`,
      onclick: () => confirmRemoveGuest(kind, event, person),
    }),
  ]);
}

function confirmRemoveGuest(kind, event, person) {
  const label = (event.note || "").trim() || (kind === "plan" ? "the plan" : "Free now");
  state.confirm = {
    title: `Remove ${person.name}?`,
    body: `They can't join ${label} again.`,
    confirmLabel: "Remove",
    action: async () => {
      await run(async () => {
        await api(`/api/${kind}s/${event.id}/people/${person.id}`, { method: "DELETE" });
        await refresh({ initial: true });
      });
    },
  };
  render();
}

function planReplyButtons(plan) {
  return replyControls("plan", plan);
}

function removedNote(item) {
  if (!item?.removedBy) return null;
  return el("p", { class: "removed-note", text: `${item.removedBy} removed you from this.` });
}

function planPinActions(plan) {
  if (plan.removedBy) return removedNote(plan);
  const mine = plan.joined.find((person) => person.id === state.me.user.id);
  return el("div", {}, [
    mine && (mine.reply === "declined" || inReply(mine))
      ? el("p", { class: "reply-line", text: planReplyLine(mine) })
      : null,
    planReplyButtons(plan),
  ]);
}

function shareToggle(label) {
  return el("label", { class: "share-toggle" }, [
    el("input", {
      type: "checkbox",
      checked: state.shareLocation,
      onchange: (event) => {
        state.shareLocation = event.target.checked;
        localStorage.setItem(SHARE_KEY, state.shareLocation ? "1" : "0");
      },
    }),
    el("span", { text: label }),
  ]);
}

async function sharedPoint() {
  if (!state.shareLocation) return { lat: null, lng: null };
  if (!navigator.geolocation) {
    state.error = "This browser can't share location. The rest still works.";
    return { lat: null, lng: null };
  }
  try {
    const pos = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: false,
        timeout: 8000,
        maximumAge: 0,
      });
    });
    state.viewerLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    return state.viewerLocation;
  } catch {
    state.error = "Location stayed off. Everything else still works.";
    return { lat: null, lng: null };
  }
}

function rememberViewerLocation() {
  if (!navigator.geolocation || !navigator.permissions?.query) return;
  navigator.permissions.query({ name: "geolocation" }).then((status) => {
    if (status.state !== "granted") return;
    navigator.geolocation.getCurrentPosition((pos) => {
      state.viewerLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      if (state.tab === "home" || state.tab === "map") render();
    }, () => {}, { enableHighAccuracy: false, maximumAge: 60000, timeout: 8000 });
  }).catch(() => {});
}

function placeLine(location, placeName, target) {
  const named = audiencePlace(placeName);
  if (!location && !named) return null;
  const distance = location && state.viewerLocation
    ? formatDistance(haversine(state.viewerLocation, location))
    : "";
  const where = named || "nearby";
  const text = distance ? `${where} · ${distance}` : where;
  if (!location || !target) return el("p", { class: "place-line static", text });
  return el("button", {
    class: "place-line",
    type: "button",
    "aria-label": `Show ${text} on the map`,
    onclick: () => showOnMap(target.kind, target.id),
  }, [
    el("span", { class: "place-pin", "aria-hidden": "true" }),
    el("span", { text }),
  ]);
}

function showOnMap(kind, id) {
  const url = new URL(location.href);
  url.searchParams.delete("social");
  url.searchParams.delete("plan");
  const clean = `${url.pathname}${url.search}${url.hash}` || "/";
  if (`${location.pathname}${location.search}${location.hash}` !== clean) {
    history.replaceState(history.state, "", clean);
  }
  if (state.tab !== "map") {
    state.mapReturnTab = state.tab;
    if (!state.mapHistory) {
      history.pushState({ hangryMap: 1 }, "", clean);
      state.mapHistory = true;
    }
  }
  state.focusPin = `${kind}:${id}`;
  state.tab = "map";
  state.sheet = null;
  render();
}

function mapsLink(lat, lng, label, text) {
  return el("a", {
    class: "map-link",
    href: mapsHref(lat, lng, label),
    target: mapsExternal() ? "_blank" : null,
    rel: mapsExternal() ? "noreferrer" : null,
    text,
  });
}

function mapsExternal() {
  return !/android/i.test(navigator.userAgent);
}

function mapsHref(lat, lng, label) {
  const name = encodeURIComponent(label || "Hangry");
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (ios) return `https://maps.apple.com/?ll=${lat},${lng}&q=${name}`;
  if (/android/i.test(navigator.userAgent)) return `geo:${lat},${lng}?q=${lat},${lng}(${name})`;
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}

function field(label, id, value, onValue, attrs = {}) {
  return el("label", { class: "field" }, [
    el("span", { text: label }),
    el("input", {
      id,
      type: "text",
      value,
      autocomplete: "off",
      ...attrs,
      oninput: (event) => onValue(event.target.value),
    }),
  ]);
}

function icon(name) {
  const node = el("span", { class: "icon" });
  node.innerHTML = ICONS[name];
  return node;
}

function avatar(person, size = 28, extra = "") {
  const node = el("span", {
    class: `avatar ${extra}`.trim(),
    text: initial(person.name),
    style: `background:${colorFor(person)}`,
  });
  if (size !== 28) {
    node.style.width = `${size}px`;
    node.style.height = `${size}px`;
  }
  return node;
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = String(value);
    else if (key === "style") node.setAttribute("style", value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (key === "disabled") node.disabled = Boolean(value);
    else if (key === "checked") node.checked = Boolean(value);
    else node.setAttribute(key, String(value));
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function openSheet(name) {
  state.sheet = name;
  state.error = "";
  if (name === "free") {
    state.noteDraft = mySocial()?.note ?? "";
    state.where = whereFromSocial(mySocial());
    state.whereQuery = state.where.place;
    state.whereAutofill = false;
    state.whereOpen = false;
    state.whereResults = [];
    state.whereSearching = false;
    state.whereHint = "";
    state.whereMap = false;
    const mine = mySocial();
    const upcoming = mine?.startsAt && mine.startsAt > Date.now();
    state.whenMode = upcoming ? "later" : "now";
    state.startChoice = upcoming ? clock(mine.startsAt) : "";
  }
  if (name === "plan") {
    state.noteDraft = "";
    state.placeDraft = "";
    state.planTime = "";
    state.planDay = "tomorrow";
    state.planDate = "";
    state.planWhere = emptyWhereSession();
  }
  state.focusSheet = false;
  render();
  if (name === "free" && state.where.mode === "none") void defaultCurrentWhere();
}

function closeSheet() {
  if (state.sheet === "feedback" && state.feedbackSent) resetFeedback();
  if (state.sheet === "whats-new") state.whatsNewView = null;
  state.sheet = null;
  state.whereMap = false;
  if (state.planWhere) state.planWhere.whereMap = false;
  if (state.adminEdit) state.adminEdit.whereMap = false;
  destroyWhereMap();
  render();
}

function sheetIsOpen() {
  return Boolean(state.sheet || state.confirm || state.onboarding || state.installSheet || state.installOpen);
}

function dismissTopSheet() {
  if (state.confirm) {
    state.confirm = null;
    render();
    return;
  }
  if (state.installOpen) {
    state.installOpen = false;
    render();
    return;
  }
  // Onboarding waits behind an open sheet (see view), so the sheet on screen closes first.
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
  if (state.sheet) closeSheet();
}

function syncSheetHistory() {
  const open = sheetIsOpen();
  if (open && !sheetHistoryPushed) {
    history.pushState({ hangrySheet: 1 }, "");
    sheetHistoryPushed = true;
    return;
  }
  if (!open && sheetHistoryPushed && !closingFromPop) {
    sheetHistoryPushed = false;
    ignoreSheetPop = true;
    history.back();
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

function bindSheetSwipe() {
  document.querySelectorAll(".sheet, .guide").forEach((panel) => {
    let tracking = false;
    let dragging = false;
    let startY = 0;
    let drag = 0;
    let pointerId = -1;
    let startedAtTop = false;
    const headerHit = (event) => Boolean(event.target.closest(".sheet-head, .grabber"));
    const handsOff = (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return true;
      if (target.closest("input, textarea, select, button, a, .leaflet-container, .leaflet-marker-icon, .leaflet-marker-pane, .pin, [data-no-sheet-drag]")) return true;
      return Boolean(horizontalScroller(target));
    };
    const place = () => {
      const shift = `translateY(${drag}px)`;
      panel.style.transform = panel.classList.contains("guide") ? shift : `translateX(-50%) ${shift}`;
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
      if (header) {
        panel.classList.add("dragging");
        panel.setPointerCapture?.(event.pointerId);
      }
    });
    panel.addEventListener("pointermove", (event) => {
      if (!tracking || event.pointerId !== pointerId) return;
      const dy = event.clientY - startY;
      if (!dragging) {
        if (!startedAtTop || dy < -4) {
          tracking = false;
          return;
        }
        if (dy < 8) return;
        dragging = true;
        panel.classList.add("dragging");
        panel.setPointerCapture?.(event.pointerId);
      }
      drag = Math.max(0, dy);
      place();
    });
    const finish = (event) => {
      if (!tracking || (event.pointerId != null && event.pointerId !== pointerId)) return;
      tracking = false;
      dragging = false;
      panel.classList.remove("dragging");
      panel.style.transform = "";
      if (drag > 72) dismissTopSheet();
    };
    panel.addEventListener("pointerup", finish);
    panel.addEventListener("pointercancel", finish);
    panel.addEventListener("touchmove", (event) => {
      if (!tracking || !event.touches.length) return;
      const dy = event.touches[0].clientY - startY;
      if (dy > 0 && (headerHit(event) || startedAtTop)) event.preventDefault();
    }, { passive: false });
  });
}

window.addEventListener("popstate", () => {
  if (ignoreSheetPop) {
    ignoreSheetPop = false;
    return;
  }
  if (sheetIsOpen()) {
    sheetHistoryPushed = false;
    closingFromPop = true;
    dismissTopSheet();
    closingFromPop = false;
    return;
  }
  sheetHistoryPushed = false;
  if (state.mapHistory) {
    state.mapHistory = false;
    state.tab = state.mapReturnTab || "home";
    state.focusPin = "";
    render();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !sheetIsOpen()) return;
  event.preventDefault();
  dismissTopSheet();
});

async function onTab(id) {
  if (id === "chat") {
    state.sheet = null;
    await openChat({ kind: "circle" });
    return;
  }
  state.tab = id;
  state.sheet = null;
  if (id === "alerts") {
    render();
    try {
      await api("/api/notifications/read", { method: "POST", body: {} });
      const readAt = Date.now();
      state.notifications = state.notifications.map((note) => ({ ...note, readAt: note.readAt ?? readAt }));
    } catch (error) {
      state.error = error.message;
    }
  }
  render();
}

function circleNameSheet() {
  return el("div", {}, [
    el("button", { class: "scrim", type: "button", "aria-label": "Close", onclick: closeSheet }),
    el("form", { class: "sheet", role: "dialog", "aria-label": "New circle", onsubmit: onCreateAnother }, [
      el("div", { class: "sheet-head" }, [
        el("div", { class: "grabber" }),
        el("h2", { text: "New circle" }),
      ]),
      el("div", { class: "sheet-scroll" }, [
        field("Circle name", "new-circle-name", state.newCircleName, (value) => {
          state.newCircleName = value;
        }, { maxlength: "32" }),
      ]),
      el("div", { class: "sheet-dock" }, [
        el("button", { class: "btn", type: "submit", text: "Create circle" }),
      ]),
    ]),
  ]);
}

function joinLinkSheet() {
  return el("div", {}, [
    el("button", { class: "scrim", type: "button", "aria-label": "Close", onclick: closeSheet }),
    el("form", { class: "sheet", role: "dialog", "aria-label": "Join with link", onsubmit: onJoinCircle }, [
      el("div", { class: "sheet-head" }, [
        el("div", { class: "grabber" }),
        el("h2", { text: "Join with link" }),
      ]),
      el("div", { class: "sheet-scroll" }, [
        field("Invite code", "invite-code", state.codeDraft, (value) => {
          state.codeDraft = value.toUpperCase();
        }, { maxlength: "12", autocapitalize: "characters", spellcheck: "false" }),
      ]),
      el("div", { class: "sheet-dock" }, [
        el("button", { class: "btn", type: "submit", text: "Join circle" }),
      ]),
    ]),
  ]);
}

async function onCreateAnother(event) {
  event.preventDefault();
  await run(async () => {
    const created = await api("/api/circles", { method: "POST", body: { name: state.newCircleName || "friends" } });
    rememberCircle(created.circle.id);
    state.sheet = null;
    state.me = await api("/api/me");
    await refresh({ initial: true });
  });
}

async function onStart(event) {
  event.preventDefault();
  state.error = "";
  try {
    const data = await api("/api/auth/start", {
      method: "POST",
      body: { name: state.nameDraft, code: state.pendingCode || undefined },
      token: null,
    });
    localStorage.setItem(TOKEN_KEY, data.token);
    state.token = data.token;
    // Someone new has nothing to catch up on. Everything up to today counts as seen.
    await markNewAccountSeen();
    if (data.circle) rememberCircle(data.circle.id);
    state.me = await api("/api/me");
    if (data.circle) {
      history.replaceState(null, "", "/");
      state.pendingCode = "";
    } else if (state.pendingCode) {
      try {
        const joined = await api("/api/circles/join", { method: "POST", body: { code: state.pendingCode } });
        rememberCircle(joined.circle.id);
        state.me = await api("/api/me");
        history.replaceState(null, "", "/");
        state.pendingCode = "";
      } catch (error) {
        state.codeDraft = state.pendingCode;
        state.error = error.message;
      }
    }
    state.pushSnooze = false;
    if (!state.me.circle) useNamedCircleDefault();
    render();
    reportDisplay();
    refresh({ initial: true }).catch(() => {});
    void considerReminders();
  } catch (error) {
    state.error = error.message;
    render();
  }
}

async function onRecover(event) {
  event.preventDefault();
  state.error = "";
  try {
    const data = await api("/api/auth/recover", { method: "POST", body: { token: state.codeDraft.trim() }, token: null });
    localStorage.setItem(TOKEN_KEY, data.token);
    state.token = data.token;
    state.sheet = null;
    state.me = await api("/api/me");
    state.pushSnooze = false;
    render();
    reportDisplay();
    refresh({ initial: true }).catch(() => {});
    void considerReminders();
  } catch (error) {
    state.error = error.message;
    render();
  }
}

async function onCreateCircle(event) {
  event.preventDefault();
  await run(async () => {
    const created = await api("/api/circles", { method: "POST", body: { name: state.circleDraft || "friends" } });
    rememberCircle(created.circle.id);
    state.me = await api("/api/me");
  });
  void considerReminders();
}

async function onJoinCircle(event) {
  event.preventDefault();
  await run(async () => {
    const joined = await api("/api/circles/join", { method: "POST", body: { code: state.codeDraft } });
    rememberCircle(joined.circle.id);
    state.sheet = null;
    state.me = await api("/api/me");
    if (state.pendingCode) history.replaceState(null, "", "/");
    await refresh({ initial: true });
  });
  void considerReminders();
}

async function onFree(event) {
  event.preventDefault();
  if (state.whenMode === "later" && !isLaterToday(state.startChoice, Date.now(), state.meta?.tz || "Europe/Berlin")) {
    state.error = TIME_LATER_ERROR;
    render();
    return;
  }
  await run(async () => {
    await api("/api/socials", { method: "POST", body: { note: state.noteDraft, ...wherePayload(), ...startPayload() } });
    state.sheet = null;
    state.whereMap = false;
    await refresh({ initial: true });
  });
}

async function onCreatePlan(event) {
  event.preventDefault();
  const picked = wherePayload(state.planWhere);
  const nothing = !picked.place && picked.lat == null && picked.lng == null;
  let place = picked.place;
  let lat = picked.lat;
  let lng = picked.lng;
  let precise = picked.precise;
  if (nothing && state.shareLocation) {
    const shared = await sharedPoint();
    lat = shared.lat ?? null;
    lng = shared.lng ?? null;
    precise = false;
    place = "";
  }
  const time = document.getElementById("plan-time")?.value || state.planTime || null;
  const date = chosenPlanDay();
  if (!date) {
    state.error = PICK_DATE_ERROR;
    render();
    return;
  }
  const locationNote = state.error;
  if (locationNote) render();
  await run(async () => {
    await api("/api/plans", { method: "POST", body: { note: state.noteDraft, place, lat, lng, precise, time, date } });
    state.sheet = null;
    state.placeDraft = "";
    state.planTime = "";
    state.planDay = "tomorrow";
    state.planDate = "";
    state.planWhere = emptyWhereSession();
    state.error = locationNote;
    await refresh({ initial: true });
  }, locationNote);
}

async function joinSocial(social) {
  await run(async () => {
    await api(`/api/socials/${social.id}/join`, { method: "POST", body: {} });
    await refresh({ initial: true });
  });
}

async function endSocial(social) {
  if (!social) return;
  state.confirm = {
    title: "End this?",
    body: "Friends will no longer see you as free.",
    confirmLabel: "End",
    action: async () => {
      await run(async () => {
        await api(`/api/socials/${social.id}`, { method: "DELETE" });
        state.sheet = null;
        await refresh({ initial: true });
      });
    },
  };
  render();
}

function confirmActions(nodes) {
  const kids = [];
  for (const node of nodes) {
    if (!node) continue;
    if (kids.length) kids.push(el("div", { class: "sheet-gap" }));
    kids.push(node);
  }
  return el("div", { class: "stack" }, kids);
}

function liftSheetToast() {
  const toast = document.querySelector(".toast");
  if (!(toast instanceof HTMLElement)) return;
  const action = document.querySelector(".sheet-dock .btn");
  if (!(action instanceof HTMLElement)) {
    toast.style.bottom = "";
    return;
  }
  const origin = window.visualViewport?.offsetTop ?? 0;
  const top = action.getBoundingClientRect().top + origin;
  toast.style.bottom = `${Math.ceil(window.innerHeight - top + 12)}px`;
}

function confirmSheet() {
  const pending = state.confirm;
  if (!pending) return el("div");
  return el("div", {}, [
    el("button", {
      class: "scrim",
      type: "button",
      "aria-label": "Cancel",
      onclick: () => {
        state.confirm = null;
        render();
      },
    }),
    el("div", { class: "sheet sheet-confirm", role: "dialog", "aria-modal": "true", "aria-label": pending.title }, [
      el("div", { class: "sheet-head" }, [
        el("div", { class: "grabber" }),
        el("h2", { text: pending.title }),
      ]),
      el("p", { class: "help sheet-body", text: pending.body }),
      pending.copy ? el("p", { class: "code-block", text: pending.copy }) : null,
      confirmActions([
        pending.copy
          ? el("button", {
              class: "btn secondary",
              type: "button",
              text: "Copy",
              onclick: () => copyText(pending.copy, "Recovery code copied"),
            })
          : null,
        el("button", {
          class: "btn danger",
          type: "button",
          text: pending.confirmLabel,
          onclick: () => {
            const action = pending.action;
            state.confirm = null;
            render();
            void action();
          },
        }),
        el("button", {
          class: "btn ghost",
          type: "button",
          text: "Cancel",
          onclick: () => {
            state.confirm = null;
            render();
          },
        }),
      ]),
    ]),
  ]);
}

async function deletePlan(plan) {
  if (!window.confirm("Delete this plan?")) return;
  await run(async () => {
    await api(`/api/plans/${plan.id}`, { method: "DELETE" });
    await refresh({ initial: true });
  });
}

async function onRename(event) {
  event.preventDefault();
  const input = document.getElementById("rename");
  await run(async () => {
    state.me = await api("/api/me", { method: "PATCH", body: { name: input.value } });
    state.error = "Name saved";
  });
}

async function onRenameCircle(event) {
  event.preventDefault();
  const input = document.getElementById("circle-rename");
  await run(async () => {
    const data = await api("/api/circles", { method: "PATCH", body: { name: input.value } });
    state.me = { ...state.me, circle: data.circle };
    state.error = "Circle name saved";
  });
}

async function onEnablePush() {
  if (!state.meta?.vapidPublicKey) {
    state.error = "Push needs VAPID keys";
    render();
    scheduleErrorClear();
    return;
  }
  state.pushBusy = true;
  render();
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error("Notification permission was not granted");
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToUint8(state.meta.vapidPublicKey),
    });
    const json = subscription.toJSON();
    await api("/api/push/subscribe", {
      method: "POST",
      body: { endpoint: json.endpoint, keys: json.keys },
    });
    state.error = "Notifications are on";
    state.pushReminder = null;
  } catch (error) {
    state.error = error.message || "Could not enable notifications";
  } finally {
    state.pushBusy = false;
    render();
    scheduleErrorClear();
  }
  void considerReminders();
}

async function onTestPush() {
  await run(async () => {
    const result = await api("/api/push/test", { method: "POST", body: {} });
    await refresh({ initial: true });
    state.error = pushTestMessage(result?.subscriptions);
  });
}

function openedInstalledApp() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function reportDisplay() {
  if (!state.token || state.displayReported) return;
  state.displayReported = true;
  api("/api/me/display", { method: "POST", body: { standalone: openedInstalledApp() } }).catch(() => {
    state.displayReported = false;
  });
}

function isInstalled() {
  if (localStorage.getItem(INSTALLED_KEY) === "1") return true;
  return window.matchMedia("(display-mode: standalone)").matches
    || window.matchMedia("(display-mode: fullscreen)").matches
    || window.navigator.standalone === true;
}

function installDue() {
  return installReminderDue(localStorage.getItem(INSTALL_LATER_KEY), Date.now());
}

async function devicePushOn() {
  if (!state.meta?.vapidPublicKey) return false;
  if (!("Notification" in window) || Notification.permission !== "granted") return false;
  const endpoint = await localSubscriptionEndpoint();
  if (!endpoint) return false;
  try {
    const status = await api("/api/push/status", { method: "POST", body: { endpoint } });
    return Boolean(status?.known);
  } catch {
    return false;
  }
}

async function considerReminders() {
  if (!state.token || !state.me || !state.me.circle) {
    state.onboarding = false;
    state.pushOn = false;
    state.installSheet = false;
    state.pushReminder = null;
    render();
    return;
  }
  state.pushOn = await devicePushOn();
  const prompt = installPrompt(currentSignals(), { canPrompt: Boolean(state.installEvent) });
  const due = reminderDue();
  const denied = "Notification" in window && Notification.permission === "denied";
  const wantInstall = due && !isInstalled() && installDue() && !prompt.quiet && !denied;
  const wantPush = due && !state.pushOn && !denied;
  const wantDenied = due && denied;
  state.onboarding = wantInstall || wantPush || wantDenied;
  state.installSheet = false;
  state.pushReminder = null;
  render();
}

function reminderDue() {
  const at = Number(localStorage.getItem(INSTALL_LATER_KEY) || 0);
  if (!at) return true;
  return Date.now() - at >= 3 * 24 * 60 * 60 * 1000;
}

function reenableSteps() {
  const firefox = /firefox|fennec/i.test(navigator.userAgent);
  if (firefox) {
    return [
      "Open the Firefox menu",
      "Settings → Site permissions → Notifications",
      "Allow Hangry",
    ];
  }
  return [
    "Open the Chrome menu",
    "Settings → Site settings → Notifications",
    "Allow Hangry",
  ];
}

function dismissOnboarding() {
  state.pushSnooze = true;
  localStorage.setItem(INSTALL_LATER_KEY, String(Date.now()));
  state.onboarding = false;
  render();
}

function onboardingSheet() {
  const prompt = installPrompt(currentSignals(), { canPrompt: Boolean(state.installEvent) });
  const denied = "Notification" in window && Notification.permission === "denied";
  const showInstall = !denied && !isInstalled() && !prompt.quiet;
  const showPush = !denied && !state.pushOn;
  const actions = [];
  if (showPush) {
    actions.push(el("button", {
      class: "btn",
      type: "button",
      text: state.pushBusy ? "Waiting…" : "Turn on notifications",
      disabled: state.pushBusy,
      onclick: () => { void onEnablePush(); },
    }));
  }
  if (showInstall && prompt.offerInstall) {
    actions.push(el("button", { class: "btn secondary", type: "button", text: "Add to home screen", onclick: () => { void onInstall(); } }));
  }
  actions.push(el("button", { class: "btn ghost", type: "button", text: "Not now", onclick: dismissOnboarding }));
  return el("div", {}, [
    el("button", { class: "scrim", type: "button", "aria-label": "Not now", onclick: dismissOnboarding }),
    el("div", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": "Get started" }, [
      el("div", { class: "sheet-head" }, [
        el("div", { class: "grabber" }),
        el("h2", { text: denied ? "Notifications are blocked" : showPush ? "Turn on notifications" : "Add to home screen" }),
        el("p", {
          class: "help",
          text: denied
            ? "Hangry can't ask again until notifications are allowed in the browser."
            : showPush
              ? "So a friend can reach this phone. Adding Hangry to your home screen keeps it one tap away."
              : "Add Hangry to your home screen so it stays one tap away.",
        }),
      ]),
      denied
        ? el("ol", { class: "guide-reenable" }, reenableSteps().map((line) => el("li", { text: line })))
        : showInstall && prompt.steps.length
          ? el("ol", { class: "guide-reenable" }, prompt.steps.map((line) => el("li", { text: line })))
          : null,
      el("div", { class: "stack" }, actions),
    ]),
  ]);
}

function localSubscriptionEndpoint() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return Promise.resolve("");
  const ready = navigator.serviceWorker.ready.then((registration) => registration.pushManager.getSubscription());
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 1500));
  return Promise.race([ready, timeout]).then((subscription) => subscription?.endpoint || "").catch(() => "");
}

function pushReminderSheet() {
  const reminder = state.pushReminder;
  if (!reminder) return el("div");
  const snooze = () => {
    state.pushSnooze = true;
    render();
  };
  const actions = [];
  if (reminder.kind === "enable") {
    actions.push(el("button", {
      class: "btn",
      type: "button",
      text: state.pushBusy ? "Waiting…" : "Turn on notifications",
      disabled: state.pushBusy,
      onclick: () => onEnablePush(),
    }));
  } else if (reminder.kind === "guide") {
    actions.push(el("button", {
      class: "btn",
      type: "button",
      text: "Open the install guide",
      onclick: openInstallGuide,
    }));
  }
  actions.push(el("button", { class: "btn ghost", type: "button", text: "Not now", onclick: snooze }));
  return el("div", {}, [
    el("button", { class: "scrim", type: "button", "aria-label": "Not now", onclick: snooze }),
    el("div", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": reminder.title }, [
      el("div", { class: "sheet-head" }, [
        el("div", { class: "grabber" }),
        el("h2", { text: reminder.title }),
        el("p", { class: "help", text: reminder.lede }),
      ]),
      reminder.steps?.length
        ? el("ol", { class: "guide-reenable" }, reminder.steps.map((line) => el("li", { text: line })))
        : null,
      el("div", { class: "stack" }, actions),
    ]),
  ]);
}

async function onInstall() {
  if (!state.installEvent) return;
  state.installEvent.prompt();
  const choice = await state.installEvent.userChoice;
  state.installEvent = null;
  if (choice?.outcome === "accepted") {
    localStorage.setItem(INSTALLED_KEY, "1");
    state.installSheet = false;
  }
  render();
  void considerReminders();
}

function showInstallPill() {
  const prompt = installPrompt(currentSignals(), { canPrompt: false });
  return Boolean(state.me?.circle) && !state.pushOn && !isInstalled() && !state.installPillHidden && !prompt.quiet;
}

function installPill() {
  return el("div", { class: "install-pill" }, [
    el("button", {
      class: "text",
      type: "button",
      text: "Add to home screen",
      onclick: () => {
        state.onboarding = true;
        render();
      },
    }),
    el("button", {
      class: "ios-dismiss",
      type: "button",
      "aria-label": "Hide install reminder",
      text: "×",
      onclick: () => {
        state.installPillHidden = true;
        render();
      },
    }),
  ]);
}

function dismissInstallSheet() {
  localStorage.setItem(INSTALL_LATER_KEY, String(Date.now()));
  state.installSheet = false;
  render();
  void considerReminders();
}

function installSheetView() {
  const prompt = installPrompt(currentSignals(), { canPrompt: Boolean(state.installEvent) });
  const actions = [];
  if (prompt.offerInstall) {
    actions.push(el("button", { class: "btn", type: "button", text: "Install app", onclick: () => onInstall() }));
  }
  if (prompt.copyLink) {
    actions.push(el("button", {
      class: "btn",
      type: "button",
      text: "Copy link",
      onclick: () => copyText(location.href, "Link copied. Open it in Chrome."),
    }));
  }
  actions.push(el("button", { class: "btn ghost", type: "button", text: "Not now", onclick: dismissInstallSheet }));
  return el("div", {}, [
    el("button", { class: "scrim", type: "button", "aria-label": "Not now", onclick: dismissInstallSheet }),
    el("div", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": prompt.title }, [
      el("div", { class: "sheet-head" }, [
        el("div", { class: "grabber" }),
        el("h2", { text: prompt.title }),
        el("p", { class: "help", text: prompt.lede }),
      ]),
      prompt.steps.length
        ? el("ol", { class: "guide-reenable" }, prompt.steps.map((line) => el("li", { text: line })))
        : null,
      el("div", { class: "stack" }, actions),
    ]),
  ]);
}

async function onRotateBuzz() {
  state.confirm = {
    title: "New secret?",
    body: "The old buzzer and recovery code will stop working.",
    confirmLabel: "Regenerate",
    action: async () => {
      await run(async () => {
        const data = await api("/api/me/buzz-token", { method: "POST", body: {} });
        state.me = { ...state.me, user: { ...state.me.user, buzzToken: data.buzzToken } };
        state.error = "New secret ready";
      });
    },
  };
  render();
}

function onDeleteCircle() {
  const circle = state.me?.circle;
  if (!circle || !youAreAdmin()) return;
  state.confirm = {
    title: `Delete ${circle.name}?`,
    body: "This can't be undone. Members, posts, plans, and chats in this circle are removed.",
    confirmLabel: "Delete circle",
    action: async () => {
      await run(async () => {
        state.me = await api("/api/circles", { method: "DELETE" });
        rememberCircle("");
        adoptCircle(state.me);
        state.tab = "home";
        state.chat = null;
        state.chatThread = null;
        state.socials = [];
        state.plans = [];
        state.notifications = [];
        state.past = false;
        state.pastDays = null;
        state.sheet = null;
        state.signature = "";
        if (!state.me.circle) useNamedCircleDefault();
        if (state.me.circle) await refresh({ initial: true });
      });
    },
  };
  render();
}

async function onLeave() {
  if (!window.confirm("Leave this circle?")) return;
  await run(async () => {
    state.me = await api("/api/circles/leave", { method: "POST", body: {} });
    rememberCircle(state.me.circle?.id || "");
    state.tab = "home";
    state.socials = [];
    state.plans = [];
    state.notifications = [];
    if (state.me.circle) await refresh({ initial: true });
  });
}

function onLogout() {
  const code = state.me?.user?.buzzToken || "";
  state.confirm = {
    title: "Sign out?",
    body: "You'll need this recovery code to get back in.",
    confirmLabel: "Sign out",
    copy: code,
    action: async () => {
      try {
        await api("/api/auth/logout", { method: "POST", body: {} });
      } catch {
        /* still drop the local session */
      }
      clearSession();
      state.tab = "home";
      state.sheet = null;
      state.onboarding = false;
      render();
    },
  };
  render();
}

async function run(fn, keepError = "") {
  state.error = keepError;
  try {
    await fn();
  } catch (error) {
    if (isNetworkFailure(error) || error.status >= 500) {
      noteConnectionProblem(error);
      scheduleOfflineRetry(1000);
      state.error = isNetworkFailure(error) ? "You're offline. Try again." : "Something went wrong. Try again.";
    } else {
      state.error = error.message || "Something went wrong. Try again.";
    }
  }
  render();
  scheduleErrorClear();
}

function scheduleErrorClear() {
  const message = state.error;
  if (!message) return;
  clearTimeout(state.errorTimer);
  state.errorTimer = setTimeout(() => {
    if (state.error === message) {
      state.error = "";
      render();
    }
  }, 3200);
}

async function copyText(value, message) {
  try {
    await navigator.clipboard.writeText(value);
    state.error = message;
  } catch {
    state.error = value;
  }
  render();
  setTimeout(() => {
    if (state.error === message) {
      state.error = "";
      render();
    }
  }, 2200);
}

function mySocial() {
  return state.socials.find((social) => social.creator.id === state.me?.user.id) ?? null;
}

function remaining(expiresAt) {
  const minutes = Math.max(0, Math.round((expiresAt - Date.now()) / 60000));
  if (minutes < 1) return "ending";
  if (minutes < 60) return `${minutes}m left`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m left`;
}

function ago(ts) {
  const seconds = Math.max(0, (Date.now() - Number(ts || 0)) / 1000);
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} d ago`;
}

function ttlLabel(ms) {
  const hours = ms / 3600000;
  if (Math.abs(hours - 2) < 0.05) return "about 2 hours";
  if (hours >= 1) return `about ${Math.round(hours)} hours`;
  return `about ${Math.round(ms / 60000)} minutes`;
}

function bgFor(id) {
  let hash = 0;
  for (const char of id) hash = (hash + char.charCodeAt(0)) % BACKGROUNDS.length;
  return BACKGROUNDS[hash];
}

/** The server picks one color per person and sends it with every user it lists. */
function colorFor(person) {
  return person?.color || "#636366";
}

function initial(name) {
  const char = Array.from(name || "?")[0] || "?";
  return char.toUpperCase();
}

function base64UrlToUint8(base64Url) {
  const padded = `${base64Url}${"=".repeat((4 - (base64Url.length % 4)) % 4)}`.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
