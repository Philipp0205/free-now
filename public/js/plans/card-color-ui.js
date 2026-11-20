import { el } from "../lib.js";
import { GRADIENT_COUNT, isCardColor } from "../card-grad.js";
import { CARD_COLOR_COPY } from "./card-color-copy.js";

/** One radio swatch. A native radio, so arrow keys move between swatches and Space picks. */
function swatch(draft, slot) {
  const auto = slot == null;
  const name = auto ? CARD_COLOR_COPY.autoName : CARD_COLOR_COPY.slotName(slot, GRADIENT_COUNT);
  const current = isCardColor(draft.cardColor) ? draft.cardColor : null;
  return el("label", { class: "color-opt" }, [
    el("input", {
      class: "color-input",
      type: "radio",
      name: "card-color",
      value: auto ? "" : String(slot),
      checked: current === slot,
      "aria-label": name,
      "data-card-color": auto ? "auto" : String(slot),
      onchange: () => { draft.cardColor = slot; },
    }),
    el("span", { class: auto ? "color-swatch color-auto" : `color-swatch grad-${slot}`, "aria-hidden": "true", text: auto ? CARD_COLOR_COPY.auto : "" }),
  ]);
}

/** The palette: Auto plus one swatch per card gradient. Writes the pick to draft.cardColor (null means Auto). */
export function cardColorField(draft) {
  const slots = [null, ...Array.from({ length: GRADIENT_COUNT }, (_, slot) => slot)];
  return el("div", { class: "sheet-group" }, [
    el("span", { class: "sheet-label", id: "card-color-label", text: CARD_COLOR_COPY.label }),
    el("div", { class: "color-pick", role: "radiogroup", "aria-labelledby": "card-color-label" }, slots.map((slot) => swatch(draft, slot))),
  ]);
}
