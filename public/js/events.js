import { CIRCLE_COLORS, circleColor, monthStart, gridRange, monthGrid, monthTitle, shiftMonth, WEEKDAY_LABELS, eventCrowd, freeOnDay } from "./calendar-month.js";
import { zonedParts, shortDate, planDayRange } from "./when.js";
import { audiencePlace } from "./place.js";
import { activeStatus } from "./status.js";
import { socialPinState, pinLabel, goingCrowd } from "./map-pin.js";
import { EVENTS_VIEW_KEY, MAP_ALL_KEY, state } from "./state.js";
import { destroyLiveMap, refreshPins } from "./map-card.js";
import { api, isNetworkFailure, noteConnectionProblem } from "./session.js";
import { render } from "./render.js";
import { screenHeader } from "./circles.js";
import { openEventDetail } from "./event-sheets.js";
import { openSheet } from "./sheets.js";
import { appTz, clock, colorFor, el, icon, initial, remaining } from "./lib.js";
import { planOpen } from "./plan-share.js";
import { avatar, avatarKey, avatarUrls, loadAvatar } from "./avatars.js";

/** Faces on a plan pin: the host's own pin plus up to three in the crowd. Anyone past that is a +N chip. */
const MAP_CROWD_FACES = 4;

/** The events the map shows: every circle when All circles is on, else the selected one. */
export function mapEvents() {
  if (state.mapAllCircles) return { socials: state.mapSocials, plans: state.mapPlans };
  return { socials: state.socials, plans: state.plans };
}

export function forgetMapAll() {
  state.mapSocials = [];
  state.mapPlans = [];
  state.calendarSocials = [];
  state.calendarPlans = [];
  state.calendarKey = "";
}

export async function refreshMapAll() {
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
export function actingCircle(item) {
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

export function mapCircleLine(item) {
  if (!state.mapAllCircles || !item) return null;
  if (item.circles && item.circles.length >= 2) return null;
  if (!item.circleName) return null;
  return el("p", { class: "map-card-circle", text: item.circleName });
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

export function calToday() {
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
export async function loadCalendar({ force = false } = {}) {
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

export function calSocialDay(social) {
  return social.day || zonedParts(social.startsAt ?? social.createdAt, appTz()).day;
}

export function calSocialOver(social) {
  return !(Number(social.expiresAt) > Date.now());
}

export function calPlanOver(plan) {
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

/** "Plan for this day" opens the plan sheet on the picked day, only where the date input allows it. */
function planForDay(day) {
  const { min, max } = planDayRange(Date.now(), appTz());
  if (day < min || day > max) return null;
  return el("button", { class: "btn ghost cal-add", type: "button", text: "Plan for this day", onclick: () => openSheet("plan", { planDate: day }) });
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
      planForDay(state.calDay),
    ]);
  } else {
    below = el("section", { class: "cal-day", "aria-label": shortDate(state.calDay, today) }, [
      el("h2", { class: "cal-day-title", text: state.calDay === today ? `Today · ${shortDate(state.calDay, today)}` : shortDate(state.calDay, today) }),
      dayEvents.length
        ? el("div", { class: "cal-list" }, dayEvents.map(calendarRow))
        : el("p", { class: "cal-quiet", text: "Nothing on this day." }),
      calFreeLine(state.calDay, dayEvents),
      planForDay(state.calDay),
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

export function mapScreen() {
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

export function collectPins() {
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
