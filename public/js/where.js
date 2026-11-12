import { looksLikeUrl, formatDistance, isMapsLink } from "./place.js";
import { FINDING_PLACE, emptyWhere, state } from "./state.js";
import { api } from "./session.js";
import { render } from "./render.js";
import { paintSummary } from "./composer.js";
import { el, icon, scheduleErrorClear } from "./lib.js";

const URL_HINT = "Paste a Google Maps link or type a place";

let whereTimer = 0;
/** Bumped on every new search or reset. Older answers see a different number and are dropped. */
let whereSeq = 0;
let skipWhereInput = false;
let reverseTimer = 0;

export function whereBag() {
  if (state.sheet === "plan" && state.planWhere) return state.planWhere;
  if (state.sheet === "admin-edit" && state.adminEdit?.where) return state.adminEdit;
  return state;
}

export function whereFromSocial(social) {
  if (!social || (!social.place && !social.location)) return emptyWhere();
  if (social.location && !social.place) {
    return { mode: "here", place: "", lat: social.location.lat, lng: social.location.lng, precise: false };
  }
  return {
    mode: "place",
    place: social.place || "",
    lat: social.location?.lat ?? null,
    lng: social.location?.lng ?? null,
    precise: Boolean(social.location),
  };
}

function namedPlace(value) {
  const text = String(value || "").trim();
  if (!text || text === FINDING_PLACE || looksLikeUrl(text)) return "";
  return text;
}

function whereLabel(bag = state) {
  if (bag.where.mode === "here" && /^near you$/i.test(bag.where.place || "")) return "Current location";
  if (bag.where.place) return bag.where.place;
  if (bag.where.mode === "here") return "Current location";
  if (bag.where.lat != null) return FINDING_PLACE;
  return "Pick a place";
}

function whereIsEmpty(bag = state) {
  return whereLabel(bag) === "Pick a place";
}

function pinnedSpot(lat, lng) {
  const digits = (value) => (Math.round(value * 10000) / 10000).toFixed(4);
  return `Pinned spot (${digits(lat)}, ${digits(lng)})`;
}

function droppedPinName(area, lat, lng) {
  const district = String(area || "").replace(/\s+/g, " ").trim();
  if (district) return `Dropped pin near ${district}`.slice(0, 80);
  return pinnedSpot(lat, lng);
}

export function wherePayload(bag = state) {
  const where = bag.where;
  const typed = namedPlace(bag.whereQuery || where.place || "");
  const named = typed || (where.lat != null && where.lng != null ? droppedPinName(bag.whereArea, where.lat, where.lng) : "");
  if (where.mode === "here" && where.lat != null && where.lng != null) {
    return { place: namedPlace(where.place) || "near you", lat: where.lat, lng: where.lng, precise: false };
  }
  if ((where.mode === "place" || named) && (named || where.lat != null)) {
    return {
      place: named,
      lat: where.lat,
      lng: where.lng,
      precise: Boolean(where.precise && where.lat != null && where.lng != null),
    };
  }
  return { place: "", lat: null, lng: null, precise: false };
}

export function whereBlock(bag = state) {
  const value = whereLabel(bag);
  const empty = whereIsEmpty(bag);
  return el("div", { class: "where sheet-group" }, [
    el("span", { class: "sheet-label", id: "where-label", text: "Where" }),
    el("div", { class: empty ? "where-field" : "where-field has-value" }, [
      el("button", {
        class: "where-row",
        type: "button",
        "aria-labelledby": "where-label",
        "aria-expanded": bag.whereOpen ? "true" : "false",
        onclick: () => {
          bag.whereOpen = !bag.whereOpen;
          if (!bag.whereOpen) bag.whereMap = false;
          render();
          if (bag.whereOpen) queueMicrotask(() => document.getElementById("where-query")?.focus());
        },
      }, [
        el("span", { class: empty ? "where-v is-placeholder" : "where-v", text: value }),
        icon("chevron"),
      ]),
      empty
        ? null
        : el("button", {
            class: "where-clear",
            type: "button",
            text: "Clear",
            onclick: (event) => {
              event.preventDefault();
              event.stopPropagation();
              clearWhereSelection(bag, bag.whereOpen);
            },
          }),
    ]),
    bag.whereOpen ? wherePicker(bag) : null,
  ]);
}

function wherePicker(bag = state) {
  return el("div", { class: "where-picker" }, [
    el("input", {
      id: "where-query",
      class: "sheet-control",
      type: "text",
      value: bag.whereQuery,
      placeholder: "Search for a place or paste a Maps link",
      maxlength: "2000",
      autocomplete: "off",
      enterkeyhint: "search",
      onbeforeinput: (event) => onWhereBeforeInput(bag, event),
      oninput: (event) => onWhereInput(bag, event),
      onkeydown: (event) => onWhereKeydown(bag, event),
    }),
    whereStatusRow(bag),
    bag.whereResults.length
      ? el("div", { class: "where-results" }, bag.whereResults.map((hit) => el("button", {
          class: "where-hit",
          type: "button",
          onclick: () => chooseWhereHit(bag, hit),
        }, [
          el("span", { class: "where-hit-name", text: hit.name }),
          hitMeta(hit) ? el("span", { class: "where-hit-meta", text: hitMeta(hit) }) : null,
        ])))
      : null,
    el("button", {
      class: "where-action",
      type: "button",
      text: "Use my current location",
      onclick: () => { void useCurrentWhere(bag); },
    }),
    el("button", {
      class: "where-action",
      type: "button",
      text: bag.whereMap ? "Hide map" : "Pick on map",
      onclick: () => {
        bag.whereMap = !bag.whereMap;
        render();
      },
    }),
    bag.whereMap ? el("div", { id: "where-map", class: "where-map", "data-no-sheet-drag": "1" }) : null,
  ]);
}

/** One line under the search field. It keeps its height, so idle, searching, empty and error never shift the sheet. */
function whereStatusRow(bag) {
  let child = null;
  if (bag.whereHint) child = el("span", { class: "where-hint", text: bag.whereHint });
  else if (bag.whereSearching) child = [el("span", { class: "where-spinner", "aria-hidden": "true" }), el("span", { text: "Searching…" })];
  else if (bag.whereStatus === "empty") child = el("span", { text: "No places found" });
  else if (bag.whereStatus === "error") child = el("span", { class: "where-error", text: "Couldn't search. Try again." });
  return el("p", {
    class: bag.whereSearching && !bag.whereHint ? "where-status is-searching" : "where-status",
    role: "status",
    "aria-live": "polite",
  }, child);
}

/** Swap just the status line, so typing never rebuilds the input mid-word. */
function paintWhereStatus(bag) {
  const row = document.querySelector(".where-picker .where-status");
  if (!row) return;
  const next = whereStatusRow(bag);
  row.className = next.className;
  row.replaceChildren(...next.childNodes);
}

function hitMeta(hit) {
  const distance = Number.isFinite(hit.distanceM) ? formatDistance(hit.distanceM) : "";
  return [distance, hit.address].filter(Boolean).join(" · ");
}

function searchOrigin() {
  if (state.viewerLocation) return state.viewerLocation;
  if (state.mapCenter) return state.mapCenter;
  return recentPlace();
}

export function recentPlace() {
  for (const social of state.socials || []) {
    if (social.location) return social.location;
  }
  for (const plan of state.plans || []) {
    if (plan.location) return plan.location;
  }
  return null;
}

function chooseWhereHit(bag, hit) {
  bag.whereAutofill = false;
  bag.where = { mode: "place", place: hit.name, lat: hit.lat, lng: hit.lng, precise: true };
  bag.whereQuery = hit.name;
  bag.whereResults = [];
  stopWhereSearch(bag);
  bag.whereHint = "";
  render();
}

function clearWhereSelection(bag, keepOpen) {
  if (typeof bag === "boolean") {
    keepOpen = bag;
    bag = state;
  }
  bag.whereAutofill = false;
  bag.where = emptyWhere();
  bag.whereQuery = "";
  bag.whereResults = [];
  stopWhereSearch(bag);
  bag.whereHint = "";
  bag.whereMap = false;
  bag.whereOpen = Boolean(keepOpen);
  render();
  paintSummary();
  if (keepOpen) queueMicrotask(() => document.getElementById("where-query")?.focus());
}

function swallowNextWhereInput() {
  skipWhereInput = true;
  queueMicrotask(() => { skipWhereInput = false; });
}

function onWhereBeforeInput(bag, event) {
  if (!bag.whereAutofill) return;
  const type = event.inputType || "";
  if (type.startsWith("delete")) {
    event.preventDefault();
    swallowNextWhereInput();
    clearWhereSelection(bag, true);
    return;
  }
  if (type.startsWith("insert") && typeof event.data === "string") {
    event.preventDefault();
    swallowNextWhereInput();
    commitTypedWhere(bag, event.data);
  }
}

function onWhereInput(bag, event) {
  if (skipWhereInput) {
    skipWhereInput = false;
    event.target.value = bag.whereQuery;
    const end = bag.whereQuery.length;
    try { event.target.setSelectionRange(end, end); } catch { /* the caret can stay */ }
    return;
  }
  if (bag.whereAutofill) {
    const next = event.target.value;
    const previous = bag.whereQuery;
    if (next.length < previous.length) {
      clearWhereSelection(bag, true);
      return;
    }
    if (next !== previous && next.startsWith(previous)) {
      commitTypedWhere(bag, next.slice(previous.length));
      return;
    }
    if (next !== previous) {
      commitTypedWhere(bag, next);
      return;
    }
  }
  applyWhereQuery(bag, event.target.value);
}

function commitTypedWhere(bag, text) {
  bag.whereAutofill = false;
  bag.where = {
    mode: text.trim() ? "place" : "none",
    place: text,
    lat: null,
    lng: null,
    precise: false,
  };
  bag.whereQuery = text;
  const input = document.getElementById("where-query");
  if (input) {
    input.value = text;
    const end = text.length;
    try { input.setSelectionRange(end, end); } catch { /* keep the caret where the field left it */ }
  }
  const label = document.querySelector(".where-v");
  if (label) {
    label.textContent = text.trim() || "Pick a place";
    label.classList.toggle("is-placeholder", !text.trim());
  }
  paintSummary();
  scheduleWhereSearch(bag);
}

function applyWhereQuery(bag, value) {
  const limited = limitWhereQuery(value);
  const input = document.getElementById("where-query");
  if (input && input.value !== limited) input.value = limited;
  bag.whereAutofill = false;
  bag.whereQuery = limited;
  const typed = limited.trim();
  bag.where.mode = typed ? "place" : "none";
  bag.where.place = typed;
  bag.where.lat = null;
  bag.where.lng = null;
  bag.where.precise = false;
  const label = document.querySelector(".where-v");
  if (label) {
    label.textContent = typed || "Pick a place";
    label.classList.toggle("is-placeholder", !typed);
  }
  paintSummary();
  scheduleWhereSearch(bag);
}

function rerenderWhere() {
  const input = document.activeElement?.id === "where-query" ? document.activeElement : null;
  const caret = input ? input.selectionStart : null;
  render();
  if (!input) return;
  queueMicrotask(() => {
    const next = document.getElementById("where-query");
    if (!next) return;
    next.focus();
    if (caret != null) {
      try { next.setSelectionRange(caret, caret); } catch { /* the field keeps its own caret */ }
    }
  });
}

function limitWhereQuery(value) {
  const text = String(value ?? "");
  const trimmed = text.trim();
  if (looksLikeUrl(trimmed)) return trimmed.slice(0, 2000);
  return text.slice(0, 80);
}

function searchQuery(value) {
  return limitWhereQuery(value).trim();
}

/** What the Where status row shows. Only re-render when this changes, not on every key. */
function whereView(bag) {
  return [bag.whereHint || "", bag.whereSearching ? 1 : 0, bag.whereStatus || "", bag.whereResults.length].join("|");
}

/** Repaint after a status change: just the status line if the hit list is the same, else the whole picker. */
function refreshWhere(bag, before) {
  const now = whereView(bag);
  if (now === before) return;
  const sameList = now.split("|")[3] === before.split("|")[3] && document.querySelector(".where-picker .where-status");
  if (sameList) paintWhereStatus(bag);
  else rerenderWhere();
}

/** Stop any pending or in-flight search so its answer is ignored. */
export function stopWhereSearch(bag) {
  clearTimeout(whereTimer);
  whereTimer = 0;
  whereSeq += 1;
  bag.whereSearching = false;
  bag.whereStatus = "";
}

function scheduleWhereSearch(bag = state, { now = false } = {}) {
  const before = whereView(bag);
  const query = searchQuery(bag.whereQuery);
  const maps = isMapsLink(query);
  const hint = looksLikeUrl(query) && !maps ? URL_HINT : "";
  stopWhereSearch(bag);
  bag.whereHint = hint;
  if (hint || (!maps && query.length < 2)) {
    bag.whereResults = [];
    refreshWhere(bag, before);
    return;
  }
  // Show Searching… straight away, through the debounce and the fetch.
  bag.whereSearching = true;
  refreshWhere(bag, before);
  const seq = whereSeq;
  const go = () => {
    whereTimer = 0;
    const origin = searchOrigin();
    const near = origin && !maps ? `&lat=${encodeURIComponent(origin.lat)}&lng=${encodeURIComponent(origin.lng)}` : "";
    api(`/api/geocode?q=${encodeURIComponent(query)}${near}`).then((data) => {
      if (seq !== whereSeq) return;
      bag.whereResults = data?.results || [];
      bag.whereSearching = false;
      bag.whereStatus = bag.whereResults.length ? "" : "empty";
      rerenderWhere();
    }).catch(() => {
      if (seq !== whereSeq) return;
      bag.whereSearching = false;
      bag.whereResults = [];
      bag.whereStatus = "error";
      rerenderWhere();
    });
  };
  if (now) go();
  else whereTimer = setTimeout(go, 400);
}

/** Enter / the keyboard's search key runs the search now. It never saves the sheet. */
function onWhereKeydown(bag, event) {
  if (event.key !== "Enter") return;
  event.preventDefault();
  if (bag.whereAutofill) return;
  const value = event.target.value;
  if (value !== bag.whereQuery) applyWhereQuery(bag, value);
  scheduleWhereSearch(bag, { now: true });
}

export async function defaultCurrentWhere() {
  if (!navigator.geolocation || !navigator.permissions?.query) return;
  try {
    const status = await navigator.permissions.query({ name: "geolocation" });
    if (status.state !== "granted") return;
  } catch {
    return;
  }
  if (state.sheet === "free" && state.where.mode === "none") await useCurrentWhere(state);
}

async function useCurrentWhere(bag = state) {
  if (!navigator.geolocation) {
    state.error = "This browser can't share location. The rest still works.";
    render();
    scheduleErrorClear();
    return;
  }
  try {
    const pos = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: false,
        timeout: 8000,
        maximumAge: 0,
      });
    });
    state.viewerLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    bag.whereAutofill = true;
    bag.where = { mode: "here", place: "near you", lat: pos.coords.latitude, lng: pos.coords.longitude, precise: false };
    bag.whereQuery = "Current location";
    bag.whereResults = [];
    stopWhereSearch(bag);
    state.error = "";
    const keepFocus = document.activeElement?.id === "where-query";
    render();
    if (keepFocus) queueMicrotask(() => document.getElementById("where-query")?.focus());
    const named = await api(`/api/geocode?lat=${encodeURIComponent(pos.coords.latitude)}&lng=${encodeURIComponent(pos.coords.longitude)}`).catch(() => null);
    if (bag.where.mode === "here" && bag.where.lat === pos.coords.latitude && bag.whereAutofill) {
      const place = named?.place && !/^near you$/i.test(named.place) ? named.place : "near you";
      bag.where.place = place;
      bag.whereQuery = place === "near you" ? "Current location" : place;
      const stillFocused = document.activeElement?.id === "where-query";
      render();
      if (stillFocused) queueMicrotask(() => document.getElementById("where-query")?.focus());
    }
  } catch {
    state.error = "Location stayed off. Everything else still works.";
    render();
    scheduleErrorClear();
  }
}

function paintChosenPlace(name) {
  const bag = whereBag();
  bag.where.place = name;
  bag.whereQuery = name;
  bag.where.mode = "place";
  bag.whereAutofill = false;
  const label = document.querySelector(".where-v");
  const query = document.getElementById("where-query");
  if (label) {
    label.textContent = name;
    label.classList.remove("is-placeholder");
  }
  if (query && document.activeElement !== query) query.value = name;
  paintSummary();
  if (!label && !query) rerenderWhere();
}

export function scheduleReverse(lat, lng, replace = false) {
  clearTimeout(reverseTimer);
  const stamp = {};
  reverseTimer = stamp;
  let finished = false;
  const bag = whereBag();
  const still = () => reverseTimer === stamp && bag.where.lat === lat && bag.where.lng === lng;
  const accept = (name, area) => {
    if (!still()) return;
    const current = bag.where.place;
    const open = !current || current === FINDING_PLACE || current === bag.whereFallback;
    if (!open) return;
    if (!replace && bag.whereQuery.trim() && bag.whereQuery !== FINDING_PLACE && current !== bag.whereFallback) return;
    if (area) bag.whereArea = area;
    bag.whereFallback = name.startsWith("Pinned spot (") || name.startsWith("Dropped pin near ") ? name : "";
    paintChosenPlace(name);
  };
  const giveUp = () => accept(droppedPinName(bag.whereArea, lat, lng), bag.whereArea);
  setTimeout(() => {
    if (!finished) giveUp();
  }, 4000);
  api(`/api/geocode?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}`).then((data) => {
    if (!still()) return;
    finished = true;
    const place = String(data?.place || "").trim();
    const area = String(data?.area || "").trim();
    if (place) accept(place, area);
    else accept(droppedPinName(area, lat, lng), area);
  }).catch((error) => {
    console.error("reverse geocode failed", error);
    finished = true;
    giveUp();
  });
}
