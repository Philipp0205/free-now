import { state } from "../state.js";
import { render } from "../render.js";
import { refreshPins } from "../map-card.js";
import { el } from "../lib.js";
import { writeJoiningOnly } from "./joining-filter.js";
import { JOINING_COPY } from "./joining-filter-copy.js";

/** Flips the one shared flag, saves it, and redraws whichever view is open. */
function setJoiningOnly(on) {
  state.joiningOnly = on;
  writeJoiningOnly(on);
  state.cardMenu = null;
  render();
  if (state.tab === "map" && state.eventsView === "map") refreshPins();
}

/** The Joining only chip, shared by Now and Events. */
export function joiningChip() {
  return el("button", {
    class: state.joiningOnly ? "joining-chip on" : "joining-chip",
    type: "button",
    "aria-pressed": state.joiningOnly ? "true" : "false",
    text: JOINING_COPY.chip,
    onclick: () => setJoiningOnly(!state.joiningOnly),
  });
}
