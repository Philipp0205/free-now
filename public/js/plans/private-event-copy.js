/** Words for private events: the people picker on the Free, Plan and Edit sheets, and the marker on cards. */
export const PRIVATE_COPY = {
  label: "Who is it for",
  everyone: "Everyone",
  help: "Pick friends and only they can see it. They are the only ones who get a push.",
  helpEveryone: "Everyone in the circle can see it.",
  marker: "Private",
  /** The marker line with the people, like "Private · with Bea, Cam". */
  withNames: (names) => `Private · with ${names}`,
};
