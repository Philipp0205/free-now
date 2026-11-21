import { POLL_OFFLINE, POLL_POST_FAILED, POLL_VOTE_FAILED, POLL_VOTE_GONE, POLL_VOTES_MANY, POLL_VOTES_ONE } from "./poll-copy.js";

/** Pure poll rules for the sheet and the thread. No DOM here. Keep the numbers in step with src/chat/poll.ts. */

export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 6;

/** A fresh sheet: empty question, two empty options. */
export function newPollDraft() {
  return { question: "", options: ["", ""], busy: false, message: "" };
}

export function setPollQuestion(draft, text) {
  return { ...draft, question: text };
}

export function setPollOption(draft, index, text) {
  return { ...draft, options: draft.options.map((option, i) => (i === index ? text : option)) };
}

/** One more empty option, up to the cap. */
export function addPollOption(draft) {
  if (draft.options.length >= POLL_MAX_OPTIONS) return draft;
  return { ...draft, options: [...draft.options, ""] };
}

/** Drops one option, never below the minimum. */
export function dropPollOption(draft, index) {
  if (draft.options.length <= POLL_MIN_OPTIONS) return draft;
  return { ...draft, options: draft.options.filter((_, i) => i !== index) };
}

/** What the server takes: the question and the filled-in options. Null until there are enough. */
export function pollPayload(draft) {
  const question = draft.question.trim();
  const options = draft.options.map((option) => option.trim()).filter(Boolean);
  if (!question || options.length < POLL_MIN_OPTIONS) return null;
  return { question, options };
}

export function canAddPollOption(draft) {
  return draft.options.length < POLL_MAX_OPTIONS;
}

/** "1 vote" or "3 votes". */
export function votesLabel(count) {
  return count === 1 ? POLL_VOTES_ONE : `${count} ${POLL_VOTES_MANY}`;
}

/** The share of all votes an option holds, 0 to 100. */
export function votePercent(count, total) {
  return total > 0 ? Math.round((count / total) * 100) : 0;
}

/** The friendly line for a failed post. A 400 carries the server's own words. */
export function postErrorText(error) {
  if (error.status === 0) return POLL_OFFLINE;
  return error.status === 400 && error.message ? error.message : POLL_POST_FAILED;
}

/** The friendly line for a failed vote. */
export function voteErrorText(error) {
  if (error.status === 0) return POLL_OFFLINE;
  return error.status === 403 || error.status === 404 ? POLL_VOTE_GONE : POLL_VOTE_FAILED;
}
