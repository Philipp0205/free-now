/**
 * Pure rules for the theme choice: System, Dark or Light, saved per device.
 * No DOM and no app state, so the rules can be tested with a plain storage object.
 */

/** "dark" or "light" when this device forces a scheme; anything else, or nothing, is System. */
export const THEME_KEY = "fn_theme";

/** The attribute the app kit reads to force a scheme. Unset means the phone decides. */
export const SCHEME_ATTR = "data-ak-scheme";

export const THEME_CHOICES = ["system", "dark", "light"];

function deviceStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** A stored value as a choice. Missing or invalid values mean System. */
export function parseTheme(value) {
  return THEME_CHOICES.includes(value) ? value : "system";
}

/** The scheme to force for a choice: "dark", "light", or null for System (leave the attribute unset). */
export function schemeFor(choice) {
  const theme = parseTheme(choice);
  return theme === "system" ? null : theme;
}

/** The choice saved on this device. A missing or unreadable store means System. */
export function readTheme(storage = deviceStorage()) {
  try {
    return parseTheme(storage?.getItem(THEME_KEY));
  } catch {
    return "system";
  }
}

/** Remembers the choice on this device. A store that cannot be written is skipped; the choice then lasts until reload. */
export function writeTheme(choice, storage = deviceStorage()) {
  try {
    storage?.setItem(THEME_KEY, parseTheme(choice));
  } catch {
    /* storage off */
  }
}
