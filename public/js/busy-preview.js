import { zonedParts, dayLabel } from "./when.js";
import { activeStatus, statusShort } from "./status.js";
import { busyByDay, busySpanText, sourceLabel } from "./freebusy.js";
import { state } from "./state.js";
import { api } from "./session.js";
import { render } from "./render.js";
import { alertsBell } from "./alerts.js";
import { youMenuRow } from "./you.js";
import { feedDate, onRefreshCalendar } from "./calendar-sync.js";
import { appTz, clock, el, viewerTz } from "./lib.js";

/** One tap from Availability & calendar to what friends see. Shown with or without a calendar: weekly hours and status count too. */
export function friendsViewPanel() {
  return el("div", { class: "panel panel-rows" }, [
    youMenuRow("See what friends see", "Your busy times, without event names", openBusyPreview),
  ]);
}

function openBusyPreview() {
  state.busyPreview = { open: true, loaded: false, data: null, error: "", busy: false };
  render();
  void loadBusyPreview();
}

export function closeBusyPreview() {
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

export function busyPreviewScreen() {
  return el("div", { class: "you-section busy-preview" }, [
    el("header", { class: "chat-head" }, [
      el("button", { class: "text-btn chat-back", type: "button", text: "Back", onclick: closeBusyPreview }),
      el("h1", { text: "What friends see" }),
      alertsBell(),
    ]),
    ...busyPreviewBody(state.busyPreview),
  ]);
}
