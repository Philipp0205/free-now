import { compactTone, planGradientClass } from "./card-grad.js";
import { state } from "./state.js";
import { render } from "./render.js";
import { chatRow } from "./chat.js";
import { youAreAdmin } from "./members.js";
import { canShareCircles, endManaged, mapsUrl, openAdminEdit, openArrivalPicker, openEventDetail, openShareCircles, planCirclesLine } from "./event-sheets.js";
import { clock, appTz, el, icon, remaining } from "./lib.js";
import { inReply } from "./composer.js";
import { arrivalDefault, arriveClock, avatarStack, inToggle, replySummary, sendReply } from "./replies.js";
import { avatar } from "./avatars.js";
import { compactTitle, compactWhen, compactWho } from "./compact-home.js";
import { addPlanToCalendar, cardActions, planOpen, remindCooling, remindFriends } from "./plan-share.js";
import { placeLine, planReplySummary, removedNote } from "./map-card.js";
import { eventIsNow } from "./map-pin.js";
import { priceLine } from "./event-pay.js";
import { MAYBE_COPY } from "./plans/maybe-copy.js";

/** Card menu opened by the latest ⋯ tap; the render that draws it pops it in once. */
let menuJustOpened = null;

/** The kit's pop for a menu that was just opened by a ⋯ tap. render() calls it once the menu is placed. */
export function playMenuPop() {
  const key = menuJustOpened;
  menuJustOpened = null;
  if (!key || state.cardMenu !== key) return;
  const menu = document.querySelector(`.card-more[data-menu="${CSS.escape(key)}"]`)?.parentElement?.querySelector(".card-menu");
  if (menu) window.AppKit?.pop?.in?.(menu);
}

/** The open menu before a render, with where it sat, so the render can pop it out instead of dropping it. */
export function captureOpenMenu() {
  const menu = document.querySelector(".card-menu:not(.ak-pop-out)");
  const key = menu?.parentElement?.querySelector(".card-more")?.dataset.menu;
  return menu && key ? { menu, key } : null;
}

/**
 * After a render that closed a card menu, puts the old menu back for the kit's pop-out, then removes it.
 * The state is already closed: the ghost is inert and hidden from assistive tech, and its card keeps
 * .menu-open (overflow visible) until the pop ends. A card that is gone, or a menu that is open again, is skipped.
 * render() rebuilds the page, so a ghost never outlives the next render.
 */
export function ghostClosedMenu(captured) {
  const pop = window.AppKit?.pop;
  if (!captured || !pop?.out) return;
  const { menu, key } = captured;
  if (state.cardMenu === key || document.querySelector(".card-menu")) return;
  const host = document.querySelector(`.card-more[data-menu="${CSS.escape(key)}"]`)?.parentElement;
  if (!host) return;
  const card = host.closest(".card, .map-card");
  menu.setAttribute("aria-hidden", "true");
  menu.setAttribute("inert", "");
  card?.classList.add("menu-open");
  host.append(menu);
  const done = () => {
    menu.remove();
    card?.classList.remove("menu-open");
  };
  const out = pop.out(menu);
  if (out?.then) out.then(done, done);
  else setTimeout(done, 160);
}

export function socialCard(social) {
  const mine = social.creator.id === state.me.user.id;
  const upcoming = social.startsAt && social.startsAt > Date.now();
  const happening = eventIsNow("social", social);
  const menuOpen = state.cardMenu === `social:${social.id}`;
  return el("article", {
    class: [
      state.focusSocial === social.id ? "card card-now focused" : upcoming ? "card card-now later" : "card card-now",
      happening ? "happening-now" : "",
      menuOpen ? "menu-open" : "",
    ].filter(Boolean).join(" "),
    "data-social": social.id,
    "data-happening-now": happening ? "1" : null,
  }, [
    el("div", { class: "card-bg", onclick: () => openEventDetail("social", social) }),
    cardOverflow("social", social),
    el("div", { class: "card-copy" }, [
      el("div", {
        class: "card-body",
        role: "button",
        tabindex: "0",
        "aria-label": "Open details",
        onclick: () => openEventDetail("social", social),
      }, [
        avatarStack(social),
        el("h3", { text: social.note || (upcoming ? "Free later" : "Free now") }),
        el("p", { text: upcoming ? `${social.creator.name} · from ${clock(social.startsAt)}` : `${social.creator.name} · ${remaining(social.expiresAt)}` }),
        replySummary(social),
        priceLine(social),
        placeLine(social.location, social.place, { kind: "social", id: social.id }),
        removedNote(social),
      ]),
      chatRow("social", social),
      social.removedBy ? null : inToggle("social", social, { locked: mine }),
    ]),
  ]);
}

export function planCard(plan) {
  const mine = plan.creator.id === state.me.user.id;
  const menuOpen = state.cardMenu === `plan:${plan.id}`;
  return el("article", {
    class: [
      state.focusPlan === plan.id ? "card card-plan focused" : "card card-plan",
      `card-grad ${planGradientClass(plan)}`,
      menuOpen ? "menu-open" : "",
    ].filter(Boolean).join(" "),
    "data-plan": plan.id,
  }, [
    el("div", { class: "card-bg", onclick: () => openEventDetail("plan", plan) }),
    cardOverflow("plan", plan),
    el("div", { class: "card-copy" }, [
      el("div", {
        class: "card-body",
        role: "button",
        tabindex: "0",
        "aria-label": "Open details",
        onclick: () => openEventDetail("plan", plan),
      }, [
        avatarStack(plan),
        el("h3", { text: plan.note }),
        el("p", { text: `${plan.whenLabel}${plan.time ? ` · ${plan.time}` : ""} · ${plan.creator.name}` }),
        planCirclesLine(plan),
        planDescription(plan),
        planReplySummary(plan),
        priceLine(plan),
        placeLine(plan.location, plan.place, { kind: "plan", id: plan.id }),
        removedNote(plan),
      ]),
      chatRow("plan", plan),
      cardActions("plan", plan, { locked: mine }),
    ]),
  ]);
}

/**
 * One line for the compact Now list: the event name, a few faces with "+N", and the date.
 * The whole line is one button that opens the details with the reply and chat actions, since
 * a row has no In button of its own. Only the name and the date
 * take the ellipsis, so a long name never pushes the row wider than the screen.
 */
export function compactRow(kind, item) {
  const now = Date.now();
  const title = compactTitle(kind, item, now);
  const when = compactWhen(kind, item, now, appTz());
  const who = compactWho(item.creator, item.joined);
  const focused = kind === "plan" ? state.focusPlan === item.id : state.focusSocial === item.id;
  const happening = eventIsNow(kind, item, now);
  return el("button", {
    class: ["compact-row", compactTone(kind, item.id, item.cardColor), focused ? "focused" : "", happening ? "happening-now" : ""].filter(Boolean).join(" "),
    type: "button",
    [`data-${kind}`]: item.id,
    "data-happening-now": happening ? "1" : null,
    onclick: () => openEventDetail(kind, item, "compact"),
  }, [
    el("strong", { class: "compact-title", text: title }),
    el("span", { class: "compact-who" }, [
      el("span", { class: "compact-faces", "aria-hidden": "true" }, [
        ...who.shown.map((person) => avatar(person, 22)),
        who.more ? el("span", { class: "compact-more", text: `+${who.more}` }) : null,
      ]),
      el("span", { class: "visually-hidden", text: who.text }),
      who.maybe ? el("span", { class: "compact-maybe", "aria-hidden": "true", text: MAYBE_COPY.count(who.maybe) }) : null,
    ]),
    el("span", { class: "compact-when", text: when }),
  ]);
}

export function planDescription(plan) {
  const text = (plan?.description || "").trim();
  if (!text) return null;
  const open = state.openDescriptions.has(plan.id);
  const toggle = (event) => {
    event.stopPropagation();
    if (event.target.closest("a")) return;
    const next = !state.openDescriptions.has(plan.id);
    if (next) state.openDescriptions.add(plan.id);
    else state.openDescriptions.delete(plan.id);
    document.querySelectorAll(`.plan-desc[data-plan="${plan.id}"]`).forEach((node) => {
      node.classList.toggle("open", next);
      node.setAttribute("aria-expanded", String(next));
    });
  };
  return el("p", {
    class: open ? "plan-desc open" : "plan-desc",
    "data-plan": plan.id,
    role: "button",
    tabindex: "0",
    "aria-expanded": String(open),
    onclick: toggle,
    onkeydown: (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggle(event);
    },
  }, linkify(text));
}

/** Plain text with http(s) links made tappable. Built as nodes, so nothing is parsed as HTML. */
export function linkify(text) {
  const parts = [];
  let last = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s<>"]+/g)) {
    const url = match[0].replace(/[.,!?;:)\]]+$/, "");
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(el("a", { href: url, target: "_blank", rel: "noopener noreferrer", text: url }));
    last = match.index + url.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export function canManageEvent(item) {
  return Boolean(item?.creator) && (item.creator.id === state.me.user.id || adminOver(item));
}

/** Admins manage events of their own circle. A shared plan belongs to its home circle (circles[0]). */
export function adminOver(item) {
  const home = item?.circles?.[0]?.id;
  return youAreAdmin() && (!home || home === state.me?.circle?.id);
}

function cardMenuKey(kind, item) {
  return `${kind}:${item.id}`;
}

export function placeOpenCardMenus() {
  const gap = 8;
  const tabbar = document.querySelector(".tabbar");
  const tabTop = tabbar ? tabbar.getBoundingClientRect().top : window.innerHeight;
  const floor = Math.min(window.innerHeight, tabTop > 0 ? tabTop : window.innerHeight) - gap;
  document.querySelectorAll(".card-menu").forEach((menu) => {
    const more = menu.parentElement?.querySelector(".card-more");
    if (!more) return;
    menu.classList.remove("drop-up");
    menu.style.maxHeight = "";
    menu.style.right = "";
    const btn = more.getBoundingClientRect();
    const natural = menu.scrollHeight;
    const below = floor - btn.bottom - 4;
    const above = btn.top - 4 - gap;
    let room = below;
    if (natural > below && above > below) {
      menu.classList.add("drop-up");
      room = above;
    }
    if (natural > room) menu.style.maxHeight = `${Math.max(88, Math.floor(room))}px`;
    // The open animation scales from the right edge, so measure the left from there at full width.
    const left = menu.getBoundingClientRect().right - menu.offsetWidth;
    if (left < gap) menu.style.right = `${Math.floor(left - gap)}px`;
  });
}

export function cardOverflow(kind, item, { onMap = false } = {}) {
  if (!item?.id) return null;
  const key = cardMenuKey(kind, item);
  const open = state.cardMenu === key;
  const hostish = canManageEvent(item);
  const mine = item.joined?.find((person) => person.id === state.me.user.id);
  const inNow = Boolean(mine) && inReply(mine);
  const declined = mine?.reply === "declined";
  const maybe = mine?.reply === "maybe";
  const isHost = item.creator?.id === state.me.user.id;
  const chosen = arriveClock(mine);
  const preset = arrivalDefault(kind, item);
  const label = item.note || (kind === "plan" ? "plan" : "free post");
  const items = [];
  if (kind === "plan") {
    if (canShareCircles(item)) {
      items.push({
        text: "Share with other circles",
        action: () => { state.cardMenu = null; openShareCircles(item); },
      });
    }
    if (!item.removedBy && planOpen(item)) {
      items.push({
        text: "Remind friends",
        muted: remindCooling(item),
        action: () => { state.cardMenu = null; void remindFriends(item); },
      });
      items.push({
        text: "Add to calendar",
        action: () => { state.cardMenu = null; void addPlanToCalendar(item); },
      });
    }
  }
  if (!isHost && !item.removedBy) {
    items.push({
      text: chosen ? `Arriving ${chosen}` : "Pick arrival time",
      action: () => {
        state.cardMenu = null;
        openArrivalPicker(kind, item, chosen || preset);
      },
    });
    items.push({
      text: "Maybe",
      action: () => { state.cardMenu = null; void sendReply(kind, item, "maybe"); },
      on: maybe,
    });
    items.push({
      text: "Can't make it",
      action: () => { state.cardMenu = null; void sendReply(kind, item, "declined"); },
      on: declined,
    });
  }
  /* Map card already has a quiet Open in Maps link; keep the menu item on plan cards only. */
  if (!onMap && kind === "plan" && item.location) {
    items.push({
      text: "Open in Maps",
      action: () => {
        state.cardMenu = null;
        const url = mapsUrl(item.location.lat, item.location.lng, item.place || item.note);
        if (url) window.open(url, "_blank", "noopener");
      },
    });
  }
  if (hostish) {
    items.push({
      text: "Edit",
      action: () => { state.cardMenu = null; openAdminEdit(kind, item); },
    });
    items.push({
      text: kind === "plan" ? "End plan" : "End",
      danger: true,
      action: () => { state.cardMenu = null; endManaged(kind, item); },
    });
  }
  return el("div", { class: "card-overflow" }, [
    el("button", {
      class: "card-more",
      type: "button",
      "data-menu": key,
      "aria-label": `More for ${label}`,
      "aria-expanded": String(open),
      "aria-haspopup": "menu",
      onclick: (event) => {
        event.stopPropagation();
        state.cardMenu = open ? null : key;
        menuJustOpened = state.cardMenu;
        render();
      },
    }, [icon("more")]),
    open ? el("div", {
      class: "card-menu",
      role: "menu",
      onclick: (event) => event.stopPropagation(),
    }, items.map((row) => el("button", {
      type: "button",
      role: "menuitem",
      class: [row.danger ? "danger" : "", row.on ? "on" : "", row.muted ? "muted" : ""].filter(Boolean).join(" "),
      // Still tappable while muted, so a tap can say when it works again.
      "aria-disabled": row.muted ? "true" : null,
      text: row.text,
      onclick: (event) => {
        event.stopPropagation();
        row.action();
      },
    }))) : null,
  ]);
}
