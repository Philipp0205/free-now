import { state } from "./state.js";
import { adoptCircle, api, refresh, rememberCircle } from "./session.js";
import { render, useNamedCircleDefault } from "./render.js";
import { alertsBell, anyCircleUnread, circleHasUnread, markAlertsRead } from "./alerts.js";
import { youAreAdmin } from "./members.js";
import { forgetMapAll } from "./events.js";
import { el, field, icon, run } from "./lib.js";
import { closeSheet } from "./sheets.js";
import { considerReminders, noteInviteJoin } from "./push-install.js";

export function screenHeader(title) {
  const titleEl = el("h1", { class: "screen-title", text: title });
  const bell = alertsBell();
  const switcher = circleSwitcher();
  if (!switcher) return el("header", { class: "screen-head" }, [titleEl, bell]);
  return el("header", { class: "screen-head" }, [
    el("div", { class: "head-copy" }, [switcher, titleEl]),
    bell,
  ]);
}

function circleSwitcher() {
  const circles = state.me?.circles || [];
  const current = state.me?.circle;
  if (!current || circles.length < 2) return null;
  return el("div", { class: "circle-switch" }, [
    el("button", {
      class: "circle-switch-btn",
      type: "button",
      "aria-label": "Switch circle",
      "aria-expanded": state.circleMenu ? "true" : "false",
      onclick: () => {
        state.circleMenu = !state.circleMenu;
        render();
      },
    }, [
      el("span", { text: current.name }),
      icon("chevron"),
      anyCircleUnread() ? el("span", { class: "unread-dot", "aria-hidden": "true" }) : null,
    ]),
    state.circleMenu ? el("div", { class: "circle-menu" }, [
      ...circles.map((circle) => el("button", {
        type: "button",
        class: circle.id === current.id ? "on" : "",
        onclick: () => { void switchCircle(circle.id); },
      }, [
        el("span", { text: circle.name }),
        circleHasUnread(circle.id) ? el("span", { class: "unread-dot", "aria-hidden": "true" }) : null,
      ])),
      el("button", { type: "button", text: "Join with link", onclick: () => openCircleSheet("join-circle") }),
      el("button", { type: "button", text: "New circle", onclick: () => openCircleSheet("new-circle") }),
    ]) : null,
  ]);
}

export function openCircleSheet(kind) {
  state.circleMenu = false;
  state.newCircleName = "";
  state.codeDraft = "";
  state.sheet = kind;
  render();
}

async function switchCircle(id) {
  if (!id || id === state.circleId) {
    state.circleMenu = false;
    render();
    return;
  }
  state.circleMenu = false;
  state.sheet = null;
  state.chat = null;
  state.past = false;
  state.pastDays = null;
  rememberCircle(id);
  // Another circle's list is not news. The bell badge shows what is unread there.
  state.bootstrappedNotifs = false;
  await run(async () => {
    await refresh({ initial: true });
    // Switching while Alerts is open shows that circle's list, so it counts as read.
    if (state.tab === "alerts" && state.notifications.some((note) => !note.readAt)) {
      await markAlertsRead();
    }
  });
}

export async function rotateInvite() {
  await run(async () => {
    const data = await api("/api/circles/invite", { method: "POST", body: {} });
    state.me = { ...state.me, circle: data.circle };
    state.error = "New invite link ready. The old one no longer works.";
  });
}

export function circleNameSheet() {
  return el("div", {}, [
    el("button", { class: "scrim", type: "button", "aria-label": "Close", onclick: closeSheet }),
    el("form", { class: "sheet", role: "dialog", "aria-label": "New circle", onsubmit: onCreateAnother }, [
      el("div", { class: "sheet-head" }, [
        el("div", { class: "grabber" }),
        el("h2", { text: "New circle" }),
      ]),
      el("div", { class: "sheet-scroll" }, [
        field("Circle name", "new-circle-name", state.newCircleName, (value) => {
          state.newCircleName = value;
        }, { maxlength: "32" }),
      ]),
      el("div", { class: "sheet-dock" }, [
        el("button", { class: "btn", type: "submit", text: "Create circle" }),
      ]),
    ]),
  ]);
}

export function joinLinkSheet() {
  return el("div", {}, [
    el("button", { class: "scrim", type: "button", "aria-label": "Close", onclick: closeSheet }),
    el("form", { class: "sheet", role: "dialog", "aria-label": "Join with link", onsubmit: onJoinCircle }, [
      el("div", { class: "sheet-head" }, [
        el("div", { class: "grabber" }),
        el("h2", { text: "Join with link" }),
      ]),
      el("div", { class: "sheet-scroll" }, [
        field("Invite code", "invite-code", state.codeDraft, (value) => {
          state.codeDraft = value.toUpperCase();
        }, { maxlength: "12", autocapitalize: "characters", spellcheck: "false" }),
      ]),
      el("div", { class: "sheet-dock" }, [
        el("button", { class: "btn", type: "submit", text: "Join circle" }),
      ]),
    ]),
  ]);
}

async function onCreateAnother(event) {
  event.preventDefault();
  await run(async () => {
    const created = await api("/api/circles", { method: "POST", body: { name: state.newCircleName || "friends" } });
    rememberCircle(created.circle.id);
    state.sheet = null;
    state.me = await api("/api/me");
    await refresh({ initial: true });
  });
}

export async function onCreateCircle(event) {
  event.preventDefault();
  await run(async () => {
    const created = await api("/api/circles", { method: "POST", body: { name: state.circleDraft || "friends" } });
    rememberCircle(created.circle.id);
    state.me = await api("/api/me");
  });
  void considerReminders();
}

export async function onJoinCircle(event) {
  event.preventDefault();
  await run(async () => {
    const joined = await api("/api/circles/join", { method: "POST", body: { code: state.codeDraft } });
    rememberCircle(joined.circle.id);
    state.sheet = null;
    state.me = await api("/api/me");
    if (state.pendingCode) history.replaceState(null, "", "/");
    noteInviteJoin();
    await refresh({ initial: true });
  });
  void considerReminders();
}

export async function onRenameCircle(event) {
  event.preventDefault();
  const input = document.getElementById("circle-rename");
  await run(async () => {
    const data = await api("/api/circles", { method: "PATCH", body: { name: input.value } });
    state.me = { ...state.me, circle: data.circle };
    state.error = "Circle name saved";
  });
}

export function onDeleteCircle() {
  const circle = state.me?.circle;
  if (!circle || !youAreAdmin()) return;
  state.confirm = {
    title: `Delete ${circle.name}?`,
    body: "This can't be undone. Members, posts, plans, and chats in this circle are removed.",
    confirmLabel: "Delete circle",
    action: async () => {
      await run(async () => {
        state.me = await api("/api/circles", { method: "DELETE" });
        rememberCircle("");
        adoptCircle(state.me);
        state.tab = "home";
        state.chat = null;
        state.chatThread = null;
        state.socials = [];
        state.plans = [];
        forgetMapAll();
        state.notifications = [];
        state.past = false;
        state.pastDays = null;
        state.sheet = null;
        state.signature = "";
        if (!state.me.circle) useNamedCircleDefault();
        if (state.me.circle) await refresh({ initial: true });
      });
    },
  };
  render();
}

export async function onLeave() {
  if (!window.confirm("Leave this circle?")) return;
  await run(async () => {
    state.me = await api("/api/circles/leave", { method: "POST", body: {} });
    rememberCircle(state.me.circle?.id || "");
    state.tab = "home";
    state.socials = [];
    state.plans = [];
    forgetMapAll();
    state.notifications = [];
    // Alerts start over: the next list only remembers its newest, it does not banner old ones.
    state.bootstrappedNotifs = false;
    await refresh({ initial: true });
  });
}
