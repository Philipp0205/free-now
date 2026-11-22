import { el } from "../lib.js";
import { render } from "../render.js";
import { PRIVATE_COPY } from "./private-event-copy.js";
import { privateLine, toggleInvite } from "./private-event.js";

/** One toggle chip. A native button with aria-pressed, like the share-circles chips. */
function inviteChip(text, on, onclick, extra = {}) {
  return el("button", { type: "button", class: on ? "chip on" : "chip", "aria-pressed": on ? "true" : "false", text, onclick, ...extra });
}

/**
 * The "Who is it for" row: an Everyone chip (nothing picked) and one chip per friend.
 * Writes the picks to draft.picked. No friends to pick means no row.
 */
export function inviteField(draft, people) {
  if (!people.length) return null;
  const everyone = draft.picked.size === 0;
  return el("div", { class: "sheet-group invite-field" }, [
    el("span", { class: "sheet-label", id: "invite-label", text: PRIVATE_COPY.label }),
    el("div", { class: "invite-chips", role: "group", "aria-labelledby": "invite-label" }, [
      inviteChip(PRIVATE_COPY.everyone, everyone, () => { draft.picked.clear(); render(); }, { "data-invite": "everyone" }),
      ...people.map((person) => inviteChip(person.name, draft.picked.has(person.id), () => { toggleInvite(draft, person.id); render(); }, { "data-invite": person.id })),
    ]),
    el("p", { class: "help", text: everyone ? PRIVATE_COPY.helpEveryone : PRIVATE_COPY.help }),
  ]);
}

/** The small "Private · with Bea" line on a card, row or sheet, or null for a public event. */
export function privateMarker(item, className = "private-line") {
  const text = privateLine(item);
  return text ? el("p", { class: className, text }) : null;
}
