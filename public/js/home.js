import { state } from "./state.js";
import { api } from "./session.js";
import { render } from "./render.js";
import { screenHeader } from "./circles.js";
import { compactRow, planCard, socialCard } from "./cards.js";
import { writeCompactHome } from "./compact-home.js";
import { isJoining } from "./plans/joining-filter.js";
import { JOINING_COPY } from "./plans/joining-filter-copy.js";
import { joiningChip } from "./plans/joining-chip.js";
import { awayLine } from "./members.js";
import { homeChatBanner } from "./alerts.js";
import { chatChip } from "./chat.js";
import { clock, el, isLiveSocial, mySocial, run, skeletonList } from "./lib.js";
import { shareInvite } from "./plan-share.js";
import { openSheet } from "./sheets.js";
import { navigate } from "./native.js";

export function home() {
  const mine = mySocial();
  const parts = [homeChatBanner(), screenHeader("Now")];
  parts.push(
    el("div", { class: "now-row" }, [
      el("button", {
        class: mine && isLiveSocial(mine) ? "orb live" : "orb",
        type: "button",
        "aria-label": "Let friends know you're free now",
        "aria-pressed": mine ? "true" : "false",
        onclick: () => openSheet("free"),
      }),
      mine
        ? el("p", { class: "hint" }, [
            el("strong", { text: mine.startsAt && mine.startsAt > Date.now() ? `Free from ${clock(mine.startsAt)}` : "You're free now" }),
            document.createTextNode(mine.note || "Friends have been told"),
          ])
        : el("p", { class: "hint" }, [
            document.createTextNode("Tap to let friends"),
            el("br"),
            document.createTextNode("know you're free now"),
          ]),
    ]),
  );
  parts.push(
    el("button", {
      class: "invite-chip",
      type: "button",
      text: "Share invite",
      onclick: () => shareInvite(),
    }),
  );
  const away = awayLine();
  if (away) parts.push(away);
  const live = state.socials.filter((social) => isLiveSocial(social) || social.creator.id === state.me.user.id);
  const later = state.socials.filter((social) => !isLiveSocial(social) && social.creator.id !== state.me.user.id);
  const events = [
    ...live.map((social) => ["social", social]),
    ...later.map((social) => ["social", social]),
    ...sortedPlans(state.plans).map((plan) => ["plan", plan]),
  ];
  if (events.length) parts.push(eventsSection(events));
  parts.push(el("div", { class: "past-entry" }, [
    el("button", { class: "text-btn", type: "button", text: "Past events", onclick: () => { void openPast(); } }),
  ]));
  return el("div", {}, parts);
}

/** The tools row (Joining only, Cards / Compact) and the list, or the filter's empty note. */
function eventsSection(events) {
  const shown = state.joiningOnly ? events.filter(([, item]) => isJoining(item, state.me.user.id)) : events;
  const list = state.compactHome
    ? el("div", { class: "compact-list" }, shown.map(([kind, item]) => compactRow(kind, item)))
    : el("div", { class: "cards" }, shown.map(([kind, item]) => (kind === "plan" ? planCard(item) : socialCard(item))));
  return el("div", { class: "section" }, [
    el("div", { class: "list-tools" }, [joiningChip(), listToggle()]),
    shown.length ? list : el("p", { class: "joining-empty", text: JOINING_COPY.homeEmpty }),
  ]);
}

function setCompactHome(on) {
  if (state.compactHome === on) return;
  state.compactHome = on;
  writeCompactHome(on);
  state.cardMenu = null;
  render();
}

/** Cards / Compact, on the same small segment the Events tab uses. Not drawn when there is nothing to list. */
function listToggle() {
  const option = (name, on) => el("button", {
    id: `home-list-${name.toLowerCase()}`,
    type: "button",
    class: state.compactHome === on ? "on" : "",
    "aria-pressed": state.compactHome === on ? "true" : "false",
    text: name,
    onclick: () => setCompactHome(on),
  });
  return el("div", { class: "home-list-toggle segment", role: "group", "aria-label": "Event list" }, [
    option("Cards", false),
    option("Compact", true),
  ]);
}

/** Plans by day, then time (no time last that day), like the server sends them. */
function sortedPlans(plans) {
  return [...plans].sort((a, b) => (
    a.forDate.localeCompare(b.forDate)
    || (a.time ? 0 : 1) - (b.time ? 0 : 1)
    || (a.time || "").localeCompare(b.time || "")
  ));
}

async function openPast() {
  state.past = true;
  state.sheet = null;
  state.pastDays = null;
  void navigate(render, "push");
  await run(async () => {
    state.pastDays = (await api("/api/past")).days;
  });
}

export function closePast() {
  state.past = false;
  state.pastDays = null;
  void navigate(render, "pop");
}

export function pastScreen() {
  const days = state.pastDays;
  return el("section", { class: "past-screen", "aria-label": "Past events" }, [
    el("header", { class: "chat-head" }, [
      el("button", { class: "text-btn chat-back", type: "button", text: "Back", onclick: closePast }),
      el("h1", { text: "Past events" }),
    ]),
    days == null
      ? skeletonList(4, "past-skel")
      : days.length
        ? el("div", { class: "past-list" }, days.map(pastDay))
        : el("p", { class: "help past-empty", text: "Nothing here yet. Ended hangouts stay for 90 days." }),
  ]);
}

function pastDay(day) {
  return el("section", { class: "past-day" }, [
    el("h2", { text: day.label }),
    ...day.events.map(pastCard),
  ]);
}

function pastCard(event) {
  const bits = [event.host.name];
  if (event.time) bits.push(event.time);
  if (event.place) bits.push(event.place);
  const people = event.people.map((person) => (
    person.arriveAt ? `${person.name}, arriving ${clock(person.arriveAt)}` : person.name
  ));
  return el("article", { class: "past-card" }, [
    el("h3", { text: event.note || (event.kind === "plan" ? "Plan" : "Free now") }),
    el("p", { text: bits.join(" · ") }),
    people.length ? el("p", { text: people.join(" · ") }) : null,
    chatChip(event.kind, event.id),
  ]);
}
