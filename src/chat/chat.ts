import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  getPlan,
  getPlanReply,
  getSocial,
  getSocialReply,
  isCircleAdmin,
  listMembers,
  listPlanAudience,
  markChatNotificationsRead,
  planInCircle,
  type MemberRow,
} from "../db.js";
import { colorHex } from "./chat-color.js";
import { isSingleEmoji } from "./emoji.js";
import { cleanGif, gifBody, readGifBody } from "./giphy.js";
import { fileGripe, gripeText, GOBLIN_COLOR, GOBLIN_NAME, type GoblinAsk } from "./goblin.js";
import { cleanPoll, pollBody, pollsFor, pollText, readPollBody, type PollSummary } from "./poll.js";
import { notifyUsers } from "../push/notify.js";
import type { PushSender } from "../push/push.js";
import { isoDate } from "../lib/time.js";
import { canSeeEventId, inviteeIds } from "../social/visibility.js";

export class ChatError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export type ChatDeps = {
  db: DatabaseSync;
  push: PushSender;
  /** `giphyApiKey` only says whether GIFs are on. It is never read for its value here. */
  config: { tz: string; giphyApiKey?: string | null };
  now: () => number;
};

type ChatRow = {
  id: string;
  circle_id: string;
  kind: string;
  ref_id: string;
  host_id: string | null;
  title: string;
  closed_at: number | null;
  last_push_at: number;
  created_at: number;
};

type MessageRow = {
  id: string;
  user_id: string;
  body: string;
  kind: string;
  created_at: number;
  name: string;
  color: number | null;
  reply_to: string | null;
  edited_at: number | null;
};

const TEXT_MAX = 1000;
/** What a GIF is called wherever only words fit: previews, quotes, notices. Never its stored JSON. */
export const GIF_LABEL = "GIF";
/** A message a person wrote: words, a GIF or a poll. The others are the Goblin and system lines. */
function isPersonKind(kind: string): boolean {
  return kind === "text" || kind === "gif" || kind === "poll";
}
/** What takes a reaction: a person's message, or a system line such as "X is in". Never the Goblin. */
function isReactableKind(kind: string): boolean {
  return isPersonKind(kind) || kind === "system";
}
/** The words for a message in a preview, quote or notice. A GIF is its label, not its JSON. A poll is its question. */
function plainText(kind: string, body: string): string {
  if (kind === "poll") return pollText(body);
  return kind === "gif" ? GIF_LABEL : body;
}
/** Quick reactions, in the order the bar and the pills show them. */
export const REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🔥"] as const;
const REACTION_NAMES_MAX = 10;
const MENTION_BODY_MAX = 140;
export const CHAT_BATCH_MS = 15_000;
export const CHAT_GAP_MS = 60_000;

export function nextChatPushDelay(lastPushAt: number, now: number): number {
  if (lastPushAt <= 0) return CHAT_BATCH_MS;
  const since = now - lastPushAt;
  if (since >= CHAT_GAP_MS) return CHAT_BATCH_MS;
  return Math.max(CHAT_BATCH_MS, CHAT_GAP_MS - since);
}

type Slot = {
  windowStart: number;
  firstBody: string;
  count: number;
  busy: boolean;
  timer: ReturnType<typeof setTimeout>;
};

type Job = {
  deps: ChatDeps;
  slots: Map<string, Slot>;
};

const jobs = new Map<string, Job>();

export function chatWindowRemaining(windowStart: number, now: number): number {
  return Math.max(0, windowStart + CHAT_BATCH_MS - now);
}

export async function routeChat(
  deps: ChatDeps,
  user: { id: string; name: string },
  method: string,
  pathname: string,
  body: Record<string, unknown>,
  requestedCircle: string | null = null,
  ask: GoblinAsk = { appVersion: null, allow: () => true },
): Promise<{ status: number; body: unknown } | null> {
  if (method === "GET" && pathname === "/api/chats") {
    const circleId = pickCircle(deps, user.id, requestedCircle, null);
    return { status: 200, body: chatSummary(deps, user.id, circleId) };
  }
  if (pathname === "/api/circles/chat") {
    if (method === "GET") return { status: 200, body: { chat: readThread(deps, user.id, "circle", "", requestedCircle) } };
    if (method === "POST" && body.poll != null) throw new ChatError(400, "Polls are for event chats.");
    if (method === "POST") return { status: 201, body: { chat: await postThread(deps, user.id, user.name, "circle", "", body.text, requestedCircle, body.replyTo, ask, body.gif) } };
  }
  const mute = /^\/api\/chats\/([^/]+)\/mute$/.exec(pathname);
  if (mute && method === "POST") {
    setMuted(deps, user.id, decodeURIComponent(mute[1]), body.muted !== false);
    return { status: 204, body: null };
  }
  const vote = /^\/api\/messages\/([^/]+)\/vote$/.exec(pathname);
  if (vote && method === "POST") {
    const messageId = decodeURIComponent(vote[1]);
    return { status: 200, body: { messageId, poll: votePoll(deps, user.id, messageId, body.choice) } };
  }
  const react = /^\/api\/messages\/([^/]+)\/reactions$/.exec(pathname);
  if (react && method === "POST") {
    const messageId = decodeURIComponent(react[1]);
    const on = typeof body.on === "boolean" ? body.on : null;
    const result = toggleReaction(deps, user.id, messageId, body.emoji, on);
    if (result.added) await notifyReaction(deps, result.added.chat, messageId, user.id, user.name, result.added.emoji, result.added.authorId, result.added.text);
    return { status: 200, body: { messageId, reactions: result.reactions } };
  }
  const message = /^\/api\/messages\/([^/]+)$/.exec(pathname);
  if (message && method === "DELETE") {
    deleteMessage(deps, user.id, decodeURIComponent(message[1]));
    return { status: 204, body: null };
  }
  if (message && method === "PATCH") {
    return { status: 200, body: { message: editMessage(deps, user.id, decodeURIComponent(message[1]), body.text) } };
  }
  const social = /^\/api\/socials\/([^/]+)\/chat$/.exec(pathname);
  if (social) {
    const id = decodeURIComponent(social[1]);
    if (method === "GET") return { status: 200, body: { chat: readThread(deps, user.id, "social", id, requestedCircle) } };
    if (method === "POST" && body.poll != null) return { status: 201, body: { chat: postPoll(deps, user.id, user.name, "social", id, body.poll, requestedCircle) } };
    if (method === "POST") return { status: 201, body: { chat: await postThread(deps, user.id, user.name, "social", id, body.text, requestedCircle, body.replyTo, ask, body.gif) } };
  }
  const plan = /^\/api\/plans\/([^/]+)\/chat$/.exec(pathname);
  if (plan) {
    const id = decodeURIComponent(plan[1]);
    if (method === "GET") return { status: 200, body: { chat: readThread(deps, user.id, "plan", id, requestedCircle) } };
    if (method === "POST" && body.poll != null) return { status: 201, body: { chat: postPoll(deps, user.id, user.name, "plan", id, body.poll, requestedCircle) } };
    if (method === "POST") return { status: 201, body: { chat: await postThread(deps, user.id, user.name, "plan", id, body.text, requestedCircle, body.replyTo, ask, body.gif) } };
  }
  return null;
}

export function chatSummary(deps: ChatDeps, userId: string, circleId: string) {
  const circle = findChat(deps.db, circleId, "circle", "");
  const rows = all<{ kind: string; ref_id: string; id: string }>(
    deps.db,
    `SELECT id, kind, ref_id FROM chats WHERE ${EVENT_CHATS_IN_CIRCLE}`,
    circleId,
    circleId,
  ).filter((row) => canSeeEventId(deps.db, row.kind === "plan" ? "plan" : "social", row.ref_id, userId));
  return {
    circle: { unread: circle ? unreadCount(deps.db, circle.id, userId) : 0, muted: circle ? isMuted(deps.db, circle.id, userId) : false },
    events: rows.map((row) => {
      const last = one<{ body: string; name: string | null; kind: string }>(
        deps.db,
        `SELECT m.body, m.kind, u.name AS name
         FROM messages m
         LEFT JOIN users u ON u.id = m.user_id
         WHERE m.chat_id = ? AND m.deleted_at IS NULL
         ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1`,
        row.id,
      );
      const preview = last ? plainText(last.kind, last.body) : "";
      return {
        kind: row.kind,
        id: row.ref_id,
        unread: unreadCount(deps.db, row.id, userId),
        preview: preview.slice(0, 80),
        previewBy: last && isPersonKind(last.kind) ? (last.name || "") : last?.kind === "goblin" ? GOBLIN_NAME : "",
      };
    }),
    unreadByCircle: unreadTotals(deps, userId),
  };
}

/** Event chats a circle sees: its own socials, and every plan linked to it (whose chat lives under the plan's home). */
const EVENT_CHATS_IN_CIRCLE =
  "((circle_id = ? AND kind NOT IN ('circle', 'plan')) OR (kind = 'plan' AND ref_id IN (SELECT plan_id FROM plan_circles WHERE circle_id = ?)))";

/** Circle chat plus every event chat, for each circle this person belongs to. */
function unreadTotals(deps: ChatDeps, userId: string): Record<string, number> {
  const circles = all<{ circle_id: string }>(deps.db, "SELECT circle_id FROM memberships WHERE user_id = ?", userId);
  const totals: Record<string, number> = {};
  for (const circle of circles) {
    const chats = all<{ id: string; kind: string; ref_id: string }>(
      deps.db,
      `SELECT id, kind, ref_id FROM chats WHERE (circle_id = ? AND kind = 'circle') OR ${EVENT_CHATS_IN_CIRCLE}`,
      circle.circle_id,
      circle.circle_id,
      circle.circle_id,
    ).filter((chat) => chat.kind === "circle" || canSeeEventId(deps.db, chat.kind === "plan" ? "plan" : "social", chat.ref_id, userId));
    let total = 0;
    for (const chat of chats) total += unreadCount(deps.db, chat.id, userId);
    totals[circle.circle_id] = total;
  }
  return totals;
}

export function readThread(deps: ChatDeps, userId: string, kind: "circle" | "social" | "plan", refId: string, requestedCircle: string | null = null) {
  const access = accessThread(deps, userId, kind, refId, false, requestedCircle);
  const now = deps.now();
  markRead(deps.db, access.chat.id, userId, now);
  markChatAlertsRead(deps.db, access.chat, userId, now);
  return threadPayload(deps, access, userId);
}

export async function postThread(
  deps: ChatDeps,
  userId: string,
  userName: string,
  kind: "circle" | "social" | "plan",
  refId: string,
  raw: unknown,
  requestedCircle: string | null = null,
  replyRaw: unknown = null,
  ask: GoblinAsk = { appVersion: null, allow: () => true },
  gifRaw: unknown = null,
): Promise<ReturnType<typeof threadPayload>> {
  const gif = gifRaw == null ? null : pickGif(deps, gifRaw);
  const text = gif ? GIF_LABEL : cleanText(raw);
  const access = accessThread(deps, userId, kind, refId, true, requestedCircle);
  const parent = replyTarget(deps.db, access.chat.id, replyRaw);
  const now = deps.now();
  const id = crypto.randomUUID();
  deps.db.prepare(
    "INSERT INTO messages (id, chat_id, user_id, body, kind, created_at, reply_to) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, access.chat.id, userId, gif ? gifBody(gif) : text, gif ? "gif" : "text", now, parent?.id ?? null);
  markRead(deps.db, access.chat.id, userId, now);
  markChatAlertsRead(deps.db, access.chat, userId, now);
  if (gif) {
    // A GIF names nobody and talks to nobody but the thread: no mentions, no Goblin. A reply still pings its author.
    const pinged = new Set<string>();
    if (parent) for (const author of await notifyReply(deps, access.chat, id, userId, userName, `sent a ${GIF_LABEL}`, parent.user_id, pinged)) pinged.add(author);
    scheduleChatNotice(deps, access.chat.id, userId, userName, `sent a ${GIF_LABEL}`, pinged);
    return threadPayload(deps, access, userId);
  }
  const pinged = await notifyMentions(deps, access.chat, id, userId, userName, text);
  if (parent) for (const author of await notifyReply(deps, access.chat, id, userId, userName, text, parent.user_id, pinged)) pinged.add(author);
  const goblin = findMentions(text, [GOBLIN_NAME]);
  if (goblin.length === 0) {
    scheduleChatNotice(deps, access.chat.id, userId, userName, text, pinged);
  } else {
    // A gripe for the Goblin: filed as feedback, answered in the thread, and nobody is pinged about it.
    const circleId = inCircle(deps, userId, access.chat.circle_id) ? access.chat.circle_id : null;
    const reply = fileGripe(deps.db, ask, { userId, circleId, rest: gripeText(text, goblin), now });
    deps.db.prepare(
      "INSERT INTO messages (id, chat_id, user_id, body, kind, created_at) VALUES (?, ?, ?, ?, 'goblin', ?)",
    ).run(crypto.randomUUID(), access.chat.id, userId, reply, now);
  }
  return threadPayload(deps, access, userId);
}

/** Posts a poll to an event chat. Only people already in the event's chat audience may start one. */
function postPoll(deps: ChatDeps, userId: string, userName: string, kind: "social" | "plan", refId: string, raw: unknown, requestedCircle: string | null) {
  const access = accessThread(deps, userId, kind, refId, true, requestedCircle);
  if (!chatAudience(deps.db, access.chat).some((member) => member.id === userId)) throw new ChatError(403, "You can't post a poll in this chat.");
  const cleaned = cleanPoll(raw);
  if (!cleaned.ok) throw new ChatError(400, cleaned.error);
  const now = deps.now();
  deps.db.prepare(
    "INSERT INTO messages (id, chat_id, user_id, body, kind, created_at) VALUES (?, ?, ?, ?, 'poll', ?)",
  ).run(crypto.randomUUID(), access.chat.id, userId, pollBody(cleaned.poll), now);
  markRead(deps.db, access.chat.id, userId, now);
  markChatAlertsRead(deps.db, access.chat, userId, now);
  scheduleChatNotice(deps, access.chat.id, userId, userName, `started a poll: ${cleaned.poll.question}`);
  return threadPayload(deps, access, userId);
}

/** Sets or changes your one vote on a poll message. Same access rules as a reaction: seen is 404 if unseen, 403 if not in the event. */
export function votePoll(deps: ChatDeps, userId: string, messageId: string, rawChoice: unknown): PollSummary {
  const row = one<{ id: string; chat_id: string; body: string; kind: string; deleted_at: number | null }>(
    deps.db,
    "SELECT id, chat_id, body, kind, deleted_at FROM messages WHERE id = ?",
    messageId,
  );
  if (!row || row.deleted_at != null) throw new ChatError(404, "message not found");
  const chat = one<ChatRow>(deps.db, "SELECT * FROM chats WHERE id = ?", row.chat_id);
  if (!chat || !canSeeChat(deps, userId, chat)) throw new ChatError(404, "message not found");
  const poll = row.kind === "poll" ? readPollBody(row.body) : null;
  if (!poll) throw new ChatError(400, "That isn't a poll.");
  if (!chatAudience(deps.db, chat).some((member) => member.id === userId)) throw new ChatError(403, "You can't vote in this chat.");
  if (!Number.isInteger(rawChoice) || (rawChoice as number) < 0 || (rawChoice as number) >= poll.options.length) throw new ChatError(400, "Pick one of the options.");
  deps.db.prepare(
    `INSERT INTO poll_votes (message_id, user_id, choice, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(message_id, user_id) DO UPDATE SET choice = excluded.choice, created_at = excluded.created_at`,
  ).run(row.id, userId, rawChoice as number, deps.now());
  return pollsFor(deps.db, [row], userId).get(row.id)!;
}

/** A GIF to send: only when GIFs are on, and only a well-formed Giphy one. Nothing else reaches the table. */
function pickGif(deps: ChatDeps, raw: unknown) {
  if (!deps.config.giphyApiKey) throw new ChatError(404, "not found");
  const gif = cleanGif(raw);
  if (!gif) throw new ChatError(400, "Pick a GIF from the list.");
  return gif;
}

/** The message a new one replies to: a live text or GIF message in the same chat. Nothing set is no reply. */
function replyTarget(db: DatabaseSync, chatId: string, raw: unknown): { id: string; user_id: string } | null {
  if (raw == null || raw === "") return null;
  if (typeof raw !== "string") throw new ChatError(400, "You can't reply to that.");
  const row = one<{ id: string; chat_id: string; user_id: string; kind: string; deleted_at: number | null }>(
    db,
    "SELECT id, chat_id, user_id, kind, deleted_at FROM messages WHERE id = ?",
    raw,
  );
  if (!row || row.chat_id !== chatId || row.deleted_at != null) throw new ChatError(404, "message not found");
  if (!isPersonKind(row.kind)) throw new ChatError(400, "You can't reply to that.");
  return { id: row.id, user_id: row.user_id };
}

/** Where `@` starts a mention: the text start, or after anything that is not a letter, digit or underscore. */
const WORD_CHAR = /[\p{L}\p{N}_]/u;

/**
 * Every `@Name` in the text that names one of `names`, case-insensitive. Longest name wins,
 * so "@Alexandra" is never read as "@Alex". Same rule as findMentions in public/js/mentions.js.
 */
export function findMentions(text: string, names: string[]): Array<{ start: number; end: number; name: string }> {
  const sorted = [...new Set(names.map((name) => name.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  const lower = text.toLowerCase();
  const found: Array<{ start: number; end: number; name: string }> = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "@" || (i > 0 && WORD_CHAR.test(text[i - 1]))) {
      i += 1;
      continue;
    }
    const hit = sorted.find((name) => {
      if (!lower.startsWith(name.toLowerCase(), i + 1)) return false;
      const after = text[i + 1 + name.length];
      return after === undefined || !WORD_CHAR.test(after);
    });
    if (!hit) {
      i += 1;
      continue;
    }
    const end = i + 1 + hit.length;
    found.push({ start: i, end, name: hit });
    i = end;
  }
  return found;
}

/** Pings each audience member the text names, right away. Returns who was pinged, so the batched notice skips them. */
async function notifyMentions(deps: ChatDeps, chat: ChatRow, messageId: string, senderId: string, senderName: string, text: string): Promise<Set<string>> {
  const audience = chatAudience(deps.db, chat);
  const named = new Set(findMentions(text, audience.map((member) => member.name)).map((hit) => hit.name.toLowerCase()));
  const recipients = audience
    .filter((member) => named.has(member.name.trim().toLowerCase()) && member.id !== senderId && !isMuted(deps.db, chat.id, member.id))
    .map((member) => member.id);
  await pingNow(deps, chat, recipients, `${senderName} mentioned you: ${text}`, `chat-mention:${messageId}`);
  return new Set(recipients);
}

/** Pings the author of the message replied to, right away, unless a mention already did. Returns who was pinged. */
async function notifyReply(
  deps: ChatDeps,
  chat: ChatRow,
  messageId: string,
  senderId: string,
  senderName: string,
  text: string,
  authorId: string,
  already: Set<string>,
): Promise<string[]> {
  if (authorId === senderId || already.has(authorId) || isMuted(deps.db, chat.id, authorId)) return [];
  if (!chatAudience(deps.db, chat).some((member) => member.id === authorId)) return [];
  await pingNow(deps, chat, [authorId], `${senderName} replied to you: ${text}`, `chat-reply:${messageId}`);
  return [authorId];
}

/** Pings the message's author once per reactor per message. Skips yourself, a muted chat, and an author who left the audience. */
async function notifyReaction(
  deps: ChatDeps,
  chat: ChatRow,
  messageId: string,
  reactorId: string,
  reactorName: string,
  emoji: string,
  authorId: string,
  text: string,
): Promise<void> {
  if (authorId === reactorId || isMuted(deps.db, chat.id, authorId)) return;
  if (!chatAudience(deps.db, chat).some((member) => member.id === authorId)) return;
  // The notice row outlives an unreact, so switching emoji or re-adding stays quiet.
  const fresh = Number(deps.db.prepare(
    "INSERT INTO reaction_notices (message_id, user_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
  ).run(messageId, reactorId, deps.now()).changes);
  if (fresh === 0) return;
  const head = `${reactorName} reacted ${emoji} to: \u201c`;
  const room = Math.max(MENTION_BODY_MAX - head.length - 1, 1);
  let excerpt = text.replace(/\s+/g, " ").trim();
  if (excerpt.length > room) {
    let cut = "";
    for (const char of excerpt) {
      if (cut.length + char.length > room - 1) break;
      cut += char;
    }
    excerpt = `${cut.trimEnd()}\u2026`;
  }
  await pingNow(deps, chat, [authorId], `${head}${excerpt}\u201d`, `chat-reaction:${messageId}:${reactorId}`);
}

/** One immediate chat push plus alert per person, deep-linked into the chat. Never throws. */
async function pingNow(deps: ChatDeps, chat: ChatRow, recipients: string[], text: string, tag: string): Promise<void> {
  if (recipients.length === 0) return;
  const title = chatTitle(chat);
  const ref = chatRef(chat);
  const body = text.slice(0, MENTION_BODY_MAX);
  try {
    for (const [circleId, userIds] of byReaderCircle(deps.db, chat, recipients)) {
      const circle = one<{ name: string }>(deps.db, "SELECT name FROM circles WHERE id = ?", circleId);
      await notifyUsers(deps.db, deps.push, deps.now(), userIds.map((userId) => ({
        userId,
        title,
        body,
        kind: "chat",
        refId: ref,
        tag,
        url: `/?chat=${encodeURIComponent(ref)}`,
      })), circle ? { id: circleId, name: circle.name } : null);
    }
  } catch (error) {
    // The message is already saved. A failed ping must not fail the post.
    console.error("chat ping failed", error instanceof Error ? error.message : error);
  }
}

/** Adds or removes your emoji on a message. `on` null flips it; true or false sets it, so a repeat is a no-op. `added` is set only for a new reaction. */
export function toggleReaction(deps: ChatDeps, userId: string, messageId: string, raw: unknown, on: boolean | null = null) {
  if (!isSingleEmoji(raw)) throw new ChatError(400, "Pick one emoji.");
  const emoji = raw;
  const row = one<{ id: string; chat_id: string; user_id: string; body: string; kind: string; deleted_at: number | null }>(
    deps.db,
    "SELECT id, chat_id, user_id, body, kind, deleted_at FROM messages WHERE id = ?",
    messageId,
  );
  if (!row || row.deleted_at != null) throw new ChatError(404, "message not found");
  const chat = one<ChatRow>(deps.db, "SELECT * FROM chats WHERE id = ?", row.chat_id);
  if (!chat || !canSeeChat(deps, userId, chat)) throw new ChatError(404, "message not found");
  if (!isReactableKind(row.kind)) throw new ChatError(400, "You can't react to that.");
  if (!chatAudience(deps.db, chat).some((member) => member.id === userId)) throw new ChatError(403, "You can't react in this chat.");
  const gone = on === true
    ? 0
    : Number(deps.db.prepare("DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?").run(row.id, userId, emoji).changes);
  let added = false;
  if (on === true || (on === null && gone === 0)) {
    added = Number(deps.db.prepare(
      "INSERT INTO message_reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
    ).run(row.id, userId, emoji, deps.now()).changes) > 0;
  }
  return {
    reactions: reactionsFor(deps.db, [row.id], userId).get(row.id) ?? [],
    // Set only when a reaction row was really inserted, so removals and repeats stay silent.
    added: added ? { chat, emoji, authorId: row.user_id, text: plainText(row.kind, row.body) } : null,
  };
}

type ReactionSummary = { emoji: string; count: number; mine: boolean; names: string[] };

/** Reactions per message: the quick six first in allowlist order, then any other emoji by first use. Names oldest first and capped. */
function reactionsFor(db: DatabaseSync, messageIds: string[], userId: string): Map<string, ReactionSummary[]> {
  const out = new Map<string, ReactionSummary[]>();
  if (messageIds.length === 0) return out;
  const rows = all<{ message_id: string; user_id: string; emoji: string; name: string }>(
    db,
    `SELECT r.message_id, r.user_id, r.emoji, u.name FROM message_reactions r JOIN users u ON u.id = r.user_id
     WHERE r.message_id IN (${messageIds.map(() => "?").join(", ")})
     ORDER BY r.created_at ASC, u.name ASC`,
    ...messageIds,
  );
  const order = REACTIONS as readonly string[];
  // Not in the quick set: after it, and the stable sort keeps these in first-use order (rows are oldest first).
  const rank = (emoji: string) => (order.includes(emoji) ? order.indexOf(emoji) : order.length);
  for (const row of rows) {
    const list = out.get(row.message_id) ?? [];
    let pill = list.find((item) => item.emoji === row.emoji);
    if (!pill) {
      pill = { emoji: row.emoji, count: 0, mine: false, names: [] };
      list.push(pill);
    }
    pill.count += 1;
    if (row.user_id === userId) pill.mine = true;
    if (pill.names.length < REACTION_NAMES_MAX) pill.names.push(row.name);
    out.set(row.message_id, list);
  }
  for (const list of out.values()) list.sort((a, b) => rank(a.emoji) - rank(b.emoji));
  return out;
}

export function deleteMessage(deps: ChatDeps, userId: string, messageId: string): void {
  const row = one<{ id: string; chat_id: string; user_id: string; kind: string; deleted_at: number | null }>(
    deps.db,
    "SELECT id, chat_id, user_id, kind, deleted_at FROM messages WHERE id = ?",
    messageId,
  );
  if (!row || row.deleted_at != null) throw new ChatError(404, "message not found");
  if (!isPersonKind(row.kind)) throw new ChatError(403, "You can't delete that.");
  const chat = one<ChatRow>(deps.db, "SELECT * FROM chats WHERE id = ?", row.chat_id);
  if (!chat || !canSeeChat(deps, userId, chat)) throw new ChatError(404, "message not found");
  const host = chat.kind !== "circle" && chat.host_id === userId;
  const admin = isCircleAdmin(deps.db, chat.circle_id, userId);
  const ownText = row.user_id === userId;
  if (!ownText && !host && !admin) throw new ChatError(403, "You can't delete that.");
  deps.db.prepare("UPDATE messages SET deleted_at = ? WHERE id = ?").run(deps.now(), row.id);
}

/** Changes the words of your own text message and stamps edited_at. Hosts and admins can delete others' messages, never edit them. */
export function editMessage(deps: ChatDeps, userId: string, messageId: string, raw: unknown): { id: string; text: string; editedAt: number } {
  const row = one<{ id: string; chat_id: string; user_id: string; kind: string; deleted_at: number | null }>(
    deps.db,
    "SELECT id, chat_id, user_id, kind, deleted_at FROM messages WHERE id = ?",
    messageId,
  );
  if (!row || row.deleted_at != null) throw new ChatError(404, "message not found");
  if (row.kind !== "text") throw new ChatError(403, "You can't edit that.");
  const chat = one<ChatRow>(deps.db, "SELECT * FROM chats WHERE id = ?", row.chat_id);
  if (!chat || !canSeeChat(deps, userId, chat)) throw new ChatError(404, "message not found");
  if (row.user_id !== userId) throw new ChatError(403, "You can't edit that.");
  const text = cleanText(raw);
  const editedAt = deps.now();
  deps.db.prepare("UPDATE messages SET body = ?, edited_at = ? WHERE id = ?").run(text, editedAt, row.id);
  return { id: row.id, text, editedAt };
}

export function setMuted(deps: ChatDeps, userId: string, chatId: string, muted: boolean): void {
  const chat = one<ChatRow>(deps.db, "SELECT * FROM chats WHERE id = ?", chatId);
  if (!chat || !canSeeChat(deps, userId, chat)) throw new ChatError(404, "chat not found");
  if (muted) {
    deps.db.prepare("INSERT INTO chat_mutes (user_id, chat_id) VALUES (?, ?) ON CONFLICT DO NOTHING").run(userId, chatId);
  } else {
    deps.db.prepare("DELETE FROM chat_mutes WHERE user_id = ? AND chat_id = ?").run(userId, chatId);
  }
}

export function recordEventLine(
  db: DatabaseSync,
  input: { circleId: string; kind: "social" | "plan"; refId: string; hostId: string; title: string; actorId: string; text: string; now: number },
): void {
  const chat = ensureChat(db, input.circleId, input.kind, input.refId, input.hostId, input.title, input.now);
  if (chat.closed_at != null) return;
  db.prepare(
    "INSERT INTO messages (id, chat_id, user_id, body, kind, created_at) VALUES (?, ?, ?, ?, 'system', ?)",
  ).run(crypto.randomUUID(), chat.id, input.actorId, input.text, input.now);
}

export function closeEventChat(db: DatabaseSync, circleId: string, kind: "social" | "plan", refId: string, now: number): void {
  db.prepare(
    "UPDATE chats SET closed_at = ? WHERE circle_id = ? AND kind = ? AND ref_id = ? AND closed_at IS NULL",
  ).run(now, circleId, kind, refId);
}

/** `skip`: people already pinged for this message (a mention), so they do not hear it twice. */
export function scheduleChatNotice(deps: ChatDeps, chatId: string, senderId: string, senderName: string, preview: string, skip: Set<string> = new Set()): void {
  const chat = one<ChatRow>(deps.db, "SELECT * FROM chats WHERE id = ?", chatId);
  if (!chat) return;
  const body = `${senderName}: ${preview}`.slice(0, 140);
  const now = deps.now();
  let job = jobs.get(chatId);
  if (!job) {
    job = { deps, slots: new Map() };
    jobs.set(chatId, job);
  }
  job.deps = deps;
  for (const member of noticeRecipients(deps.db, chat, senderId)) {
    if (skip.has(member.id)) continue;
    const slot = job.slots.get(member.id);
    if (!slot) {
      const created: Slot = {
        windowStart: now,
        firstBody: body,
        count: 1,
        busy: false,
        timer: armSlot(chatId, member.id, CHAT_BATCH_MS),
      };
      job.slots.set(member.id, created);
      continue;
    }
    slot.count += 1;
  }
  if (job.slots.size === 0) jobs.delete(chatId);
}

export async function flushChatNotices(force = false): Promise<void> {
  for (let pass = 0; pass < 4; pass += 1) {
    const work: Array<[string, string]> = [];
    for (const [chatId, job] of jobs) {
      for (const userId of job.slots.keys()) work.push([chatId, userId]);
    }
    if (work.length === 0) return;
    for (const [chatId, userId] of work) await fireSlot(chatId, userId, force);
    if (!force) return;
  }
}

function armSlot(chatId: string, userId: string, delay: number): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => {
    void fireSlot(chatId, userId, false).catch((error: unknown) => {
      console.error("chat push failed", error instanceof Error ? error.message : error);
    });
  }, delay);
  timer.unref?.();
  return timer;
}

function dropSlot(chatId: string, userId: string): void {
  const job = jobs.get(chatId);
  if (!job) return;
  const slot = job.slots.get(userId);
  if (slot) clearTimeout(slot.timer);
  job.slots.delete(userId);
  if (job.slots.size === 0) jobs.delete(chatId);
}

async function fireSlot(chatId: string, userId: string, force: boolean): Promise<void> {
  const job = jobs.get(chatId);
  const slot = job?.slots.get(userId);
  if (!job || !slot || slot.busy) return;
  const remain = chatWindowRemaining(slot.windowStart, job.deps.now());
  if (!force && remain > 0) {
    clearTimeout(slot.timer);
    slot.timer = armSlot(chatId, userId, remain);
    return;
  }
  clearTimeout(slot.timer);
  slot.busy = true;
  try {
    const chat = one<ChatRow>(job.deps.db, "SELECT * FROM chats WHERE id = ?", chatId);
    if (!chat || !recipientStillEligible(job.deps.db, chat, userId)) {
      slot.busy = false;
      dropSlot(chatId, userId);
      return;
    }
    const count = slot.count;
    const body = count <= 1 ? slot.firstBody : `${count} new messages`;
    dropSlot(chatId, userId);
    await deliverChatPush(job.deps, chat, [userId], body);
  } finally {
    slot.busy = false;
  }
}

async function deliverChatPush(deps: ChatDeps, chat: ChatRow, userIds: string[], body: string): Promise<void> {
  const allowed = new Set(chatAudience(deps.db, chat).map((member) => member.id));
  const recipients = userIds.filter((id) => allowed.has(id) && !isMuted(deps.db, chat.id, id));
  if (recipients.length === 0) return;
  const title = chatTitle(chat);
  const ref = chatRef(chat);
  deps.db.prepare("UPDATE chats SET last_push_at = ? WHERE id = ?").run(deps.now(), chat.id);
  for (const [circleId, userIds] of byReaderCircle(deps.db, chat, recipients)) {
    const named = one<{ name: string }>(deps.db, "SELECT name FROM circles WHERE id = ?", circleId);
    await notifyUsers(deps.db, deps.push, deps.now(), userIds.map((userId) => ({
      userId,
      title,
      body,
      kind: "chat",
      refId: ref,
      tag: `chat:${chat.id}`,
      url: `/?chat=${encodeURIComponent(ref)}`,
      // Plan and free-post chats land in Alerts. Circle chat has its own tab, so it stays out.
      skipAlert: chat.kind === "circle",
    })), named ? { id: circleId, name: named.name } : null);
  }
}

function chatTitle(chat: ChatRow): string {
  return chat.kind === "circle" ? (chat.title || "Circle chat") : (chat.title || "Chat");
}

function chatRef(chat: ChatRow): string {
  return chat.kind === "circle" ? "circle" : `${chat.kind}:${chat.ref_id}`;
}

/** A shared plan's chat opens in a circle the reader is in: home if they can, else the first linked one. */
function byReaderCircle(db: DatabaseSync, chat: ChatRow, userIds: string[]): Map<string, string[]> {
  const byCircle = new Map<string, string[]>();
  for (const userId of userIds) {
    const circleId = chat.kind === "plan" ? (readerCircle(db, chat, userId) ?? chat.circle_id) : chat.circle_id;
    const list = byCircle.get(circleId);
    if (list) list.push(userId);
    else byCircle.set(circleId, [userId]);
  }
  return byCircle;
}

function readerCircle(db: DatabaseSync, chat: Pick<ChatRow, "ref_id" | "circle_id">, userId: string): string | null {
  return one<{ circle_id: string }>(
    db,
    `SELECT pc.circle_id FROM plan_circles pc JOIN memberships m ON m.circle_id = pc.circle_id AND m.user_id = ?
     WHERE pc.plan_id = ? ORDER BY pc.circle_id = ? DESC, pc.added_at ASC LIMIT 1`,
    userId,
    chat.ref_id,
    chat.circle_id,
  )?.circle_id ?? null;
}

function noticeRecipients(db: DatabaseSync, chat: ChatRow, senderId: string): Array<{ id: string }> {
  return chatAudience(db, chat).filter((member) => member.id !== senderId && !isMuted(db, chat.id, member.id));
}

function recipientStillEligible(db: DatabaseSync, chat: ChatRow, userId: string): boolean {
  if (isMuted(db, chat.id, userId)) return false;
  return chatAudience(db, chat).some((member) => member.id === userId);
}

/** Who may read and write a chat: the circle, or for an event the host, people coming, and earlier writers. Never blocked people. */
export function chatAudience(db: DatabaseSync, chat: ChatRow): MemberRow[] {
  const linked = chat.kind === "plan" ? listPlanAudience(db, chat.ref_id) : [];
  const everyone = linked.length ? linked : listMembers(db, chat.circle_id);
  if (chat.kind === "circle") return everyone;
  // A private event's chat is only its invitees and host, whatever the circle looks like.
  const invited = inviteeIds(db, chat.kind === "social" ? "social" : "plan", chat.ref_id);
  const members = invited ? everyone.filter((member) => invited.has(member.id) || member.id === chat.host_id) : everyone;
  const memberIds = new Set(members.map((member) => member.id));
  const blocked = new Set(
    all<{ user_id: string }>(
      db,
      chat.kind === "social"
        ? "SELECT user_id FROM social_joins WHERE social_id = ? AND blocked = 1"
        : "SELECT user_id FROM plan_joins WHERE plan_id = ? AND blocked = 1",
      chat.ref_id,
    ).map((row) => row.user_id),
  );
  const allowed = new Set<string>();
  if (chat.host_id && memberIds.has(chat.host_id) && !blocked.has(chat.host_id)) allowed.add(chat.host_id);
  const coming = chat.kind === "social"
    ? all<{ user_id: string }>(
      db,
      "SELECT user_id FROM social_joins WHERE social_id = ? AND blocked = 0 AND reply IN ('coming', 'join')",
      chat.ref_id,
    )
    : all<{ user_id: string }>(
      db,
      "SELECT user_id FROM plan_joins WHERE plan_id = ? AND blocked = 0 AND reply IN ('coming', 'join')",
      chat.ref_id,
    );
  for (const row of coming) {
    if (memberIds.has(row.user_id) && !blocked.has(row.user_id)) allowed.add(row.user_id);
  }
  const writers = all<{ user_id: string }>(
    db,
    "SELECT DISTINCT user_id FROM messages WHERE chat_id = ? AND kind IN ('text', 'gif') AND deleted_at IS NULL",
    chat.id,
  );
  for (const row of writers) {
    if (!memberIds.has(row.user_id) || blocked.has(row.user_id)) continue;
    allowed.add(row.user_id);
  }
  return members.filter((member) => allowed.has(member.id));
}

function threadPayload(deps: ChatDeps, access: Access, userId: string) {
  const messages = all<MessageRow>(
    deps.db,
    `SELECT m.id, m.user_id, m.body, m.kind, m.created_at, u.name, u.color, m.reply_to, m.edited_at
     FROM messages m JOIN users u ON u.id = m.user_id
     WHERE m.chat_id = ? AND m.deleted_at IS NULL
     ORDER BY m.created_at ASC, m.rowid ASC
     LIMIT 200`,
    access.chat.id,
  );
  const admin = isCircleAdmin(deps.db, access.chat.circle_id, userId);
  const host = access.chat.kind !== "circle" && access.chat.host_id === userId;
  const reactions = reactionsFor(deps.db, messages.filter((message) => isReactableKind(message.kind)).map((message) => message.id), userId);
  const quotes = quotesFor(deps.db, access.chat.id, messages, userId);
  const polls = pollsFor(deps.db, messages.filter((message) => message.kind === "poll"), userId);
  return {
    id: access.chat.id,
    kind: access.chat.kind,
    refId: access.chat.ref_id,
    title: access.title,
    closed: access.closed,
    removed: access.blocked,
    muted: isMuted(deps.db, access.chat.id, userId),
    messages: messages.map((message) => ({
      id: message.id,
      name: message.kind === "goblin" ? GOBLIN_NAME : message.name,
      // A GIF's words are just "GIF", so a client that does not know GIFs never shows raw JSON.
      text: plainText(message.kind, message.body),
      gif: message.kind === "gif" ? readGifBody(message.body) : null,
      poll: polls.get(message.id) ?? null,
      at: message.created_at,
      system: message.kind === "system",
      goblin: message.kind === "goblin",
      mine: message.kind !== "goblin" && message.user_id === userId,
      color: isPersonKind(message.kind) ? colorHex(message.user_id, message.color) : message.kind === "goblin" ? GOBLIN_COLOR : null,
      canDelete: isPersonKind(message.kind) && (message.user_id === userId || admin || host),
      canEdit: message.kind === "text" && message.user_id === userId,
      editedAt: message.edited_at,
      reactions: reactions.get(message.id) ?? [],
      replyTo: message.reply_to ? quotes.get(message.reply_to) ?? goneQuote(message.reply_to) : null,
    })),
    participants: chatAudience(deps.db, access.chat).map((member) => ({
      id: member.id,
      name: member.name,
      color: colorHex(member.id, member.color),
    })),
  };
}

type Quote = { id: string; name: string; text: string; mine: boolean; deleted: boolean; color: string | null };

const QUOTE_MAX = 120;

function goneQuote(id: string): Quote {
  return { id, name: "", text: "", mine: false, deleted: true, color: null };
}

/** The one message each reply quotes, even if it was deleted since. A deleted one never carries its text. */
function quotesFor(db: DatabaseSync, chatId: string, messages: MessageRow[], userId: string): Map<string, Quote> {
  const out = new Map<string, Quote>();
  const ids = [...new Set(messages.map((message) => message.reply_to).filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return out;
  const rows = all<{ id: string; user_id: string; body: string; kind: string; deleted_at: number | null; name: string | null; color: number | null }>(
    db,
    `SELECT m.id, m.user_id, m.body, m.kind, m.deleted_at, u.name, u.color FROM messages m LEFT JOIN users u ON u.id = m.user_id
     WHERE m.chat_id = ? AND m.id IN (${ids.map(() => "?").join(", ")})`,
    chatId,
    ...ids,
  );
  for (const row of rows) {
    const deleted = row.deleted_at != null;
    out.set(row.id, {
      id: row.id,
      name: row.name || "",
      text: deleted ? "" : plainText(row.kind, row.body).replace(/\s+/g, " ").trim().slice(0, QUOTE_MAX),
      mine: row.user_id === userId,
      deleted,
      color: deleted ? null : colorHex(row.user_id, row.color),
    });
  }
  return out;
}

type Access = { chat: ChatRow; title: string; closed: boolean; blocked: boolean };

function accessThread(deps: ChatDeps, userId: string, kind: "circle" | "social" | "plan", refId: string, writing: boolean, requestedCircle: string | null): Access {
  if (kind !== "circle" && !canSeeEventId(deps.db, kind, refId, userId)) throw new ChatError(404, "chat not found");
  if (kind === "plan") return accessPlanThread(deps, userId, refId, writing, requestedCircle);
  const resourceCircle = kind === "social" ? getSocial(deps.db, refId)?.circle_id ?? null : null;
  const circleId = pickCircle(deps, userId, requestedCircle, resourceCircle);
  return openThread(deps, userId, circleId, kind, refId, writing);
}

/** One chat per plan, kept under its home circle. Any linked circle's member may use it. */
function accessPlanThread(deps: ChatDeps, userId: string, refId: string, writing: boolean, requestedCircle: string | null): Access {
  const plan = getPlan(deps.db, refId);
  if (!plan) {
    const circleId = pickCircle(deps, userId, requestedCircle, null);
    return openThread(deps, userId, circleId, "plan", refId, writing);
  }
  let viewing: string;
  if (requestedCircle) {
    viewing = pickCircle(deps, userId, requestedCircle, null);
  } else {
    const linked = readerCircle(deps.db, { ref_id: plan.id, circle_id: plan.circle_id }, userId);
    if (!linked) throw new ChatError(404, "chat not found");
    viewing = linked;
  }
  if (!planInCircle(deps.db, plan.id, viewing)) throw new ChatError(404, "chat not found");
  return openThread(deps, userId, plan.circle_id, "plan", refId, writing);
}

function openThread(deps: ChatDeps, userId: string, circleId: string, kind: "circle" | "social" | "plan", refId: string, writing: boolean): Access {
  const now = deps.now();
  const looked = lookEvent(deps, circleId, userId, kind, refId, now);
  if (looked.missing) throw new ChatError(404, "chat not found");
  const chat = ensureChat(deps.db, circleId, kind, refId, looked.hostId, looked.title, now);
  let closed = chat.closed_at != null || looked.closed;
  if (looked.closed && chat.closed_at == null) {
    deps.db.prepare("UPDATE chats SET closed_at = ? WHERE id = ?").run(now, chat.id);
    chat.closed_at = now;
    closed = true;
  }
  if (writing && closed) throw new ChatError(403, "This chat is closed.");
  if (writing && looked.blocked) throw new ChatError(403, `${looked.removedBy?.trim() || "Someone"} removed you from this.`);
  return { chat, title: looked.title || chat.title || "Chat", closed, blocked: looked.blocked };
}

function lookEvent(deps: ChatDeps, circleId: string, userId: string, kind: string, refId: string, now: number): { missing: boolean; closed: boolean; blocked: boolean; removedBy: string | null; title: string; hostId: string | null } {
  if (kind === "circle") {
    return { missing: false, closed: false, blocked: false, removedBy: null, title: "Circle chat", hostId: null };
  }
  if (kind === "social") {
    const social = getSocial(deps.db, refId);
    const socialReply = getSocialReply(deps.db, refId, userId);
    if (!social || social.circle_id !== circleId) {
      const existing = findChat(deps.db, circleId, "social", refId);
      if (!existing) return { missing: true, closed: true, blocked: false, removedBy: null, title: "", hostId: null };
      const prior = getSocialReply(deps.db, refId, userId);
      return { missing: false, closed: true, blocked: Boolean(prior?.blocked), removedBy: prior?.removed_by ?? null, title: existing.title, hostId: existing.host_id };
    }
    return {
      missing: false,
      closed: social.expires_at <= now,
      blocked: Boolean(socialReply?.blocked),
      removedBy: socialReply?.removed_by ?? null,
      title: social.note.trim() || "Free now",
      hostId: social.creator_id,
    };
  }
  const plan = getPlan(deps.db, refId);
  if (!plan || plan.circle_id !== circleId) {
    const existing = findChat(deps.db, circleId, "plan", refId);
    if (!existing) return { missing: true, closed: true, blocked: false, removedBy: null, title: "", hostId: null };
      const prior = getPlanReply(deps.db, refId, userId);
      return { missing: false, closed: true, blocked: Boolean(prior?.blocked), removedBy: prior?.removed_by ?? null, title: existing.title, hostId: existing.host_id };
  }
  const today = isoDate(now, deps.config.tz);
  return {
    missing: false,
    closed: plan.for_date < today || (plan.ends_at != null && plan.ends_at <= now),
    blocked: Boolean(getPlanReply(deps.db, plan.id, userId)?.blocked),
    removedBy: getPlanReply(deps.db, plan.id, userId)?.removed_by ?? null,
    title: plan.note.trim() || "Plan",
    hostId: plan.creator_id,
  };
}

/** A plan chat is open to members of any circle the plan is linked to. A private event's chat is for its people only. */
function canSeeChat(deps: ChatDeps, userId: string, chat: ChatRow): boolean {
  if ((chat.kind === "social" || chat.kind === "plan") && !canSeeEventId(deps.db, chat.kind, chat.ref_id, userId)) return false;
  if (inCircle(deps, userId, chat.circle_id)) return true;
  if (chat.kind !== "plan") return false;
  return Boolean(one(
    deps.db,
    `SELECT 1 AS ok FROM plan_circles pc JOIN memberships m ON m.circle_id = pc.circle_id
     WHERE pc.plan_id = ? AND m.user_id = ?`,
    chat.ref_id,
    userId,
  ));
}

function inCircle(deps: ChatDeps, userId: string, circleId: string): boolean {
  return Boolean(one(deps.db, "SELECT 1 AS ok FROM memberships WHERE user_id = ? AND circle_id = ?", userId, circleId));
}

function pickCircle(deps: ChatDeps, userId: string, requested: string | null, resourceCircle: string | null): string {
  const count = Number(one<{ n: number }>(deps.db, "SELECT COUNT(*) AS n FROM memberships WHERE user_id = ?", userId)?.n ?? 0);
  if (count === 0) throw new ChatError(409, "join a circle first");
  if (requested) {
    if (!inCircle(deps, userId, requested)) throw new ChatError(404, "chat not found");
    if (resourceCircle && resourceCircle !== requested) throw new ChatError(404, "chat not found");
    return requested;
  }
  if (resourceCircle) {
    if (!inCircle(deps, userId, resourceCircle)) throw new ChatError(404, "chat not found");
    return resourceCircle;
  }
  if (count === 1) {
    const only = one<{ circle_id: string }>(deps.db, "SELECT circle_id FROM memberships WHERE user_id = ?", userId);
    if (!only) throw new ChatError(409, "join a circle first");
    return only.circle_id;
  }
  throw new ChatError(400, "circle is required");
}

function ensureChat(db: DatabaseSync, circleId: string, kind: string, refId: string, hostId: string | null, title: string, now: number): ChatRow {
  db.prepare(
    `INSERT INTO chats (id, circle_id, kind, ref_id, host_id, title, created_at, last_push_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(circle_id, kind, ref_id) DO UPDATE SET
       title = excluded.title,
       host_id = COALESCE(chats.host_id, excluded.host_id)`,
  ).run(crypto.randomUUID(), circleId, kind, refId, hostId, title, now);
  const chat = findChat(db, circleId, kind, refId);
  if (!chat) throw new ChatError(500, "chat missing");
  return chat;
}

function findChat(db: DatabaseSync, circleId: string, kind: string, refId: string): ChatRow | undefined {
  return one<ChatRow>(db, "SELECT * FROM chats WHERE circle_id = ? AND kind = ? AND ref_id = ?", circleId, kind, refId);
}

function markRead(db: DatabaseSync, chatId: string, userId: string, now: number): void {
  db.prepare(
    `INSERT INTO chat_reads (user_id, chat_id, read_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id, chat_id) DO UPDATE SET read_at = excluded.read_at`,
  ).run(userId, chatId, now);
}

/** Reading a chat also reads its Alerts. Only circle chat is scoped to its circle, since its ref is the same everywhere. */
function markChatAlertsRead(db: DatabaseSync, chat: ChatRow, userId: string, now: number): void {
  markChatNotificationsRead(db, userId, chatRef(chat), chat.kind === "circle" ? chat.circle_id : null, now);
}

function unreadCount(db: DatabaseSync, chatId: string, userId: string): number {
  const row = one<{ n: number | bigint }>(
    db,
    `SELECT COUNT(*) AS n FROM messages m
     LEFT JOIN chat_reads r ON r.chat_id = m.chat_id AND r.user_id = ?
     WHERE m.chat_id = ? AND m.deleted_at IS NULL AND m.user_id != ? AND m.kind != 'goblin'
       AND m.created_at > COALESCE(r.read_at, 0)`,
    userId,
    chatId,
    userId,
  );
  return Number(row?.n ?? 0);
}

function isMuted(db: DatabaseSync, chatId: string, userId: string): boolean {
  return Boolean(one(db, "SELECT 1 AS ok FROM chat_mutes WHERE chat_id = ? AND user_id = ?", chatId, userId));
}

function lastPushAt(db: DatabaseSync, chatId: string): number {
  return one<{ last_push_at: number }>(db, "SELECT last_push_at FROM chats WHERE id = ?", chatId)?.last_push_at ?? 0;
}

function cleanText(raw: unknown): string {
  if (typeof raw !== "string") throw new ChatError(400, "Write a message.");
  const text = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
  if (!text) throw new ChatError(400, "Write a message.");
  if (text.length > TEXT_MAX) throw new ChatError(400, "Keep it under 1000 characters.");
  return text;
}

function one<T>(db: DatabaseSync, sql: string, ...params: Array<string | number | null>): T | undefined {
  const row = db.prepare(sql).get(...params);
  return row ? ({ ...row } as T) : undefined;
}

function all<T>(db: DatabaseSync, sql: string, ...params: Array<string | number | null>): T[] {
  return db.prepare(sql).all(...params).map((row) => ({ ...row }) as T);
}

export function replyLogText(name: string, reply: "coming" | "declined" | "maybe", eta: number | null, arriveLabel: string, alreadyIn: boolean): string {
  if (reply === "declined") return `${name} can't make it`;
  if (reply === "maybe") return `${name} is maybe`;
  if (arriveLabel && alreadyIn) return `${name} is arriving ${arriveLabel}`;
  if (arriveLabel) return `${name} is in, arriving ${arriveLabel}`;
  if (eta) return `${name} is there in ${eta} min`;
  return `${name} is in`;
}
