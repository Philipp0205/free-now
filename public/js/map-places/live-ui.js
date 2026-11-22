/** Live location UI: the share toggle and the card of a friend's live pin. Rules live in live-logic.js. */
import { el, icon } from "../lib.js";
import { LIVE_COPY } from "./live-copy.js";
import { canShareLive, lastSeenText } from "./live-logic.js";
import { isSharing, startLive, stopLive } from "./live-share.js";

/** The toggle with its open-app note, or null when this event cannot be shared from here. */
export function liveToggle(kind, item) {
  if (!canShareLive(item)) return null;
  const on = isSharing(kind, item.id);
  return el("div", { class: "live-share", "data-live": on ? "on" : "off" }, [
    el("label", { class: "share-toggle live-toggle" }, [
      el("input", {
        type: "checkbox",
        checked: on,
        onchange: (event) => (event.target.checked ? startLive(kind, item.id) : stopLive()),
      }),
      el("span", { text: LIVE_COPY.toggle }),
    ]),
    el("p", { class: "help live-note", text: on ? LIVE_COPY.sharing : LIVE_COPY.limit }),
  ]);
}

/** The card for a friend's live pin: name, last seen, and the open-app limit. No coordinates. */
export function liveCard(pin, onClose) {
  return el("article", { class: "map-card live-card" }, [
    el("div", { class: "map-card-head" }, [
      el("strong", { text: pin.title }),
      el("button", {
        class: "map-card-close",
        type: "button",
        "aria-label": "Close",
        onclick: (event) => {
          event.stopPropagation();
          onClose();
        },
      }, [icon("close")]),
    ]),
    el("div", { class: "map-card-body" }, [
      el("p", { class: "live-seen", text: lastSeenText(pin.updatedAt, Date.now()) }),
      el("p", { class: "map-card-time", text: pin.note }),
      el("p", { class: "map-card-time", text: LIVE_COPY.cardLimit }),
    ]),
  ]);
}
