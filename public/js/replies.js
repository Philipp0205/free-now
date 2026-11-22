import { cardCrowd } from "./map-pin.js";
import { PLAN_DURATION_MS, dayEvents, eventOverlaps, eventTimeText } from "./freebusy.js";
import { zonedParts, planDayRange, dayLabel, addDays } from "./when.js";
import { state } from "./state.js";
import { api, refresh } from "./session.js";
import { render } from "./render.js";
import { openEventDetail } from "./event-sheets.js";
import { appTz, clock, el, icon, run, scheduleErrorClear } from "./lib.js";
import { inReply } from "./composer.js";
import { guestLine } from "./map-card.js";
import { avatar } from "./avatars.js";
import { MAYBE_COPY } from "./plans/maybe-copy.js";

export function arriveClock(person) {
  return person?.arriveAt ? clock(person.arriveAt) : "";
}

export function replyLine(person, social) {
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

export function maybeLine(person, mine) {
  return mine ? "You're maybe" : `${person.name} is maybe`;
}

/** The card's faces: host first, then everyone In. Maybe and Can't stay out of the stack. */
export function avatarStack(item) {
  const crowd = cardCrowd(item.creator, item.joined);
  return el("div", { class: "avatars" }, [
    ...crowd.stack.map((person) => avatar(person)),
    crowd.more ? el("span", { class: "avatar avatar-more", text: `+${crowd.more}`, "aria-label": `${crowd.more} more` }) : null,
  ]);
}

/** The who-row's people: everyone In, then the Maybe group as its own lines. Can't is only in the details. */
export function whoRowPeople(host, joined) {
  const crowd = cardCrowd(host, joined);
  return [...crowd.listed, ...crowd.maybe];
}

/** Shown in the who-row: in, then maybe. Can't is only in the details. */
export function replySummary(social) {
  const people = whoRowPeople(social.creator, social.joined);
  return whoRow("social", social, people.map((person) => guestLine(replyLine(person, social), person, "social", social)));
}

/* Full-width "who's in" row: its own 44px+ tap target that opens the details, never the map. */
export function whoRow(kind, item, lines) {
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

export function inToggle(kind, item, { locked = false } = {}) {
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

/** The Maybe button: tap to say maybe, tap again to take it back. Not for the host, who stays In. */
export function maybeToggle(kind, item) {
  const mine = item.joined?.find((person) => person.id === state.me.user.id);
  const on = mine?.reply === "maybe";
  return el("button", {
    class: ["maybe-toggle", on ? "on" : ""].filter(Boolean).join(" "),
    type: "button",
    text: on ? MAYBE_COPY.buttonOn : MAYBE_COPY.button,
    "aria-pressed": String(on),
    "aria-label": MAYBE_COPY.button,
    title: on ? MAYBE_COPY.titleOn : MAYBE_COPY.titleOff,
    onclick: (event) => {
      event.stopPropagation();
      state.cardMenu = null;
      tick();
      if (on) void leaveEvent(kind, item);
      else void sendReply(kind, item, "maybe");
    },
  });
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
export function tick() {
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

export function chooseArrival(kind, item, value) {
  if (!/^\d{2}:\d{2}$/.test(value)) return;
  if (!arrivalAllowed(kind, item, value)) {
    state.error = "Pick a time you can arrive.";
    render();
    scheduleErrorClear();
    return;
  }
  void sendReply(kind, item, "in", value);
}

export async function sendReply(kind, item, reply, arriveAt = null) {
  await run(async () => {
    const body = { reply };
    if (arriveAt) body.arriveAt = arriveAt;
    await api(`/api/${kind}s/${item.id}/reply`, { method: "POST", body });
    await refresh({ initial: true });
  });
}

export function arrivalDefault(kind, item) {
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

export function clockInstant(day, hhmm) {
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
