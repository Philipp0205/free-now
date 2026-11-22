import { addDays, planDayRange, planDayDate, dayLabel, nextLaterDay, isLaterToday, nextLaterSlot, minLaterClock } from "./when.js";
import { untilText } from "./freebusy.js";
import { emptyWhereSession, state } from "./state.js";
import { api, refresh } from "./session.js";
import { render } from "./render.js";
import { appTz, el, run, viewerTz } from "./lib.js";
import { clockInstant } from "./replies.js";
import { wherePayload } from "./where.js";
import { sharedPoint } from "./map-card.js";
import { emptyEnd, endError, endPayload } from "./plans/event-end.js";
import { endField } from "./plans/event-end-ui.js";
import { emptyInvites, inviteBody } from "./plans/private-event.js";

/** Now and Later make you free. Plan for another day, a quieter link, makes a plan on a date. */
export function whenBlock() {
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

export function enterPlanMode() {
  state.whenMode = "pick";
  state.sheet = "plan";
  state.planDay = "pick";
  if (!state.planDate) state.planDate = addDays(planDayRange(Date.now(), appTz()).today, PLAN_DEFAULT_DAYS);
}

export function planDateField() {
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

export const TIME_LATER_ERROR = "Pick a time later today.";
export const PICK_DATE_ERROR = "Pick a date from today on.";

/** Today, Tomorrow, or Pick a date. `bag` is state for a new plan, or the edit session. */
export function planDayBlock(bag, prefix) {
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

export function planTimeError() {
  return state.error === TIME_LATER_ERROR ? el("p", { class: "time-error", text: TIME_LATER_ERROR }) : null;
}

function chosenPlanDay() {
  return planDayDate(state.planDay, state.planDate, Date.now(), appTz());
}

export function planHeading() {
  const day = chosenPlanDay();
  return day ? dayLabel(day, planDayRange(Date.now(), appTz()).today) : "Plan";
}

export function planThrough() {
  const label = planHeading();
  if (label === "Plan") return "that day";
  return label === "Today" || label === "Tomorrow" ? label.toLowerCase() : label;
}

export function offeringTomorrow(now = Date.now()) {
  return nextLaterDay(now, state.meta?.tz || "Europe/Berlin") === "tomorrow";
}

function ensureLaterTime() {
  const tz = state.meta?.tz || "Europe/Berlin";
  const now = Date.now();
  if (!isLaterToday(state.startChoice, now, tz)) state.startChoice = nextLaterSlot(now, tz);
  if (state.error === TIME_LATER_ERROR && (isLaterToday(state.startChoice, now, tz) || offeringTomorrow(now))) state.error = "";
}

export function timeBlock() {
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
export function busyAtBlock() {
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

export function paintBusyAt() {
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

export function friendsSummary() {
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

export function paintSummary() {
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
export function saveOnlyFromButton(handler) {
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

export function sheetField(label, id, value, onValue, attrs = {}) {
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

export function laterTimeChosen() {
  return isLaterToday(state.startChoice, Date.now(), state.meta?.tz || "Europe/Berlin");
}

function startPayload() {
  if (state.whenMode !== "later") return { startsAt: null };
  if (state.startChoice === "+60") return { later: true, startsInMin: 60 };
  if (/^\d{2}:\d{2}$/.test(state.startChoice)) return { later: true, startsAt: state.startChoice };
  return { later: true };
}

/** The end row of the create sheets. A render after a pick repaints the chips. */
export function endBlock() {
  return endField(state.endDraft, render);
}

/** The body fields for the end, or null (with the error shown) when the pick cannot work. `start` is "HH:MM" or "". */
function endBody(start, needsStart) {
  const error = endError(state.endDraft, start, needsStart);
  if (!error) return endPayload(state.endDraft);
  state.endDraft.error = error;
  render();
  return null;
}

export function inReply(person) {
  return person.reply === "coming" || person.reply === "join" || person.reply === "in";
}

export async function onFree(event) {
  event.preventDefault();
  if (state.whenMode === "later" && !isLaterToday(state.startChoice, Date.now(), state.meta?.tz || "Europe/Berlin")) {
    state.error = TIME_LATER_ERROR;
    render();
    return;
  }
  const start = state.whenMode === "later" && /^\d{2}:\d{2}$/.test(state.startChoice) ? state.startChoice : "";
  const end = endBody(start, false);
  if (!end) return;
  await run(async () => {
    await api("/api/socials", { method: "POST", body: { note: state.noteDraft, ...wherePayload(), ...startPayload(), ...end, invitees: inviteBody(state.inviteDraft) } });
    state.sheet = null;
    state.whereMap = false;
    await refresh({ initial: true });
  });
}

export async function onCreatePlan(event) {
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
  const end = endBody(time || "", true);
  if (!end) return;
  if (locationNote) render();
  await run(async () => {
    const description = document.getElementById("sheet-description")?.value ?? state.planDraft.description;
    await api("/api/plans", { method: "POST", body: { note: state.noteDraft, place, lat, lng, precise, time, date, description, cardColor: state.planDraft.cardColor ?? null, ...end, invitees: inviteBody(state.inviteDraft) } });
    state.sheet = null;
    state.inviteDraft = emptyInvites();
    state.placeDraft = "";
    state.planTime = "";
    state.endDraft = emptyEnd();
    state.planDraft = { description: "" };
    state.planDay = "pick";
    state.planDate = "";
    state.planWhere = emptyWhereSession();
    state.error = locationNote;
    await refresh({ initial: true });
  }, locationNote);
}

export async function endSocial(social) {
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
