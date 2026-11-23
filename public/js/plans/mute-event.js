import { state } from "../state.js";
import { api } from "../session.js";
import { render } from "../render.js";
import { run } from "../lib.js";
import { replaceEvent } from "../event-pay.js";
import { MUTE_COPY } from "./mute-copy.js";

/** The card menu row for muting this event: Unmute once muted. Same row as the chat header's Mute. */
export function muteRow(kind, item) {
  return {
    text: item.muted ? MUTE_COPY.unmute : MUTE_COPY.mute,
    action: () => { state.cardMenu = null; void setEventMuted(kind, item, !item.muted); },
  };
}

/** Saves the mute, swaps in the fresh event everywhere it shows, then redraws. */
async function setEventMuted(kind, item, muted) {
  render();
  await run(async () => {
    const data = await api(`/api/${kind}s/${item.id}/mute`, { method: "POST", body: { muted } });
    if (data[kind]) replaceEvent(kind, data[kind]);
  });
}
