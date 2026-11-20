import { el } from "../lib.js";
import { render } from "../render.js";
import { THEME_CHOICES, readTheme, writeTheme } from "./theme.js";
import { applyTheme } from "./theme-apply.js";
import { THEME_COPY } from "./theme-copy.js";

/** The choice in use. Kept here so it still shows when the device store cannot be written. */
let chosen = readTheme();

/** The words for the current choice, shown under the Appearance row. */
export function themeSummary() {
  return THEME_COPY.options[chosen];
}

/** Saves and applies a new choice, then redraws. */
function chooseTheme(choice) {
  if (choice === chosen) return;
  chosen = choice;
  writeTheme(choice);
  applyTheme(choice);
  render();
}

function option(choice) {
  return el("button", {
    id: `theme-${choice}`,
    type: "button",
    class: chosen === choice ? "on" : "",
    "aria-pressed": chosen === choice ? "true" : "false",
    text: THEME_COPY.options[choice],
    onclick: () => chooseTheme(choice),
  });
}

/** The Appearance panel: System / Dark / Light on the small segment, with one line of help. */
export function themePanel() {
  return el("div", { class: "panel stack" }, [
    el("h3", { text: THEME_COPY.heading }),
    el("div", { class: "segment theme-seg", role: "group", "aria-label": THEME_COPY.heading }, THEME_CHOICES.map(option)),
    el("p", { class: "help", text: THEME_COPY.help }),
  ]);
}
