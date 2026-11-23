import { el } from "../lib.js";
import { render } from "../render.js";
import { state } from "../state.js";
import { MORE_OPTIONS_COPY } from "./more-options-copy.js";

/**
 * The "More options" disclosure of the create sheets: one row that folds the given fields.
 * The open flag is state.moreOpen. Closed, the row shows `summary` (one line, may be empty) and the fields are not drawn.
 * The button's name stays "More options"; the summary is its description.
 */
export function moreOptions(fields, summary) {
  const nodes = fields.filter(Boolean);
  if (!nodes.length) return null;
  const open = Boolean(state.moreOpen);
  const showSummary = !open && summary;
  return el("div", { class: open ? "more-options open" : "more-options" }, [
    el("button", {
      class: "more-options-row",
      type: "button",
      id: "more-options-toggle",
      "aria-label": MORE_OPTIONS_COPY.label,
      "aria-expanded": open ? "true" : "false",
      "aria-controls": open ? "more-options-body" : null,
      "aria-describedby": showSummary ? "more-options-summary" : null,
      onclick: () => { state.moreOpen = !state.moreOpen; render(); },
    }, [
      el("span", { class: "more-options-text" }, [
        el("span", { class: "more-options-label", text: MORE_OPTIONS_COPY.label }),
        showSummary ? el("span", { class: "more-options-summary", id: "more-options-summary", text: summary }) : null,
      ]),
      el("span", { class: "more-options-chevron", "aria-hidden": "true" }),
    ]),
    open ? el("div", { class: "more-options-body", id: "more-options-body" }, nodes) : null,
  ]);
}
