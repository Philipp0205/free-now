import Picker from "emoji-picker-element/picker.js";
// The emoji data (names, search tags, groups) is served from our own origin as a separate file. Nothing is fetched from a CDN.
import dataSource from "emoji-picker-element-data/en/emojibase/data.json?url";

/**
 * The emoji picker, loaded on first use (import() in chat.js), so none of it is in the first-paint bundle.
 * Returns a ready <emoji-picker> that calls onPick(character) when an emoji is chosen.
 */
export function createEmojiPicker(onPick) {
  const picker = new Picker({ dataSource, locale: "en" });
  // No .dark or .light class: the picker follows the phone's scheme, and styles.css sets its colours from our tokens.
  // The grid never selects text (a drag or a hold paints nothing); the search box still takes typing, also in Safari.
  const style = document.createElement("style");
  style.textContent = ".picker { -webkit-user-select: none; user-select: none; } input.search { -webkit-user-select: text; user-select: text; }";
  picker.shadowRoot.appendChild(style);
  picker.addEventListener("emoji-click", (event) => {
    const unicode = event.detail?.unicode;
    if (unicode) onPick(unicode);
  });
  return picker;
}
