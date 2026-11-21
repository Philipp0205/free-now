import { calendarPlatform, calendarFeedSteps } from "./calendar-feed.js";
import { zonedParts } from "./when.js";
import { state } from "./state.js";
import { api, calendarLanding, isNetworkFailure } from "./session.js";
import { render } from "./render.js";
import { appTz, clock, el, run, scheduleErrorClear } from "./lib.js";

window.addEventListener("focus", () => void checkGoogleReturn());
window.addEventListener("pageshow", () => void checkGoogleReturn());

export function calendarFeedPanel() {
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

export function copyWithSelection(value) {
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
    await navigator.share({ title: "Spontaco calendar", url });
  } catch (error) {
    if (error?.name !== "AbortError") await copyFeedLink(url);
  }
}

/** The feed link shows once. Once the Availability & calendar screen is not on show, it is gone for good. */
export function forgetShownFeedLink() {
  if (!state.calendarFeed?.url) return;
  if (state.tab === "you" && state.youSection === "availability" && !state.chat && !state.past) return;
  state.calendarFeed = { ...state.calendarFeed, url: "", webcalUrl: "" };
}

export function feedDate(ms) {
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

const CALENDAR_SYNC_STEPS = [
  "Google Calendar on a computer: Settings, pick your calendar, Integrate calendar, then copy Secret address in iCal format.",
  "Outlook on the web: Settings, Calendar, Shared calendars, Publish a calendar, then copy the ICS link.",
  "iCloud: in the Calendar app tap the info button next to a calendar, turn on Public Calendar, then Share Link.",
];

const GOOGLE_PERMISSIONS_URL = "https://myaccount.google.com/permissions";
const SECRET_LINK_NOTE = "A private calendar link lets Spontaco download the whole calendar file, including event names. Spontaco keeps only the times, plus your event names encrypted for you alone (so you can see them when you tap I'm in). It discards places, notes and people. Friends still only see busy or free.";

function permissionsLink() {
  return el("a", { href: GOOGLE_PERMISSIONS_URL, target: "_blank", rel: "noopener noreferrer", text: "myaccount.google.com/permissions" });
}

/** Plain words on what Spontaco can and cannot see once Google is connected. */
function googleFacts() {
  return el("div", { class: "sync-facts" }, [
    el("h4", { text: "What Spontaco can and can't see" }),
    el("ul", { class: "feed-steps" }, [
      el("li", { text: "Spontaco only sees when you're busy, never event names, places, people or notes." }),
      el("li", { text: "Spontaco asks Google only for the free/busy permission, and Google's consent screen says so. Spontaco never receives event titles or details, and never stores them." }),
      el("li", { text: "Spontaco stores only your busy times for the next 14 days, plus an encrypted token so it can check again." }),
      el("li", { text: "Spontaco checks about every 20 minutes." }),
      el("li", {}, ["The ", el("a", { href: "/privacy", text: "privacy policy" }), " has the same details."]),
      el("li", {}, [
        "To disconnect, tap Remove in this panel. Spontaco deletes the token and the busy times, and tells Google to revoke access. You can also revoke Spontaco at ",
        permissionsLink(),
        ".",
      ]),
    ]),
  ]);
}

/** Import side of calendars: friends see busy or free, never titles. The link never comes back from the server. */
export function calendarSyncPanel() {
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
      el("p", { class: "help sync-note", text: "It stays off for every circle until you turn one on. Spontaco keeps the link encrypted and never shows it again." }),
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
      ? el("p", { class: "help sync-note", text: "Spontaco never sees the names of your events, so they will not appear when you tap I'm in." })
      : el("p", { class: "help sync-note", text: "When you tap I'm in, you see your own events for that day first. Only you see them." }),
    isGoogle ? el("p", { class: "help sync-note" }, ["You can revoke Spontaco any time at ", permissionsLink(), "."]) : null,
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
  return el("p", { class: "help sync-status", text: `Last checked ${when}. Spontaco checks about every 20 minutes.` });
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
export function landCalendar() {
  if (!calendarLanding || !state.token || !state.me?.circle) return;
  state.tab = "you";
  state.youSection = "availability";
  state.calendarSync = null;
  state.busyPreview = null;
  state.error = calendarLanding === "google" ? "Google Calendar connected" : "Could not connect Google Calendar. Try again.";
}

/** The app stayed in the background while Google ran in another tab. On return, notice a new Google connection. */
let googleReturnChecking = false;
export async function checkGoogleReturn() {
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

export async function onRefreshCalendar() {
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
      ? "Friends stop seeing when you're busy. Spontaco deletes the token and the busy times, and tells Google to revoke access."
      : "Friends stop seeing when you're busy. Spontaco deletes the link and everything it read from it.",
    confirmLabel: "Remove",
    action: async () => {
      await calendarSyncCall("/api/me/calendar-sync", { method: "DELETE" });
    },
  };
  render();
}
