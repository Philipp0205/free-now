import { bindMap } from "./map.js";
import { formatDistance, haversine, audiencePlace } from "./place.js";
import { gradientClass } from "./card-grad.js";
import { cardCrowd } from "./map-pin.js";
import { statusLine } from "./status.js";
import { availabilityText } from "./freebusy.js";
import { FINDING_PLACE, SHARE_KEY, state } from "./state.js";
import { api, refresh } from "./session.js";
import { render } from "./render.js";
import { adminOver, cardOverflow, planDescription } from "./cards.js";
import { chatRow } from "./chat.js";
import { memberAvailability } from "./members.js";
import { mapsUrl, openEventDetail, planCirclesLine } from "./event-sheets.js";
import { collectPins, mapCircleLine, mapEvents } from "./events.js";
import { recentPlace, scheduleReverse, whereBag } from "./where.js";
import { el, icon, run, viewerTz } from "./lib.js";
import { inReply, paintSummary } from "./composer.js";
import { arriveClock, maybeLine, replySummary, whoRow } from "./replies.js";
import { cardActions } from "./plan-share.js";
import { avatar } from "./avatars.js";
import { tapClosedMenu } from "./nav.js";

export const { mountMap, mountWhereMap, destroyLiveMap, destroyWhereMap, refreshPins, closeMapCard, mapCardOpen, warmMap } = bindMap({
  state,
  whereTarget: () => whereBag(),
  collectPins,
  mapCard,
  paintSummary,
  scheduleReverse,
  recentPlace,
  keepCardOnMapTap: () => tapClosedMenu,
  FINDING_PLACE,
});

function mapCard(pin) {
  const distance = state.viewerLocation ? formatDistance(haversine(state.viewerLocation, pin)) : "";
  const events = mapEvents();
  const social = pin.kind === "social"
    ? events.socials.find((item) => item.id === pin.id) || { id: pin.id, startsAt: null, joined: [] }
    : null;
  const plan = pin.kind === "plan"
    ? events.plans.find((item) => item.id === pin.id) || { id: pin.id, joined: [] }
    : null;
  const item = social?.creator ? social : plan?.creator ? plan : null;
  const kind = social?.creator ? "social" : plan?.creator ? "plan" : pin.kind;
  const menuOpen = item ? state.cardMenu === `${kind}:${item.id}` : false;
  const own = Boolean(pin.own);
  const grad = pin.kind === "plan" ? `card-grad ${gradientClass(pin.id)}` : "";
  return el("article", { class: ["map-card", grad, menuOpen ? "menu-open" : ""].filter(Boolean).join(" ") }, [
    el("div", { class: "map-card-head" }, [
      el("strong", {
        text: pin.title,
        role: "button",
        tabindex: "0",
        onclick: () => item && openEventDetail(kind, item),
      }),
      item ? cardOverflow(kind, item, { onMap: true }) : null,
      el("button", {
        class: "map-card-close",
        type: "button",
        "aria-label": "Close",
        onclick: (event) => {
          event.stopPropagation();
          closeMapCard();
        },
      }, [icon("close")]),
    ]),
    el("div", {
      class: "map-card-body",
      role: item ? "button" : null,
      tabindex: item ? "0" : null,
      onclick: () => item && openEventDetail(kind, item),
    }, [
      el("p", { text: pin.note }),
      el("p", { class: "map-card-time", text: distance ? `${pin.time} · ${distance}` : pin.time }),
      mapCircleLine(item),
      planCirclesLine(plan),
      plan ? planDescription(plan) : null,
      social && !own ? replySummary(social) : null,
      social ? removedNote(social) : null,
      plan && !own ? (plan.removedBy ? removedNote(plan) : (
        (plan.joined.find((person) => person.id === state.me.user.id && person.reply !== "declined") && el("p", {
          class: "reply-line",
          text: planReplyLine(plan.joined.find((person) => person.id === state.me.user.id)),
        }))
      )) : null,
    ]),
    item ? chatRow(kind, item) : null,
    item ? cardActions(kind, item, { locked: own }) : null,
    pin.lat != null ? el("a", {
      class: "map-link quiet",
      href: mapsUrl(pin.lat, pin.lng, pin.note),
      target: "_blank",
      rel: "noopener noreferrer",
      text: "Open in Maps",
      onclick: (event) => event.stopPropagation(),
    }) : null,
  ]);
}

export function planReplyLine(person) {
  const mine = person.id === state.me.user.id;
  const arriving = arriveClock(person);
  if (person.reply === "declined") return mine ? "You can't make it" : `${person.name} can't`;
  if (person.reply === "maybe") return maybeLine(person, mine);
  if (arriving) return mine ? "You're in" : `${person.name} is in, arriving ${arriving}`;
  return mine ? "You're in" : `${person.name} is in`;
}

export function planReplySummary(plan) {
  const people = cardCrowd(plan.creator, plan.joined).listed;
  return whoRow("plan", plan, people.map((person) => guestLine(planReplyLine(person), person, "plan", plan)));
}

function canRemoveGuest(event) {
  return Boolean(event?.creator) && (event.creator.id === state.me.user.id || adminOver(event));
}

export function guestLine(text, person, kind, event) {
  /* Remove moved to the event detail sheet so cards stay clean. Spans: these sit inside the who-row button. */
  return el("span", { class: "reply-line", text });
}

export function guestDetailRow(text, person, kind, event) {
  const status = statusLine(person?.status, Date.now(), viewerTz());
  const availability = person.id === state.me.user.id ? null : memberAvailability(person.id);
  const busyText = availability ? availabilityText(availability, Date.now(), viewerTz()) : "";
  const reply = busyText
    ? el("div", { class: "reply-line" }, [
        el("span", { text }),
        el("span", { class: `avail-tag ${availability.state}`, text: busyText }),
      ])
    : el("p", { class: "reply-line", text });
  const line = status
    ? el("div", { class: "guest-text" }, [reply, el("p", { class: "guest-status", "data-status": person.status.type, text: status })])
    : reply;
  if (!canRemoveGuest(event) || !inReply(person) || person.id === state.me.user.id) {
    return el("div", { class: "guest-row" }, [avatar(person), line]);
  }
  return el("div", { class: "guest-row" }, [
    avatar(person),
    line,
    el("button", {
      class: "text-btn",
      type: "button",
      text: "Remove",
      "aria-label": `Remove ${person.name}`,
      onclick: () => confirmRemoveGuest(kind, event, person),
    }),
  ]);
}

function confirmRemoveGuest(kind, event, person) {
  const label = (event.note || "").trim() || (kind === "plan" ? "the plan" : "Free now");
  state.confirm = {
    title: `Remove ${person.name}?`,
    body: `They can't join ${label} again.`,
    confirmLabel: "Remove",
    action: async () => {
      await run(async () => {
        await api(`/api/${kind}s/${event.id}/people/${person.id}`, { method: "DELETE" });
        await refresh({ initial: true });
      });
    },
  };
  render();
}

export function removedNote(item) {
  if (!item?.removedBy) return null;
  return el("p", { class: "removed-note", text: `${item.removedBy} removed you from this.` });
}

export function shareToggle(label) {
  return el("label", { class: "share-toggle" }, [
    el("input", {
      type: "checkbox",
      checked: state.shareLocation,
      onchange: (event) => {
        state.shareLocation = event.target.checked;
        localStorage.setItem(SHARE_KEY, state.shareLocation ? "1" : "0");
      },
    }),
    el("span", { text: label }),
  ]);
}

export async function sharedPoint() {
  if (!state.shareLocation) return { lat: null, lng: null };
  if (!navigator.geolocation) {
    state.error = "This browser can't share location. The rest still works.";
    return { lat: null, lng: null };
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
    return state.viewerLocation;
  } catch {
    state.error = "Location stayed off. Everything else still works.";
    return { lat: null, lng: null };
  }
}

export function rememberViewerLocation() {
  if (!navigator.geolocation || !navigator.permissions?.query) return;
  navigator.permissions.query({ name: "geolocation" }).then((status) => {
    if (status.state !== "granted") return;
    navigator.geolocation.getCurrentPosition((pos) => {
      state.viewerLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      if (state.tab === "home" || state.tab === "map") render();
    }, () => {}, { enableHighAccuracy: false, maximumAge: 60000, timeout: 8000 });
  }).catch(() => {});
}

export function placeLine(location, placeName, target) {
  const named = audiencePlace(placeName);
  if (!location && !named) return null;
  const distance = location && state.viewerLocation
    ? formatDistance(haversine(state.viewerLocation, location))
    : "";
  const where = named || "nearby";
  const text = distance ? `${where} · ${distance}` : where;
  if (!location || !target) return el("p", { class: "place-line static", text });
  return el("button", {
    class: "place-line",
    type: "button",
    "aria-label": `Show ${text} on the map`,
    onclick: (event) => { event.stopPropagation(); showOnMap(target.kind, target.id); },
  }, [
    el("span", { class: "place-pin", "aria-hidden": "true" }),
    el("span", { text }),
  ]);
}

export function showOnMap(kind, id) {
  const url = new URL(location.href);
  url.searchParams.delete("social");
  url.searchParams.delete("plan");
  const clean = `${url.pathname}${url.search}${url.hash}` || "/";
  if (`${location.pathname}${location.search}${location.hash}` !== clean) {
    history.replaceState(history.state, "", clean);
  }
  if (state.tab !== "map") {
    state.mapReturnTab = state.tab;
    // syncOverlayHistory (from render) pushes the entry Back pops to return here.
    state.mapHistory = true;
  }
  state.focusPin = `${kind}:${id}`;
  state.tab = "map";
  // A pin focus needs the map, so this shows it for now without changing the saved view.
  state.eventsView = "map";
  state.sheet = null;
  render();
}
