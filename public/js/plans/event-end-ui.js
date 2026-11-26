import { el } from "../lib.js";
import { END_COPY } from "./event-end-copy.js";

/**
 * The optional end time: a native time input. Empty means no end. Writes to `draft` on input.
 * `idBase` keeps ids apart between the sheets.
 */
export function endField(draft, idBase = "free-end") {
  const input = el("input", {
    id: `${idBase}-time`,
    class: "sheet-control",
    type: "time",
    "aria-label": END_COPY.endLabel,
    oninput: (event) => {
      Object.assign(draft, { until: event.target.value, touched: true, error: "" });
    },
  });
  input.value = draft.until || "";
  return el("label", { class: "sheet-group" }, [
    el("span", { class: "sheet-label", text: END_COPY.label }),
    input,
    draft.error ? el("p", { class: "time-error", role: "alert", text: draft.error }) : null,
  ]);
}
