import { zonedParts, shortDate } from "./when.js";
import { state } from "./state.js";
import { api, friendlyMessage, isNetworkFailure, rememberCircle } from "./session.js";
import { render } from "./render.js";
import { copyWithSelection } from "./calendar-sync.js";
import { openInstallGuide } from "./push-install.js";
import { appTz, clock, copyText, el, icon, run, scheduleErrorClear } from "./lib.js";
import { inToggle } from "./replies.js";

export async function shareInvite() {
  const circle = state.me?.circle;
  if (!circle) return;
  const payload = { title: "Spontaco", text: `Join ${circle.name} on Spontaco`, url: circle.inviteUrl };
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
export function planOpen(plan) {
  return Boolean(plan.forDate) && plan.forDate >= zonedParts(Date.now(), appTz()).day;
}

/** True while the plan's one-reminder-an-hour window is still running. */
export function remindCooling(plan) {
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

export async function remindFriends(plan) {
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
  return `${slug || "spontaco-plan"}.ics`;
}

/** Fetches the .ics with the session header, then saves it as a file. The link itself is never shared. */
export async function addPlanToCalendar(plan) {
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
  return { title: plan.note, text: when ? `${plan.note}, ${when} on Spontaco` : `${plan.note} on Spontaco`, url };
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
export function cardActions(kind, item, opts) {
  const toggle = item.removedBy ? null : inToggle(kind, item, opts);
  const share = shareButton(kind, item);
  if (!share) return toggle;
  return el("div", { class: "card-cta" }, [toggle, share]);
}

/** A /p/ link: a member lands on the plan. Anyone else gets the small preview. */
export async function resolveShareLink() {
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

export function sharePreviewScreen() {
  const preview = state.sharePreview;
  const signedIn = Boolean(state.token && state.me);
  const head = el("div", { class: "hero" }, [
    el("button", { class: "orb small", type: "button", "aria-hidden": "true", tabindex: "-1" }),
    el("h1", { class: "wordmark", text: "Spontaco" }),
  ]);
  if (preview.ended) {
    return el("section", { class: "gate share-gate" }, [
      head,
      el("article", { class: "panel share-preview" }, [
        el("h2", { text: "This link no longer works" }),
        el("p", { class: "help", text: "Ask a friend for a new link." }),
      ]),
      el("div", { class: "stack" }, [
        el("button", { class: "btn", type: "button", text: "Open Spontaco", onclick: () => leaveSharePreview() }),
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
      : "Spontaco is invite-only. Sign in, or ask a friend in this circle for an invite." }),
    el("div", { class: "stack" }, signedIn
      ? [
          el("button", { class: "btn", type: "button", text: "Open Spontaco", onclick: () => leaveSharePreview() }),
        ]
      : [
          el("button", { class: "btn", type: "button", text: "Sign back in", onclick: () => leaveSharePreview("recover") }),
          el("button", { class: "btn secondary", type: "button", text: "Add to home screen", onclick: openInstallGuide }),
          el("button", { class: "btn ghost", type: "button", text: "Open Spontaco", onclick: () => leaveSharePreview() }),
        ]),
  ]);
}
