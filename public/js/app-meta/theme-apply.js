import { SCHEME_ATTR, schemeFor } from "./theme.js";

/**
 * Puts a theme choice on the page: Dark and Light set data-ak-scheme on html, System removes it so the phone decides.
 * Then the kit rewrites the browser bar colour from the background that is now painted.
 * The root and the kit are parameters so a test can pass plain objects.
 */
export function applyTheme(choice, root = document.documentElement, kit = globalThis.AppKit?.themeColor) {
  const scheme = schemeFor(choice);
  if (scheme) root.setAttribute(SCHEME_ATTR, scheme);
  else root.removeAttribute(SCHEME_ATTR);
  kit?.start({ media: ["(max-width: 719px)"] });
}
