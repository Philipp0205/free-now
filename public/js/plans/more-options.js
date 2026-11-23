import { END_COPY } from "./event-end-copy.js";
import { PHOTO_COPY } from "./event-photo-copy.js";
import { PRIVATE_COPY } from "./private-event-copy.js";
import { REPEAT_OPTIONS } from "./repeat-copy.js";
import { MORE_OPTIONS_COPY } from "./more-options-copy.js";

/** Pure rules for the folded fields of the create sheets. Nothing here touches the DOM. */

/** "1h", "Until 21:00" or "" for the end draft. */
function endPart(end) {
  if (!end || end.mode === "none") return "";
  if (end.mode === "duration") return END_COPY.pick(end.minutes);
  return end.until ? `${END_COPY.until} ${end.until}` : END_COPY.until;
}

/** "Weekly", "Monthly" or "" for the repeat token. */
function repeatPart(repeat) {
  if (!repeat || repeat === "never") return "";
  return REPEAT_OPTIONS.find((option) => option.value === repeat)?.label ?? "";
}

/** "Private · with Bea" for the picked friends, or "" when it is for everyone. */
function privatePart(invites, people) {
  const picked = invites?.picked;
  if (!picked || !picked.size) return "";
  const names = people.filter((person) => picked.has(person.id)).map((person) => person.name).join(", ");
  return names ? PRIVATE_COPY.withNames(names) : PRIVATE_COPY.marker;
}

/**
 * The folded values as short parts, in field order. `fields` has description, hasPhoto, end,
 * repeat, invites and people. Free now has no description or repeat.
 */
function foldedParts(fields) {
  return [
    fields.description?.trim() ? MORE_OPTIONS_COPY.description : "",
    fields.hasPhoto ? PHOTO_COPY.label : "",
    endPart(fields.end),
    repeatPart(fields.repeat),
    privatePart(fields.invites, fields.people || []),
  ].filter(Boolean);
}

/** Whether any folded field is set, so the sheet opens More options on its own. */
export function hasFoldedValue(fields) {
  return foldedParts(fields).length > 0;
}

/** The one-line summary for the closed row, like "Weekly · Private · with Bea". Empty when nothing is set. */
export function foldedSummary(fields) {
  return foldedParts(fields).join(" · ");
}
