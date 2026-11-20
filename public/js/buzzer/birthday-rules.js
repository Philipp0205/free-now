/** Pure rules for the special birthday buzz. No DOM, and no imports, so buzzer.js can use it freely. */

export const BIRTHDAY = "birthday";

/** "birthday" when the social's creator has it switched on, otherwise undefined (missing, null or any other value). */
export function payloadAnimation(social) {
  const value = social && social.creator && social.creator.buzzAnimation;
  return value === BIRTHDAY ? BIRTHDAY : undefined;
}

/** The animation to play for a consumed buzz. A payload animation wins and never calls `next`, so the rotation keeps its place. */
export function animationFor(buzz, next) {
  return (buzz && buzz.animation) || next();
}
