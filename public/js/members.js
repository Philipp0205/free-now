import { circleStatusLine, statusLine, activeStatus, untilText as statusUntilText, statusBadge, statusLabel } from "./status.js";
import { availabilityText } from "./freebusy.js";
import { state } from "./state.js";
import { api, refresh } from "./session.js";
import { render } from "./render.js";
import { onDeleteCircle, onRenameCircle, openCircleSheet, rotateInvite, screenHeader } from "./circles.js";
import { el, field, payLink, run, viewerTz, weroEntry } from "./lib.js";
import { shareInvite } from "./plan-share.js";
import { avatar } from "./avatars.js";
import { closeSheet } from "./sheets.js";

export function circleScreen() {
  const circle = state.me.circle;
  return el("div", {}, [
    screenHeader("Circle"),
    el("div", { class: "panel" }, [
      el("h3", { text: circle.name }),
      youAreAdmin()
        ? el("form", { class: "stack", onsubmit: onRenameCircle }, [
            field("Circle name", "circle-rename", circle.name, () => {}, { maxlength: "32" }),
            el("button", { class: "btn secondary", type: "submit", text: "Save circle name" }),
          ])
        : null,
      el("div", { class: "code-block", text: circle.inviteCode }),
      el("p", { class: "help", text: "Share the link. It lasts 14 days. New invite link turns the old one off." }),
      el("div", { class: "stack" }, [
        el("button", {
          class: "btn",
          type: "button",
          text: "Share invite",
          onclick: () => shareInvite(),
        }),
        el("button", {
          class: "text-btn",
          type: "button",
          text: "New link",
          onclick: () => rotateInvite(),
        }),
        el("button", {
          class: "text-btn",
          type: "button",
          text: "New circle",
          onclick: () => openCircleSheet("new-circle"),
        }),
        el("button", {
          class: "text-btn",
          type: "button",
          text: "Join with link",
          onclick: () => openCircleSheet("join-circle"),
        }),
      ]),
    ]),
    el("div", { class: "list" }, [
      awayLine(),
      el("h2", { class: "members-title", text: "Members" }),
      ...circle.members.map((member) => memberRow(member)),
    ]),
    youAreAdmin()
      ? el("div", { class: "panel stack" }, [
          el("button", { class: "btn danger", type: "button", text: "Delete circle", onclick: onDeleteCircle }),
        ])
      : null,
  ]);
}

/** Who in this circle is away or busy, in one line. Null when no one is. */
export function awayLine() {
  const text = circleStatusLine(state.me?.circle?.members, state.me?.user?.id, Date.now(), 3, viewerTz());
  return text ? el("p", { class: "away-line", text }) : null;
}

/** Busy or free right now for a member who shares with this circle, from the circle payload. */
export function memberAvailability(id) {
  return state.me?.circle?.members?.find((member) => member.id === id)?.availability || null;
}

function availabilityLine(availability, from = Date.now()) {
  const text = availabilityText(availability, from, viewerTz());
  if (!text) return null;
  return el("p", { class: `avail-line ${availability.state}` }, [
    el("span", { class: "avail-dot", "aria-hidden": "true" }),
    el("span", { text }),
  ]);
}

export function youAreAdmin() {
  return Boolean(state.me?.circle?.youAreAdmin);
}

function reachText(reach) {
  if (reach === "on") return "Notifications on";
  if (reach === "off") return "Notifications off";
  if (reach === "not_installed") return "Not installed";
  return "";
}

function memberRow(member) {
  const self = member.id === state.me.user.id;
  const reach = reachText(member.reach);
  const line = [self ? "You" : "", reach].filter(Boolean).join(" · ");
  const status = statusLine(member.status, Date.now(), viewerTz());
  return el("div", { class: "row member-row" }, [
    el("button", {
      class: "member-open",
      type: "button",
      "aria-label": `Details for ${member.name}`,
      onclick: () => openMemberMenu(member),
    }, [
      avatar(member, 40),
      el("div", { class: "grow" }, [
        el("h3", {}, [
          el("span", { text: member.name }),
          member.admin ? el("span", { class: "admin-badge", text: "Admin" }) : null,
        ]),
        status ? el("p", { class: "status-line", "data-status": member.status.type, text: status }) : null,
        line ? el("p", { text: line }) : null,
        self ? null : availabilityLine(member.availability),
      ]),
    ]),
    payLink(member),
    youAreAdmin() && !self
      ? el("button", {
          class: "text-btn",
          type: "button",
          text: "Manage",
          "aria-label": `Manage ${member.name}`,
          onclick: () => openMemberMenu(member),
        })
      : null,
    weroEntry(member),
  ]);
}

function openMemberMenu(member) {
  state.memberMenu = member;
  state.sheet = "member";
  render();
}

/** Away / Busy with its note, place and end day, for the member sheet. */
function statusCard(person) {
  const status = activeStatus(person?.status);
  if (!status) return null;
  const until = statusUntilText(status.until, Date.now(), viewerTz());
  return el("div", { class: "status-card", "data-status": status.type }, [
    el("p", { class: "status-card-head" }, [
      el("span", { class: "status-card-mark", "aria-hidden": "true", text: statusBadge(status.type) }),
      el("strong", { text: statusLabel(status.type) }),
    ]),
    status.text ? el("p", { class: "status-card-text", text: status.text }) : null,
    status.place ? el("p", { class: "status-card-meta", text: status.place }) : null,
    el("p", { class: "status-card-meta", text: until ? until.charAt(0).toUpperCase() + until.slice(1) : "No end day" }),
  ]);
}

export function memberSheet() {
  const member = state.memberMenu;
  if (!member) return el("div");
  const manage = youAreAdmin() && member.id !== state.me.user.id;
  return el("div", {}, [
    el("button", { class: "scrim", type: "button", "aria-label": "Close", onclick: closeSheet }),
    el("div", { class: "sheet", role: "dialog", "aria-label": member.name, "data-snap": `member:${member.id}` }, [
      el("div", { class: "sheet-head" }, [
        el("div", { class: "grabber" }),
        el("h2", { text: member.name }),
        el("p", { class: "help", text: [member.admin ? "Admin" : "Member", reachText(member.reach)].filter(Boolean).join(" · ") }),
      ]),
      statusCard(member),
      manage
        ? el("div", { class: "actions" }, [
            payLink(member, "action"),
            weroEntry(member, "wero-entry full"),
            member.admin
              ? el("button", { class: "action", type: "button", text: "Remove admin", onclick: () => setMemberAdmin(member, false) })
              : el("button", { class: "action", type: "button", text: "Make admin", onclick: () => setMemberAdmin(member, true) }),
            el("button", {
              class: "action",
              type: "button",
              text: "Remove from circle",
              onclick: () => confirmRemoveMember(member),
            }),
          ])
        : el("div", { class: "actions" }, [
            payLink(member, "action"),
            weroEntry(member, "wero-entry full"),
            el("button", { class: "action", type: "button", text: "Close", onclick: closeSheet }),
          ]),
    ]),
  ]);
}

async function setMemberAdmin(member, admin) {
  await run(async () => {
    const data = await api(`/api/circles/members/${member.id}`, { method: "POST", body: { admin } });
    state.me = { ...state.me, circle: data.circle };
    state.sheet = null;
  });
}

function confirmRemoveMember(member) {
  state.sheet = null;
  state.confirm = {
    title: `Remove ${member.name}?`,
    body: "They lose access right away. Their free posts and plans in this circle end.",
    confirmLabel: "Remove",
    action: async () => {
      await run(async () => {
        await api(`/api/circles/members/${member.id}`, { method: "DELETE" });
        await refresh({ initial: true });
      });
    },
  };
  render();
}
