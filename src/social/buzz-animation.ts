/** The only special buzzer animation an operator can switch on for a person. Null means the normal rotation. */
export const BUZZ_ANIMATION_BIRTHDAY = "birthday";

/** Reads the operator body value: "birthday" or null is fine, anything else is undefined (a 400). */
export function parseBuzzAnimation(value: unknown): string | null | undefined {
  if (value === null || value === BUZZ_ANIMATION_BIRTHDAY) return value;
  return undefined;
}

/** The payload field for a creator: only present when a special animation is on, so other buzzes look as before. */
export function buzzAnimationField(value: string | null | undefined): { buzzAnimation?: string } {
  return value === BUZZ_ANIMATION_BIRTHDAY ? { buzzAnimation: value } : {};
}
