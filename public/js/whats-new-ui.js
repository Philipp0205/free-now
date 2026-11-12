import { normalizeEntries, SEEN_KEY, latestId, newerSeen, unseenEntries, formatEntryDate } from "./whats-new.js";
import { APP_VERSION } from "./app.js";
import { FEEDBACK_MAX, state } from "./state.js";
import { api, isNetworkFailure } from "./session.js";
import { el, isTyping, scheduleErrorClear } from "./lib.js";
import { render } from "./render.js";
import { closeSheet } from "./sheets.js";

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

export async function markNewAccountSeen() {
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
export async function considerWhatsNew() {
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

export async function openWhatsNewList() {
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

export function whatsNewSheet() {
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

export function resetFeedback() {
  state.feedbackDraft = "";
  state.feedbackError = "";
  state.feedbackBusy = false;
  state.feedbackSent = false;
}

export function openFeedback() {
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

export function feedbackSheet() {
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
