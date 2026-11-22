import { el } from "../lib.js";
import { END_PICKS } from "./event-end.js";
import { END_COPY } from "./event-end-copy.js";

/** One chip. `on` marks the chosen one for screen readers and the style. */
function endChip(text, on, onclick, extra = {}) {
  return el("button", {
    type: "button",
    class: on ? "chip on" : "chip",
    "aria-pressed": on ? "true" : "false",
    onclick,
    text,
    ...extra,
  });
}

/**
 * The end row: No end, 1h, 2h, 3h and Until with a time input. Writes to `draft` and calls
 * `onChange` (a render) after a pick. `idBase` keeps ids apart between the sheets.
 */
export function endField(draft, onChange, idBase = "free-end") {
  const set = (mode, minutes = 0) => () => {
    Object.assign(draft, { mode, minutes, touched: true, error: "" });
    onChange();
  };
  const until = el("input", {
    id: `${idBase}-until`,
    class: "sheet-control end-until",
    type: "time",
    "aria-label": END_COPY.untilLabel,
    oninput: (event) => {
      Object.assign(draft, { mode: "until", until: event.target.value, touched: true, error: "" });
    },
  });
  until.value = draft.until || "";
  const picks = END_PICKS.map((minutes) => endChip(
    END_COPY.pick(minutes),
    draft.mode === "duration" && draft.minutes === minutes,
    set("duration", minutes),
    { "aria-label": END_COPY.pickLabel(minutes), "data-end": String(minutes) },
  ));
  return el("div", { class: "sheet-group" }, [
    el("span", { class: "sheet-label", text: END_COPY.label }),
    el("div", { class: "end-picks" }, [
      endChip(END_COPY.none, draft.mode === "none", set("none"), { "data-end": "none" }),
      ...picks,
      endChip(END_COPY.until, draft.mode === "until", set("until"), { "data-end": "until" }),
    ]),
    draft.mode === "until" ? until : null,
    draft.error ? el("p", { class: "time-error", role: "alert", text: draft.error }) : null,
  ]);
}
