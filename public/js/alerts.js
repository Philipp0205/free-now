import { state } from "./state.js";
import { api, persistCachedState } from "./session.js";
import { ago, el, icon, isTyping } from "./lib.js";
import { render } from "./render.js";
import { screenHeader } from "./circles.js";
import { openChat } from "./chat.js";
import { openWhatsNewList } from "./whats-new-ui.js";
import { showOnMap } from "./map-card.js";
import { closeAlerts, onTab } from "./nav.js";

/** Without a circle there is no Alerts tab, so the person's own alerts sit under the setup forms. */
export function personalAlerts() {
  if (!state.notifications.length) return null;
  const unread = state.notifications.filter((note) => !note.readAt).length;
  return el("section", { class: "personal-alerts", "aria-label": unread ? `Your alerts, ${unread} unread` : "Your alerts" }, [
    el("h2", { class: "personal-alerts-title", text: "Your alerts" }),
    el("div", { class: "list" }, state.notifications.map(alertCard)),
  ]);
}

export function alertsBell() {
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

export function homeChatBanner() {
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

export function circleUnread() {
  return state.chatSummary?.circle?.unread || 0;
}

/** A circle dot means unread Alerts in that circle. Chat unread has its own badges. */
export function circleHasUnread(id) {
  return (state.me?.circles?.find((circle) => circle.id === id)?.alertUnread || 0) > 0;
}

export function anyCircleUnread() {
  return (state.me?.circles || []).some((circle) => circleHasUnread(circle.id));
}

/** Copies fresh per-circle alert counts from /api/notifications onto the circle list. */
/** Shows the banner once for an alert newer than the last one seen. The first load only remembers it. */
export function noteNewestAlert() {
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

export function applyAlertUnread(totals) {
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
export async function markAlertsRead() {
  await api("/api/notifications/read", { method: "POST", body: {} });
  const readAt = Date.now();
  state.notifications = state.notifications.map((note) => ({ ...note, readAt: note.readAt ?? readAt }));
  const current = state.me?.circles?.find((circle) => circle.id === state.me?.circle?.id);
  if (current) current.alertUnread = 0;
  persistCachedState();
}

/** The alert ref a chat target uses, matching chatRef on the server. */
function chatAlertRef(target) {
  return target.kind === "circle" ? "circle" : `${target.kind}:${target.id}`;
}

/**
 * Reading a chat reads that chat's Alerts on the server. Mirror it here so the bell badge and circle dots
 * drop now, without POST /api/notifications/read (that would clear unrelated alerts too).
 */
export function markChatAlertsRead(target) {
  const circleId = state.me?.circle?.id;
  const ref = chatAlertRef(target);
  const readAt = Date.now();
  let cleared = 0;
  state.notifications = state.notifications.map((note) => {
    if (note.readAt || note.kind !== "chat" || note.refId !== ref) return note;
    if (target.kind === "circle" && note.circleId !== circleId) return note;
    cleared += 1;
    return { ...note, readAt };
  });
  const current = state.me?.circles?.find((circle) => circle.id === circleId);
  if (current && cleared) current.alertUnread = Math.max(0, (current.alertUnread || 0) - cleared);
  if (cleared) {
    state.signature = "";
    persistCachedState();
  }
}

/** After a chat call succeeded: clear its alerts here, then take the server's per-circle totals (a GET marks nothing). */
export async function syncChatAlerts(target) {
  markChatAlertsRead(target);
  try {
    const data = await api("/api/notifications");
    applyAlertUnread(data.unreadByCircle);
    state.signature = "";
    persistCachedState();
    if (!state.sheet && !isTyping()) render();
  } catch {
    /* the next poll brings the totals */
  }
}

export function forgetOpenUnread(target) {
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

export function eventUnread(kind, id) {
  return state.chatSummary?.events?.find((row) => row.kind === kind && row.id === id)?.unread || 0;
}

export function chatTargetUrl(target) {
  if (target.kind === "circle") return "/api/circles/chat";
  return `/api/${target.kind}s/${target.id}/chat`;
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

export function alertsScreen() {
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

export function banner(note) {
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
