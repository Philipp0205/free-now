import { installGuide, installPrompt, installReminderDue, joinInstallStep, needsInstallForPush, pushReminder, pushTestMessage, readInstallSignals } from "./install-guide.js";
import { FIELD_REVEAL_MS, KEYBOARD_OFFSET_MIN, keyboardIsOpen, keyboardOffset, tabbarOverlapsKeyboard } from "./keyboard.js";
import { addDays, clockText, dayLabel, isLaterToday, minLaterClock, nextLaterDay, nextLaterSlot, planDayChoice, planDayDate, planDayRange, shortDate, zonedParts } from "./when.js";
import { audiencePlace, formatDistance, haversine, isMapsLink, looksLikeUrl } from "./place.js";
import { bindMap } from "./map.js";
import { cardCrowd, goingCrowd, pinLabel, socialPinState } from "./map-pin.js";
import { nextPushDetail, pushTitle } from "./push-sheet.js";
import { gradientClass } from "./card-grad.js";
import { calendarFeedSteps, calendarPlatform } from "./calendar-feed.js";
import { PLAN_DURATION_MS, availabilityText, busyByDay, busySpanText, dayEvents, eventOverlaps, eventTimeText, sourceLabel, untilText } from "./freebusy.js";
import { SEEN_KEY, formatEntryDate, latestId, newerSeen, normalizeEntries, unseenEntries } from "./whats-new.js";
import { REACTIONS, findMentions, insertMention, mentionAt, mentionMatches, toggledReactions } from "./mentions.js";
import { STATUS_PLACE_MAX, STATUS_TEXT_MAX, activeStatus, busyUntilPresets, circleStatusLine, statusBadge, statusLabel, statusLine, statusShort, statusToday, statusUntilDay, untilFromClock, untilText as statusUntilText } from "./status.js";
import { CIRCLE_COLORS, WEEKDAY_LABELS, circleColor, eventCrowd, freeOnDay, gridRange, monthGrid, monthStart, monthTitle, shiftMonth } from "./calendar-month.js";

const TOKEN_KEY = "fn_token";
const CIRCLE_KEY = "fn_circle";
const MAP_ALL_KEY = "hangry-map-all";
/**
 * The Events tab (formerly Map) shows the month calendar or the map: "calendar" (default) or "map".
 * v2: the old "hangry-events-view" key is ignored, so everyone lands on Calendar once.
 */
const EVENTS_VIEW_KEY = "hangry-events-view-v2";
const SHARE_KEY = "fn_share_location";
const INSTALLED_KEY = "fn_installed";
const INSTALL_LATER_KEY = "fn_install_later";
/** Set once the install step after joining a circle was closed, so it never comes back. */
const JOIN_INSTALL_KEY = "fn_join_install_done";
/** Set when the person turned notifications off here, so we do not nag them to turn them back on. */
const PUSH_OFF_KEY = "hangry.pushOff";
/** Same label as CACHE in sw.js. Sent with feedback so a report names the build it came from. */
const APP_VERSION = "hangry-v88";
const FEEDBACK_MAX = 2000;
/** Faces on a plan pin: the host's own pin plus up to three in the crowd. Anyone past that is a +N chip. */
const MAP_CROWD_FACES = 4;

/** How many history entries the app pushed for open overlays (sheets, panels, non-home tabs). */
let overlayHistoryDepth = 0;
/** Set by a tab bar tap that changes the page; the next render fades that page in once, then clears it. */
let pageEntrance = false;
/** Card menu opened by the latest ⋯ tap; its next render plays the open animation once. */
let menuJustOpened = null;
/** Pops we caused ourselves via history.go() and must not treat as Back. */
let ignoreSheetPop = 0;
let closingFromPop = false;
/**
 * Every refresh() is numbered when it starts. The 3s poll, a switch and an action can overlap, and their
 * answers can land in any order. Only the newest answer for the circle on screen is applied, see refreshIsStale.
 */
let refreshSeq = 0;
let refreshApplied = 0;
/** Refreshes numbered below this were asked for a circle we have since left. */
let refreshFloor = 0;

const state = {
  booting: true,
  token: localStorage.getItem(TOKEN_KEY),
  meta: null,
  me: null,
  socials: [],
  plans: [],
  /** Map scope: true shows every circle's places, false only the selected circle. */
  mapAllCircles: localStorage.getItem(MAP_ALL_KEY) === "1",
  mapSocials: [],
  mapPlans: [],
  /** Events tab: "calendar" or "map". Same circle scope (mapAllCircles) for both. */
  eventsView: readEventsView(),
  /** First of the month the calendar shows, and the picked day. Set on first show. */
  calMonth: "",
  calDay: "",
  /** The month's events, kept apart from Home and the map. calendarKey names what is loaded. */
  calendarPlans: [],
  calendarSocials: [],
  calendarKey: "",
  calendarLoading: false,
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
  joinInstall: false,
  installPillHidden: false,
  onboarding: false,
  pushOn: false,
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
  whereStatus: "",
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
  chat: null,
  openDescriptions: new Set(),
  chatQueue: null,
  chatThread: null,
  chatReturn: "home",
  alertsReturn: "home",
  chatDraft: "",
  chatStick: false,
  /** Open @ autocomplete in the composer: { start, query, index }. */
  chatMention: null,
  /** Message id whose quick-reaction bar is open. */
  chatReactFor: null,
  /** Pill whose names are showing after a long-press: { id, emoji }. */
  chatWho: null,
  /** Message the composer is replying to: { id, name, text, mine, color }. */
  chatReplyTo: null,
  chatSummary: { circle: { unread: 0, muted: false }, events: [], unreadByCircle: {} },
  past: false,
  pastDays: null,
  circleId: localStorage.getItem(CIRCLE_KEY) || "",
  circleMenu: false,
  cardMenu: null,
  /** In toggle the person just tapped: { key, on, startedAt, until }. Drives the one-off pop. */
  inPop: null,
  eventDetail: null,
  arrivalPick: null,
  shareCircles: null,
  newCircleName: "",
  whatsNew: null,
  whatsNewView: null,
  whatsNewChecked: false,
  feedbackDraft: "",
  feedbackError: "",
  feedbackBusy: false,
  /** Calendar feed on the You tab: { loaded, active, createdAt, url, webcalUrl, busy }. url is set only right after making one. */
  calendarFeed: null,
  /** Calendar availability on the You tab: syncStatus from the server plus { loaded, busy, draft, error }. */
  calendarSync: null,
  /** "See what friends see" on the Availability & calendar screen: { open, loaded, data, error, busy }. data is the preview from the server. */
  busyPreview: null,
  /** Assistant tokens on the You tab: { loaded, failed, tokens, busy, draft, secret }. secret is set only right after making one. */
  agentTokens: null,
  /** Open You sub-screen: null (the menu) or one of YOU_SECTIONS ids. */
  youSection: null,
  /** Busy people at a later time on the create sheet: { at, people: [{ id, state, until }] }. */
  busyAt: null,
  /** The "I'm in" tap waiting on the owner's own calendar for that day. */
  calendarCheckBusy: "",
  feedbackSent: false,
};

const deepLinkParams = new URLSearchParams(location.search);
const planFocus = deepLinkParams.get("plan");
const socialFocus = deepLinkParams.get("social");
const chatFocus = deepLinkParams.get("chat");
const circleFocus = deepLinkParams.get("circle");
/** Google sends people back to /?calendar=google or /?calendar=google-error. Handled once after the session loads. */
const calendarLanding = ["google", "google-error"].includes(deepLinkParams.get("calendar") || "") ? deepLinkParams.get("calendar") : "";
if (circleFocus) rememberCircle(circleFocus);
if (chatFocus) state.deepLink = { kind: "chat", id: chatFocus };
else if (planFocus) state.deepLink = { kind: "plan", id: planFocus };
else if (socialFocus) state.deepLink = { kind: "social", id: socialFocus };
if (state.deepLink || circleFocus || calendarLanding) {
  const url = new URL(location.href);
  url.searchParams.delete("calendar");
  url.searchParams.delete("social");
  url.searchParams.delete("plan");
  url.searchParams.delete("chat");
  url.searchParams.delete("circle");
  history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}` || "/");
}
const sharePath = location.pathname.match(/^\/p\/([A-Za-z0-9_-]+)\/?$/);
if (sharePath) state.shareLink = sharePath[1];
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
  calendar: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="4" y="5.5" width="16" height="14.5" rx="3" stroke="currentColor" stroke-width="1.8"/><path d="M8.5 3.5v4M15.5 3.5v4M4 10.5h16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M8.5 14.2h.01M12 14.2h.01M15.5 14.2h.01M8.5 17h.01M12 17h.01" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  people: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="9" cy="8.5" r="2.8" stroke="currentColor" stroke-width="1.8"/><path d="M3.8 18.5c.6-2.6 2.6-4 5.2-4s4.6 1.4 5.2 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M15.2 6.2a2.6 2.6 0 0 1 0 5M17 14.7c1.6.5 2.7 1.8 3.2 3.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 6.5 15 12l-6 5.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7.2 16.2 5 19.2c-.3.4.1 1 .6.8l3.2-.9A7.2 7.2 0 1 0 7.2 16.2Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 14.5V4.5M8.2 8 12 4.2 15.8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 11H6.5a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-7a1 1 0 0 0-1-1H16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  more: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><circle cx="19" cy="12" r="1.8" fill="currentColor"/></svg>',
  reply: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9.5 7 5 11.5 9.5 16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M5.5 11.5h8a5 5 0 0 1 5 5v1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
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
  state.joinInstall = false;
  void considerReminders();
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

const FINDING_PLACE = "Finding address…";
const URL_HINT = "Paste a Google Maps link or type a place";
const { mountMap, mountWhereMap, destroyLiveMap, destroyWhereMap, refreshPins, closeMapCard, mapCardOpen, warmMap } = bindMap({
  state,
  whereTarget: () => whereBag(),
  collectPins,
  mapCard,
  paintSummary,
  scheduleReverse,
  recentPlace,
  keepCardOnMapTap: () => tapClosedMenu,
  FINDING_PLACE,
});

boot();
setInterval(() => {
  // A later buzzer turns live, and a live one ends, without a new answer from the server.
  if (!document.hidden && state.me?.user) refreshPins();
  if (!document.hidden && state.token) {
    refresh().catch((error) => {
      if (error?.status === 401) return;
      noteConnectionProblem(error);
      render();
    });
  }
}, 3000);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  refresh().catch(() => {});
  void checkGoogleReturn();
});
window.addEventListener("focus", () => void checkGoogleReturn());
window.addEventListener("pageshow", () => void checkGoogleReturn());
/* iOS Safari only applies :active press styles once the page listens for touches. Passive, so scrolling is untouched. */
document.addEventListener("touchstart", () => {}, { passive: true });

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
    if (state.shareLink) await resolveShareLink();
    if (state.token && state.me && state.pendingCode && !state.inviteError) {
      try {
        const joined = await api("/api/circles/join", { method: "POST", body: { code: state.pendingCode } });
        rememberCircle(joined.circle.id);
        state.me = await api("/api/me");
        history.replaceState(null, "", "/");
        state.pendingCode = "";
        noteInviteJoin();
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
    landCalendar();
    render();
    scheduleErrorClear();
    if (!state.offline) {
      reportDisplay();
      refresh({ initial: true }).catch(() => {});
      rememberViewerLocation();
      void considerReminders();
      // The map and its header load in the background, so the Map tab opens without a wait.
      if (state.me?.user) warmMap();
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
  if (lower.includes("photo")) return text;
  if (lower.includes("away or busy") || lower.includes("end day") || /^(note|place) must be/.test(lower)) return text;
  if (lower.includes("chat is closed")) return "This chat is closed.";
  if (lower.includes("1000")) return "Keep it under 1000 characters.";
  if (lower.includes("write a message")) return "Write a message.";
  if (lower.includes("can't delete")) return "You can't delete that.";
  if (lower.includes("can't reply")) return "You can't reply to that.";
  if (lower.includes("message not found")) return "That message was deleted.";
  if (lower.includes("were removed")) return "You were removed from this event.";
  if (lower.includes("only the host")) return "Only the host can do that.";
  if (status === 403 || lower.includes("only an admin")) return "Only an admin can do that.";
  if (lower.includes("needs an admin")) return "A circle needs an admin.";
  if (status === 401) return "Please sign in again.";
  return "Something went wrong. Try again.";
}

async function refresh({ initial = false } = {}) {
  const seq = ++refreshSeq;
  if (state.token && state.me && !state.me.circle) {
    await refreshPersonalAlerts(seq);
    return;
  }
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
    if (refreshIsStale(seq)) return;
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
  // A late answer for the circle we left, or one older than what is on screen, would repaint old data
  // and banner alerts that were already seen.
  if (refreshIsStale(seq)) return;
  refreshApplied = seq;
  state.socials = socials.socials;
  state.plans = plans.plans;
  if (state.tab === "map" && state.eventsView === "calendar") await loadCalendar({ force: true });
  else if (state.tab === "map" && state.mapAllCircles) await refreshMapAll();
  state.notifications = notifications.notifications;
  state.me = me;
  applyAlertUnread(notifications.unreadByCircle);
  state.chatSummary = summary;
  if (state.chat) forgetOpenUnread(state.chat);
  if (thread?.chat) state.chatThread = thread.chat;
  noteNewestAlert();
  const signature = JSON.stringify({
    socials: state.socials,
    plans: state.plans,
    mapAll: state.mapAllCircles ? [state.mapSocials, state.mapPlans] : null,
    calendar: state.eventsView === "calendar" ? [state.calendarKey, state.calendarSocials, state.calendarPlans] : null,
    notifications: state.notifications.map((note) => [note.id, note.readAt]),
    members: state.me?.circle?.members ?? null,
    circles: state.me?.circles ?? null,
    banner: state.banner?.id ?? null,
    chats: state.chatSummary,
    thread: state.chatThread?.messages?.map((message) => [message.id, (message.reactions || []).map((item) => `${item.emoji}${item.count}${item.mine ? "+" : ""}`)]) ?? null,
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

/** True when refresh number `seq` was asked for a circle we have left, or a newer one already landed. */
function refreshIsStale(seq) {
  return seq < refreshFloor || seq < refreshApplied;
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
  forgetMapAll();
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
  state.bootstrappedNotifs = false;
  render();
  refresh({ initial: true }).catch(() => {});
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
  if ((id || "") !== state.circleId) refreshFloor = refreshSeq + 1;
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
  if (options.circle === null || options.token === null) return {};
  if (typeof options.circle === "string" && options.circle) return { "x-circle": options.circle };
  if (!state.circleId) return {};
  if (/^\/api\/(meta|auth\/|invites\/|buzz\/|plans\/share\/)/.test(path)) return {};
  const owned = mapEventCircle(path);
  if (owned) return { "x-circle": owned };
  return { "x-circle": state.circleId };
}

/** With All circles on, an event route goes to the circle the event lives in. */
function mapEventCircle(path) {
  if (!state.mapAllCircles) return "";
  const match = /^\/api\/(socials|plans)\/([^/?]+)/.exec(path);
  if (!match) return "";
  const list = match[1] === "plans" ? [...state.mapPlans, ...state.calendarPlans] : [...state.mapSocials, ...state.calendarSocials];
  const item = list.find((row) => row.id === match[2]);
  return item ? actingCircle(item) : "";
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
    error.data = data;
    throw error;
  }
  return data;
}

function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  forgetAvatars();
  // What's new is per person. The next account on this phone starts from its own server value.
  localStorage.removeItem(SEEN_KEY);
  state.whatsNewChecked = false;
  rememberCircle("");
  state.token = null;
  state.joinInstall = false;
  state.displayReported = false;
  state.me = null;
  state.socials = [];
  state.plans = [];
  forgetMapAll();
  state.notifications = [];
  state.bootstrappedNotifs = false;
  state.past = false;
  state.pastDays = null;
  state.calendarFeed = null;
  state.calendarSync = null;
  state.busyPreview = null;
  state.agentTokens = null;
  state.youSection = null;
  state.busyAt = null;
}

function render() {
  const activeId = state.focusSheet ? null : document.activeElement?.id || null;
  const caret = document.activeElement?.selectionStart ?? null;
  const y = document.scrollingElement?.scrollTop ?? 0;
  const sheetY = document.querySelector(".sheet-scroll")?.scrollTop ?? 0;
  const chatLog = document.querySelector(".chat-log");
  const chatY = chatLog?.scrollTop ?? 0;
  const chatNearEnd = chatLog ? chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 48 : true;
  const calY = document.querySelector(".cal")?.scrollTop ?? 0;
  document.getElementById("app").replaceChildren(view());
  menuJustOpened = null;
  pageEntrance = false;
  const sheetScroll = document.querySelector(".sheet-scroll");
  if (sheetScroll) sheetScroll.scrollTop = sheetY;
  // The month scrolls inside the Events tab, so a refresh render keeps its place.
  const cal = document.querySelector(".cal");
  if (cal) cal.scrollTop = calY;
  const nextLog = document.querySelector(".chat-log");
  if (nextLog) nextLog.scrollTop = state.chatStick || chatNearEnd ? nextLog.scrollHeight : chatY;
  if (nextLog) {
    chatLogAtEnd = state.chatStick || chatNearEnd;
    chatLogTop = nextLog.scrollTop;
  }
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
  syncOverlayHistory();
  if (state.cardMenu) {
    placeOpenCardMenus();
    requestAnimationFrame(() => { if (state.cardMenu) placeOpenCardMenus(); });
  }
  if (state.focusPlanScroll) {
    state.focusPlanScroll = false;
    const id = state.focusPlan;
    queueMicrotask(() => {
      document.querySelector(`[data-plan="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "center" });
    });
  }
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
  if (state.sharePreview) {
    root.append(sharePreviewScreen());
    if (state.installOpen) root.append(installGuideView());
    if (state.error) root.append(el("div", { class: "toast", role: "status", text: state.error }));
    return root;
  }
  if (calendarLanding && !state.token) {
    root.append(calendarReturnScreen());
  } else if (!state.token || !state.me) {
    root.append(welcome());
  } else if (!state.me.circle) {
    root.append(setup());
    if (state.sheet === "whats-new") root.append(whatsNewSheet());
  } else {
    root.append(shell());
  }
  if (state.installOpen) root.append(installGuideView());
  const joinSheet = state.joinInstall && state.me?.circle && !state.sheet && !state.confirm && !state.installOpen
    ? joinInstallSheet()
    : null;
  if (joinSheet) {
    root.append(joinSheet);
  } else if (state.onboarding && !state.sheet && !state.confirm && !state.installOpen) {
    root.append(onboardingSheet());
  }
  if (state.banner) root.append(banner(state.banner));
  if (state.confirm) root.append(confirmSheet());
  if (state.error && state.error !== TIME_LATER_ERROR && !RETRY_NOTE.has(state.error)) {
    root.append(el("div", { class: "toast", role: "status", text: state.error }));
  }
  return root;
}

/** Google's page can open in a browser tab that has no session. Say how it went and point back to the app. */
function calendarReturnScreen() {
  return el("section", { class: "gate" }, [
    el("div", { class: "hero" }, [
      el("button", { class: "orb small", type: "button", "aria-hidden": "true", tabindex: "-1" }),
      el("h1", { class: "wordmark", text: "Hangry" }),
      el("p", { class: "lede", text: calendarLanding === "google" ? "Google Calendar connected." : "Could not connect Google Calendar." }),
      el("p", { class: "lede", text: "Go back to Hangry." }),
    ]),
  ]);
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
    el("div", { class: "gate-links" }, [
      state.pendingCode || state.inviteError || recovering
        ? null
        : el("a", { class: "gate-about", href: "/welcome", text: "What is Hangry?" }),
      el("a", { class: "gate-about", href: "/privacy", text: "Privacy" }),
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
    personalAlerts(),
  ]);
}

/** Without a circle there is no Alerts tab, so the person's own alerts sit under the setup forms. */
function personalAlerts() {
  if (!state.notifications.length) return null;
  const unread = state.notifications.filter((note) => !note.readAt).length;
  return el("section", { class: "personal-alerts", "aria-label": unread ? `Your alerts, ${unread} unread` : "Your alerts" }, [
    el("h2", { class: "personal-alerts-title", text: "Your alerts" }),
    el("div", { class: "list" }, state.notifications.map(alertCard)),
  ]);
}

function shell() {
  forgetShownFeedLink();
  forgetShownAgentToken();
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
  // Only an explicit tab bar switch fades in; sheet closes, Back and the 3s refresh renders never do.
  const freshTab = pageEntrance;
  const screens = { home, map: mapScreen, circle: circleScreen, alerts: alertsScreen, you: youScreen };
  const page = screens[state.tab]?.();
  if (page) {
    page.classList.add("page");
    if (freshTab) page.classList.add("page-in");
    page.dataset.page = state.tab;
    phone.append(page);
  }
  phone.append(tabbar(freshTab));
  if (state.sheet) phone.append(sheet());
  return phone;
}

function alertsBell() {
  const unread = state.notifications.filter((note) => !note.readAt).length;
  return el("button", {
    class: state.tab === "alerts" ? "icon-btn on" : "icon-btn",
    type: "button",
    "aria-label": unread ? `Alerts, ${unread} unread` : "Alerts",
    "aria-expanded": state.tab === "alerts" ? "true" : "false",
    onclick: () => {
      if (state.tab === "alerts") closeAlerts();
      else void onTab("alerts");
    },
  }, [
    icon("bell"),
    unread ? el("span", { class: "badge", text: unread > 9 ? "9+" : String(unread) }) : null,
  ]);
}

function screenHeader(title) {
  const titleEl = el("h1", { class: "screen-title", text: title });
  const bell = alertsBell();
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
  // Another circle's list is not news. The bell badge shows what is unread there.
  state.bootstrappedNotifs = false;
  await run(async () => {
    await refresh({ initial: true });
    // Switching while Alerts is open shows that circle's list, so it counts as read.
    if (state.tab === "alerts" && state.notifications.some((note) => !note.readAt)) {
      await markAlertsRead();
    }
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
  const away = awayLine();
  if (away) parts.push(away);
  const live = state.socials.filter((social) => isLiveSocial(social) || social.creator.id === state.me.user.id);
  const later = state.socials.filter((social) => !isLiveSocial(social) && social.creator.id !== state.me.user.id);
  const feed = [...live.map(socialCard), ...later.map(socialCard), ...sortedPlans(state.plans).map(planCard)];
  if (feed.length) parts.push(el("div", { class: "section" }, [el("div", { class: "cards" }, feed)]));
  parts.push(el("div", { class: "past-entry" }, [
    el("button", { class: "text-btn", type: "button", text: "Past events", onclick: () => { void openPast(); } }),
  ]));
  return el("div", {}, parts);
}

/** Plans by day, then time (no time last that day), like the server sends them. */
function sortedPlans(plans) {
  return [...plans].sort((a, b) => (
    a.forDate.localeCompare(b.forDate)
    || (a.time ? 0 : 1) - (b.time ? 0 : 1)
    || (a.time || "").localeCompare(b.time || "")
  ));
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
  const upcoming = social.startsAt && social.startsAt > Date.now();
  const menuOpen = state.cardMenu === `social:${social.id}`;
  return el("article", {
    class: [
      state.focusSocial === social.id ? "card card-now focused" : upcoming ? "card card-now later" : "card card-now",
      menuOpen ? "menu-open" : "",
    ].filter(Boolean).join(" "),
    "data-social": social.id,
  }, [
    el("div", { class: "card-bg", onclick: () => openEventDetail("social", social) }),
    cardOverflow("social", social),
    el("div", { class: "card-copy" }, [
      el("div", {
        class: "card-body",
        role: "button",
        tabindex: "0",
        "aria-label": "Open details",
        onclick: () => openEventDetail("social", social),
      }, [
        avatarStack(social),
        el("h3", { text: social.note || (upcoming ? "Free later" : "Free now") }),
        el("p", { text: upcoming ? `${social.creator.name} · from ${clock(social.startsAt)}` : `${social.creator.name} · ${remaining(social.expiresAt)}` }),
        replySummary(social),
        placeLine(social.location, social.place, { kind: "social", id: social.id }),
        removedNote(social),
      ]),
      chatRow("social", social),
      social.removedBy ? null : inToggle("social", social, { locked: mine }),
    ]),
  ]);
}

function planCard(plan) {
  const mine = plan.creator.id === state.me.user.id;
  const menuOpen = state.cardMenu === `plan:${plan.id}`;
  return el("article", {
    class: [
      state.focusPlan === plan.id ? "card card-plan focused" : "card card-plan",
      `card-grad ${gradientClass(plan.id)}`,
      menuOpen ? "menu-open" : "",
    ].filter(Boolean).join(" "),
    "data-plan": plan.id,
  }, [
    el("div", { class: "card-bg", onclick: () => openEventDetail("plan", plan) }),
    cardOverflow("plan", plan),
    el("div", { class: "card-copy" }, [
      el("div", {
        class: "card-body",
        role: "button",
        tabindex: "0",
        "aria-label": "Open details",
        onclick: () => openEventDetail("plan", plan),
      }, [
        avatarStack(plan),
        el("h3", { text: plan.note }),
        el("p", { text: `${plan.whenLabel}${plan.time ? ` · ${plan.time}` : ""} · ${plan.creator.name}` }),
        planCirclesLine(plan),
        planDescription(plan),
        planReplySummary(plan),
        placeLine(plan.location, plan.place, { kind: "plan", id: plan.id }),
        removedNote(plan),
      ]),
      chatRow("plan", plan),
      cardActions("plan", plan, { locked: mine }),
    ]),
  ]);
}

function planDescription(plan) {
  const text = (plan?.description || "").trim();
  if (!text) return null;
  const open = state.openDescriptions.has(plan.id);
  const toggle = (event) => {
    event.stopPropagation();
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
      awayLine(),
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

/** Who in this circle is away or busy, in one line. Null when no one is. */
function awayLine() {
  const text = circleStatusLine(state.me?.circle?.members, state.me?.user?.id, Date.now(), 3, viewerTz());
  return text ? el("p", { class: "away-line", text }) : null;
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

/** A circle dot means unread Alerts in that circle. Chat unread has its own badges. */
function circleHasUnread(id) {
  return (state.me?.circles?.find((circle) => circle.id === id)?.alertUnread || 0) > 0;
}

function anyCircleUnread() {
  return (state.me?.circles || []).some((circle) => circleHasUnread(circle.id));
}

/** Copies fresh per-circle alert counts from /api/notifications onto the circle list. */
/** Shows the banner once for an alert newer than the last one seen. The first load only remembers it. */
function noteNewestAlert() {
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
}

/**
 * Someone in no circle still has their own alerts (for example "Your suggestion is live").
 * The server answers with personal alerts only when no circle is named.
 */
async function refreshPersonalAlerts(seq) {
  let data;
  try {
    // No x-circle header: a stale remembered circle would turn this into a 404.
    data = await api("/api/notifications", { circle: null });
  } catch {
    return;
  }
  if (state.me?.circle || refreshIsStale(seq)) return;
  refreshApplied = seq;
  state.notifications = Array.isArray(data?.notifications) ? data.notifications : [];
  noteNewestAlert();
  const signature = JSON.stringify({
    personal: state.notifications.map((note) => [note.id, note.readAt]),
    banner: state.banner?.id ?? null,
  });
  if (signature === state.signature) return;
  state.signature = signature;
  if (state.sheet || isTyping()) return;
  render();
}

function applyAlertUnread(totals) {
  if (!totals || !state.me?.circles) return;
  for (const circle of state.me.circles) circle.alertUnread = totals[circle.id] || 0;
}

/** No circle: reading means the person's own alerts. */
async function markPersonalAlertsRead() {
  try {
    await api("/api/notifications/read", { method: "POST", body: {} });
  } catch {
    return;
  }
  const readAt = Date.now();
  state.notifications = state.notifications.map((note) => ({ ...note, readAt: note.readAt ?? readAt }));
  state.signature = "";
  if (!state.sheet) render();
}

/** Marks this circle's alerts read, then clears the bell badge and the circle dot together. */
async function markAlertsRead() {
  await api("/api/notifications/read", { method: "POST", body: {} });
  const readAt = Date.now();
  state.notifications = state.notifications.map((note) => ({ ...note, readAt: note.readAt ?? readAt }));
  const current = state.me?.circles?.find((circle) => circle.id === state.me?.circle?.id);
  if (current) current.alertUnread = 0;
  persistCachedState();
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
  state.chatReplyTo = null;
  forgetOpenUnread(target);
  await run(async () => {
    const chat = (await api(chatTargetUrl(target))).chat;
    // Another tab was tapped while this loaded; that tap wins.
    if (state.chat === target) state.chatThread = chat;
  });
}

function closeChat() {
  state.chat = null;
  state.chatThread = null;
  state.chatDraft = "";
  state.chatMention = null;
  state.chatReactFor = null;
  state.chatWho = null;
  state.chatReplyTo = null;
  state.tab = state.chatReturn || "home";
  render();
}

function chatScreen() {
  const thread = state.chatThread;
  const title = thread?.title || "Chat";
  const me = thread?.participants?.find((person) => person.id === state.me?.user?.id);
  return     el("section", { class: "chat-screen", "aria-label": title, style: me ? `--me:${me.color}` : null }, [
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
    el("div", { class: "chat-log", id: "chat-log", onscroll: noteChatLogScroll }, thread
      ? thread.messages.map((message) => message.system ? systemLine(message) : messageRow(message))
      : [el("p", { class: "help", text: "Loading…" })]),
    thread?.removed
      ? el("p", { class: "chat-closed", text: "You were removed from this event." })
      : thread?.closed
      ? el("p", { class: "chat-closed", text: "This chat is closed." })
      : el("form", { class: "chat-compose", onsubmit: sendChat }, [
          replyPreview(),
          el("input", {
            id: "chat-input",
            class: "sheet-control",
            type: "text",
            maxlength: "1000",
            placeholder: "Message",
            value: state.chatDraft,
            autocomplete: "off",
            "aria-autocomplete": "list",
            "aria-controls": "mention-list",
            oninput: (event) => {
              state.chatDraft = event.target.value;
              noteMentionTyping(event.target);
            },
            onkeydown: onComposerKey,
            onblur: (event) => {
              if (!event.target.isConnected || !state.chatMention) return;
              state.chatMention = null;
              paintMentions();
            },
          }),
          el("button", { class: "btn chat-send", type: "submit", text: "Send" }),
          mentionPicker(),
        ]),
  ]);
}

/** Who can be tagged: the chat's people, never you. */
function mentionChoices() {
  const pick = state.chatMention;
  if (!pick) return [];
  return mentionMatches(state.chatThread?.participants || [], pick.query, state.me?.user?.id);
}

function mentionPicker() {
  const people = mentionChoices();
  if (!people.length) return null;
  const index = Math.min(state.chatMention.index, people.length - 1);
  return el("ul", { class: "mention-list", id: "mention-list", role: "listbox", "aria-label": "Mention someone" }, people.map((person, i) =>
    el("li", {
      class: i === index ? "mention-option active" : "mention-option",
      role: "option",
      "aria-selected": i === index ? "true" : "false",
      style: `--person:${person.color}`,
      // Keeps focus (and the keyboard) on the composer.
      onmousedown: (event) => event.preventDefault(),
      onclick: () => chooseMention(person),
    }, [el("span", { class: "mention-dot", "aria-hidden": "true" }), el("span", { text: person.name })])));
}

/** Swaps the list in place, so typing never rebuilds the composer under the keyboard. */
function paintMentions() {
  const form = document.querySelector(".chat-compose");
  if (!form) return;
  form.querySelector(".mention-list")?.remove();
  const next = mentionPicker();
  if (next) form.append(next);
}

function noteMentionTyping(input) {
  const found = mentionAt(input.value, input.selectionStart ?? input.value.length);
  const before = state.chatMention;
  state.chatMention = found ? { ...found, index: before && before.start === found.start ? before.index : 0 } : null;
  paintMentions();
}

function onComposerKey(event) {
  const people = mentionChoices();
  if (!people.length) return;
  const pick = state.chatMention;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    pick.index = (Math.min(pick.index, people.length - 1) + step + people.length) % people.length;
    paintMentions();
  } else if (event.key === "Enter" || event.key === "Tab") {
    event.preventDefault();
    chooseMention(people[Math.min(pick.index, people.length - 1)]);
  } else if (event.key === "Escape") {
    // Only the list closes; the chat stays open.
    event.preventDefault();
    event.stopPropagation();
    state.chatMention = null;
    paintMentions();
  }
}

function chooseMention(person) {
  const input = document.getElementById("chat-input");
  const pick = state.chatMention;
  if (!input || !pick) return;
  const next = insertMention(input.value, pick.start, input.selectionStart ?? input.value.length, person.name);
  input.value = next.text;
  state.chatDraft = next.text;
  state.chatMention = null;
  paintMentions();
  input.focus({ preventScroll: true });
  input.setSelectionRange(next.caret, next.caret);
}

/** Message text with each @Name of someone in the chat in their colour. Yours is a little stronger. */
function messageText(text) {
  const thread = state.chatThread;
  const colors = new Map();
  for (const message of thread?.messages || []) if (message.color && message.name) colors.set(message.name.toLowerCase(), message.color);
  for (const person of thread?.participants || []) colors.set(person.name.toLowerCase(), person.color);
  const hits = findMentions(text, [...colors.keys()]);
  if (!hits.length) return el("p", { text });
  const me = (state.me?.user?.name || "").trim().toLowerCase();
  const parts = [];
  let at = 0;
  for (const hit of hits) {
    if (hit.start > at) parts.push(text.slice(at, hit.start));
    const key = hit.name.toLowerCase();
    parts.push(el("span", {
      class: key === me ? "mention me" : "mention",
      style: `--person:${colors.get(key)}`,
      text: text.slice(hit.start, hit.end),
    }));
    at = hit.end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return el("p", {}, parts);
}

/** You can react once you are one of the chat's people and were not removed. */
function canReact() {
  const thread = state.chatThread;
  if (!thread || thread.removed) return false;
  return (thread.participants || []).some((person) => person.id === state.me?.user?.id);
}

/** Reply needs an open composer too, so a closed chat only takes reactions. */
function canReply() {
  return canReact() && !state.chatThread?.closed;
}

function reactionBar(message) {
  return el("div", { class: "react-bar", role: "toolbar", "aria-label": "React" }, [
    ...REACTIONS.map((emoji) => {
      const mine = (message.reactions || []).some((item) => item.emoji === emoji && item.mine);
      return el("button", {
        class: mine ? "react-pick mine" : "react-pick",
        type: "button",
        "aria-label": `React ${emoji}`,
        "aria-pressed": mine ? "true" : "false",
        text: emoji,
        onclick: () => { if (!pressConsumed()) void reactTo(message.id, emoji); },
      });
    }),
    canReply() && el("button", {
      class: "react-reply",
      type: "button",
      text: "Reply",
      // Keeps focus (and the keyboard) on the composer.
      onmousedown: (event) => event.preventDefault(),
      onclick: () => { if (!pressConsumed()) startReply(message); },
    }),
  ]);
}

/** One line of a message, for a quote. */
function snippet(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

/** Puts the composer in reply mode for this message, with the keyboard up. */
function startReply(message) {
  state.chatReplyTo = { id: message.id, name: message.name, text: snippet(message.text), mine: message.mine, color: message.color || null };
  state.chatReactFor = null;
  state.chatWho = null;
  render();
  const input = document.getElementById("chat-input");
  if (!input) return;
  input.focus({ preventScroll: true });
  const end = input.value.length;
  input.setSelectionRange(end, end);
}

/** Drops the reply target. The draft stays. */
function clearReply() {
  if (!state.chatReplyTo) return false;
  state.chatReplyTo = null;
  render();
  return true;
}

function replyPreview() {
  const reply = state.chatReplyTo;
  if (!reply) return null;
  return el("div", { class: "reply-preview", style: reply.color ? `--person:${reply.color}` : null }, [
    el("div", { class: "reply-preview-copy" }, [
      el("strong", { text: reply.mine ? "You" : reply.name }),
      el("span", { text: reply.text }),
    ]),
    el("button", {
      class: "reply-cancel",
      type: "button",
      "aria-label": "Cancel reply",
      onmousedown: (event) => event.preventDefault(),
      onclick: () => {
        clearReply();
        document.getElementById("chat-input")?.focus({ preventScroll: true });
      },
    }, [icon("close")]),
  ]);
}

/** The message a reply answers, one line. A deleted one says so and goes nowhere. */
function replyQuote(quote) {
  if (!quote) return null;
  if (quote.deleted) return el("p", { class: "chat-quote gone", text: "Original message deleted" });
  return el("button", {
    class: "chat-quote",
    type: "button",
    style: quote.color ? `--quote:${quote.color}` : null,
    "aria-label": `Reply to ${quote.mine ? "you" : quote.name}: ${quote.text}. Show message`,
    onclick: () => { if (!pressConsumed()) jumpToMessage(quote.id); },
  }, [
    el("strong", { text: quote.mine ? "You" : quote.name }),
    el("span", { text: quote.text }),
  ]);
}

const FLASH_MS = 1600;
let flashTimer = 0;

/** Scrolls the log to a message and lights it up for a moment. Not loaded: nothing happens. */
function jumpToMessage(id) {
  const row = document.querySelector(`.chat-log .chat-msg[data-id="${CSS.escape(id)}"]`);
  if (!row) return;
  const still = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  chatLogAtEnd = false;
  row.scrollIntoView({ block: "center", behavior: still ? "auto" : "smooth" });
  document.querySelectorAll(".chat-msg.flash").forEach((node) => node.classList.remove("flash"));
  // Restart the fade if it is already lit.
  void row.offsetWidth;
  row.classList.add("flash");
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => row.classList.remove("flash"), FLASH_MS);
}

function reactionPills(message, live) {
  const list = message.reactions || [];
  if (!list.length) return null;
  const who = state.chatWho && state.chatWho.id === message.id
    ? list.find((item) => item.emoji === state.chatWho.emoji)
    : null;
  return el("div", { class: "chat-reacts" }, [
    ...list.map((item) => el("button", {
      class: item.mine ? "react-pill mine" : "react-pill",
      type: "button",
      "data-emoji": item.emoji,
      title: item.names.join(", "),
      "aria-label": `${item.emoji} ${item.count}: ${item.names.join(", ")}`,
      "aria-pressed": item.mine ? "true" : "false",
      disabled: !live,
      onclick: () => { if (!pressConsumed()) void reactTo(message.id, item.emoji); },
    }, [el("span", { class: "react-emoji", text: item.emoji }), el("span", { class: "react-count", text: String(item.count) })])),
    who ? el("span", { class: "react-who", text: who.names.join(", ") }) : null,
  ]);
}

const LONG_PRESS_MS = 400;
let pressTimer = 0;
let pressStart = null;
let pressUsedAt = 0;

/** A long-press just fired, so the click that follows it is not a tap. */
function pressConsumed() {
  return Date.now() - pressUsedAt < 700 || Date.now() - swipeUsedAt < 350;
}

/** Touch and pen: hold a message for the reaction bar, or a pill for who reacted. */
function startPress(event, message) {
  if (event.pointerType === "mouse") return;
  const pill = event.target.closest?.(".react-pill");
  // Chrome's touch adjustment can land a press on the row's Delete, so only the bar itself is left alone.
  if (event.target.closest?.(".react-bar")) return;
  clearTimeout(pressTimer);
  pressStart = { x: event.clientX, y: event.clientY };
  pressTimer = setTimeout(() => {
    pressStart = null;
    pressUsedAt = Date.now();
    tick();
    if (pill) state.chatWho = { id: message.id, emoji: pill.dataset.emoji };
    else {
      state.chatReactFor = message.id;
      state.chatWho = null;
    }
    render();
  }, LONG_PRESS_MS);
}

function movePress(event) {
  if (!pressStart) return;
  if (Math.hypot(event.clientX - pressStart.x, event.clientY - pressStart.y) > 8) endPress();
}

function endPress() {
  clearTimeout(pressTimer);
  pressStart = null;
}

const SWIPE_REPLY_PX = 56;
const SWIPE_MAX_PX = 72;
let swipe = null;
/** When a swipe last started a reply. The click its lift may fire is not a tap. */
let swipeUsedAt = 0;

/** Touch: a short swipe right on a message starts a reply. Up or down is a scroll and lets go. */
function startSwipe(event, row, message) {
  if (event.pointerType === "mouse" || event.target.closest?.(".react-bar")) return;
  swipe = { row, message, x: event.clientX, y: event.clientY, at: Date.now(), dx: 0, on: false };
}

function moveSwipe(event) {
  if (!swipe) return;
  const dx = event.clientX - swipe.x;
  const dy = event.clientY - swipe.y;
  // A long-press already opened the bar, or the finger went up or down: not a swipe.
  if (pressUsedAt >= swipe.at || Math.abs(dy) > 24 || (!swipe.on && Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx))) {
    dropSwipe();
    return;
  }
  if (!swipe.on && dx > 10 && dx > Math.abs(dy) * 1.5) swipe.on = true;
  if (!swipe.on) return;
  swipe.dx = Math.max(0, Math.min(dx, SWIPE_MAX_PX));
  swipe.row.classList.add("swiping");
  swipe.row.style.setProperty("--swipe", `${swipe.dx}px`);
  swipe.row.classList.toggle("swipe-ready", swipe.dx >= SWIPE_REPLY_PX);
}

function endSwipe() {
  const done = swipe;
  dropSwipe();
  if (!done?.on || done.dx < SWIPE_REPLY_PX) return;
  swipeUsedAt = Date.now();
  tick();
  startReply(done.message);
}

function dropSwipe() {
  if (!swipe) return;
  swipe.row.classList.remove("swiping", "swipe-ready");
  swipe.row.style.removeProperty("--swipe");
  swipe = null;
}

function openReactionBar(message) {
  state.chatReactFor = state.chatReactFor === message.id ? null : message.id;
  state.chatWho = null;
  render();
  document.querySelector(".react-bar .react-pick")?.focus({ preventScroll: true });
}

/** Puts the bar or the names away without a re-render, so the tap that did it still lands. */
function closeReactUi() {
  if (!state.chatReactFor && !state.chatWho) return false;
  state.chatReactFor = null;
  state.chatWho = null;
  document.querySelectorAll(".react-bar, .react-who").forEach((node) => node.remove());
  document.querySelectorAll('.chat-react-btn[aria-expanded="true"]').forEach((node) => node.setAttribute("aria-expanded", "false"));
  return true;
}

async function reactTo(messageId, emoji) {
  const thread = state.chatThread;
  const message = thread?.messages?.find((item) => item.id === messageId);
  if (!message) return;
  const on = !(message.reactions || []).some((item) => item.emoji === emoji && item.mine);
  tick();
  message.reactions = toggledReactions(message.reactions || [], emoji, state.me?.user?.name || "You");
  state.chatReactFor = null;
  state.chatWho = null;
  render();
  try {
    const result = await api(`/api/messages/${encodeURIComponent(messageId)}/reactions`, { method: "POST", body: { emoji, on } });
    const current = state.chatThread?.messages?.find((item) => item.id === messageId);
    if (current) current.reactions = result.reactions;
  } catch (error) {
    if (error.status === 401) return;
    state.error = error.message || "Something went wrong. Try again.";
    try {
      if (state.chat) state.chatThread = (await api(chatTargetUrl(state.chat))).chat;
    } catch {
      /* the next refresh catches up */
    }
    scheduleErrorClear();
  }
  render();
}

function systemLine(message) {
  return el("p", { class: "chat-system" }, [
    el("span", { text: message.text }),
    el("time", { text: messageWhen(message.at) }),
  ]);
}

function messageRow(message) {
  const accent = message.system ? "" : message.color || "";
  const live = canReact();
  const replyable = canReply();
  return el("article", {
    class: message.mine ? "chat-msg mine" : "chat-msg",
    "data-color": accent || null,
    "data-id": message.id,
    style: accent ? `--person:${accent}` : null,
    onpointerdown: live ? (event) => { startPress(event, message); if (replyable) startSwipe(event, event.currentTarget, message); } : null,
    onpointermove: live ? (event) => { movePress(event); moveSwipe(event); } : null,
    onpointerup: live ? () => { endPress(); endSwipe(); } : null,
    onpointercancel: live ? () => { endPress(); dropSwipe(); } : null,
    // A held finger opens the reaction bar, not the browser's own menu.
    oncontextmenu: live ? (event) => { if (prefersTouchUi()) event.preventDefault(); } : null,
  }, [
    el("header", {}, [
      el("strong", { text: message.mine ? "You" : message.name }),
      live
        ? el("button", {
            class: "chat-react-btn",
            type: "button",
            "aria-label": "React",
            "aria-expanded": state.chatReactFor === message.id ? "true" : "false",
            text: "☺",
            onclick: () => openReactionBar(message),
          })
        : null,
      replyable
        ? el("button", {
            class: "chat-reply-btn",
            type: "button",
            "aria-label": "Reply",
            onmousedown: (event) => event.preventDefault(),
            onclick: () => startReply(message),
          }, [icon("reply")])
        : null,
      el("time", { text: messageWhen(message.at) }),
    ]),
    replyQuote(message.replyTo),
    messageText(message.text),
    live && state.chatReactFor === message.id ? reactionBar(message) : null,
    reactionPills(message, live),
    message.canDelete
      ? el("button", { class: "text-btn", type: "button", text: "Delete", onclick: () => { if (!pressConsumed()) confirmDeleteMessage(message); } })
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

/** False once someone scrolls the log up (or jumps to a quoted message), so the keyboard does not pull it back down. */
let chatLogAtEnd = true;
let chatLogTop = 0;

function noteChatLog(log) {
  chatLogAtEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
  chatLogTop = log.scrollTop;
}

function noteChatLogScroll(event) {
  noteChatLog(event.currentTarget);
}

function stickChatLog() {
  const log = document.querySelector(".chat-log");
  const bar = document.querySelector(".chat-compose, .chat-closed");
  // A scroll up that has not reported yet counts too.
  if (!log || !chatLogAtEnd || log.scrollTop < chatLogTop - 4) return;
  const view = window.visualViewport;
  const viewBottom = (view?.offsetTop ?? 0) + (view?.height ?? window.innerHeight);
  const limit = Math.min(viewBottom, bar?.getBoundingClientRect().top ?? viewBottom) - 8;
  const last = log.lastElementChild;
  if (!last) return;
  const box = last.getBoundingClientRect();
  if (box.bottom > limit) log.scrollTop += box.bottom - limit;
  chatLogTop = log.scrollTop;
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
  tick();
  const target = { kind: state.chat.kind, id: state.chat.id };
  const replyTo = state.chatReplyTo?.id || null;
  state.chatQueue = { target, text, replyTo };
  try {
    state.chatThread = (await api(chatTargetUrl(target), { method: "POST", body: replyTo ? { text, replyTo } : { text } })).chat;
    state.chatQueue = null;
    state.chatDraft = unsentTail(state.chatDraft, text);
    sentReply(replyTo);
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

/** The reply went out, so the preview goes. A newer reply target picked meanwhile stays. */
function sentReply(id) {
  if (id && state.chatReplyTo?.id === id) state.chatReplyTo = null;
}

async function flushChatQueue() {
  const queued = state.chatQueue;
  if (!queued) return;
  try {
    const body = queued.replyTo ? { text: queued.text, replyTo: queued.replyTo } : { text: queued.text };
    const thread = (await api(chatTargetUrl(queued.target), { method: "POST", body })).chat;
    state.chatQueue = null;
    state.chatDraft = unsentTail(state.chatDraft, queued.text);
    sentReply(queued.replyTo);
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
  return chatRow(kind, { id });
}

function eventChatMeta(kind, id) {
  return state.chatSummary?.events?.find((row) => row.kind === kind && row.id === id) || null;
}

function chatRow(kind, item) {
  const id = item.id;
  const unread = eventUnread(kind, id);
  const meta = eventChatMeta(kind, id);
  const preview = (meta?.preview || "").trim();
  const by = (meta?.previewBy || "").trim();
  const previewText = preview
    ? (by ? `${by}: ${preview}` : preview)
    : "Chat";
  return el("button", {
    class: "chat-row",
    type: "button",
    "aria-label": unread ? `Chat, ${unread} unread` : "Chat",
    onclick: (event) => {
      event.stopPropagation();
      state.cardMenu = null;
      void openChat({ kind, id });
    },
  }, [
    icon("chat"),
    el("div", { class: "chat-row-copy" }, [
      el("strong", { text: "Chat" }),
      preview ? el("span", { class: "chat-row-preview", text: previewText }) : el("span", { class: "chat-row-preview muted", text: "Say hi" }),
    ]),
    unread ? el("span", { class: "badge", text: unread > 9 ? "9+" : String(unread) }) : null,
  ]);
}

/** One alert row. Title and body are untrusted text and only ever go through textContent. */
function alertCard(note) {
  return el("button", {
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
  ]);
}

function alertsScreen() {
  const items = state.notifications.length
    ? state.notifications.map(alertCard)
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

/** The person's own zone: the one saved with their status or hours, else this device's, else the app's. */
function userTz() {
  return state.me?.user?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || appTz();
}

/** The active status the person set by hand. Weekly hours do not count. */
function manualStatus() {
  const status = activeStatus(state.me.user.status);
  return status && status.source !== "schedule" ? status : null;
}

/** "Busy until" quick picks as chips. `isOn` marks the chosen one in the editor. */
function busyPresetChips(onPick, isOn = () => false) {
  return el("div", { class: "busy-presets", role: "group", "aria-label": "Busy until" }, busyUntilPresets(Date.now(), userTz()).map((preset) => el("button", {
    type: "button",
    class: isOn(preset) ? "chip on" : "chip",
    "aria-pressed": isOn(preset) ? "true" : "false",
    text: preset.label,
    onclick: () => onPick(preset),
  })));
}

/** Away / Busy on the You tab: a summary with Edit and Clear, or quick Busy picks and two buttons that open the editor. */
function statusPanel() {
  const status = activeStatus(state.me.user.status);
  if (state.statusDraft) return statusEditor();
  if (status) {
    const fromHours = status.source === "schedule";
    return el("div", { class: "panel status-panel", "data-status": status.type }, [
      el("h3", { text: "Your status" }),
      el("p", { class: "status-summary" }, [
        el("span", { class: "status-card-mark", "aria-hidden": "true", text: statusBadge(status.type) }),
        el("span", { text: statusLine(status, Date.now(), viewerTz()) }),
      ]),
      el("p", {
        class: "help",
        text: fromHours
          ? "From your weekly hours. Friends only see that you're busy or free, and until when."
          : "People in your circles see this next to your name.",
      }),
      el("div", { class: "status-actions" }, fromHours
        ? [
            el("button", { class: "btn secondary", type: "button", text: "Set a status", onclick: () => editStatus("busy") }),
            el("button", { class: "text-btn", type: "button", text: "Edit weekly hours", onclick: editBusyHours }),
          ]
        : [
            el("button", { class: "btn secondary", type: "button", text: "Edit status", onclick: () => editStatus(status.type) }),
            el("button", { class: "text-btn", type: "button", text: "Clear status", onclick: () => { void onClearStatus(); } }),
          ]),
    ]);
  }
  return el("div", { class: "panel status-panel" }, [
    el("h3", { text: "Status" }),
    el("p", { class: "help", text: "Busy for a bit, or away for a while? Let your circles know." }),
    el("p", { class: "busy-presets-label", text: "Busy until" }),
    busyPresetChips((preset) => { void onQuickBusy(preset); }),
    el("div", { class: "status-actions two" }, [
      el("button", { class: "btn secondary", type: "button", text: "\u2708\ufe0f Set Away", onclick: () => editStatus("away") }),
      el("button", { class: "btn secondary", type: "button", text: "\u23f3 Set Busy", onclick: () => editStatus("busy") }),
    ]),
  ]);
}

async function onQuickBusy(preset) {
  await run(async () => {
    state.me = await api("/api/me/status", {
      method: "PUT",
      body: { type: "busy", until: preset.until, timezone: userTz() },
    });
    state.statusDraft = null;
    state.error = "Status saved";
  });
}

function editStatus(type) {
  const current = manualStatus();
  state.statusDraft = {
    type,
    text: current?.text || "",
    place: current?.place || "",
    untilDay: statusUntilDay(current),
    until: current?.type === "busy" && type === "busy" ? current.until ?? null : null,
    preset: "",
    clock: "",
  };
  render();
  requestAnimationFrame(() => document.getElementById("status-text")?.focus({ preventScroll: true }));
}

function statusEditor() {
  const draft = state.statusDraft;
  const busy = draft.type === "busy";
  const typeButton = (type) => el("button", {
    type: "button",
    class: draft.type === type ? "on" : "",
    "aria-pressed": draft.type === type ? "true" : "false",
    text: statusLabel(type),
    onclick: () => {
      draft.type = type;
      render();
    },
  });
  return el("form", { class: "panel stack status-panel status-editor", onsubmit: onSaveStatus }, [
    el("h3", { id: "status-type-label", text: "Your status" }),
    el("div", { class: "segment", role: "group", "aria-labelledby": "status-type-label" }, [typeButton("away"), typeButton("busy")]),
    field("Note (optional)", "status-text", draft.text, (value) => { draft.text = value; }, {
      maxlength: String(STATUS_TEXT_MAX),
      placeholder: "Tennis vacation in Portugal",
    }),
    field("Where (optional)", "status-place", draft.place, (value) => { draft.place = value; }, {
      maxlength: String(STATUS_PLACE_MAX),
      placeholder: "Portugal",
    }),
    ...(busy
      ? [
          el("p", { class: "busy-presets-label", text: "Busy until" }),
          busyPresetChips((preset) => {
            draft.until = preset.until;
            draft.preset = preset.id;
            draft.clock = "";
            render();
          }, (preset) => draft.preset === preset.id),
          el("label", { class: "field" }, [
            el("span", { text: "Or until a time" }),
            el("input", {
              id: "status-until-time",
              class: "sheet-control",
              type: "time",
              value: draft.clock || "",
              oninput: (event) => setBusyClock(draft, event.target.value),
              onchange: (event) => {
                setBusyClock(draft, event.target.value);
                render();
              },
            }),
          ]),
          el("p", { class: "help", text: "It clears itself at that time. Friends only see that you're busy or free, and until when." }),
        ]
      : [
          el("label", { class: "field" }, [
            el("span", { text: "Until (optional)" }),
            el("input", {
              id: "status-until",
              class: "sheet-control",
              type: "date",
              min: statusToday(),
              value: draft.untilDay || "",
              oninput: (event) => { draft.untilDay = event.target.value; },
              onchange: (event) => { draft.untilDay = event.target.value; },
            }),
          ]),
          el("p", { class: "help", text: "It clears itself after that day. Leave it empty to keep it until you clear it." }),
        ]),
    el("div", { class: "status-actions" }, [
      el("button", { class: "btn", type: "submit", text: "Save status" }),
      el("button", { class: "text-btn", type: "button", text: "Cancel", onclick: () => { state.statusDraft = null; render(); } }),
    ]),
  ]);
}

/** A custom time sets the end to its next occurrence. The page redraws on change, not on every keystroke. */
function setBusyClock(draft, value) {
  draft.clock = value;
  draft.preset = "";
  draft.until = untilFromClock(value, Date.now(), userTz());
}

async function onSaveStatus(event) {
  event.preventDefault();
  const draft = state.statusDraft;
  if (!draft) return;
  const busy = draft.type === "busy";
  await run(async () => {
    state.me = await api("/api/me/status", {
      method: "PUT",
      body: busy
        ? { type: draft.type, text: draft.text, place: draft.place, until: draft.until || null, untilDay: null, timezone: userTz() }
        : { type: draft.type, text: draft.text, place: draft.place, untilDay: draft.untilDay || null, until: null },
    });
    state.statusDraft = null;
    state.error = "Status saved";
  });
}

async function onClearStatus() {
  await run(async () => {
    state.me = await api("/api/me/status", { method: "DELETE" });
    state.statusDraft = null;
    state.error = "Status cleared";
  });
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const BUSY_BLOCKS_MAX = 3;

/** "Mon–Fri 09:00 to 17:00" for one block: runs of consecutive days are joined. */
function busyBlockText(block) {
  const days = [...new Set(block.days)].sort((a, b) => a - b);
  const runs = [];
  for (const day of days) {
    const last = runs[runs.length - 1];
    if (last && last[1] === day - 1) last[1] = day;
    else runs.push([day, day]);
  }
  const names = runs.map(([from, to]) => {
    if (from === to) return WEEKDAYS[from - 1];
    return to === from + 1 ? `${WEEKDAYS[from - 1]}, ${WEEKDAYS[to - 1]}` : `${WEEKDAYS[from - 1]}\u2013${WEEKDAYS[to - 1]}`;
  });
  return `${names.join(", ")} ${block.start} to ${block.end}`;
}

/** Weekly busy hours on the You tab: a summary with Edit and Remove, or a button that opens the editor. */
function busyHoursPanel() {
  if (state.hoursDraft) return busyHoursEditor();
  const schedule = state.me.user.busyHours;
  if (!schedule?.blocks?.length) {
    return el("div", { class: "panel stack hours-panel" }, [
      el("h3", { text: "Weekly hours" }),
      el("p", { class: "help", text: "Set hours when you're usually busy, like weekdays 9 to 5. Friends only see that you're busy or free, and until when." }),
      el("button", { class: "btn secondary", type: "button", text: "Set weekly hours", onclick: editBusyHours }),
    ]);
  }
  return el("div", { class: "panel stack hours-panel" }, [
    el("h3", { text: "Weekly hours" }),
    el("div", { class: "hours-summary" }, schedule.blocks.map((block) => el("p", { text: busyBlockText(block) }))),
    el("p", { class: "help", text: `Times are in your time zone (${schedule.timezone}). Friends only see that you're busy or free, and until when.` }),
    el("div", { class: "status-actions" }, [
      el("button", { class: "btn secondary", type: "button", text: "Edit weekly hours", onclick: editBusyHours }),
      el("button", { class: "text-btn", type: "button", text: "Remove weekly hours", onclick: () => { void onRemoveBusyHours(); } }),
    ]),
  ]);
}

function editBusyHours() {
  const saved = state.me.user.busyHours?.blocks;
  state.hoursDraft = {
    blocks: saved?.length
      ? saved.map((block) => ({ days: [...block.days], start: block.start, end: block.end }))
      : [{ days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" }],
  };
  render();
}

function busyHoursEditor() {
  const draft = state.hoursDraft;
  const blocks = draft.blocks.map((block, index) => el("div", { class: "hours-block", "data-block": String(index) }, [
    el("div", { class: "hours-days", role: "group", "aria-label": `Days for block ${index + 1}` }, WEEKDAYS.map((name, i) => {
      const day = i + 1;
      const on = block.days.includes(day);
      return el("button", {
        type: "button",
        class: on ? "chip on" : "chip",
        "aria-pressed": on ? "true" : "false",
        text: name,
        onclick: () => {
          block.days = on ? block.days.filter((d) => d !== day) : [...block.days, day].sort((a, b) => a - b);
          render();
        },
      });
    })),
    el("div", { class: "hours-times" }, [
      el("label", { class: "field" }, [
        el("span", { text: "From" }),
        el("input", {
          class: "sheet-control hours-start",
          type: "time",
          value: block.start,
          oninput: (event) => { block.start = event.target.value; },
          onchange: (event) => { block.start = event.target.value; },
        }),
      ]),
      el("label", { class: "field" }, [
        el("span", { text: "To" }),
        el("input", {
          class: "sheet-control hours-end",
          type: "time",
          value: block.end,
          oninput: (event) => { block.end = event.target.value; },
          onchange: (event) => { block.end = event.target.value; },
        }),
      ]),
    ]),
    draft.blocks.length > 1
      ? el("button", {
          class: "text-btn",
          type: "button",
          text: "Remove",
          "aria-label": `Remove block ${index + 1}`,
          onclick: () => { draft.blocks.splice(index, 1); render(); },
        })
      : null,
  ]));
  return el("form", { class: "panel stack hours-panel hours-editor", onsubmit: onSaveBusyHours }, [
    el("h3", { text: "Weekly hours" }),
    ...blocks,
    draft.blocks.length < BUSY_BLOCKS_MAX
      ? el("button", {
          class: "text-btn",
          type: "button",
          text: "Add another block",
          onclick: () => { draft.blocks.push({ days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" }); render(); },
        })
      : null,
    el("p", { class: "help", text: `Times are in your time zone (${userTz()}). Friends only see that you're busy or free, and until when.` }),
    el("div", { class: "status-actions" }, [
      el("button", { class: "btn", type: "submit", text: "Save weekly hours" }),
      el("button", { class: "text-btn", type: "button", text: "Cancel", onclick: () => { state.hoursDraft = null; render(); } }),
    ]),
  ]);
}

async function onSaveBusyHours(event) {
  event.preventDefault();
  const draft = state.hoursDraft;
  if (!draft) return;
  await run(async () => {
    if (draft.blocks.some((block) => !block.days.length)) {
      state.error = "Pick at least one day";
      return;
    }
    const body = await api("/api/me/busy-hours", {
      method: "PUT",
      body: { timezone: userTz(), blocks: draft.blocks.map((block) => ({ days: block.days, start: block.start, end: block.end })) },
    });
    state.hoursDraft = null;
    state.me = await api("/api/me");
    state.error = body.schedule ? "Weekly hours saved" : "Weekly hours removed";
  });
}

async function onRemoveBusyHours() {
  await run(async () => {
    await api("/api/me/busy-hours", { method: "DELETE" });
    state.hoursDraft = null;
    state.me = await api("/api/me");
    state.error = "Weekly hours removed";
  });
}

function flicPanel(code) {
  const circles = state.me?.circles || [];
  const current = state.me?.circle;
  // With more than one circle the link names the circle on screen, like buzzNote.
  const aimed = circles.length > 1 && current;
  const link = `${location.origin}/api/buzz/${encodeURIComponent(code)}${aimed ? `?circle=${encodeURIComponent(current.id)}` : ""}`;
  return el("div", { class: "panel" }, [
    el("button", {
      class: "text-btn",
      type: "button",
      text: state.showButton ? "Hide button setup" : "Set up a Flic button",
      onclick: () => {
        state.showButton = !state.showButton;
        render();
      },
    }),
    state.showButton
      ? el("div", {}, [
          el("p", {
            class: "help",
            text: aimed
              ? `One press tells ${current.name} you're free now.`
              : "One press tells your circle you're free now.",
          }),
          el("pre", { class: "curl", text: link }),
          el("ol", { class: "guide-reenable" }, [
            "In the Flic app, open your button and choose Push.",
            "Add the Internet Request action.",
            "Paste this link as the URL, set the method to POST, and save.",
            "Optional: add the same link under Hold with the method DELETE. Holding the button then ends your social.",
          ].map((line) => el("li", { text: line }))),
          el("p", {
            class: "help",
            style: "margin-top: 12px",
            text: "Keep this link private. It contains your recovery code, and anyone with it can post as you.",
          }),
          el("button", {
            class: "btn secondary",
            type: "button",
            text: "Copy link",
            onclick: () => copyText(link, "Button link copied"),
          }),
        ])
      : null,
  ]);
}

const YOU_SECTIONS = [
  { id: "profile", title: "Profile" },
  { id: "availability", title: "Availability & calendar" },
  { id: "notifications", title: "Notifications" },
  { id: "assistants", title: "Assistants" },
  { id: "account", title: "Account" },
];

function openYouSection(id) {
  state.youSection = id;
  render();
}

function closeYouSection() {
  state.youSection = null;
  state.busyPreview = null;
  render();
}

function youSectionSummary(id) {
  if (id === "profile") return state.me.user.name;
  if (id === "availability") {
    const status = activeStatus(state.me.user.status);
    if (status) return statusLine(status, Date.now(), viewerTz());
    if (state.calendarSync?.source === "google") return "Google connected";
    if (state.me.user.calendarConnected || state.calendarSync?.connected) return "Calendar connected";
    return "No status";
  }
  if (id === "notifications") return notificationStatusLabel();
  if (id === "assistants") {
    const tokens = state.agentTokens;
    if (!tokens?.loaded || tokens.failed) return "";
    return tokens.tokens.length === 0 ? "No tokens" : tokens.tokens.length === 1 ? "1 token" : `${tokens.tokens.length} tokens`;
  }
  return "";
}

function youMenuRow(title, summary, onclick) {
  return el("button", { class: "row nav-row", type: "button", "aria-label": title, onclick }, [
    el("div", { class: "grow" }, [
      el("h3", { text: title }),
      summary ? el("p", { text: summary }) : null,
    ]),
    icon("chevron"),
  ]);
}

function youScreen() {
  if (state.youSection) return youSectionScreen(state.youSection);
  return el("div", {}, [
    screenHeader("You"),
    el("div", { class: "panel panel-rows" }, YOU_SECTIONS.map((section) => (
      youMenuRow(section.title, youSectionSummary(section.id), () => openYouSection(section.id))
    ))),
    el("div", { class: "panel panel-rows" }, [
      youMenuRow("What's new", "Recent changes to Hangry", () => { void openWhatsNewList(); }),
      youMenuRow("Send feedback", "Ideas, bugs, anything", openFeedback),
    ]),
  ]);
}

function youSectionScreen(id) {
  if (id === "availability" && state.busyPreview?.open) return busyPreviewScreen();
  const section = YOU_SECTIONS.find((item) => item.id === id);
  const bodies = {
    profile: profileSection,
    availability: () => [statusPanel(), friendsViewPanel(), busyHoursPanel(), calendarFeedPanel(), calendarSyncPanel()],
    notifications: notificationsSection,
    assistants: () => [agentTokensPanel()],
    account: accountSection,
  };
  return el("div", { class: "you-section" }, [
    el("header", { class: "chat-head" }, [
      el("button", { class: "text-btn chat-back", type: "button", text: "Back", onclick: closeYouSection }),
      el("h1", { text: section.title }),
      alertsBell(),
    ]),
    ...bodies[id](),
  ]);
}

/** One tap from Availability & calendar to what friends see. Shown with or without a calendar: weekly hours and status count too. */
function friendsViewPanel() {
  return el("div", { class: "panel panel-rows" }, [
    youMenuRow("See what friends see", "Your busy times, without event names", openBusyPreview),
  ]);
}

function openBusyPreview() {
  state.busyPreview = { open: true, loaded: false, data: null, error: "", busy: false };
  render();
  void loadBusyPreview();
}

function closeBusyPreview() {
  state.busyPreview = null;
  render();
}

async function loadBusyPreview() {
  const view = state.busyPreview;
  if (!view) return;
  try {
    const data = await api("/api/me/calendar-sync/preview", { circle: null });
    if (state.busyPreview !== view) return;
    view.data = data;
    view.error = "";
  } catch {
    if (state.busyPreview !== view) return;
    view.error = "Could not load. Try again.";
  }
  view.loaded = true;
  view.busy = false;
  render();
}

function retryBusyPreview() {
  const view = state.busyPreview;
  if (!view) return;
  view.loaded = false;
  view.error = "";
  render();
  void loadBusyPreview();
}

/** Same Check now as the calendar panel, then the preview and the panel's own state both show the new copy. */
async function onCheckBusyPreview() {
  const view = state.busyPreview;
  if (!view || view.busy) return;
  view.busy = true;
  view.refreshError = "";
  render();
  await onRefreshCalendar();
  if (state.busyPreview !== view) return;
  view.refreshError = state.calendarSync?.error || "";
  await loadBusyPreview();
}

/** Calendar blocks only count when a circle gets them. Weekly hours and the status go to every circle. */
function previewBlocks(data) {
  const calendar = data.sharedCircles.length ? data.calendar.map((span) => ({ ...span, source: data.source })) : [];
  return [...calendar, ...data.weekly.map((span) => ({ ...span, source: "weekly" }))];
}

function previewRow(time, tag) {
  return el("li", { class: "bp-row" }, [
    el("span", { class: "bp-time", text: time }),
    tag ? el("span", { class: "bp-tag", text: tag }) : null,
  ]);
}

function previewSync(data) {
  if (data.lastSyncOk === false) {
    const reason = state.calendarSync?.lastError || "The last check failed";
    return el("p", { class: "help bp-note bad", text: `${reason}. Friends see your last good copy for up to a day.` });
  }
  if (!data.lastSyncAt) return null;
  const today = zonedParts(Date.now(), appTz()).day;
  const day = zonedParts(data.lastSyncAt, appTz()).day;
  const when = day === today ? clock(data.lastSyncAt) : `${feedDate(data.lastSyncAt)} ${clock(data.lastSyncAt)}`;
  return el("p", { class: "help bp-note", text: `Last checked ${when}.` });
}

function busyPreviewBody(view) {
  if (view.error) {
    return [el("div", { class: "panel bp-state", role: "alert" }, [
      el("p", { class: "time-error", text: view.error }),
      el("button", { class: "btn secondary", type: "button", text: "Try again", onclick: retryBusyPreview }),
    ])];
  }
  if (!view.loaded || !view.data) return [el("div", { class: "panel" }, [el("p", { class: "help", text: "Loading…" })])];
  const data = view.data;
  const tz = viewerTz();
  const now = Date.now();
  const today = zonedParts(now, tz).day;
  const shared = data.sharedCircles.map((circle) => circle.name);
  const status = activeStatus(data.status, now);
  const days = busyByDay(previewBlocks(data), tz, now);
  const outOfDate = data.connected && (data.stale || !data.lastSyncAt);

  const who = [];
  if (data.connected && shared.length) {
    who.push(el("p", { class: "bp-shared", text: `Shared with: ${shared.join(", ")}` }));
  } else if (data.connected) {
    who.push(el("p", { class: "bp-shared", text: "Not shared with any circle. Friends see none of your calendar busy times." }));
    who.push(el("p", { class: "help", text: "Turn a circle on in Availability & calendar." }));
  }
  who.push(el("p", { class: "help", text: "Your weekly hours and your status are shown to everyone in your circles." }));

  const times = [];
  // A weekly-hours status is already one of the day rows below.
  const manual = status && status.source !== "schedule" ? status : null;
  if (manual) times.push(el("ul", { class: "bp-list" }, [previewRow(statusShort(manual, now, tz), "Status")]));
  for (const group of days) {
    times.push(el("h3", { class: "bp-day", text: dayLabel(group.day, today) }));
    times.push(el("ul", { class: "bp-list" }, group.spans.map((span) => previewRow(busySpanText(span, tz), sourceLabel(span.source)))));
  }
  if (outOfDate) times.push(el("p", { class: "time-error bp-stale", text: "Your calendar is out of date, so friends see nothing from it. Tap Check now." }));
  else if (!manual && !days.length) times.push(el("p", { class: "help bp-empty", text: "Nothing busy. Friends see you as free." }));

  const foot = [];
  if (data.connected) {
    foot.push(previewSync(data));
    if (view.refreshError) foot.push(el("p", { class: "time-error sync-error", role: "alert", text: view.refreshError }));
    foot.push(el("button", {
      class: "text-btn",
      type: "button",
      text: view.busy ? "Checking…" : "Check now",
      disabled: view.busy,
      onclick: () => { void onCheckBusyPreview(); },
    }));
    foot.push(el("p", { class: "help bp-note", text: "Something wrong? Fix it in your calendar, then tap Check now. Changes show here within a minute." }));
  }
  return [
    el("div", { class: "panel" }, [
      el("p", { class: "bp-intro", text: "This is what friends in your circles see. They never see event names." }),
      ...who,
    ]),
    el("section", { class: "panel bp-times", "aria-label": "Busy times" }, times),
    foot.length ? el("div", { class: "panel bp-foot" }, foot) : null,
  ];
}

function busyPreviewScreen() {
  return el("div", { class: "you-section busy-preview" }, [
    el("header", { class: "chat-head" }, [
      el("button", { class: "text-btn chat-back", type: "button", text: "Back", onclick: closeBusyPreview }),
      el("h1", { text: "What friends see" }),
      alertsBell(),
    ]),
    ...busyPreviewBody(state.busyPreview),
  ]);
}

function profileSection() {
  const hasPhoto = Boolean(state.me.user.avatarRev);
  return [
    el("div", { class: "profile-hero" }, [
      el("button", {
        class: "avatar-btn",
        type: "button",
        "aria-label": hasPhoto ? "Change photo" : "Add photo",
        disabled: state.avatarBusy,
        onclick: pickPhoto,
      }, [avatar(state.me.user, 72, "lg")]),
      el("strong", { text: state.me.user.name }),
      el("div", { class: "photo-actions" }, state.avatarBusy
        ? [el("span", { class: "help", text: "Saving photo…" })]
        : [
            el("button", { class: "text-btn", type: "button", text: hasPhoto ? "Change photo" : "Add photo", onclick: pickPhoto }),
            hasPhoto ? el("button", { class: "text-btn", type: "button", text: "Remove photo", onclick: () => { void onRemovePhoto(); } }) : null,
          ]),
    ]),
    el("form", { class: "panel stack", onsubmit: onRename }, [
      field("Your name", "rename", state.me.user.name, () => {}, { maxlength: "24" }),
      el("button", { class: "btn secondary", type: "submit", text: "Save name" }),
      el("p", { class: "help", text: "Friends see this name on your cards." }),
    ]),
  ];
}

function notificationsSection() {
  return [
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
  ];
}

function accountSection() {
  const code = state.me.user.buzzToken;
  return [
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
    flicPanel(code),
    el("div", { class: "panel stack" }, [
      el("button", { class: "btn danger", type: "button", text: "Leave circle", onclick: onLeave }),
      el("button", { class: "btn ghost", type: "button", text: "Sign out", onclick: onLogout }),
    ]),
  ];
}

function calendarFeedPanel() {
  if (!state.calendarFeed) void loadCalendarFeed();
  const feed = state.calendarFeed || { loaded: false };
  const head = [
    el("h3", { text: "Calendar feed" }),
    el("p", { text: "Your plans in your calendar app: ones you host or said in or maybe to. Your calendar app decides how often it checks for changes, which can take hours." }),
  ];
  if (!feed.loaded) return el("section", { class: "panel calendar-feed", "aria-label": "Calendar feed" }, [...head, el("p", { class: "help", text: "Loading…" })]);
  if (!feed.active) {
    return el("section", { class: "panel calendar-feed", "aria-label": "Calendar feed" }, [
      ...head,
      el("button", { class: "btn secondary", type: "button", text: "Turn on calendar feed", disabled: feed.busy, onclick: () => { void onIssueCalendarFeed(); } }),
    ]);
  }
  return el("section", { class: "panel calendar-feed", "aria-label": "Calendar feed" }, [
    ...head,
    feed.url
      ? calendarFeedLink(feed)
      : el("p", { class: "help feed-once", text: `On since ${feedDate(feed.createdAt)}. The link is only shown once. To add it to another calendar, use Reset link (the old link stops working).` }),
    el("div", { class: "feed-manage" }, [
      el("button", { class: "text-btn", type: "button", text: "Reset link", disabled: feed.busy, onclick: onResetCalendarFeed }),
      el("button", { class: "text-btn danger", type: "button", text: "Turn off", disabled: feed.busy, onclick: onRevokeCalendarFeed }),
    ]),
  ]);
}

function calendarFeedLink(feed) {
  const platform = calendarPlatform(navigator.userAgent);
  const copy = el("button", { class: platform === "apple" ? "btn ghost" : "btn secondary", type: "button", text: "Copy link", onclick: () => { void copyFeedLink(feed.url); } });
  // Only Apple has a calendar app that opens webcal:// links. Elsewhere that link does nothing.
  const actions = platform === "apple"
    ? [el("a", { class: "btn secondary link-btn", href: feed.webcalUrl, text: "Open in Apple Calendar" }), copy]
    : [copy, typeof navigator.share === "function" ? el("button", { class: "btn ghost", type: "button", text: "Send link", onclick: () => { void shareFeedLink(feed.url); } }) : null];
  return el("div", { class: "stack feed-link" }, [
    el("p", { class: "feed-url", text: feed.url }),
    el("p", { class: "help", text: "Keep this link private. Anyone with it can see these plans. It is shown only now." }),
    ...actions,
    el("ul", { class: "feed-steps" }, calendarFeedSteps(platform).map((line) => el("li", { text: line }))),
  ]);
}

/** Copies inside the tap so an installed PWA still has permission; falls back to a hidden field. */
async function copyFeedLink(url) {
  let copied = false;
  try {
    await navigator.clipboard.writeText(url);
    copied = true;
  } catch {
    copied = copyWithSelection(url);
  }
  state.error = copied ? "Link copied" : "Copy failed. Press and hold the link to copy it.";
  render();
  if (!copied) selectFeedUrl();
  scheduleErrorClear();
}

function copyWithSelection(value) {
  const field = el("textarea", { readonly: "", "aria-hidden": "true", class: "copy-buffer" });
  field.value = value;
  document.body.append(field);
  try {
    field.focus({ preventScroll: true });
    field.select();
    field.setSelectionRange(0, value.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    field.remove();
  }
}

function selectFeedUrl() {
  const node = document.querySelector(".calendar-feed .feed-url");
  const selection = window.getSelection();
  if (!node || !selection) return;
  const range = document.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);
}

async function shareFeedLink(url) {
  try {
    await navigator.share({ title: "Hangry calendar", url });
  } catch (error) {
    if (error?.name !== "AbortError") await copyFeedLink(url);
  }
}

/** The feed link shows once. Once the Availability & calendar screen is not on show, it is gone for good. */
function forgetShownFeedLink() {
  if (!state.calendarFeed?.url) return;
  if (state.tab === "you" && state.youSection === "availability" && !state.chat && !state.past) return;
  state.calendarFeed = { ...state.calendarFeed, url: "", webcalUrl: "" };
}

function feedDate(ms) {
  if (!ms) return "today";
  return new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: appTz() });
}

async function loadCalendarFeed() {
  state.calendarFeed = { loaded: false };
  try {
    const data = await api("/api/me/calendar-feed", { circle: null });
    if (!state.calendarFeed || state.calendarFeed.loaded) return;
    state.calendarFeed = { loaded: true, active: data.active, createdAt: data.createdAt };
  } catch {
    state.calendarFeed = { loaded: true, active: false, createdAt: null };
  }
  // Swap only the feed section so the rest of the You tab stays attached.
  document.querySelector(".calendar-feed")?.replaceWith(calendarFeedPanel());
}

async function onIssueCalendarFeed() {
  state.calendarFeed = { ...(state.calendarFeed || {}), busy: true };
  render();
  await run(async () => {
    try {
      const data = await api("/api/me/calendar-feed", { method: "POST", body: {}, circle: null });
      state.calendarFeed = { loaded: true, active: true, createdAt: data.createdAt, url: data.url, webcalUrl: data.webcalUrl };
    } finally {
      if (state.calendarFeed) state.calendarFeed.busy = false;
    }
  });
}

function onResetCalendarFeed() {
  state.confirm = {
    title: "Reset calendar link?",
    body: "The old link stops working. Calendars that use it stop updating until you add the new link.",
    confirmLabel: "Reset link",
    action: onIssueCalendarFeed,
  };
  render();
}

function onRevokeCalendarFeed() {
  state.confirm = {
    title: "Turn off calendar feed?",
    body: "The link stops working. Calendars that use it stop updating, and may keep showing old plans until you remove the subscription there.",
    confirmLabel: "Turn off",
    action: async () => {
      await run(async () => {
        await api("/api/me/calendar-feed", { method: "DELETE", circle: null });
        state.calendarFeed = { loaded: true, active: false, createdAt: null };
        state.error = "Calendar feed is off";
      });
    },
  };
  render();
}

/** Assistant tokens: an outside assistant acts as this person. The full token shows once, right after making it. */
function agentTokensPanel() {
  if (!state.agentTokens) void loadAgentTokens();
  const data = state.agentTokens || { loaded: false };
  const wrap = (kids) => el("section", { class: "panel agent-tokens", "aria-label": "Assistant tokens" }, [
    el("h3", { text: "Assistant tokens" }),
    el("p", { text: "A token lets an assistant act as you: read your circles, set your status, create plans and say you are in. Friends see those actions as you. You can revoke a token at any time and it stops working at once. The full token is shown only once, so copy it now." }),
    ...kids,
  ]);
  if (!data.loaded) return wrap([el("p", { class: "help", text: "Loading…" })]);
  const tokens = data.tokens || [];
  return wrap([
    data.secret ? agentTokenSecret(data.secret) : null,
    el("form", { class: "stack", novalidate: "", onsubmit: (event) => { event.preventDefault(); void onCreateAgentToken(); } }, [
      el("label", { class: "field" }, [
        el("span", { text: "Token name" }),
        el("input", {
          id: "agent-token-name",
          type: "text",
          maxlength: "40",
          autocomplete: "off",
          placeholder: "Grok Bot",
          value: data.draft || "",
          oninput: (event) => { state.agentTokens.draft = event.target.value; },
        }),
      ]),
      el("button", { class: "btn secondary", type: "submit", text: data.busy ? "Creating…" : "Create token", disabled: data.busy }),
    ]),
    data.failed ? el("p", { class: "help", text: "Could not load your tokens." }) : null,
    tokens.length || data.failed ? null : el("p", { class: "help", text: "No tokens yet. Name one after the assistant you want to use it with." }),
    tokens.length ? el("ul", { class: "agent-token-list" }, tokens.map(agentTokenRow)) : null,
  ]);
}

function agentTokenSecret(secret) {
  return el("div", { class: "stack agent-token-once" }, [
    el("p", { class: "agent-token-secret", text: secret }),
    el("p", { class: "help", text: "It will not be shown again. Copy it now and keep it private." }),
    el("button", { class: "btn secondary", type: "button", text: "Copy", onclick: () => { void copyAgentToken(secret); } }),
  ]);
}

function agentTokenRow(token) {
  const used = token.lastUsedAt ? `Last used ${feedDate(token.lastUsedAt)}` : "Not used yet";
  return el("li", { class: "agent-token-row" }, [
    el("div", { class: "grow" }, [
      el("strong", { text: token.name }),
      el("p", { class: "help", text: `${token.tokenPrefix}… · Made ${feedDate(token.createdAt)} · ${used}` }),
    ]),
    el("button", {
      class: "text-btn danger",
      type: "button",
      text: "Revoke",
      "aria-label": `Revoke ${token.name}`,
      onclick: () => onRevokeAgentToken(token),
    }),
  ]);
}

async function copyAgentToken(secret) {
  let copied = false;
  try {
    await navigator.clipboard.writeText(secret);
    copied = true;
  } catch {
    copied = copyWithSelection(secret);
  }
  state.error = copied ? "Token copied" : "Copy failed. Press and hold the token to copy it.";
  render();
  scheduleErrorClear();
}

/** The token shows once. Once the Assistants screen is not on show, it is gone for good. */
function forgetShownAgentToken() {
  if (!state.agentTokens?.secret) return;
  if (state.tab === "you" && state.youSection === "assistants" && !state.chat && !state.past) return;
  state.agentTokens = { ...state.agentTokens, secret: "" };
}

async function loadAgentTokens() {
  state.agentTokens = { loaded: false };
  try {
    const data = await api("/api/me/agent-tokens", { circle: null });
    if (!state.agentTokens || state.agentTokens.loaded) return;
    state.agentTokens = { loaded: true, tokens: data.tokens, draft: "" };
  } catch {
    state.agentTokens = { loaded: true, failed: true, tokens: [], draft: "" };
  }
  document.querySelector(".agent-tokens")?.replaceWith(agentTokensPanel());
}

async function onCreateAgentToken() {
  const data = state.agentTokens;
  if (!data?.loaded || data.busy) return;
  data.busy = true;
  render();
  await run(async () => {
    try {
      const made = await api("/api/me/agent-tokens", { method: "POST", body: { name: data.draft || "" }, circle: null });
      const list = await api("/api/me/agent-tokens", { circle: null });
      state.agentTokens = { loaded: true, tokens: list.tokens, draft: "", secret: made.token };
    } finally {
      if (state.agentTokens) state.agentTokens.busy = false;
    }
  });
}

function onRevokeAgentToken(token) {
  state.confirm = {
    title: `Revoke ${token.name}?`,
    body: "It stops working at once. Anything using it loses access until you make a new token.",
    confirmLabel: "Revoke",
    action: async () => {
      await run(async () => {
        await api(`/api/me/agent-tokens/${encodeURIComponent(token.id)}`, { method: "DELETE", circle: null });
        const list = await api("/api/me/agent-tokens", { circle: null });
        state.agentTokens = { ...state.agentTokens, tokens: list.tokens, secret: "" };
        state.error = "Token revoked";
      });
    },
  };
  render();
}

const CALENDAR_SYNC_STEPS = [
  "Google Calendar on a computer: Settings, pick your calendar, Integrate calendar, then copy Secret address in iCal format.",
  "Outlook on the web: Settings, Calendar, Shared calendars, Publish a calendar, then copy the ICS link.",
  "iCloud: in the Calendar app tap the info button next to a calendar, turn on Public Calendar, then Share Link.",
];

const GOOGLE_PERMISSIONS_URL = "https://myaccount.google.com/permissions";
const SECRET_LINK_NOTE = "A private calendar link lets Hangry download the whole calendar file, including event names. Hangry keeps only the times, plus your event names encrypted for you alone (so you can see them when you tap I'm in). It discards places, notes and people. Friends still only see busy or free.";

function permissionsLink() {
  return el("a", { href: GOOGLE_PERMISSIONS_URL, target: "_blank", rel: "noopener noreferrer", text: "myaccount.google.com/permissions" });
}

/** Plain words on what Hangry can and cannot see once Google is connected. */
function googleFacts() {
  return el("div", { class: "sync-facts" }, [
    el("h4", { text: "What Hangry can and can't see" }),
    el("ul", { class: "feed-steps" }, [
      el("li", { text: "Hangry only sees when you're busy, never event names, places, people or notes." }),
      el("li", { text: "Hangry asks Google only for the free/busy permission, and Google's consent screen says so. Hangry never receives event titles or details, and never stores them." }),
      el("li", { text: "Hangry stores only your busy times for the next 14 days, plus an encrypted token so it can check again." }),
      el("li", { text: "Hangry checks about every 20 minutes." }),
      el("li", {}, ["The ", el("a", { href: "/privacy", text: "privacy policy" }), " has the same details."]),
      el("li", {}, [
        "To disconnect, tap Remove in this panel. Hangry deletes the token and the busy times, and tells Google to revoke access. You can also revoke Hangry at ",
        permissionsLink(),
        ".",
      ]),
    ]),
  ]);
}

/** Import side of calendars: friends see busy or free, never titles. The link never comes back from the server. */
function calendarSyncPanel() {
  if (!state.calendarSync) void loadCalendarSync();
  const sync = state.calendarSync || { loaded: false };
  const head = [
    el("h3", { text: "Calendar availability" }),
    el("p", { text: "Friends in circles you pick see when you're busy or free. They never see what is in your calendar." }),
  ];
  const wrap = (kids) => el("section", { class: "panel calendar-sync", "aria-label": "Calendar availability" }, [...head, ...kids]);
  if (!sync.loaded) return wrap([el("p", { class: "help", text: "Loading…" })]);
  const error = sync.error ? el("p", { class: "time-error sync-error", role: "alert", text: sync.error }) : null;
  if (!sync.connected) {
    const google = Boolean(sync.googleAvailable);
    return wrap([
      google ? el("button", {
        class: "btn sync-google",
        type: "button",
        text: sync.googleBusy ? "Connecting…" : "Connect Google Calendar",
        disabled: sync.busy,
        onclick: () => { void onConnectGoogle(); },
      }) : null,
      google && sync.googleError ? el("p", { class: "time-error sync-error", role: "alert", text: sync.googleError }) : null,
      google ? googleFacts() : null,
      google ? el("p", { class: "sheet-label sync-label", text: "Or use a private calendar link" }) : null,
      el("form", { class: "stack", novalidate: "", onsubmit: (event) => { event.preventDefault(); void onConnectCalendar(); } }, [
        el("label", { class: "field" }, [
          el("span", { text: "Private calendar link" }),
          el("input", {
            id: "calendar-sync-url",
            class: "calendar-url",
            type: "url",
            inputmode: "url",
            autocomplete: "off",
            autocapitalize: "off",
            spellcheck: "false",
            placeholder: "https://… .ics",
            value: sync.draft || "",
            oninput: (event) => { state.calendarSync.draft = event.target.value; },
          }),
        ]),
        error,
        el("button", { class: "btn secondary", type: "submit", text: sync.busy && !sync.googleBusy ? "Connecting…" : "Connect calendar", disabled: sync.busy }),
      ]),
      el("p", { class: "help sync-note secret-link-note", text: SECRET_LINK_NOTE }),
      el("p", { class: "help sync-note", text: "It stays off for every circle until you turn one on. Hangry keeps the link encrypted and never shows it again." }),
      el("ul", { class: "feed-steps" }, CALENDAR_SYNC_STEPS.map((line) => el("li", { text: line }))),
    ]);
  }
  const isGoogle = sync.source === "google";
  const circles = sync.circles || [];
  const shared = new Set(sync.sharedCircleIds || []);
  return wrap([
    el("p", { class: "sync-host", text: `Connected: ${sync.host || "calendar"}` }),
    syncStatusLine(sync),
    error,
    el("p", { class: "sheet-label sync-label", text: "Show busy or free in" }),
    el("div", { class: "sync-circles" }, circles.map((circle) => el("label", { class: "share-toggle" }, [
      el("input", {
        type: "checkbox",
        checked: shared.has(circle.id),
        disabled: sync.busy,
        onchange: (event) => { void onShareCalendar(circle.id, event.target.checked); },
      }),
      el("span", { text: circle.name }),
    ]))),
    shared.size ? null : el("p", { class: "help sync-note", text: "Off everywhere. Tick a circle to share." }),
    isGoogle
      ? el("p", { class: "help sync-note", text: "Hangry never sees the names of your events, so they will not appear when you tap I'm in." })
      : el("p", { class: "help sync-note", text: "When you tap I'm in, you see your own events for that day first. Only you see them." }),
    isGoogle ? el("p", { class: "help sync-note" }, ["You can revoke Hangry any time at ", permissionsLink(), "."]) : null,
    el("div", { class: "feed-manage" }, [
      el("button", { class: "text-btn", type: "button", text: "Check now", disabled: sync.busy, onclick: () => { void onRefreshCalendar(); } }),
      el("button", { class: "text-btn danger", type: "button", text: "Remove", disabled: sync.busy, onclick: onRemoveCalendar }),
    ]),
  ]);
}

function syncStatusLine(sync) {
  if (sync.lastSyncOk === false) {
    return el("div", { class: "sync-status bad" }, [
      el("p", { class: "help", text: `${sync.lastError || "The last check failed"}. Friends see your last good copy for up to a day.` }),
      el("button", { class: "text-btn", type: "button", text: "Try again", disabled: sync.busy, onclick: () => { void onRefreshCalendar(); } }),
    ]);
  }
  if (!sync.lastSyncAt) return el("p", { class: "help sync-status", text: "Checking your calendar…" });
  const today = zonedParts(Date.now(), appTz()).day;
  const day = zonedParts(sync.lastSyncAt, appTz()).day;
  const when = day === today ? clock(sync.lastSyncAt) : `${feedDate(sync.lastSyncAt)} ${clock(sync.lastSyncAt)}`;
  return el("p", { class: "help sync-status", text: `Last checked ${when}. Hangry checks about every 20 minutes.` });
}

function paintCalendarSync() {
  const node = document.querySelector(".calendar-sync");
  if (node) node.replaceWith(calendarSyncPanel());
  else render();
}

function applyCalendarSync(data, extra = {}) {
  state.calendarSync = { loaded: true, ...data, draft: "", busy: false, googleBusy: false, error: "", googleError: "", ...extra };
  if (state.me?.user) state.me.user.calendarConnected = Boolean(data.connected);
}

async function loadCalendarSync() {
  state.calendarSync = { loaded: false };
  try {
    const data = await api("/api/me/calendar-sync", { circle: null });
    if (!state.calendarSync || state.calendarSync.loaded) return;
    applyCalendarSync(data);
  } catch {
    state.calendarSync = { loaded: true, connected: false, circles: [], sharedCircleIds: [], draft: "" };
  }
  document.querySelector(".calendar-sync")?.replaceWith(calendarSyncPanel());
}

/** Shows the server's short reason in the panel, never the link itself. */
function calendarSyncError(error) {
  if (error?.status === 400 && error.data?.error) return String(error.data.error);
  if (error?.status === 429) return "That's a lot at once. Try again in a minute.";
  return isNetworkFailure(error) ? "You're offline. Try again." : "Something went wrong. Try again.";
}

async function calendarSyncCall(path, options, after) {
  const draft = state.calendarSync?.draft || "";
  state.calendarSync = { ...(state.calendarSync || { loaded: true }), busy: true, error: "" };
  paintCalendarSync();
  try {
    const data = await api(path, { ...options, circle: null });
    applyCalendarSync(data);
    after?.(data);
  } catch (error) {
    state.calendarSync = { ...state.calendarSync, busy: false, draft, error: calendarSyncError(error) };
  }
  paintCalendarSync();
}

async function onConnectCalendar() {
  const url = (document.getElementById("calendar-sync-url")?.value || state.calendarSync?.draft || "").trim();
  if (!url) {
    state.calendarSync = { ...state.calendarSync, error: "Paste your private calendar link first." };
    paintCalendarSync();
    return;
  }
  state.calendarSync.draft = url;
  await calendarSyncCall("/api/me/calendar-sync", { method: "PUT", body: { url } });
}

/** Asks the server for Google's consent URL and leaves for it. The URL is never shown. */
async function onConnectGoogle() {
  if (state.calendarSync?.busy) return;
  state.calendarSync = { ...state.calendarSync, busy: true, googleBusy: true, error: "", googleError: "" };
  paintCalendarSync();
  try {
    const data = await api("/api/calendar/google/start", { circle: null });
    if (typeof data?.url !== "string" || !data.url) throw new Error("no url");
    location.href = data.url;
  } catch (error) {
    const message = error?.status === 429
      ? "That's a lot at once. Try again in a minute."
      : isNetworkFailure(error) ? "You're offline. Try again." : "Could not reach Google Calendar. Try again.";
    state.calendarSync = { ...state.calendarSync, busy: false, googleBusy: false, googleError: message };
    paintCalendarSync();
  }
}

/** Coming back from Google (or Back from its page) must not leave the button stuck on Connecting. */
window.addEventListener("pageshow", (event) => {
  if (!event.persisted || !state.calendarSync?.googleBusy) return;
  state.calendarSync = { ...state.calendarSync, busy: false, googleBusy: false };
  paintCalendarSync();
});

/** The return trip from Google: open the You tab, say how it went, and let the panel load fresh. */
function landCalendar() {
  if (!calendarLanding || !state.token || !state.me?.circle) return;
  state.tab = "you";
  state.youSection = "availability";
  state.calendarSync = null;
  state.busyPreview = null;
  state.error = calendarLanding === "google" ? "Google Calendar connected" : "Could not connect Google Calendar. Try again.";
}

/** The app stayed in the background while Google ran in another tab. On return, notice a new Google connection. */
let googleReturnChecking = false;
async function checkGoogleReturn() {
  const before = state.calendarSync;
  if (googleReturnChecking || document.hidden || !state.token || !state.me?.circle) return;
  if (!before?.loaded || before.source === "google" || (before.busy && !before.googleBusy)) return;
  googleReturnChecking = true;
  try {
    const data = await api("/api/me/calendar-sync", { circle: null });
    if (data?.source !== "google" || state.calendarSync !== before || !state.token) return;
    applyCalendarSync(data);
    if (state.chat) {
      state.chat = null;
      state.chatThread = null;
    }
    state.tab = "you";
    state.sheet = null;
    state.error = "Google Calendar connected";
    render();
    scheduleErrorClear();
  } catch {
    // Offline or signed out: the next return will look again.
  } finally {
    googleReturnChecking = false;
  }
}

async function onRefreshCalendar() {
  await calendarSyncCall("/api/me/calendar-sync/refresh", { method: "POST", body: {} });
}

async function onShareCalendar(circleId, on) {
  const ids = new Set(state.calendarSync?.sharedCircleIds || []);
  if (on) ids.add(circleId);
  else ids.delete(circleId);
  await calendarSyncCall("/api/me/calendar-sync", { method: "PATCH", body: { sharedCircleIds: [...ids] } });
}

function onRemoveCalendar() {
  const google = state.calendarSync?.source === "google";
  state.confirm = {
    title: "Remove calendar?",
    body: google
      ? "Friends stop seeing when you're busy. Hangry deletes the token and the busy times, and tells Google to revoke access."
      : "Friends stop seeing when you're busy. Hangry deletes the link and everything it read from it.",
    confirmLabel: "Remove",
    action: async () => {
      await calendarSyncCall("/api/me/calendar-sync", { method: "DELETE" });
    },
  };
  render();
}

/** Busy or free right now for a member who shares with this circle, from the circle payload. */
function memberAvailability(id) {
  return state.me?.circle?.members?.find((member) => member.id === id)?.availability || null;
}

function availabilityLine(availability, from = Date.now()) {
  const text = availabilityText(availability, from, viewerTz());
  if (!text) return null;
  return el("p", { class: `avail-line ${availability.state}` }, [
    el("span", { class: "avail-dot", "aria-hidden": "true" }),
    el("span", { text }),
  ]);
}

function tabbar(fresh = false) {
  const tabs = [
    ["home", "Now", "home"],
    // The Events tab (formerly Map): the id stays "map" so routing and hashes do not move.
    ["map", "Events", "calendar"],
    ["chat", "Chat", "chat"],
    ["circle", "Circle", "compass"],
    ["you", "You", "person"],
  ];
  const unread = circleUnread();
  return el("nav", { class: "tabbar" }, tabs.map(([id, label, glyph]) => {
    const current = state.tab === id;
    const name = id === "chat" && unread ? `Chat, ${unread} unread` : label;
    return el("button", {
      class: current && fresh ? "tab tab-in" : "tab",
      type: "button",
      "aria-label": name,
      "aria-current": current ? "page" : null,
      onclick: () => {
        // Chat is its own screen, not a page. A tap on the page already showing is not a switch.
        if (id !== "chat" && (id !== state.tab || state.chat)) pageEntrance = true;
        void onTab(id);
      },
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
            ? "Notifications are on for this phone."
            : "Allow notifications so a friend can reach this phone.",
        }),
      ]),
      state.pushOn
        ? el("button", {
            class: "btn secondary",
            type: "button",
            text: state.pushBusy ? "Waiting…" : "Turn off notifications",
            disabled: state.pushBusy,
            onclick: () => { void onDisablePush(); },
          })
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
  const status = statusLine(member.status, Date.now(), viewerTz());
  return el("div", { class: "row member-row" }, [
    el("button", {
      class: "member-open",
      type: "button",
      "aria-label": `Details for ${member.name}`,
      onclick: () => openMemberMenu(member),
    }, [
      avatar(member, 40),
      el("div", { class: "grow" }, [
        el("h3", {}, [
          el("span", { text: member.name }),
          member.admin ? el("span", { class: "admin-badge", text: "Admin" }) : null,
        ]),
        status ? el("p", { class: "status-line", "data-status": member.status.type, text: status }) : null,
        line ? el("p", { text: line }) : null,
        self ? null : availabilityLine(member.availability),
      ]),
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

/** Away / Busy with its note, place and end day, for the member sheet. */
function statusCard(person) {
  const status = activeStatus(person?.status);
  if (!status) return null;
  const until = statusUntilText(status.until, Date.now(), viewerTz());
  return el("div", { class: "status-card", "data-status": status.type }, [
    el("p", { class: "status-card-head" }, [
      el("span", { class: "status-card-mark", "aria-hidden": "true", text: statusBadge(status.type) }),
      el("strong", { text: statusLabel(status.type) }),
    ]),
    status.text ? el("p", { class: "status-card-text", text: status.text }) : null,
    status.place ? el("p", { class: "status-card-meta", text: status.place }) : null,
    el("p", { class: "status-card-meta", text: until ? until.charAt(0).toUpperCase() + until.slice(1) : "No end day" }),
  ]);
}

function memberSheet() {
  const member = state.memberMenu;
  if (!member) return el("div");
  const manage = youAreAdmin() && member.id !== state.me.user.id;
  return el("div", {}, [
    el("button", { class: "scrim", type: "button", "aria-label": "Close", onclick: closeSheet }),
    el("div", { class: "sheet", role: "dialog", "aria-label": member.name }, [
      el("div", { class: "sheet-head" }, [
        el("div", { class: "grabber" }),
        el("h2", { text: member.name }),
        el("p", { class: "help", text: [member.admin ? "Admin" : "Member", reachText(member.reach)].filter(Boolean).join(" · ") }),
      ]),
      statusCard(member),
      manage
        ? el("div", { class: "actions" }, [
            member.admin
              ? el("button", { class: "action", type: "button", text: "Remove admin", onclick: () => setMemberAdmin(member, false) })
              : el("button", { class: "action", type: "button", text: "Make admin", onclick: () => setMemberAdmin(member, true) }),
            el("button", {
              class: "action",
              type: "button",
              text: "Remove from circle",
              onclick: () => confirmRemoveMember(member),
            }),
          ])
        : el("div", { class: "actions" }, [el("button", { class: "action", type: "button", text: "Close", onclick: closeSheet })]),
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

function openEventDetail(kind, item, from = "") {
  if (!item?.id) return;
  state.cardMenu = null;
  state.eventDetail = { kind, id: item.id, from };
  state.sheet = "event-detail";
  render();
}

function eventDetailItem() {
  const detail = state.eventDetail;
  if (!detail) return null;
  return findEvent(detail.kind, detail.id);
}

/** An event by id from Home, then the map, then the calendar month. */
function findEvent(kind, id) {
  const lists = kind === "plan"
    ? [state.plans, mapEvents().plans, state.calendarPlans]
    : [state.socials, mapEvents().socials, state.calendarSocials];
  for (const list of lists) {
    const found = list.find((row) => row.id === id);
    if (found) return found;
  }
  return null;
}

function eventDetailSheet() {
  const detail = state.eventDetail;
  const item = eventDetailItem();
  if (!detail || !item) {
    return el("div", {}, [
      el("button", { class: "scrim", type: "button", "aria-label": "Close", onclick: closeSheet }),
      el("div", { class: "sheet", role: "dialog", "aria-label": "Details" }, [
        el("div", { class: "sheet-head" }, [
          el("div", { class: "grabber" }),
          el("h2", { text: "Details" }),
          el("p", { class: "help", text: "This hangout is gone." }),
        ]),
      ]),
    ]);
  }
  const kind = detail.kind;
  const title = item.note || (kind === "plan" ? "Plan" : "Free now");
  const calendar = detail.from === "calendar";
  const over = calendar && (kind === "plan" ? calPlanOver(item) : calSocialOver(item));
  const mine = item.creator?.id === state.me.user.id;
  let when;
  if (kind === "plan") when = `${item.whenLabel}${item.time ? ` · ${item.time}` : ""}${over ? " · Ended" : ""}`;
  else if (over) when = `${shortDate(calSocialDay(item), calToday())} · ${clock(item.startsAt ?? item.createdAt)} · Ended`;
  else when = item.startsAt && item.startsAt > Date.now() ? `from ${clock(item.startsAt)}` : remaining(item.expiresAt);
  const crowd = cardCrowd(item.creator, item.joined);
  const line = (person) => (kind === "plan" ? planReplyLine(person) : replyLine(person, item));
  const personRow = (text, person) => over
    ? el("div", { class: "guest-row" }, [avatar(person), el("p", { class: "reply-line", text })])
    : guestDetailRow(text, person, kind, item);
  return el("div", {}, [
    el("button", { class: "scrim", type: "button", "aria-label": "Close", onclick: closeSheet }),
    el("div", { class: "sheet", role: "dialog", "aria-label": "Details" }, [
      el("div", { class: kind === "plan" ? `sheet-head card-grad ${gradientClass(item.id)}` : "sheet-head" }, [
        el("div", { class: "grabber" }),
        el("h2", { text: title }),
        el("p", { class: "help", text: `${when} · ${item.creator.name}` }),
      ]),
      el("div", { class: "sheet-scroll" }, [
        calendar ? mapCircleLine(item) : null,
        calendar && kind === "plan" ? planCirclesLine(item) : null,
        kind === "plan" && item.description ? el("p", { class: "detail-desc" }, linkify(item.description)) : null,
        item.place || item.location ? el("p", { class: "detail-place", text: audiencePlace(item.place) || "nearby" }) : null,
        deliveryLine(kind, item),
        calendar ? el("div", { class: "detail-actions" }, [
          chatRow(kind, item),
          over ? null : cardActions(kind, item, { locked: mine }),
        ]) : null,
        el("h3", { class: "members-title", text: "Who's in" }),
        el("div", { class: "list" }, crowd.people.map((person) => personRow(
          person.id === item.creator.id ? `${person.name} · host` : line(person), person,
        ))),
        crowd.cant.length ? el("h3", { class: "members-title", text: "Can't make it" }) : null,
        crowd.cant.length ? el("div", { class: "list cant-list" }, crowd.cant.map((person) => (
          personRow(line(person), person)
        ))) : null,
      ]),
    ]),
  ]);
}

function canManageEvent(item) {
  return Boolean(item?.creator) && (item.creator.id === state.me.user.id || adminOver(item));
}

/** Admins manage events of their own circle. A shared plan belongs to its home circle (circles[0]). */
function adminOver(item) {
  const home = item?.circles?.[0]?.id;
  return youAreAdmin() && (!home || home === state.me?.circle?.id);
}

function cardMenuKey(kind, item) {
  return `${kind}:${item.id}`;
}

function placeOpenCardMenus() {
  const gap = 8;
  const tabbar = document.querySelector(".tabbar");
  const tabTop = tabbar ? tabbar.getBoundingClientRect().top : window.innerHeight;
  const floor = Math.min(window.innerHeight, tabTop > 0 ? tabTop : window.innerHeight) - gap;
  document.querySelectorAll(".card-menu").forEach((menu) => {
    const more = menu.parentElement?.querySelector(".card-more");
    if (!more) return;
    menu.classList.remove("drop-up");
    menu.style.maxHeight = "";
    menu.style.right = "";
    const btn = more.getBoundingClientRect();
    const natural = menu.scrollHeight;
    const below = floor - btn.bottom - 4;
    const above = btn.top - 4 - gap;
    let room = below;
    if (natural > below && above > below) {
      menu.classList.add("drop-up");
      room = above;
    }
    if (natural > room) menu.style.maxHeight = `${Math.max(88, Math.floor(room))}px`;
    // The open animation scales from the right edge, so measure the left from there at full width.
    const left = menu.getBoundingClientRect().right - menu.offsetWidth;
    if (left < gap) menu.style.right = `${Math.floor(left - gap)}px`;
  });
}

function cardOverflow(kind, item, { onMap = false } = {}) {
  if (!item?.id) return null;
  const key = cardMenuKey(kind, item);
  const open = state.cardMenu === key;
  const hostish = canManageEvent(item);
  const mine = item.joined?.find((person) => person.id === state.me.user.id);
  const inNow = Boolean(mine) && inReply(mine);
  const declined = mine?.reply === "declined";
  const maybe = mine?.reply === "maybe";
  const isHost = item.creator?.id === state.me.user.id;
  const chosen = arriveClock(mine);
  const preset = arrivalDefault(kind, item);
  const label = item.note || (kind === "plan" ? "plan" : "free post");
  const items = [];
  if (kind === "plan") {
    if (canShareCircles(item)) {
      items.push({
        text: "Share with other circles",
        action: () => { state.cardMenu = null; openShareCircles(item); },
      });
    }
    if (!item.removedBy && planOpen(item)) {
      items.push({
        text: "Remind friends",
        muted: remindCooling(item),
        action: () => { state.cardMenu = null; void remindFriends(item); },
      });
      items.push({
        text: "Add to calendar",
        action: () => { state.cardMenu = null; void addPlanToCalendar(item); },
      });
    }
  }
  if (!isHost && !item.removedBy) {
    items.push({
      text: chosen ? `Arriving ${chosen}` : "Pick arrival time",
      action: () => {
        state.cardMenu = null;
        openArrivalPicker(kind, item, chosen || preset);
      },
    });
    items.push({
      text: "Maybe",
      action: () => { state.cardMenu = null; void sendReply(kind, item, "maybe"); },
      on: maybe,
    });
    items.push({
      text: "Can't make it",
      action: () => { state.cardMenu = null; void sendReply(kind, item, "declined"); },
      on: declined,
    });
  }
  /* Map card already has a quiet Open in Maps link; keep the menu item on plan cards only. */
  if (!onMap && kind === "plan" && item.location) {
    items.push({
      text: "Open in Maps",
      action: () => {
        state.cardMenu = null;
        const url = mapsUrl(item.location.lat, item.location.lng, item.place || item.note);
        if (url) window.open(url, "_blank", "noopener");
      },
    });
  }
  if (hostish) {
    items.push({
      text: "Edit",
      action: () => { state.cardMenu = null; openAdminEdit(kind, item); },
    });
    items.push({
      text: kind === "plan" ? "End plan" : "End",
      danger: true,
      action: () => { state.cardMenu = null; endManaged(kind, item); },
    });
  }
  return el("div", { class: "card-overflow" }, [
    el("button", {
      class: "card-more",
      type: "button",
      "data-menu": key,
      "aria-label": `More for ${label}`,
      "aria-expanded": String(open),
      "aria-haspopup": "menu",
      onclick: (event) => {
        event.stopPropagation();
        state.cardMenu = open ? null : key;
        menuJustOpened = state.cardMenu;
        render();
      },
    }, [icon("more")]),
    open ? el("div", {
      class: menuJustOpened === key ? "card-menu menu-in" : "card-menu",
      role: "menu",
      onclick: (event) => event.stopPropagation(),
    }, items.map((row) => el("button", {
      type: "button",
      role: "menuitem",
      class: [row.danger ? "danger" : "", row.on ? "on" : "", row.muted ? "muted" : ""].filter(Boolean).join(" "),
      // Still tappable while muted, so a tap can say when it works again.
      "aria-disabled": row.muted ? "true" : null,
      text: row.text,
      onclick: (event) => {
        event.stopPropagation();
        row.action();
      },
    }))) : null,
  ]);
}

function openArrivalPicker(kind, item, value) {
  state.arrivalPick = {
    kind,
    id: item.id,
    value: /^\d{2}:\d{2}$/.test(value) ? value : (arrivalDefault(kind, item) || ""),
  };
  state.sheet = "arrival";
  render();
}

function arrivalSheet() {
  const pick = state.arrivalPick;
  if (!pick) return el("div");
  return el("div", {}, [
    el("button", { class: "scrim", type: "button", "aria-label": "Close", onclick: closeSheet }),
    el("form", {
      class: "sheet",
      role: "dialog",
      "aria-label": "Pick arrival",
      onsubmit: (event) => {
        event.preventDefault();
        const value = document.getElementById("arrival-time")?.value || pick.value;
        const kind = pick.kind;
        const item = findEvent(kind, pick.id);
        state.arrivalPick = null;
        state.sheet = null;
        if (item && value) chooseArrival(kind, item, value);
        else render();
      },
    }, [
      el("div", { class: "sheet-head" }, [
        el("div", { class: "grabber" }),
        el("h2", { text: "Pick arrival" }),
        el("p", { class: "help", text: "When do you think you'll get there?" }),
      ]),
      el("div", { class: "sheet-scroll" }, [
        el("label", { class: "sheet-group" }, [
          el("span", { class: "sheet-label", text: "Time" }),
          el("input", {
            id: "arrival-time",
            class: "sheet-control",
            type: "time",
            step: "60",
            value: pick.value,
            "aria-label": "Pick time",
            oninput: (event) => { pick.value = event.target.value; },
          }),
        ]),
      ]),
      el("div", { class: "sheet-dock" }, [
        el("button", { class: "btn", type: "submit", text: "Save" }),
      ]),
    ]),
  ]);
}

function mapsUrl(lat, lng, label) {
  if (lat == null || lng == null) return "";
  return mapsHref(lat, lng, label);
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
    shared: kind === "plan" && Boolean(item.shareId) && item.creator?.id === state.me.user.id,
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
    el("form", { class: "sheet", role: "dialog", "aria-label": "Edit", ...saveOnlyFromButton(saveAdminEdit) }, [
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
          edit.shared ? el("button", { class: "btn ghost stop-sharing", type: "button", text: "Stop sharing", onclick: () => { void stopSharing(edit); } }) : null,
        ]),
      ]),
      el("div", { class: "sheet-dock" }, [
        el("button", { class: "btn", type: "submit", text: "Save" }),
      ]),
    ]),
  ]);
}

/** Host of an open plan, in more than one circle. Same rule the server checks in readPlanCircles. */
function canShareCircles(plan) {
  return Boolean(plan?.creator?.id) && plan.creator.id === state.me?.user?.id
    && (state.me.circles || []).length > 1
    && Boolean(plan.circles?.length)
    && !plan.removedBy
    && planOpen(plan);
}

function openShareCircles(plan) {
  const mine = new Set((state.me.circles || []).map((circle) => circle.id));
  state.shareCircles = {
    id: plan.id,
    home: plan.circles[0],
    picked: new Set(plan.circles.slice(1).map((circle) => circle.id).filter((id) => mine.has(id))),
    busy: false,
    error: "",
  };
  state.sheet = "share-circles";
  render();
}

/** Home circle fixed, toggle chips for the host's other circles. Saves only the circle set. */
function shareCirclesSheet() {
  const share = state.shareCircles;
  if (!share) return el("div");
  const others = (state.me.circles || []).filter((circle) => circle.id !== share.home.id);
  return el("div", {}, [
    el("button", { class: "scrim", type: "button", "aria-label": "Close", onclick: closeSheet }),
    el("form", { class: "sheet", role: "dialog", "aria-label": "Share with other circles", ...saveOnlyFromButton(saveShareCircles) }, [
      el("div", { class: "sheet-head" }, [
        el("div", { class: "grabber" }),
        el("h2", { text: "Share with other circles" }),
        el("p", { class: "help", text: "Same plan, same chat and guest list. New circles get one notification." }),
      ]),
      el("div", { class: "sheet-scroll" }, [
        el("div", { class: "sheet-form" }, [
          el("div", { class: "sheet-group" }, [
            el("span", { class: "sheet-label", text: "Always in" }),
            el("div", { class: "also-circles" }, [
              el("span", { class: "chip chip-fixed", text: share.home.name }),
            ]),
          ]),
          el("div", { class: "sheet-group" }, [
            el("span", { class: "sheet-label", id: "share-circles-label", text: "Your other circles" }),
            el("div", { class: "also-circles", role: "group", "aria-labelledby": "share-circles-label" }, others.map((circle) => {
              const on = share.picked.has(circle.id);
              return el("button", {
                type: "button",
                class: on ? "chip on" : "chip",
                "aria-pressed": on ? "true" : "false",
                text: circle.name,
                onclick: () => {
                  if (share.picked.has(circle.id)) share.picked.delete(circle.id);
                  else share.picked.add(circle.id);
                  share.error = "";
                  render();
                },
              });
            })),
          ]),
          share.error ? el("p", { class: "time-error", role: "alert", text: share.error }) : null,
        ]),
      ]),
      el("div", { class: "sheet-dock stack" }, [
        el("button", { class: "btn", type: "submit", text: share.busy ? "Saving…" : "Save", disabled: share.busy }),
        el("button", { class: "btn ghost", type: "button", text: "Cancel", onclick: closeSheet }),
      ]),
    ]),
  ]);
}

async function saveShareCircles(event) {
  event.preventDefault();
  const share = state.shareCircles;
  if (!share || share.busy) return;
  const circleIds = [share.home.id, ...share.picked];
  share.busy = true;
  share.error = "";
  render();
  try {
    // Circles only: the server keeps every other field, so this is never a move.
    await api(`/api/plans/${share.id}`, { method: "PATCH", body: { circleIds } });
  } catch (error) {
    share.busy = false;
    share.error = isNetworkFailure(error)
      ? "You're offline. Try again."
      : error.status >= 500 ? "Something went wrong. Try again." : (error.message || "Something went wrong. Try again.");
    if (state.shareCircles === share) render();
    return;
  }
  state.shareCircles = null;
  state.sheet = null;
  await refresh({ initial: true });
  state.error = circleIds.length > 1 ? `Shared with ${circleIds.length} circles` : `Now only in ${share.home.name}`;
  render();
  scheduleErrorClear();
}

/** "Friends + Climbing" when a plan is in more than one circle. */
function planCirclesLine(plan) {
  if (!plan?.circles || plan.circles.length < 2) return null;
  return el("p", { class: "plan-circles", text: plan.circles.map((circle) => circle.name).join(" + ") });
}

async function stopSharing(edit) {
  await run(async () => {
    await api(`/api/plans/${edit.id}/share`, { method: "DELETE" });
    edit.shared = false;
    await refresh({ initial: true });
    state.error = "Link stopped. Old links no longer work.";
    render();
    scheduleErrorClear();
  });
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
        el("div", { class: "list" }, detail.push.people.map((person) => {
          // Here status is the delivery state; Away / Busy comes as userStatus.
          const away = activeStatus(person.userStatus);
          return el("div", { class: "row" }, [
            avatar({ ...person, status: away }, 40),
            el("div", { class: "grow" }, [
              el("h3", { text: person.name }),
              el("p", { text: [pushStatusText(person), away ? statusLabel(away.type) : ""].filter(Boolean).join(" · ") }),
            ]),
          ]);
        })),
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
    && !state.joinInstall
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
  if (state.sheet === "event-detail") return eventDetailSheet();
  if (state.sheet === "arrival") return arrivalSheet();
  if (state.sheet === "share-circles") return shareCirclesSheet();
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
    el("form", { class: "sheet", role: "dialog", ...saveOnlyFromButton((event) => (state.sheet === "plan" ? onCreatePlan(event) : onFree(event))) }, [
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
          whenBlock(),
          planning ? null : timeBlock(),
          planning ? null : busyAtBlock(),
          sheetField(planning ? "Plan" : "Note (optional)", "sheet-note", state.noteDraft, (value) => {
            state.noteDraft = value;
            paintSummary();
          }, {
            placeholder: planning ? "Walk and dinner with Alvin?" : "Rooftop coffee??",
            maxlength: "80",
          }),
          planning ? planDateField() : null,
          planning ? el("label", { class: "sheet-group" }, [
            el("span", { class: "sheet-label", text: "Time (optional)" }),
            el("input", {
              id: "plan-time",
              class: "sheet-control",
              type: "time",
              value: state.planTime,
              oninput: (event) => {
                state.planTime = event.target.value;
                paintBusyAt();
              },
            }),
            planTimeError(),
          ]) : null,
          planning ? busyAtBlock() : null,
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
    if (note.kind === "feedback-done") {
      openNotification(note);
      return;
    }
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

/** The events the map shows: every circle when All circles is on, else the selected one. */
function mapEvents() {
  if (state.mapAllCircles) return { socials: state.mapSocials, plans: state.mapPlans };
  return { socials: state.socials, plans: state.plans };
}

function forgetMapAll() {
  state.mapSocials = [];
  state.mapPlans = [];
  state.calendarSocials = [];
  state.calendarPlans = [];
  state.calendarKey = "";
}

async function refreshMapAll() {
  try {
    const [socials, plans] = await Promise.all([
      api("/api/socials?all=1", { circle: null }),
      api("/api/plans?all=1", { circle: null }),
    ]);
    state.mapSocials = socials.socials || [];
    state.mapPlans = plans.plans || [];
  } catch (error) {
    if (error.status === 401) return;
    if (isNetworkFailure(error) || error.status >= 500) noteConnectionProblem(error);
  }
}

/** The circle an event lives in, so In, chat and share hit its home circle from the All map. */
function actingCircle(item) {
  const mine = new Set((state.me?.circles || []).map((circle) => circle.id));
  if (item?.circleId && (!mine.size || mine.has(item.circleId))) return item.circleId;
  const shared = (item?.circles || []).find((circle) => mine.has(circle.id));
  return shared?.id || state.circleId;
}

async function setMapAll(on) {
  if (state.mapAllCircles === on) return;
  state.mapAllCircles = on;
  try {
    localStorage.setItem(MAP_ALL_KEY, on ? "1" : "0");
  } catch {
    /* storage off */
  }
  if (on && state.eventsView !== "calendar") await refreshMapAll();
  if (state.eventsView === "calendar") await loadCalendar();
  // A fresh map fits to the new set of pins.
  destroyLiveMap();
  mapWrap = null;
  render();
  refreshPins();
}

function mapScopeControl() {
  if ((state.me?.circles || []).length < 2) return null;
  const all = state.mapAllCircles;
  return el("div", { class: "map-scope segment", role: "group", "aria-label": "Map scope" }, [
    el("button", {
      type: "button",
      class: all ? "" : "on",
      "aria-pressed": all ? "false" : "true",
      text: "This circle",
      onclick: () => void setMapAll(false),
    }),
    el("button", {
      type: "button",
      class: all ? "on" : "",
      "aria-pressed": all ? "true" : "false",
      text: "All circles",
      onclick: () => void setMapAll(true),
    }),
  ]);
}

function mapCircleLine(item) {
  if (!state.mapAllCircles || !item) return null;
  if (item.circles && item.circles.length >= 2) return null;
  if (!item.circleName) return null;
  return el("p", { class: "map-card-circle", text: item.circleName });
}

function readEventsView() {
  try {
    return localStorage.getItem(EVENTS_VIEW_KEY) === "map" ? "map" : "calendar";
  } catch {
    return "calendar";
  }
}

async function setEventsView(view) {
  if (state.eventsView === view) return;
  state.eventsView = view;
  try {
    localStorage.setItem(EVENTS_VIEW_KEY, view);
  } catch {
    /* storage off */
  }
  state.cardMenu = null;
  // Leaving the map tears it down the same way leaving the tab does; coming back builds a fresh one.
  destroyLiveMap();
  mapWrap = null;
  if (view === "calendar") calFade = "grid";
  render();
  if (view === "calendar") await loadCalendar();
  else if (state.mapAllCircles) await refreshMapAll();
  if (state.tab !== "map" || state.eventsView !== view) return;
  render();
  if (view === "map") refreshPins();
}

/** One short row: Map / Calendar, then This circle / All circles when there is more than one circle. */
function eventsControls() {
  const calendar = state.eventsView === "calendar";
  const scope = mapScopeControl();
  // With the scope switch beside it the view switch is icons only; on its own it has room for the words.
  const viewButton = (name, view, on) => el("button", {
    type: "button",
    class: on ? "on" : "",
    "aria-pressed": on ? "true" : "false",
    "aria-label": name,
    onclick: () => void setEventsView(view),
  }, [icon(view), scope ? null : el("span", { class: "events-view-label", text: name, "aria-hidden": "true" })]);
  return el("div", { class: scope ? "events-controls scoped" : "events-controls" }, [
    el("div", { class: "events-view segment", role: "group", "aria-label": "Show" }, [
      viewButton("Map", "map", !calendar),
      viewButton("Calendar", "calendar", calendar),
    ]),
    scope,
  ]);
}

/** Set by a month or day change; the next render fades that part in once. */
let calFade = "";
/** Bumped per month fetch, so an older answer never lands over a newer month. */
let calendarSeq = 0;

/** Your circles get the palette in order, so two of them never share a colour (up to eight). */
function calColor(circleId) {
  const index = (state.me?.circles || []).findIndex((circle) => circle.id === circleId);
  return index >= 0 ? CIRCLE_COLORS[index % CIRCLE_COLORS.length] : circleColor(circleId);
}

function calToday() {
  return zonedParts(Date.now(), appTz()).day;
}

function ensureCalendarMonth() {
  if (state.calMonth) return;
  const today = calToday();
  state.calMonth = monthStart(today);
  state.calDay = today;
}

function calendarKeyFor() {
  const range = gridRange(state.calMonth);
  const scope = state.mapAllCircles && (state.me?.circles || []).length >= 2 ? "all" : state.circleId || "";
  return { range, scope, key: `${scope}|${range.from}|${range.to}` };
}

/** The visible grid's events, padding days included. Kept apart from Home and the map. */
async function loadCalendar({ force = false } = {}) {
  ensureCalendarMonth();
  const { range, scope, key } = calendarKeyFor();
  if (!force && key === state.calendarKey) return;
  const seq = ++calendarSeq;
  state.calendarLoading = true;
  const query = `from=${range.from}&to=${range.to}`;
  try {
    const data = scope === "all"
      ? await api(`/api/calendar-month?${query}&all=1`, { circle: null })
      : await api(`/api/calendar-month?${query}`);
    if (seq !== calendarSeq) return;
    state.calendarPlans = data.plans || [];
    state.calendarSocials = data.socials || [];
    state.calendarKey = key;
  } catch (error) {
    if (error.status === 401) return;
    if (isNetworkFailure(error) || error.status >= 500) noteConnectionProblem(error);
  } finally {
    if (seq === calendarSeq) state.calendarLoading = false;
  }
}

function calSocialDay(social) {
  return social.day || zonedParts(social.startsAt ?? social.createdAt, appTz()).day;
}

function calSocialOver(social) {
  return !(Number(social.expiresAt) > Date.now());
}

function calPlanOver(plan) {
  return Boolean(plan.endedAt) || !planOpen(plan);
}

/** Every loaded event, by day, in time order (a plan with no time comes last). */
function calendarByDay() {
  const days = new Map();
  const add = (day, entry) => {
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(entry);
  };
  for (const plan of state.calendarPlans) {
    add(plan.forDate, { kind: "plan", item: plan, at: plan.time || "~", over: calPlanOver(plan) });
  }
  for (const social of state.calendarSocials) {
    add(calSocialDay(social), { kind: "social", item: social, at: clock(social.startsAt ?? social.createdAt), over: calSocialOver(social) });
  }
  for (const list of days.values()) list.sort((a, b) => a.at.localeCompare(b.at) || a.item.id.localeCompare(b.item.id));
  return days;
}

function goCalMonth(first, day = "") {
  const today = calToday();
  state.calMonth = first;
  state.calDay = day || (monthStart(today) === first ? today : first);
  calFade = "grid";
  render();
  void loadCalendar().then(() => {
    if (state.tab === "map" && state.eventsView === "calendar") render();
  });
}

function pickCalDay(day) {
  if (monthStart(day) !== state.calMonth) {
    goCalMonth(monthStart(day), day);
    return;
  }
  if (state.calDay === day) return;
  state.calDay = day;
  calFade = "list";
  render();
}

function calendarScreen() {
  ensureCalendarMonth();
  const today = calToday();
  const { key } = calendarKeyFor();
  const ready = state.calendarKey === key;
  const byDay = ready ? calendarByDay() : new Map();
  const fade = calFade;
  calFade = "";
  const grid = monthGrid(state.calMonth);
  const monthCount = grid.reduce((sum, cell) => sum + (cell.inMonth ? (byDay.get(cell.day)?.length || 0) : 0), 0);
  const cells = grid.map((cell) => {
    const events = byDay.get(cell.day) || [];
    // Two events fit as two stacks; with more, the second slot says how many others there are.
    const stacked = events.length > CAL_CELL_STACKS ? events.slice(0, CAL_CELL_STACKS - 1) : events;
    const moreEvents = events.length - stacked.length;
    const classes = ["cal-cell"];
    if (!cell.inMonth) classes.push("pad");
    if (cell.day === today) classes.push("today");
    if (cell.day === state.calDay) classes.push("on");
    const date = Number(cell.day.slice(8, 10));
    const label = `${shortDate(cell.day, today)}${cell.day === today ? ", today" : ""}${events.length ? `, ${events.length} ${events.length === 1 ? "event" : "events"}` : ""}`;
    return el("button", {
      class: classes.join(" "),
      type: "button",
      "data-day": cell.day,
      "aria-label": label,
      "aria-pressed": cell.day === state.calDay ? "true" : "false",
      "aria-current": cell.day === today ? "date" : null,
      onclick: () => pickCalDay(cell.day),
    }, [
      el("span", { class: "cal-num", text: String(date) }),
      events.length ? el("span", { class: "cal-stacks", "aria-hidden": "true" }, [
        ...stacked.map((entry) => crowdStack(entry, CAL_CELL_FACES, 16, "cal-stack")),
        moreEvents ? el("span", { class: "cal-more", text: `+${moreEvents}` }) : null,
      ]) : null,
    ]);
  });
  const dayEvents = byDay.get(state.calDay) || [];
  let below;
  if (!ready) below = el("p", { class: "cal-quiet", text: "Loading…" });
  else if (!monthCount && monthStart(state.calDay) === state.calMonth) {
    below = el("div", { class: "cal-empty" }, [
      el("h2", { text: "Nothing planned this month." }),
      el("p", { text: "Plans and hangouts from your circle show up here on their day." }),
    ]);
  } else {
    below = el("section", { class: "cal-day", "aria-label": shortDate(state.calDay, today) }, [
      el("h2", { class: "cal-day-title", text: state.calDay === today ? `Today · ${shortDate(state.calDay, today)}` : shortDate(state.calDay, today) }),
      dayEvents.length
        ? el("div", { class: "cal-list" }, dayEvents.map(calendarRow))
        : el("p", { class: "cal-quiet", text: "Nothing on this day." }),
      calFreeLine(state.calDay, dayEvents),
    ]);
  }
  return el("div", { class: "cal" }, [
    el("div", { class: "cal-head" }, [
      el("h2", { class: "cal-title", text: monthTitle(state.calMonth), "aria-live": "polite" }),
      el("button", {
        class: "text-btn cal-today",
        type: "button",
        text: "Today",
        onclick: () => goCalMonth(monthStart(today), today),
      }),
      el("button", {
        class: "icon-btn cal-nav prev",
        type: "button",
        "aria-label": "Previous month",
        onclick: () => goCalMonth(shiftMonth(state.calMonth, -1)),
      }, [icon("chevron")]),
      el("button", {
        class: "icon-btn cal-nav",
        type: "button",
        "aria-label": "Next month",
        onclick: () => goCalMonth(shiftMonth(state.calMonth, 1)),
      }, [icon("chevron")]),
    ]),
    el("div", { class: fade === "grid" ? "cal-panel cal-fade" : "cal-panel" }, [
      el("div", { class: "cal-week", "aria-hidden": "true" }, WEEKDAY_LABELS.map((name) => el("span", { text: name }))),
      el("div", { class: "cal-grid" }, cells),
    ]),
    el("div", { class: fade ? "cal-below cal-fade" : "cal-below" }, [below]),
  ]);
}

/** Faces per event in a month cell, and event stacks per cell, so a 320px grid never overflows. */
const CAL_CELL_FACES = 2;
const CAL_CELL_STACKS = 2;
/** Faces per event in the day list. */
const CAL_ROW_FACES = 4;

/** Who is in on one event: overlapping faces, then +N. The first face is ringed in the circle's colour. */
function crowdStack(entry, cap, size, cls) {
  const { faces, more, total } = eventCrowd(entry.item, cap);
  const names = faces.map((face) => face.person.name).filter(Boolean);
  const label = more ? `${names.join(", ")} and ${more} more` : names.join(", ");
  return el("span", {
    class: ["avatars", "cal-crowd", cls, entry.over ? "over" : ""].filter(Boolean).join(" "),
    style: `--cal-ring: ${calColor(entry.item.circleId)}`,
    "data-in": String(total),
    "aria-label": cls === "cal-stack" ? null : `${label} ${total === 1 ? "is" : "are"} in`,
    role: cls === "cal-stack" ? null : "img",
  }, [
    ...faces.map((face) => avatar(face.person, size, "cal-face")),
    more ? el("span", { class: "avatar cal-face cal-face-more", text: `+${more}` }) : null,
  ]);
}

/** Friends free that day but not on an event. Empty until a later change fills freeOnDay in. */
function calFreeLine(day, events) {
  const free = freeOnDay(day, events, state.me?.circle?.members ?? []);
  if (!free.length) return null;
  return el("div", { class: "cal-free" }, free.map((person) => avatar(person, 24)));
}

/** One event under the grid: title, when, host, the circle when All circles is on, and who is in. */
function calendarRow(entry) {
  const { kind, item, over } = entry;
  const title = item.note || (kind === "plan" ? "Plan" : "Free now");
  let when;
  if (kind === "plan") when = item.time || "";
  else if (!over && (!item.startsAt || item.startsAt <= Date.now())) when = "Free now";
  else if (!over) when = `from ${clock(item.startsAt)}`;
  else when = clock(item.startsAt ?? item.createdAt);
  const bits = [when, item.creator?.name];
  if (state.mapAllCircles && (state.me?.circles || []).length >= 2 && item.circleName) bits.push(item.circleName);
  if (over) bits.push("Ended");
  return el("button", {
    class: over ? "cal-event over" : "cal-event",
    type: "button",
    "data-kind": kind,
    "data-id": item.id,
    onclick: () => openEventDetail(kind, item, "calendar"),
  }, [
    el("span", { class: "cal-dot", "aria-hidden": "true", style: `background: ${calColor(item.circleId)}` }),
    el("span", { class: "cal-event-copy" }, [
      el("strong", { text: title }),
      el("span", { text: bits.filter(Boolean).join(" · ") }),
    ]),
    crowdStack(entry, CAL_ROW_FACES, 24, "cal-row-crowd"),
  ]);
}

function mapScreen() {
  if (state.eventsView === "calendar") {
    destroyLiveMap();
    mapWrap = null;
    return el("div", { class: "map-screen calendar-view" }, [
      screenHeader("Events"),
      eventsControls(),
      calendarScreen(),
    ]);
  }
  const pins = collectPins();
  if (!pins.length) {
    destroyLiveMap();
    mapWrap = null;
    return el("div", { class: "map-screen" }, [
      screenHeader("Events"),
      eventsControls(),
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
    screenHeader("Events"),
    eventsControls(),
    mapWrap,
  ]);
}

function collectPins() {
  const pins = [];
  const events = mapEvents();
  for (const social of events.socials) {
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
      personId: social.creator.id,
      photo: pinPhoto(social.creator),
      status: activeStatus(social.creator.status)?.type || "",
      now: socialPinState(social) === "now",
      label: pinLabel("social", social, Date.now(), appTz()),
    });
  }
  for (const plan of events.plans) {
    if (!plan.location) continue;
    const mine = plan.creator.id === state.me.user.id;
    const place = audiencePlace(plan.place);
    const crowd = goingCrowd(plan.creator, plan.joined, MAP_CROWD_FACES);
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
      personId: plan.creator.id,
      photo: pinPhoto(plan.creator),
      status: activeStatus(plan.creator.status)?.type || "",
      now: false,
      label: pinLabel("plan", plan, Date.now(), appTz()),
      // The host is the pin itself, so the crowd is everyone else who is In.
      faces: crowd.faces.slice(1).map((person) => ({
        id: person.id,
        initial: initial(person.name),
        color: colorFor(person),
        photo: pinPhoto(person),
        status: activeStatus(person.status)?.type || "",
      })),
      more: crowd.more,
    });
  }
  return pins;
}

/** A photo already fetched for this person, or "". Fetches once, then repaints the pins. */
function pinPhoto(person) {
  const key = avatarKey(person);
  if (!key) return "";
  const cached = avatarUrls.get(key);
  if (typeof cached === "string") return cached;
  if (cached === undefined) void Promise.resolve(loadAvatar(person)).then((url) => { if (url) refreshPins(); });
  return "";
}

let mapWrap = null;
let whereTimer = 0;
/** Bumped on every new search or reset. Older answers see a different number and are dropped. */
let whereSeq = 0;
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
    whereStatus: "",
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

/** Now and Later make you free. Plan for another day, a quieter link, makes a plan on a date. */
function whenBlock() {
  const planning = state.whenMode === "pick";
  return el("div", { class: "sheet-group" }, [
    el("span", { class: "sheet-label", id: "when-label", text: "When" }),
    el("div", { class: "segment", role: "group", "aria-labelledby": "when-label" }, [
      whenChoice("now", "Now"),
      whenChoice("later", offeringTomorrow() ? "Tomorrow" : "Later today"),
    ]),
    el("button", {
      id: "plan-another-day",
      class: planning ? "when-other on" : "when-other",
      type: "button",
      "aria-pressed": planning ? "true" : "false",
      text: "Plan for another day",
      onclick: () => {
        if (state.error === PICK_DATE_ERROR || state.error === TIME_LATER_ERROR) state.error = "";
        enterPlanMode();
        render();
      },
    }),
  ]);
}

const PLAN_DEFAULT_DAYS = 3;

function enterPlanMode() {
  state.whenMode = "pick";
  state.sheet = "plan";
  state.planDay = "pick";
  if (!state.planDate) state.planDate = addDays(planDayRange(Date.now(), appTz()).today, PLAN_DEFAULT_DAYS);
}

function planDateField() {
  const range = planDayRange(Date.now(), appTz());
  return el("label", { class: "sheet-group" }, [
    el("span", { class: "sheet-label", text: "Date" }),
    el("input", {
      id: "plan-date",
      class: "sheet-control",
      type: "date",
      min: range.min,
      max: range.max,
      value: state.planDate || "",
      onchange: (event) => {
        state.planDate = event.target.value;
        if (state.error === PICK_DATE_ERROR) state.error = "";
        render();
      },
    }),
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
      if (state.error === PICK_DATE_ERROR) state.error = "";
      state.sheet = "free";
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

/** This device's zone. Busy-until and availability clocks are shown in it, whatever zone the setter used. */
function viewerTz() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || appTz();
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
        if (value === "pick" && !bag[dateKey]) bag[dateKey] = addDays(range.today, 7);
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

/** The moment the create sheet is about: now, the later start, or a timed plan. Null for an untimed plan. */
function sheetBusyAt(now = Date.now()) {
  if (state.sheet === "plan") {
    const day = chosenPlanDay();
    if (!day || !/^\d{2}:\d{2}$/.test(state.planTime || "")) return null;
    const at = clockInstant(day, state.planTime);
    return Number.isFinite(at) ? at : null;
  }
  if (state.whenMode !== "later") return "now";
  if (state.startChoice === "+60") return Math.floor((now + 3600000) / 60000) * 60000;
  if (!/^\d{2}:\d{2}$/.test(state.startChoice)) return null;
  const range = planDayRange(now, appTz());
  const tomorrow = offeringTomorrow(now) && state.startChoice === nextLaterSlot(now, appTz());
  const at = clockInstant(tomorrow ? range.tomorrow : range.today, state.startChoice);
  return Number.isFinite(at) ? at : null;
}

let busyAtTimer = 0;

/**
 * "Busy then: Alex until 15:30". Only people who share their calendar with this circle, and
 * only busy or free: the server never sends what is in anyone's calendar.
 */
function busyAtBlock() {
  const at = sheetBusyAt();
  const node = el("div", { class: "busy-at", "aria-live": "polite" });
  if (at === null) return node;
  const self = state.me?.user?.id;
  let people;
  let from = Date.now();
  if (at === "now") {
    people = (state.me?.circle?.members || [])
      .filter((member) => member.id !== self && member.availability)
      .map((member) => ({ id: member.id, ...member.availability }));
  } else if (state.busyAt?.at === at) {
    people = state.busyAt.people;
    from = at;
  } else {
    clearTimeout(busyAtTimer);
    busyAtTimer = setTimeout(() => { void loadBusyAt(at); }, 250);
    return node;
  }
  const names = new Map((state.me?.circle?.members || []).map((member) => [member.id, member.name]));
  const busy = people.filter((person) => person.state === "busy" && names.has(person.id) && person.id !== self);
  if (!busy.length) return node;
  const parts = busy.map((person) => Number.isFinite(person.until)
    ? `${names.get(person.id)} until ${untilText(person.until, from, viewerTz())}`
    : names.get(person.id));
  node.append(
    el("span", { class: "avail-dot", "aria-hidden": "true" }),
    el("span", { text: `${at === "now" ? "Busy now" : "Busy then"}: ${parts.join(", ")}` }),
  );
  return node;
}

async function loadBusyAt(at) {
  let people = [];
  try {
    const data = await api(`/api/circles/availability?at=${at}`);
    people = Array.isArray(data?.people) ? data.people : [];
  } catch {
    people = [];
  }
  state.busyAt = { at, people };
  paintBusyAt();
}

function paintBusyAt() {
  document.querySelector(".busy-at")?.replaceWith(busyAtBlock());
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

/**
 * Create and edit sheets save only from their Save / I'm free / Add plan button.
 * Enter in a field (Android sends its Go / Search key as Enter) would submit the form
 * implicitly, so the key is cancelled here. Textareas keep Enter for new lines.
 * (Implicit submit still names the default button as submitter, so the key guard is
 * what stops it.) #where-query also handles Enter itself and searches. A submit with
 * no submit button behind it, such as requestSubmit(), is ignored too.
 */
function saveOnlyFromButton(handler) {
  return {
    onkeydown: (event) => {
      if (event.key !== "Enter") return;
      if (event.target instanceof HTMLInputElement) event.preventDefault();
    },
    onsubmit: (event) => {
      const button = event.submitter;
      if (!(button instanceof HTMLButtonElement) || button.type !== "submit") {
        event.preventDefault();
        return;
      }
      return handler(event);
    },
  };
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
  if (person.reply === "maybe") return maybeLine(person, mine);
  if (arriving) return mine ? "You're in" : `${person.name} is in, arriving ${arriving}`;
  if (mine) return eta ? `You're in · ${eta} min` : "You're in";
  return eta ? `${person.name} · there in ${eta} min` : `${person.name} is in`;
}

function maybeLine(person, mine) {
  return mine ? "You're maybe" : `${person.name} is maybe`;
}

/** The card's faces: host first, then everyone In or Maybe. Can't stays in the details. */
function avatarStack(item) {
  const crowd = cardCrowd(item.creator, item.joined);
  return el("div", { class: "avatars" }, [
    ...crowd.stack.map((person) => avatar(person)),
    crowd.more ? el("span", { class: "avatar avatar-more", text: `+${crowd.more}`, "aria-label": `${crowd.more} more` }) : null,
  ]);
}

/** Shown in the who-row: in and maybe. Can't is only in the details. */
function replySummary(social) {
  const people = cardCrowd(social.creator, social.joined).listed;
  return whoRow("social", social, people.map((person) => guestLine(replyLine(person, social), person, "social", social)));
}

/* Full-width "who's in" row: its own 44px+ tap target that opens the details, never the map. */
function whoRow(kind, item, lines) {
  return el("button", {
    class: "who-row",
    type: "button",
    onclick: (event) => {
      event.stopPropagation();
      if (item?.creator) openEventDetail(kind, item);
    },
  }, [
    icon("people"),
    el("span", { class: "who-row-copy" }, lines.length ? lines : [el("span", { class: "who-empty", text: "Waiting for friends" })]),
    icon("chevron"),
  ]);
}

function inToggle(kind, item, { locked = false } = {}) {
  const isHost = item.creator?.id === state.me.user.id;
  const mine = item.joined?.find((person) => person.id === state.me.user.id);
  const inNow = isHost || (Boolean(mine) && inReply(mine));
  const hostLocked = locked || isHost;
  const pop = inPopClass(kind, item, inNow);
  const node = el("button", {
    class: ["in-toggle", inNow ? "on" : "", pop?.name || ""].filter(Boolean).join(" "),
    style: pop?.delay ? `animation-delay: -${pop.delay}ms` : null,
    type: "button",
    text: inNow ? "In ✓" : "I'm in",
    "aria-pressed": String(inNow),
    "aria-label": inNow ? "In ✓" : "I'm in",
    title: inNow ? (hostLocked ? "You're in" : "Tap to undo") : "Join this plan",
    disabled: hostLocked && inNow ? true : undefined,
    onclick: (event) => {
      event.stopPropagation();
      if (hostLocked && inNow) return;
      state.cardMenu = null;
      tick();
      if (inNow) {
        state.inPop = { key: `${kind}:${item.id}`, on: false, startedAt: 0, until: Date.now() + 10_000 };
        void leaveEvent(kind, item);
      } else void joinIn(kind, item);
    },
  });
  if (pop) node.addEventListener("animationend", () => {
    node.classList.remove("pop-on", "pop-off");
    node.style.animationDelay = "";
    if (state.inPop?.key === `${kind}:${item.id}`) state.inPop = null;
  }, { once: true });
  return node;
}

const IN_POP_MS = 250;

/**
 * The In toggle pops once when the state the person tapped for shows up. The tap itself is
 * never delayed: the class is added on the render that carries the new state. A re-render
 * mid-pop picks the animation up where it was instead of restarting it.
 */
function inPopClass(kind, item, inNow) {
  const pop = state.inPop;
  if (!pop || pop.key !== `${kind}:${item.id}`) return null;
  const now = Date.now();
  if (pop.on !== inNow) {
    if (pop.startedAt || now > pop.until) state.inPop = null;
    return null;
  }
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
    state.inPop = null;
    return null;
  }
  if (!pop.startedAt) pop.startedAt = now;
  const elapsed = now - pop.startedAt;
  if (elapsed >= IN_POP_MS) {
    state.inPop = null;
    return null;
  }
  return { name: inNow ? "pop-on" : "pop-off", delay: elapsed };
}

/** A tiny buzz where the phone supports it. Never blocks or throws. */
function tick() {
  try {
    navigator.vibrate?.(10);
  } catch {
    /* no vibration here */
  }
}

function joinNow(kind, item) {
  state.inPop = { key: `${kind}:${item.id}`, on: true, startedAt: 0, until: Date.now() + 10_000 };
  void sendReply(kind, item, "in");
}

/** The stretch of time the hangout covers, for the overlap highlight. Untimed plans have none. */
function hangoutWindow(kind, item, now = Date.now()) {
  if (kind === "plan") {
    if (!/^\d{2}:\d{2}$/.test(item.time || "")) return null;
    const start = clockInstant(item.forDate, item.time);
    return Number.isFinite(start) ? { start, end: start + PLAN_DURATION_MS } : null;
  }
  const start = item.startsAt && item.startsAt > now ? item.startsAt : now;
  return Number.isFinite(item.expiresAt) && item.expiresAt > start ? { start, end: item.expiresAt } : null;
}

function hangoutDay(kind, item, now = Date.now()) {
  if (kind === "plan") return /^\d{4}-\d{2}-\d{2}$/.test(item.forDate || "") ? item.forDate : "";
  return zonedParts(item.startsAt && item.startsAt > now ? item.startsAt : now, appTz()).day;
}

/**
 * I'm in, with a look at your own calendar first. Only for someone who connected one, and
 * only when that day has events. No events, or no answer, joins straight away.
 */
async function joinIn(kind, item) {
  const day = hangoutDay(kind, item);
  if (!state.me?.user?.calendarConnected || !day) {
    joinNow(kind, item);
    return;
  }
  const key = `${kind}:${item.id}`;
  if (state.calendarCheckBusy === key) return;
  state.calendarCheckBusy = key;
  let events = [];
  try {
    const data = await api(`/api/me/calendar-sync/day?date=${day}`, { circle: null });
    if (data?.connected === false && state.me?.user) state.me.user.calendarConnected = false;
    events = dayEvents(data?.events);
  } catch {
    events = [];
  } finally {
    state.calendarCheckBusy = "";
  }
  if (!events.length) {
    joinNow(kind, item);
    return;
  }
  const span = hangoutWindow(kind, item);
  const clash = events.some((event) => eventOverlaps(event, span));
  const today = planDayRange(Date.now(), appTz()).today;
  const label = dayLabel(day, today) || day;
  state.confirm = {
    title: clash ? "This clashes with your calendar" : `Your calendar ${label === "Today" || label === "Tomorrow" ? label.toLowerCase() : `on ${label}`}`,
    body: span
      ? (clash ? "Highlighted events overlap. Only you can see this." : "Nothing overlaps. Only you can see this.")
      : "Only you can see this.",
    confirmLabel: "I'm in",
    confirmClass: "btn",
    extra: calendarCheckList(events, day, span),
    action: async () => joinNow(kind, item),
  };
  render();
}

function calendarCheckList(events, day, span) {
  const dayStart = clockInstant(day, "00:00");
  const dayEnd = clockInstant(addDays(day, 1), "00:00");
  return el("ul", { class: "cal-check", "aria-label": "Your events that day" }, events.map((event) => {
    const hit = eventOverlaps(event, span);
    return el("li", { class: hit ? "cal-event clash" : "cal-event" }, [
      el("span", { class: "cal-time", text: eventTimeText(event, dayStart, dayEnd, appTz()) }),
      el("span", { class: "cal-title", text: event.title || "Busy" }),
      hit ? el("span", { class: "cal-flag", text: "Overlaps" }) : null,
    ]);
  }));
}

async function leaveEvent(kind, item) {
  await run(async () => {
    const data = await api(`/api/${kind}s/${item.id}/leave`, { method: "POST", body: {} });
    if (kind === "plan" && data.plan) {
      state.plans = state.plans.map((row) => row.id === data.plan.id ? data.plan : row);
    }
    if (kind === "social" && data.social) {
      state.socials = state.socials.map((row) => row.id === data.social.id ? data.social : row);
    }
    await refresh({ initial: true });
  });
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

/** Not on a past day. Ended plans leave the list, so a stale copy past midnight is the case to catch. */
function planOpen(plan) {
  return Boolean(plan.forDate) && plan.forDate >= zonedParts(Date.now(), appTz()).day;
}

/** True while the plan's one-reminder-an-hour window is still running. */
function remindCooling(plan) {
  return Boolean(plan.remindAgainAt) && plan.remindAgainAt > Date.now();
}

function remindLaterText(at) {
  return `Already reminded. You can remind again at ${clock(at)}`;
}

function friendsText(count) {
  return count === 1 ? "Reminded 1 friend" : `Reminded ${count} friends`;
}

function adoptPlan(plan) {
  if (!plan?.id) return;
  state.plans = state.plans.map((row) => row.id === plan.id ? plan : row);
}

async function remindFriends(plan) {
  if (remindCooling(plan)) {
    state.error = remindLaterText(plan.remindAgainAt);
    render();
    scheduleErrorClear();
    return;
  }
  let message = "";
  await run(async () => {
    try {
      const data = await api(`/api/plans/${plan.id}/remind`, { method: "POST", body: {} });
      adoptPlan(data.plan);
      message = data.reminded > 0 ? friendsText(data.reminded) : "Everyone has already answered";
    } catch (error) {
      if (error.status === 429 && error.data?.retryAt) {
        adoptPlan({ ...plan, remindAgainAt: error.data.retryAt });
        message = remindLaterText(error.data.retryAt);
        return;
      }
      throw error;
    }
  });
  if (message) {
    state.error = message;
    render();
    scheduleErrorClear();
  }
}

const CALENDAR_SAVED = "Saved to your calendar file. It will not update if the plan changes.";

/** A file name from the plan title, same rule as the server. */
function calendarFileName(note) {
  const slug = String(note || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return `${slug || "hangry-plan"}.ics`;
}

/** Fetches the .ics with the session header, then saves it as a file. The link itself is never shared. */
async function addPlanToCalendar(plan) {
  let saved = false;
  await run(async () => {
    let response;
    try {
      response = await fetch(`/api/plans/${plan.id}/calendar.ics`, {
        headers: { authorization: `Bearer ${state.token}` },
      });
    } catch {
      const error = new Error("You're offline. Try again.");
      error.status = 0;
      throw error;
    }
    if (!response.ok) {
      let data = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      const error = new Error(friendlyMessage(data?.error, response.status));
      error.status = response.status;
      throw error;
    }
    const blob = new Blob([await response.text()], { type: "text/calendar;charset=utf-8" });
    saveBlob(blob, calendarFileName(plan.note));
    saved = true;
  });
  if (saved) {
    state.error = CALENDAR_SAVED;
    render();
    scheduleErrorClear();
  }
}

function saveBlob(blob, name) {
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = name;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

/** Plans whose link was just made: the next Share tap opens the sheet. id -> "share" | "copy". */
const shareReady = new Map();
/** Plans with a POST /share in flight, so a double tap makes one request. */
const shareBusy = new Set();

function planShareUrl(plan) {
  return plan?.shareId ? `${state.meta?.publicBaseUrl || location.origin}/p/${plan.shareId}` : "";
}

/** Title, day and time only. Never the place, people, chat or circle. Absolute day: it is read later. */
function planSharePayload(plan, url) {
  const day = shortDate(plan.forDate, zonedParts(Date.now(), appTz()).day);
  const when = [day, plan.time].filter(Boolean).join(" ");
  return { title: plan.note, text: when ? `${plan.note}, ${when} on Hangry` : `${plan.note} on Hangry`, url };
}

function canSharePlanLink(kind, item) {
  return kind === "plan" && Boolean(item?.creator) && !item.removedBy && planOpen(item);
}

function shareToast(message) {
  state.error = message;
  render();
  scheduleErrorClear();
}

/** Starts the clipboard write inside the tap, then falls back to a hidden field. Never shows the link. */
function copyShareLink(url) {
  let pending;
  try {
    pending = navigator.clipboard?.writeText ? navigator.clipboard.writeText(url) : Promise.reject(new Error("no clipboard"));
  } catch (error) {
    pending = Promise.reject(error);
  }
  return pending.then(() => true, () => copyWithSelection(url));
}

async function copyPlanLink(plan, url) {
  const copied = await copyShareLink(url);
  if (copied) {
    shareReady.delete(plan.id);
    shareToast("Link copied");
    return;
  }
  // Keep a copy button so the retry is a fresh tap.
  shareReady.set(plan.id, "copy");
  shareToast("Couldn't share. Try again.");
}

/**
 * Card Share button. navigator.share needs the tap's user activation, so with a known link it is
 * called right away, before any await. Without one, this tap only makes the link and the next tap shares.
 */
function onSharePlanTap(event, plan) {
  event.stopPropagation();
  event.preventDefault();
  if (shareBusy.has(plan.id)) return;
  const url = planShareUrl(plan);
  if (!url) {
    void makePlanLink(plan);
    return;
  }
  const payload = planSharePayload(plan, url);
  const canShare = shareReady.get(plan.id) !== "copy"
    && typeof navigator.share === "function"
    && (typeof navigator.canShare !== "function" || navigator.canShare(payload));
  if (!canShare) {
    void copyPlanLink(plan, url);
    return;
  }
  let sharing;
  try {
    sharing = navigator.share(payload);
  } catch (error) {
    sharing = Promise.reject(error);
  }
  Promise.resolve(sharing).then(() => {
    if (shareReady.delete(plan.id)) render();
  }, (error) => {
    if (error?.name === "AbortError") {
      if (shareReady.delete(plan.id)) render();
      return;
    }
    void copyPlanLink(plan, url);
  });
}

/** First tap on a plan with no link yet: make it, then say so. Never opens the share sheet after the await. */
async function makePlanLink(plan) {
  shareBusy.add(plan.id);
  render();
  let shareId = "";
  let message = "";
  try {
    shareId = (await api(`/api/plans/${plan.id}/share`, { method: "POST", body: {} })).shareId || "";
    if (!shareId) message = "Couldn't get a link. Try again.";
  } catch (error) {
    message = error.status === 410 ? "That plan has ended." : isNetworkFailure(error) ? "You're offline. Try again." : "Couldn't get a link. Try again.";
  }
  shareBusy.delete(plan.id);
  if (!shareId) {
    shareToast(message);
    return;
  }
  for (const row of state.plans) if (row.id === plan.id) row.shareId = shareId;
  plan.shareId = shareId;
  if (typeof navigator.share === "function") {
    shareReady.set(plan.id, "share");
    shareToast("Link ready. Tap Send link.");
    return;
  }
  // No share sheet: copying may still be allowed this soon after the tap. If not, the next tap copies.
  if (await copyShareLink(planShareUrl(plan))) {
    shareReady.delete(plan.id);
    shareToast("Link copied");
    return;
  }
  shareReady.set(plan.id, "copy");
  shareToast("Link ready. Tap Copy link.");
}

function shareButton(kind, item) {
  if (!canSharePlanLink(kind, item)) return null;
  const busy = shareBusy.has(item.id);
  // A link stopped since then needs a new one, so the ready state only counts with a link.
  const ready = planShareUrl(item) ? shareReady.get(item.id) : undefined;
  const text = ready === "copy" ? "Copy link" : ready === "share" ? "Send link" : "Share";
  const label = item.note || "plan";
  return el("button", {
    class: ["card-share", ready ? "ready" : "", busy ? "busy" : ""].filter(Boolean).join(" "),
    // An id so render() gives focus back after the link is made.
    id: `card-share-${item.id}`,
    type: "button",
    "aria-label": ready === "copy" ? `Copy link for ${label}` : ready === "share" ? `Send link for ${label}` : `Share ${label}`,
    "aria-busy": busy ? "true" : null,
    "aria-disabled": busy ? "true" : null,
    onclick: (event) => onSharePlanTap(event, item),
  }, [icon("share"), el("span", { text })]);
}

/** In toggle, and Share on an open plan, side by side under the chat row. */
function cardActions(kind, item, opts) {
  const toggle = item.removedBy ? null : inToggle(kind, item, opts);
  const share = shareButton(kind, item);
  if (!share) return toggle;
  return el("div", { class: "card-cta" }, [toggle, share]);
}

/** A /p/ link: a member lands on the plan. Anyone else gets the small preview. */
async function resolveShareLink() {
  const id = state.shareLink;
  let preview;
  try {
    preview = await api(`/api/plans/share/${encodeURIComponent(id)}`, { circle: null });
  } catch (error) {
    if (isNetworkFailure(error)) throw error;
    preview = { ended: true };
  }
  if (preview.member && preview.planId) {
    state.shareLink = "";
    state.sharePreview = null;
    if (preview.circleId && preview.circleId !== state.me?.circle?.id) {
      rememberCircle(preview.circleId);
      state.me = await api("/api/me");
    }
    state.deepLink = { kind: "plan", id: preview.planId, share: true };
    history.replaceState(null, "", "/");
    return;
  }
  state.sharePreview = preview;
}

function leaveSharePreview(next = null) {
  state.sharePreview = null;
  state.shareLink = next ? state.shareLink : "";
  state.sheet = next;
  state.error = "";
  history.replaceState(null, "", "/");
  render();
}

function sharePreviewScreen() {
  const preview = state.sharePreview;
  const signedIn = Boolean(state.token && state.me);
  const head = el("div", { class: "hero" }, [
    el("button", { class: "orb small", type: "button", "aria-hidden": "true", tabindex: "-1" }),
    el("h1", { class: "wordmark", text: "Hangry" }),
  ]);
  if (preview.ended) {
    return el("section", { class: "gate share-gate" }, [
      head,
      el("article", { class: "panel share-preview" }, [
        el("h2", { text: "This link no longer works" }),
        el("p", { class: "help", text: "Ask a friend for a new link." }),
      ]),
      el("div", { class: "stack" }, [
        el("button", { class: "btn", type: "button", text: "Open Hangry", onclick: () => leaveSharePreview() }),
      ]),
    ]);
  }
  const when = preview.time ? `${preview.whenLabel} · ${preview.time}` : preview.whenLabel;
  return el("section", { class: "gate share-gate" }, [
    head,
    el("article", { class: "panel share-preview" }, [
      el("h2", { text: preview.note }),
      el("p", { class: "share-when", text: when }),
    ]),
    el("p", { class: "lede share-lede", text: signedIn
      ? "Only people in this circle can open it. Ask a friend there for an invite."
      : "Hangry is invite-only. Sign in, or ask a friend in this circle for an invite." }),
    el("div", { class: "stack" }, signedIn
      ? [
          el("button", { class: "btn", type: "button", text: "Open Hangry", onclick: () => leaveSharePreview() }),
        ]
      : [
          el("button", { class: "btn", type: "button", text: "Sign back in", onclick: () => leaveSharePreview("recover") }),
          el("button", { class: "btn secondary", type: "button", text: "Add to home screen", onclick: openInstallGuide }),
          el("button", { class: "btn ghost", type: "button", text: "Open Hangry", onclick: () => leaveSharePreview() }),
        ]),
  ]);
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
      onkeydown: (event) => onWhereKeydown(bag, event),
    }),
    whereStatusRow(bag),
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

/** One line under the search field. It keeps its height, so idle, searching, empty and error never shift the sheet. */
function whereStatusRow(bag) {
  let child = null;
  if (bag.whereHint) child = el("span", { class: "where-hint", text: bag.whereHint });
  else if (bag.whereSearching) child = [el("span", { class: "where-spinner", "aria-hidden": "true" }), el("span", { text: "Searching…" })];
  else if (bag.whereStatus === "empty") child = el("span", { text: "No places found" });
  else if (bag.whereStatus === "error") child = el("span", { class: "where-error", text: "Couldn't search. Try again." });
  return el("p", {
    class: bag.whereSearching && !bag.whereHint ? "where-status is-searching" : "where-status",
    role: "status",
    "aria-live": "polite",
  }, child);
}

/** Swap just the status line, so typing never rebuilds the input mid-word. */
function paintWhereStatus(bag) {
  const row = document.querySelector(".where-picker .where-status");
  if (!row) return;
  const next = whereStatusRow(bag);
  row.className = next.className;
  row.replaceChildren(...next.childNodes);
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
  stopWhereSearch(bag);
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
  stopWhereSearch(bag);
  bag.whereHint = "";
  bag.whereMap = false;
  bag.whereOpen = Boolean(keepOpen);
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

/** What the Where status row shows. Only re-render when this changes, not on every key. */
function whereView(bag) {
  return [bag.whereHint || "", bag.whereSearching ? 1 : 0, bag.whereStatus || "", bag.whereResults.length].join("|");
}

/** Repaint after a status change: just the status line if the hit list is the same, else the whole picker. */
function refreshWhere(bag, before) {
  const now = whereView(bag);
  if (now === before) return;
  const sameList = now.split("|")[3] === before.split("|")[3] && document.querySelector(".where-picker .where-status");
  if (sameList) paintWhereStatus(bag);
  else rerenderWhere();
}

/** Stop any pending or in-flight search so its answer is ignored. */
function stopWhereSearch(bag) {
  clearTimeout(whereTimer);
  whereTimer = 0;
  whereSeq += 1;
  bag.whereSearching = false;
  bag.whereStatus = "";
}

function scheduleWhereSearch(bag = state, { now = false } = {}) {
  const before = whereView(bag);
  const query = searchQuery(bag.whereQuery);
  const maps = isMapsLink(query);
  const hint = looksLikeUrl(query) && !maps ? URL_HINT : "";
  stopWhereSearch(bag);
  bag.whereHint = hint;
  if (hint || (!maps && query.length < 2)) {
    bag.whereResults = [];
    refreshWhere(bag, before);
    return;
  }
  // Show Searching… straight away, through the debounce and the fetch.
  bag.whereSearching = true;
  refreshWhere(bag, before);
  const seq = whereSeq;
  const go = () => {
    whereTimer = 0;
    const origin = searchOrigin();
    const near = origin && !maps ? `&lat=${encodeURIComponent(origin.lat)}&lng=${encodeURIComponent(origin.lng)}` : "";
    api(`/api/geocode?q=${encodeURIComponent(query)}${near}`).then((data) => {
      if (seq !== whereSeq) return;
      bag.whereResults = data?.results || [];
      bag.whereSearching = false;
      bag.whereStatus = bag.whereResults.length ? "" : "empty";
      rerenderWhere();
    }).catch(() => {
      if (seq !== whereSeq) return;
      bag.whereSearching = false;
      bag.whereResults = [];
      bag.whereStatus = "error";
      rerenderWhere();
    });
  };
  if (now) go();
  else whereTimer = setTimeout(go, 400);
}

/** Enter / the keyboard's search key runs the search now. It never saves the sheet. */
function onWhereKeydown(bag, event) {
  if (event.key !== "Enter") return;
  event.preventDefault();
  if (bag.whereAutofill) return;
  const value = event.target.value;
  if (value !== bag.whereQuery) applyWhereQuery(bag, value);
  scheduleWhereSearch(bag, { now: true });
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
    stopWhereSearch(bag);
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
  if (note.kind === "feedback-done") {
    // Your own shipped suggestion: the changelog is where it shows up for everyone.
    if (!state.me?.circle && !note.readAt) void markPersonalAlertsRead();
    void openWhatsNewList();
    return;
  }
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
  if (plan) {
    state.tab = "home";
    state.sheet = null;
    state.focusPlan = plan.id;
    state.focusPlanScroll = true;
    render();
    return;
  }
  if (item || note.kind === "social" || note.kind === "plan" || note.kind === "plan-reply" || note.kind === "plan-remind" || note.kind === "reply" || note.kind === "join") {
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
  const { kind, id, share } = state.deepLink;
  const list = kind === "plan" ? state.plans : state.socials;
  const item = list.find((entry) => entry.id === id);
  state.deepLink = null;
  clearDeepLinkQuery();
  if (!item) return false;
  if (item.location) {
    showOnMap(kind, item.id);
    return true;
  }
  state.sheet = null;
  if (share || kind === "plan") {
    state.tab = "home";
    state.focusPlan = item.id;
    state.focusPlanScroll = true;
    return false;
  }
  state.tab = "map";
  return false;
}

function mapCard(pin) {
  const distance = state.viewerLocation ? formatDistance(haversine(state.viewerLocation, pin)) : "";
  const events = mapEvents();
  const social = pin.kind === "social"
    ? events.socials.find((item) => item.id === pin.id) || { id: pin.id, startsAt: null, joined: [] }
    : null;
  const plan = pin.kind === "plan"
    ? events.plans.find((item) => item.id === pin.id) || { id: pin.id, joined: [] }
    : null;
  const item = social?.creator ? social : plan?.creator ? plan : null;
  const kind = social?.creator ? "social" : plan?.creator ? "plan" : pin.kind;
  const menuOpen = item ? state.cardMenu === `${kind}:${item.id}` : false;
  const own = Boolean(pin.own);
  const grad = pin.kind === "plan" ? `card-grad ${gradientClass(pin.id)}` : "";
  return el("article", { class: ["map-card", grad, menuOpen ? "menu-open" : ""].filter(Boolean).join(" ") }, [
    el("div", { class: "map-card-head" }, [
      el("strong", {
        text: pin.title,
        role: "button",
        tabindex: "0",
        onclick: () => item && openEventDetail(kind, item),
      }),
      item ? cardOverflow(kind, item, { onMap: true }) : null,
      el("button", {
        class: "map-card-close",
        type: "button",
        "aria-label": "Close",
        onclick: (event) => {
          event.stopPropagation();
          closeMapCard();
        },
      }, [icon("close")]),
    ]),
    el("div", {
      class: "map-card-body",
      role: item ? "button" : null,
      tabindex: item ? "0" : null,
      onclick: () => item && openEventDetail(kind, item),
    }, [
      el("p", { text: pin.note }),
      el("p", { class: "map-card-time", text: distance ? `${pin.time} · ${distance}` : pin.time }),
      mapCircleLine(item),
      planCirclesLine(plan),
      plan ? planDescription(plan) : null,
      social && !own ? replySummary(social) : null,
      social ? removedNote(social) : null,
      plan && !own ? (plan.removedBy ? removedNote(plan) : (
        (plan.joined.find((person) => person.id === state.me.user.id && person.reply !== "declined") && el("p", {
          class: "reply-line",
          text: planReplyLine(plan.joined.find((person) => person.id === state.me.user.id)),
        }))
      )) : null,
    ]),
    item ? chatRow(kind, item) : null,
    item ? cardActions(kind, item, { locked: own }) : null,
    pin.lat != null ? el("a", {
      class: "map-link quiet",
      href: mapsUrl(pin.lat, pin.lng, pin.note),
      target: "_blank",
      rel: "noopener noreferrer",
      text: "Open in Maps",
      onclick: (event) => event.stopPropagation(),
    }) : null,
  ]);
}

function planReplyLine(person) {
  const mine = person.id === state.me.user.id;
  const arriving = arriveClock(person);
  if (person.reply === "declined") return mine ? "You can't make it" : `${person.name} can't`;
  if (person.reply === "maybe") return maybeLine(person, mine);
  if (arriving) return mine ? "You're in" : `${person.name} is in, arriving ${arriving}`;
  return mine ? "You're in" : `${person.name} is in`;
}

function planReplySummary(plan) {
  const people = cardCrowd(plan.creator, plan.joined).listed;
  return whoRow("plan", plan, people.map((person) => guestLine(planReplyLine(person), person, "plan", plan)));
}

function canRemoveGuest(event) {
  return Boolean(event?.creator) && (event.creator.id === state.me.user.id || adminOver(event));
}

function guestLine(text, person, kind, event) {
  /* Remove moved to the event detail sheet so cards stay clean. Spans: these sit inside the who-row button. */
  return el("span", { class: "reply-line", text });
}

function guestDetailRow(text, person, kind, event) {
  const status = statusLine(person?.status, Date.now(), viewerTz());
  const availability = person.id === state.me.user.id ? null : memberAvailability(person.id);
  const busyText = availability ? availabilityText(availability, Date.now(), viewerTz()) : "";
  const reply = busyText
    ? el("div", { class: "reply-line" }, [
        el("span", { text }),
        el("span", { class: `avail-tag ${availability.state}`, text: busyText }),
      ])
    : el("p", { class: "reply-line", text });
  const line = status
    ? el("div", { class: "guest-text" }, [reply, el("p", { class: "guest-status", "data-status": person.status.type, text: status })])
    : reply;
  if (!canRemoveGuest(event) || !inReply(person) || person.id === state.me.user.id) {
    return el("div", { class: "guest-row" }, [avatar(person), line]);
  }
  return el("div", { class: "guest-row" }, [
    avatar(person),
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

function removedNote(item) {
  if (!item?.removedBy) return null;
  return el("p", { class: "removed-note", text: `${item.removedBy} removed you from this.` });
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
    onclick: (event) => { event.stopPropagation(); showOnMap(target.kind, target.id); },
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
    // syncOverlayHistory (from render) pushes the entry Back pops to return here.
    state.mapHistory = true;
  }
  state.focusPin = `${kind}:${id}`;
  state.tab = "map";
  // A pin focus needs the map, so this shows it for now without changing the saved view.
  state.eventsView = "map";
  state.sheet = null;
  render();
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

/** Blob URLs for photos, by `${id}:${rev}`. A string is ready, a Promise is loading, null failed. */
const avatarUrls = new Map();

function avatarKey(person) {
  return person?.id && person.avatarRev ? `${person.id}:${person.avatarRev}` : "";
}

/** Photos need the Bearer token, so <img src> cannot fetch them. Fetch once, keep a blob URL. */
function loadAvatar(person) {
  const key = avatarKey(person);
  if (avatarUrls.has(key)) return avatarUrls.get(key);
  const token = state.token;
  const job = fetch(`/api/users/${encodeURIComponent(person.id)}/avatar?v=${encodeURIComponent(person.avatarRev)}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
    .then((response) => (response.ok ? response.blob() : null))
    .then((blob) => {
      const url = blob && blob.size ? URL.createObjectURL(blob) : null;
      avatarUrls.set(key, url);
      return url;
    })
    .catch(() => {
      // Offline: forget the failure so the next render tries again.
      avatarUrls.delete(key);
      return null;
    });
  avatarUrls.set(key, job);
  return job;
}

function forgetAvatars() {
  for (const value of avatarUrls.values()) if (typeof value === "string") URL.revokeObjectURL(value);
  avatarUrls.clear();
}

function avatarImg(url, person, size, extra) {
  const node = el("img", {
    class: `avatar photo ${extra}`.trim(),
    src: url,
    alt: "",
    "data-person": person.id,
    style: `background:${colorFor(person)}`,
  });
  if (size !== 28) {
    node.style.width = `${size}px`;
    node.style.height = `${size}px`;
  }
  return node;
}

/** The face, with a small Away / Busy badge on it while that status is on. */
function avatar(person, size = 28, extra = "") {
  const face = avatarFace(person, size, extra);
  const status = activeStatus(person?.status);
  if (!status) return face;
  const badge = el("span", {
    class: "status-badge",
    role: "img",
    "aria-label": statusLabel(status.type),
    "data-status": status.type,
    text: statusBadge(status.type),
  });
  const mark = Math.max(14, Math.round(size * 0.4));
  badge.style.width = `${mark}px`;
  badge.style.height = `${mark}px`;
  badge.style.fontSize = `${Math.round(mark * 0.62)}px`;
  return el("span", { class: "avatar-wrap" }, [face, badge]);
}

function avatarFace(person, size = 28, extra = "") {
  const key = avatarKey(person);
  const cached = key ? avatarUrls.get(key) : undefined;
  if (typeof cached === "string") return avatarImg(cached, person, size, extra);
  const node = el("span", {
    class: `avatar ${extra}`.trim(),
    text: initial(person.name),
    "data-person": person?.id || null,
    style: `background:${colorFor(person)}`,
  });
  if (size !== 28) {
    node.style.width = `${size}px`;
    node.style.height = `${size}px`;
  }
  if (key && cached !== null) {
    // Initials while it loads. Swap in place when ready; a later render reads the cache.
    void Promise.resolve(loadAvatar(person)).then((url) => {
      if (url && node.isConnected) node.replaceWith(avatarImg(url, person, size, extra));
    });
  }
  return node;
}

const PHOTO_SIZE = 256;
const PHOTO_MAX_BYTES = 50 * 1024;
let photoInputNode = null;

/** One hidden picker outside #app, so a re-render while it is open does not lose the change event. */
function photoInput() {
  if (photoInputNode) return photoInputNode;
  photoInputNode = el("input", { type: "file", accept: "image/*", id: "avatar-file", class: "visually-hidden", tabindex: "-1", "aria-hidden": "true" });
  photoInputNode.addEventListener("change", () => {
    const file = photoInputNode.files?.[0];
    photoInputNode.value = "";
    if (file) void onPhotoChosen(file);
  });
  document.body.append(photoInputNode);
  return photoInputNode;
}

function pickPhoto() {
  if (state.avatarBusy) return;
  photoInput().click();
}

async function decodePhoto(file) {
  if ("createImageBitmap" in window) {
    try {
      return await createImageBitmap(file);
    } catch {
      /* fall back to <img> */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function canvasBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** Centre square, 256×256, WebP (JPEG where WebP will not encode), at most 50 KB. */
async function squarePhoto(file) {
  const image = await decodePhoto(file);
  const width = image.width || image.naturalWidth;
  const height = image.height || image.naturalHeight;
  if (!width || !height) throw new Error("That photo could not be read.");
  const side = Math.min(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = PHOTO_SIZE;
  canvas.height = PHOTO_SIZE;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, (width - side) / 2, (height - side) / 2, side, side, 0, 0, PHOTO_SIZE, PHOTO_SIZE);
  image.close?.();
  let type = "image/webp";
  let quality = 0.8;
  let blob = await canvasBlob(canvas, type, quality);
  if (!blob || blob.type !== "image/webp") {
    type = "image/jpeg";
    quality = 0.85;
    blob = await canvasBlob(canvas, type, quality);
  }
  while (blob && blob.size > PHOTO_MAX_BYTES && quality > 0.3) {
    quality -= 0.1;
    blob = await canvasBlob(canvas, type, quality);
  }
  if (!blob || blob.size > PHOTO_MAX_BYTES) throw new Error("That photo is too big.");
  return blob;
}

async function onPhotoChosen(file) {
  state.avatarBusy = true;
  render();
  await run(async () => {
    try {
      let blob;
      try {
        blob = await squarePhoto(file);
      } catch (error) {
        throw new Error(error?.message === "That photo is too big." ? error.message : "That photo could not be read.");
      }
      let response;
      try {
        response = await fetch("/api/me/avatar", {
          method: "PUT",
          headers: { "content-type": blob.type, authorization: `Bearer ${state.token}` },
          body: blob,
        });
      } catch {
        const error = new Error("You're offline. Retrying…");
        error.status = 0;
        throw error;
      }
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        const error = new Error(friendlyMessage(data?.error, response.status));
        error.status = response.status;
        throw error;
      }
      // The bytes we just sent are the photo. No need to fetch them back.
      avatarUrls.set(`${data.user.id}:${data.user.avatarRev}`, URL.createObjectURL(blob));
      state.me = { ...state.me, user: data.user };
      state.error = "Photo saved";
    } finally {
      state.avatarBusy = false;
    }
    await refresh();
  });
}

async function onRemovePhoto() {
  state.avatarBusy = true;
  render();
  await run(async () => {
    try {
      const data = await api("/api/me/avatar", { method: "DELETE" });
      state.me = { ...state.me, user: data.user };
      state.error = "Photo removed";
    } finally {
      state.avatarBusy = false;
    }
    await refresh();
  });
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
  if (name === "free" || name === "plan") {
    state.noteDraft = mySocial()?.note ?? "";
    state.where = whereFromSocial(mySocial());
    state.whereQuery = state.where.place;
    state.whereAutofill = false;
    state.whereOpen = false;
    state.whereResults = [];
    stopWhereSearch(state);
    state.whereHint = "";
    state.whereMap = false;
    const mine = mySocial();
    const upcoming = mine?.startsAt && mine.startsAt > Date.now();
    state.whenMode = upcoming ? "later" : "now";
    state.startChoice = upcoming ? clock(mine.startsAt) : "";
  }
  if (name === "free" || name === "plan") {
    state.placeDraft = "";
    state.planTime = "";
    state.planDay = "pick";
    state.planDate = "";
    state.planWhere = emptyWhereSession();
  }
  if (name === "plan") {
    state.noteDraft = "";
    enterPlanMode();
  }
  state.focusSheet = false;
  render();
  if (name === "free" && state.where.mode === "none") void defaultCurrentWhere();
}

function closeSheet() {
  if (state.sheet === "feedback" && state.feedbackSent) resetFeedback();
  if (state.sheet === "whats-new") state.whatsNewView = null;
  if (state.sheet === "event-detail") state.eventDetail = null;
  if (state.sheet === "arrival") state.arrivalPick = null;
  if (state.sheet === "share-circles") state.shareCircles = null;
  state.cardMenu = null;
  state.sheet = null;
  state.whereMap = false;
  if (state.planWhere) state.planWhere.whereMap = false;
  if (state.adminEdit) state.adminEdit.whereMap = false;
  destroyWhereMap();
  render();
}

function sheetIsOpen() {
  return Boolean(state.sheet || state.confirm || state.onboarding || state.joinInstall || state.installSheet || state.installOpen);
}

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
function syncOverlayHistory() {
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
      if (drag > 72) dismissTopOverlay();
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
let tapClosedMenu = false;

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
function closeAlerts() {
  state.tab = ALERTS_RETURN_TABS.includes(state.alertsReturn) ? state.alertsReturn : "home";
  state.sheet = null;
  state.focusPlan = "";
  render();
}

async function onTab(id) {
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
      noteInviteJoin();
    } else if (state.pendingCode) {
      try {
        const joined = await api("/api/circles/join", { method: "POST", body: { code: state.pendingCode } });
        rememberCircle(joined.circle.id);
        state.me = await api("/api/me");
        history.replaceState(null, "", "/");
        state.pendingCode = "";
        noteInviteJoin();
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
    adoptCircle(state.me);
    if (state.shareLink) await resolveShareLink();
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
    noteInviteJoin();
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
    state.planDay = "pick";
    state.planDate = "";
    state.planWhere = emptyWhereSession();
    state.error = locationNote;
    await refresh({ initial: true });
  }, locationNote);
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
      pending.extra ? el("div", { class: "sheet-extra" }, [pending.extra]) : null,
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
          class: pending.confirmClass || "btn danger",
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
    localStorage.removeItem(PUSH_OFF_KEY);
    state.pushOn = true;
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

async function onDisablePush() {
  state.pushBusy = true;
  render();
  try {
    if ("serviceWorker" in navigator) {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        // Server first, so no more pushes go out even if the device step fails.
        await api("/api/push/subscribe", { method: "DELETE", body: { endpoint: subscription.endpoint } });
        await subscription.unsubscribe();
      }
    }
    localStorage.setItem(PUSH_OFF_KEY, "1");
    state.pushOn = false;
    state.pushReminder = null;
    state.onboarding = false;
    state.error = "Notifications are off";
  } catch (error) {
    state.error = error.message || "Could not turn off notifications";
  } finally {
    state.pushBusy = false;
    render();
    scheduleErrorClear();
  }
}

function pushTurnedOff() {
  return localStorage.getItem(PUSH_OFF_KEY) === "1";
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
  if (state.joinInstall) {
    // The install step after a join goes first; the usual reminder waits until it is closed.
    state.onboarding = false;
    render();
    return;
  }
  const prompt = installPrompt(currentSignals(), { canPrompt: Boolean(state.installEvent) });
  const due = reminderDue();
  const denied = "Notification" in window && Notification.permission === "denied";
  const wantInstall = due && !isInstalled() && installDue() && !prompt.quiet && !denied;
  const wantPush = due && !state.pushOn && !denied && !pushTurnedOff();
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
  const showPush = !denied && !state.pushOn && !pushTurnedOff();
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

async function onInstall() {
  if (!state.installEvent) return;
  state.installEvent.prompt();
  const choice = await state.installEvent.userChoice;
  state.installEvent = null;
  if (choice?.outcome === "accepted") {
    localStorage.setItem(INSTALLED_KEY, "1");
    state.installSheet = false;
    if (state.joinInstall) {
      localStorage.setItem(JOIN_INSTALL_KEY, "1");
      state.joinInstall = false;
    }
  }
  render();
  void considerReminders();
}

function joinInstallSignals() {
  return joinInstallStep(currentSignals(), { canPrompt: Boolean(state.installEvent) });
}

/** Just joined a circle from an invite: offer the install step once, unless this phone has it or said Not now. */
function noteInviteJoin() {
  if (localStorage.getItem(JOIN_INSTALL_KEY) === "1" || isInstalled()) return;
  if (!joinInstallSignals()) return;
  state.joinInstall = true;
  state.onboarding = false;
}

function dismissJoinInstall() {
  localStorage.setItem(JOIN_INSTALL_KEY, "1");
  state.joinInstall = false;
  // Same as Not now on the usual sheet: nothing else pops up now, and that reminder comes back softly after three days.
  state.pushSnooze = true;
  localStorage.setItem(INSTALL_LATER_KEY, String(Date.now()));
  render();
  void considerReminders();
}

function joinInstallSheet() {
  const step = joinInstallSignals();
  if (!step) return null;
  const actions = [];
  if (step.offerInstall) {
    actions.push(el("button", { class: "btn", type: "button", text: "Install app", onclick: () => { void onInstall(); } }));
  }
  if (step.copyLink) {
    const where = step.kind === "ios-other" ? "Safari" : "Chrome";
    actions.push(el("button", {
      class: step.offerInstall ? "btn secondary" : "btn",
      type: "button",
      text: "Copy link",
      onclick: () => copyText(location.origin + "/", `Link copied. Open it in ${where}.`),
    }));
  }
  actions.push(el("button", { class: "btn ghost", type: "button", text: "Not now", onclick: dismissJoinInstall }));
  return el("div", {}, [
    el("button", { class: "scrim", type: "button", "aria-label": "Not now", onclick: dismissJoinInstall }),
    el("div", { class: "sheet join-install", role: "dialog", "aria-modal": "true", "aria-labelledby": "join-install-title" }, [
      el("div", { class: "sheet-head" }, [
        el("div", { class: "grabber" }),
        el("h2", { id: "join-install-title", text: step.title }),
        el("p", { class: "help", text: step.lede }),
      ]),
      step.steps.length
        ? el("ol", { class: "guide-steps" }, step.steps.map((line, index) => el("li", {}, [
            el("span", { class: "n", text: String(index + 1) }),
            el("strong", { text: line }),
          ])))
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
        forgetMapAll();
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
    forgetMapAll();
    state.notifications = [];
    // Alerts start over: the next list only remembers its newest, it does not banner old ones.
    state.bootstrappedNotifs = false;
    await refresh({ initial: true });
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
