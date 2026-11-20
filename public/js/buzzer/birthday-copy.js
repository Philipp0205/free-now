/** Copy for the buzzer overlay. The payload name is formatted into the lines here and nowhere else. */

const FREE_NOW = "is free now";
const BIRTHDAY_LEAD = "Happy birthday";
const BIRTHDAY_SUB = "Time to celebrate";

/**
 * The lines for one overlay. `name` is the headline and `sub` the small line (the still overlay shows both),
 * `sr` is the screen reader text. The birthday canvas stacks `lead` over `who`.
 */
export function buzzLines(animation, who) {
  if (animation === "birthday") {
    const greeting = `${BIRTHDAY_LEAD} ${who}`;
    return { name: greeting, sub: BIRTHDAY_SUB, sr: greeting, lead: BIRTHDAY_LEAD, who };
  }
  return { name: who, sub: FREE_NOW, sr: `${who} ${FREE_NOW}` };
}
