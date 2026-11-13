import { SEEN_KEY } from "./whats-new.js";
import { CIRCLE_KEY, FEEDBACK_MAX, TOKEN_KEY, state } from "./state.js";
import { noteBuzz } from "./flic.js";
import { isTyping } from "./lib.js";
import { render, useNamedCircleDefault } from "./render.js";
import { applyAlertUnread, chatTargetUrl, forgetOpenUnread, markChatAlertsRead, noteNewestAlert } from "./alerts.js";
import { flushChatQueue, openChat } from "./chat.js";
import { considerReminders, noteInviteJoin, reportDisplay, syncPushDetail } from "./push-install.js";
import { considerWhatsNew, markNewAccountSeen } from "./whats-new-ui.js";
import { actingCircle, forgetMapAll, loadCalendar, refreshMapAll } from "./events.js";
import { resolveShareLink } from "./plan-share.js";
import { showOnMap } from "./map-card.js";
import { forgetAvatars } from "./avatars.js";

/**
 * Every refresh() is numbered when it starts. The 3s poll, a switch and an action can overlap, and their
 * answers can land in any order. Only the newest answer for the circle on screen is applied, see refreshIsStale.
 */
let refreshSeq = 0;
let refreshApplied = 0;
/** Refreshes numbered below this were asked for a circle we have since left. */
let refreshFloor = 0;
/** True while a poll tick's refresh has not settled. The next tick skips, so stalled requests cannot pile up. */
let pollPending = false;
/** A GET that has not answered by then is dropped as a network failure, so it frees its connection. */
const API_GET_TIMEOUT_MS = 15000;

const deepLinkParams = new URLSearchParams(location.search);
const planFocus = deepLinkParams.get("plan");
const socialFocus = deepLinkParams.get("social");
const chatFocus = deepLinkParams.get("chat");
const circleFocus = deepLinkParams.get("circle");
/** Google sends people back to /?calendar=google or /?calendar=google-error. Handled once after the session loads. */
export const calendarLanding = ["google", "google-error"].includes(deepLinkParams.get("calendar") || "") ? deepLinkParams.get("calendar") : "";
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

export function persistCachedState() {
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

export function restoreCachedState() {
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

export function isNetworkFailure(error) {
  const status = error?.status;
  return status == null || status === 0;
}

export function noteConnectionProblem(error) {
  state.offline = isNetworkFailure(error);
  state.statusMessage = state.offline
    ? "You're offline. Retrying…"
    : error.status >= 500
      ? "Something went wrong. Retrying…"
      : state.statusMessage;
}

export function scheduleOfflineRetry(delay) {
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

export const RETRY_NOTE = new Set(["You're offline. Retrying…", "Something went wrong. Retrying…"]);

export function friendlyMessage(raw, status) {
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

export async function refresh({ initial = false } = {}) {
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
  noteBuzz();
  state.plans = plans.plans;
  if (state.tab === "map" && state.eventsView === "calendar") await loadCalendar({ force: true });
  else if (state.tab === "map" && state.mapAllCircles) await refreshMapAll();
  state.notifications = notifications.notifications;
  state.me = me;
  applyAlertUnread(notifications.unreadByCircle);
  state.chatSummary = summary;
  if (state.chat) forgetOpenUnread(state.chat);
  if (thread?.chat) {
    state.chatThread = thread.chat;
    if (state.chat) markChatAlertsRead(state.chat);
  }
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

/** The 3s poll. Skips while the previous poll refresh is still pending; explicit refresh() calls always run. */
export async function pollRefresh() {
  if (pollPending) return;
  pollPending = true;
  try {
    await refresh();
  } finally {
    pollPending = false;
  }
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

export function rememberCircle(id) {
  if ((id || "") !== state.circleId) refreshFloor = refreshSeq + 1;
  state.circleId = id || "";
  if (state.circleId) localStorage.setItem(CIRCLE_KEY, state.circleId);
  else localStorage.removeItem(CIRCLE_KEY);
}

export function adoptCircle(me) {
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

export async function api(path, options = {}) {
  const token = options.token === undefined ? state.token : options.token;
  const method = options.method ?? "GET";
  // Only reads time out. Aborting a write that already reached the server could send it twice.
  const controller = method === "GET" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), API_GET_TIMEOUT_MS) : 0;
  let response;
  let text;
  try {
    response = await fetch(path, {
      method,
      headers: {
        ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...circleHeader(path, options),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller?.signal,
    });
    text = await response.text();
  } catch {
    const error = new Error("You're offline. Retrying…");
    error.status = 0;
    throw error;
  } finally {
    clearTimeout(timer);
  }
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
      state.installSteps = false;
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

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  forgetAvatars();
  // What's new is per person. The next account on this phone starts from its own server value.
  localStorage.removeItem(SEEN_KEY);
  state.whatsNewChecked = false;
  rememberCircle("");
  state.token = null;
  state.joinInstall = false;
  state.installSteps = false;
  state.remindersChecked = false;
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

export async function onStart(event) {
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

export async function onRecover(event) {
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
