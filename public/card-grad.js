/**
 * Each plan card gets one of a few soft gradients, picked from its id. The colours
 * live in styles.css as .grad-0 … .grad-13; this file only picks the index, so it can be tested.
 */
export const GRADIENT_COUNT = 14;

/** FNV-1a over the id. Same id, same gradient, on every device. */
export function gradientIndex(id) {
  let hash = 0x811c9dc5;
  for (const char of String(id ?? "")) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % GRADIENT_COUNT;
}

export function gradientClass(id) {
  return `grad-${gradientIndex(id)}`;
}
