import { el } from "../lib.js";
import { REPEAT_COPY, REPEAT_OPTIONS, repeatsLine } from "./repeat-copy.js";

/** The quiet "Repeats weekly" line on a card or in the detail sheet, or null when the plan does not repeat. */
export function repeatMarker(item, className = "repeat-line") {
  const text = repeatsLine(item?.recurrence);
  return text ? el("p", { class: className, text }) : null;
}

/**
 * The "Repeats" select. `value` is the current token ("never" by default) and `onChange` gets the new one.
 * `idBase` keeps ids apart between the create and edit sheets.
 */
export function repeatField(value, onChange, idBase = "plan-repeat") {
  const select = el("select", {
    id: idBase,
    class: "sheet-control",
    onchange: (event) => onChange(event.target.value),
  }, REPEAT_OPTIONS.map((option) => el("option", { value: option.value, text: option.label })));
  select.value = value || "never";
  return el("label", { class: "sheet-group" }, [
    el("span", { class: "sheet-label", text: REPEAT_COPY.label }),
    select,
  ]);
}

/** The "Stop repeating" button for the edit sheet. A plain button, never a submit. */
export function stopRepeatButton(onclick) {
  return el("button", { class: "btn ghost", type: "button", text: REPEAT_COPY.stop, onclick });
}
