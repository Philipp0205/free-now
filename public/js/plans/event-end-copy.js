/** Words for the end time field, the range on cards and the errors next to it. */
export const END_COPY = {
  label: "Ends",
  none: "No end",
  until: "Until",
  untilLabel: "Until time",
  pick: (minutes) => `${minutes / 60}h`,
  pickLabel: (minutes) => `Ends ${minutes / 60} ${minutes === 60 ? "hour" : "hours"} after the start`,
  /** The start of a live social's range, shown where a clock would be. */
  now: "Now",
  needsStart: "Pick a start time to set an end.",
  pickUntil: "Pick an until time.",
  afterStart: "The end must be after the start.",
};
