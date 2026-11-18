/** Longest accepted reaction, in UTF-16 units. The longest standard sequences (a family, a flag with a subdivision) are well under this. */
export const EMOJI_MAX_UNITS = 32;

// The `v` flag needs ES2024 in a literal, so build it. RGI_Emoji is the standard set: single emoji, skin tones, flags, keycaps and ZWJ sequences.
const RGI_EMOJI = new RegExp("^\\p{RGI_Emoji}$", "v");
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

/** True for exactly one emoji grapheme of bounded length. Plain text, several emoji, empty and overlong values are false. */
export function isSingleEmoji(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > EMOJI_MAX_UNITS) return false;
  let count = 0;
  for (const _ of graphemes.segment(value)) {
    count += 1;
    if (count > 1) return false;
  }
  return RGI_EMOJI.test(value);
}
