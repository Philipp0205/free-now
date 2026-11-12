import { emptyWhereSession, state } from "./state.js";
import { destroyWhereMap, shareToggle } from "./map-card.js";
import { render } from "./render.js";
import { notificationsSheet, pushSheet } from "./push-install.js";
import { memberSheet } from "./members.js";
import { adminEditSheet, arrivalSheet, eventDetailSheet, shareCirclesSheet } from "./event-sheets.js";
import { feedbackSheet, resetFeedback, whatsNewSheet } from "./whats-new-ui.js";
import { defaultCurrentWhere, stopWhereSearch, whereBlock, whereFromSocial } from "./where.js";
import { clock, copyText, el, mySocial, ttlLabel } from "./lib.js";
import { busyAtBlock, endSocial, enterPlanMode, friendsSummary, laterTimeChosen, offeringTomorrow, onCreatePlan, onFree, paintBusyAt, paintSummary, planDateField, planHeading, planThrough, planTimeError, saveOnlyFromButton, sheetField, timeBlock, whenBlock } from "./composer.js";
import { circleNameSheet, joinLinkSheet } from "./circles.js";

export function sheet() {
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

export function openSheet(name) {
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

export function closeSheet() {
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

export function sheetIsOpen() {
  return Boolean(state.sheet || state.confirm || state.onboarding || state.joinInstall || state.installSheet || state.installOpen);
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

export function liftSheetToast() {
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

export function confirmSheet() {
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
