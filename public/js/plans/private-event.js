import { PRIVATE_COPY } from "./private-event-copy.js";

/** Pure rules for private events. Nothing here touches the DOM. */

/** A fresh picker draft: the friends picked so far. Empty means everyone. */
export function emptyInvites() {
  return { picked: new Set() };
}

/** The draft for an existing event: its invitees except the host, who is always in. */
export function invitesFromItem(item) {
  const hostId = item?.creator?.id;
  const picked = new Set((item?.invitees || []).map((person) => person.id).filter((id) => id !== hostId));
  return { picked };
}

/** The `invitees` value to send: the picked ids, or an empty list for everyone. */
export function inviteBody(draft) {
  return [...(draft?.picked || [])];
}

/** Flips one friend in the draft. */
export function toggleInvite(draft, id) {
  if (draft.picked.has(id)) draft.picked.delete(id);
  else draft.picked.add(id);
}

/** Friends the host can pick: the circle without the host, plus anyone already on the event. */
export function invitePeople(members, item, meId) {
  const people = new Map();
  for (const member of members || []) if (member.id !== meId) people.set(member.id, member);
  for (const person of item?.invitees || []) if (person.id !== item.creator?.id && !people.has(person.id)) people.set(person.id, person);
  return [...people.values()];
}

/** "Private · with Bea, Cam" for a private event this viewer can see, else "". The host is left out of the names. */
export function privateLine(item) {
  if (!item?.private) return "";
  const hostId = item.creator?.id;
  const names = (item.invitees || []).filter((person) => person.id !== hostId).map((person) => person.name).join(", ");
  return names ? PRIVATE_COPY.withNames(names) : PRIVATE_COPY.marker;
}
