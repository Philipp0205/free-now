import { state } from "./state.js";
import { api } from "./session.js";
import { render } from "./render.js";
import { screenHeader } from "./circles.js";
import { planCard, socialCard } from "./cards.js";
import { awayLine } from "./members.js";
import { homeChatBanner } from "./alerts.js";
import { chatChip } from "./chat.js";
import { clock, el, isLiveSocial, mySocial, run, skeletonList } from "./lib.js";
import { shareInvite } from "./plan-share.js";
import { openSheet } from "./sheets.js";

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
  const feed = [...live.map(socialCard), ...later.map(socialCard), ...sortedPlans(state.plans).map(planCard)];
  if (feed.length) parts.push(el("div", { class: "section" }, [el("div", { class: "cards" }, feed)]));
  parts.push(el("div", { class: "past-entry" }, [
    el("button", { class: "text-btn", type: "button", text: "Past events", onclick: () => { void openPast(); } }),
  ]));
  return el("div", {}, parts);
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
  render();
  await run(async () => {
    state.pastDays = (await api("/api/past")).days;
  });
}

export function closePast() {
  state.past = false;
  state.pastDays = null;
  render();
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
