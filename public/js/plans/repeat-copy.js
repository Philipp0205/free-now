/** User-facing copy for repeating plans. Tokens match the API: never, weekly, biweekly, monthly. */
export const REPEAT_OPTIONS = [
  { value: "never", label: "Never" },
  { value: "weekly", label: "Weekly" },
  { value: "biweekly", label: "Every 2 weeks" },
  { value: "monthly", label: "Monthly" },
];

export const REPEAT_COPY = {
  label: "Repeats",
  stop: "Stop repeating",
  stopped: "Not repeating anymore.",
  hint: "The next one shows up after this one ends.",
};

const LINES = {
  weekly: "Repeats weekly",
  biweekly: "Repeats every 2 weeks",
  monthly: "Repeats monthly",
};

/** The quiet line on a card or in the detail sheet, or an empty string when the plan does not repeat. */
export function repeatsLine(recurrence) {
  return LINES[recurrence] ?? "";
}

/** The token to send: null for Never, so the server clears the rule. */
export function repeatToken(value) {
  return LINES[value] ? value : null;
}
