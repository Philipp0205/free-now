import type { DatabaseSync } from "node:sqlite";

/** The most options a poll can have. public/js/chat/poll-logic.js keeps the same number for the sheet. */
export const POLL_MAX_OPTIONS = 6;
/** What a poll is called wherever only words fit: previews, quotes, notices. */
export const POLL_LABEL = "Poll";
const QUESTION_MAX = 200;
const OPTION_MAX = 80;

export type Poll = { question: string; options: string[] };

export type PollOption = { index: number; text: string; count: number; names: string[]; mine: boolean };
export type PollSummary = { question: string; options: PollOption[]; total: number; mine: number | null };

function line(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  return raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

/** A poll to post: one question and 2 to POLL_MAX_OPTIONS non-blank options. Anything else is an error line for the caller. */
export function cleanPoll(raw: unknown): { ok: true; poll: Poll } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Ask a question." };
  const input = raw as Record<string, unknown>;
  const question = line(input.question);
  if (!question) return { ok: false, error: "Ask a question." };
  if (question.length > QUESTION_MAX) return { ok: false, error: `Keep the question under ${QUESTION_MAX} characters.` };
  if (!Array.isArray(input.options) || input.options.length < 2) return { ok: false, error: "Add at least 2 options." };
  if (input.options.length > POLL_MAX_OPTIONS) return { ok: false, error: `Polls can have up to ${POLL_MAX_OPTIONS} options.` };
  const options = input.options.map(line);
  if (options.some((option) => !option)) return { ok: false, error: "Every option needs some words." };
  if (options.some((option) => (option as string).length > OPTION_MAX)) return { ok: false, error: `Keep each option under ${OPTION_MAX} characters.` };
  return { ok: true, poll: { question, options: options as string[] } };
}

export function pollBody(poll: Poll): string {
  return JSON.stringify({ question: poll.question, options: poll.options });
}

/** The stored message body, read back. Null when it is not a poll, so a bad row renders as plain words. */
export function readPollBody(body: string): Poll | null {
  try {
    const cleaned = cleanPoll(JSON.parse(body));
    return cleaned.ok ? cleaned.poll : null;
  } catch {
    return null;
  }
}

/** The words for a poll message in a preview, quote or notice. */
export function pollText(body: string): string {
  const poll = readPollBody(body);
  return poll ? `${POLL_LABEL}: ${poll.question}` : POLL_LABEL;
}

type VoteRow = { message_id: string; user_id: string; choice: number; name: string };

function votesFor(db: DatabaseSync, ids: string[]): VoteRow[] {
  return db.prepare(
    `SELECT v.message_id, v.user_id, v.choice, u.name FROM poll_votes v JOIN users u ON u.id = v.user_id
     WHERE v.message_id IN (${ids.map(() => "?").join(", ")})
     ORDER BY v.created_at ASC, u.name ASC`,
  ).all(...ids).map((row) => ({ ...row }) as VoteRow);
}

/** Counts, voter names and your own pick for each poll message given. Messages that are not polls are left out. */
export function pollsFor(db: DatabaseSync, messages: Array<{ id: string; body: string }>, userId: string): Map<string, PollSummary> {
  const out = new Map<string, PollSummary>();
  for (const message of messages) {
    const poll = readPollBody(message.body);
    if (!poll) continue;
    const options = poll.options.map((text, index) => ({ index, text, count: 0, names: [] as string[], mine: false }));
    out.set(message.id, { question: poll.question, options, total: 0, mine: null });
  }
  if (out.size === 0) return out;
  for (const vote of votesFor(db, [...out.keys()])) {
    const summary = out.get(vote.message_id);
    const option = summary?.options[vote.choice];
    if (!summary || !option) continue;
    option.count += 1;
    option.names.push(vote.name);
    summary.total += 1;
    if (vote.user_id === userId) {
      option.mine = true;
      summary.mine = vote.choice;
    }
  }
  return out;
}
