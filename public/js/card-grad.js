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

/** True for a picked slot: a whole number 0..13. Null, missing and anything else mean "no pick". */
export function isCardColor(value) {
  return Number.isInteger(value) && value >= 0 && value < GRADIENT_COUNT;
}

/** The .grad-N for a plan: its picked cardColor when valid, else the id hash as before. */
export function planGradientClass(plan) {
  return isCardColor(plan?.cardColor) ? `grad-${plan.cardColor}` : gradientClass(plan?.id);
}

/** Classes that colour a compact row: a plan keeps its card's .grad-N (the pick, else the hash), a social gets the social tint (never .card-now). */
export function compactTone(kind, id, cardColor = null) {
  return kind === "plan" ? `compact-plan ${planGradientClass({ id, cardColor })}` : "compact-social";
}
