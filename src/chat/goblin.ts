import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { cleanFeedbackText, insertFeedback } from "../admin/feedback.js";

/**
 * The Goblin is not an account. A chat message that names @Goblin is filed as feedback, and
 * the Goblin answers in the thread with a message of kind 'goblin' (stored under the asker's id).
 */
export const GOBLIN_NAME = "Goblin";
/** Same as GOBLIN.color in public/js/mentions.js. Green, and AA on both black and white like the chat colors. */
export const GOBLIN_COLOR = "#4f8410";

/** What the route knows about the request: the client's build label, and the shared feedback limiter. */
export type GoblinAsk = { appVersion: string | null; allow: () => boolean };

/** Every line the Goblin can say, by situation. Tests check a reply against its list, never one line. */
export const GOBLIN_LINES = {
  received: [
    "*clanking away* 🔨 got it, the goblin is on it",
    "Gripe swallowed. Digesting into a fix...",
    "The goblin has scribbled this on a very important rock.",
    "*clank clank* noted, boss.",
    "Gripe eaten. The goblin burps and gets to work.",
    "The goblin stuffed your gripe in its hat. Safe and grumbling.",
    "*sharpening tiny wrench* consider it handled.",
    "Ooh, a fresh gripe. The goblin is gnawing on it now.",
  ],
  empty: [
    "Yes? The goblin is listening. What is wrong?",
    "You summoned the goblin and then said nothing. What is the gripe?",
    "The goblin pokes you with a stick. What is bothering you?",
  ],
  full: [
    "The goblin is full. Too many gripes, try again later.",
    "Burp. The goblin cannot eat another gripe right now. Try later.",
  ],
} as const;

/** One line of the list, at random. */
export function goblinLine(kind: keyof typeof GOBLIN_LINES): string {
  const lines = GOBLIN_LINES[kind];
  return lines[crypto.randomInt(lines.length)];
}

/** The message with the @Goblin mentions (from findMentions) taken out. */
export function gripeText(text: string, hits: Array<{ start: number; end: number }>): string {
  let rest = "";
  let at = 0;
  for (const hit of hits) {
    rest += text.slice(at, hit.start);
    at = hit.end;
  }
  return (rest + text.slice(at))
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([,.;:!?])/g, "$1")
    .replace(/^[,:;\s]+/, "")
    .trim();
}

/** Files the gripe as feedback, like the in-app form. Returns what the Goblin says back. */
export function fileGripe(
  db: DatabaseSync,
  ask: GoblinAsk,
  gripe: { userId: string; circleId: string | null; rest: string; now: number },
): string {
  const text = cleanFeedbackText(gripe.rest);
  // Chat text is capped at 1000 characters, under FEEDBACK_MAX, so what is left is never too long.
  if (!text) return goblinLine("empty");
  if (!ask.allow()) return goblinLine("full");
  insertFeedback(db, { userId: gripe.userId, circleId: gripe.circleId, text, appVersion: ask.appVersion, createdAt: gripe.now });
  return goblinLine("received");
}
