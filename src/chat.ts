import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  getPlan,
  getPlanReply,
  getSocial,
  getSocialReply,
  isCircleAdmin,
  listMembers,
} from "./db.js";
import { notifyUsers } from "./notify.js";
import type { PushSender } from "./push.js";
import { isoDate } from "./time.js";

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
  config: { tz: string };
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
};

const TEXT_MAX = 1000;
export const CHAT_BATCH_MS = 15_000;
export const CHAT_GAP_MS = 60_000;

export function nextChatPushDelay(lastPushAt: number, now: number): number {
  if (lastPushAt <= 0) return CHAT_BATCH_MS;
  const since = now - lastPushAt;
  if (since >= CHAT_GAP_MS) return CHAT_BATCH_MS;
  return Math.max(CHAT_BATCH_MS, CHAT_GAP_MS - since);
}

type Job = {
  deps: ChatDeps;
  count: number;
  senderName: string;
  preview: string;
  timer: ReturnType<typeof setTimeout>;
};

const jobs = new Map<string, Job>();

export async function routeChat(
  deps: ChatDeps,
  user: { id: string; name: string },
  method: string,
  pathname: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown } | null> {
  if (method === "GET" && pathname === "/api/chats") {
    const circleId = memberCircle(deps, user.id);
    if (!circleId) throw new ChatError(409, "join a circle first");
    return { status: 200, body: chatSummary(deps, user.id, circleId) };
  }
  if (pathname === "/api/circles/chat") {
    if (method === "GET") return { status: 200, body: { chat: readThread(deps, user.id, "circle", "") } };
    if (method === "POST") return { status: 201, body: { chat: await postThread(deps, user.id, user.name, "circle", "", body.text) } };
  }
  const mute = /^\/api\/chats\/([^/]+)\/mute$/.exec(pathname);
  if (mute && method === "POST") {
    setMuted(deps, user.id, decodeURIComponent(mute[1]), body.muted !== false);
    return { status: 204, body: null };
  }
  const message = /^\/api\/messages\/([^/]+)$/.exec(pathname);
  if (message && method === "DELETE") {
    deleteMessage(deps, user.id, decodeURIComponent(message[1]));
    return { status: 204, body: null };
  }
  const social = /^\/api\/socials\/([^/]+)\/chat$/.exec(pathname);
  if (social) {
    const id = decodeURIComponent(social[1]);
    if (method === "GET") return { status: 200, body: { chat: readThread(deps, user.id, "social", id) } };
    if (method === "POST") return { status: 201, body: { chat: await postThread(deps, user.id, user.name, "social", id, body.text) } };
  }
  const plan = /^\/api\/plans\/([^/]+)\/chat$/.exec(pathname);
  if (plan) {
    const id = decodeURIComponent(plan[1]);
    if (method === "GET") return { status: 200, body: { chat: readThread(deps, user.id, "plan", id) } };
    if (method === "POST") return { status: 201, body: { chat: await postThread(deps, user.id, user.name, "plan", id, body.text) } };
  }
  return null;
}

export function chatSummary(deps: ChatDeps, userId: string, circleId: string) {
  const circle = findChat(deps.db, circleId, "circle", "");
  const rows = all<{ kind: string; ref_id: string; id: string }>(
    deps.db,
    "SELECT id, kind, ref_id FROM chats WHERE circle_id = ? AND kind != 'circle'",
    circleId,
  );
  return {
    circle: { unread: circle ? unreadCount(deps.db, circle.id, userId) : 0, muted: circle ? isMuted(deps.db, circle.id, userId) : false },
    events: rows.map((row) => ({
      kind: row.kind,
      id: row.ref_id,
      unread: unreadCount(deps.db, row.id, userId),
    })),
  };
}

export function readThread(deps: ChatDeps, userId: string, kind: "circle" | "social" | "plan", refId: string) {
  const access = accessThread(deps, userId, kind, refId, false);
  markRead(deps.db, access.chat.id, userId, deps.now());
  return threadPayload(deps, access, userId);
}

export async function postThread(
  deps: ChatDeps,
  userId: string,
  userName: string,
  kind: "circle" | "social" | "plan",
  refId: string,
  raw: unknown,
): Promise<ReturnType<typeof threadPayload>> {
  const text = cleanText(raw);
  const access = accessThread(deps, userId, kind, refId, true);
  const now = deps.now();
  const id = crypto.randomUUID();
  deps.db.prepare(
    "INSERT INTO messages (id, chat_id, user_id, body, kind, created_at) VALUES (?, ?, ?, ?, 'text', ?)",
  ).run(id, access.chat.id, userId, text, now);
  markRead(deps.db, access.chat.id, userId, now);
  scheduleChatNotice(deps, access.chat.id, userName, text);
  return threadPayload(deps, access, userId);
}

export function deleteMessage(deps: ChatDeps, userId: string, messageId: string): void {
  const row = one<{ id: string; chat_id: string; user_id: string; kind: string; deleted_at: number | null }>(
    deps.db,
    "SELECT id, chat_id, user_id, kind, deleted_at FROM messages WHERE id = ?",
    messageId,
  );
  if (!row || row.deleted_at != null) throw new ChatError(404, "message not found");
  const chat = one<ChatRow>(deps.db, "SELECT * FROM chats WHERE id = ?", row.chat_id);
  if (!chat) throw new ChatError(404, "message not found");
  const circle = memberCircle(deps, userId);
  if (circle !== chat.circle_id) throw new ChatError(404, "message not found");
  const host = chat.kind !== "circle" && chat.host_id === userId;
  const admin = isCircleAdmin(deps.db, chat.circle_id, userId);
  const ownText = row.kind === "text" && row.user_id === userId;
  if (!ownText && !host && !admin) throw new ChatError(403, "You can't delete that.");
  deps.db.prepare("UPDATE messages SET deleted_at = ? WHERE id = ?").run(deps.now(), row.id);
}

export function setMuted(deps: ChatDeps, userId: string, chatId: string, muted: boolean): void {
  const chat = one<ChatRow>(deps.db, "SELECT * FROM chats WHERE id = ?", chatId);
  if (!chat || memberCircle(deps, userId) !== chat.circle_id) throw new ChatError(404, "chat not found");
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

export function scheduleChatNotice(deps: ChatDeps, chatId: string, senderName: string, preview: string): void {
  const existing = jobs.get(chatId);
  if (existing) {
    clearTimeout(existing.timer);
    existing.count += 1;
    existing.senderName = senderName;
    existing.preview = preview;
    existing.deps = deps;
    existing.timer = arm(chatId, nextChatPushDelay(lastPushAt(deps.db, chatId), deps.now()));
    return;
  }
  jobs.set(chatId, {
    deps,
    count: 1,
    senderName,
    preview,
    timer: arm(chatId, nextChatPushDelay(lastPushAt(deps.db, chatId), deps.now())),
  });
}

export async function flushChatNotices(force = false): Promise<void> {
  const ids = [...jobs.keys()];
  for (const id of ids) await fireChatNotice(id, force);
}

function arm(chatId: string, delay: number): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => {
    void fireChatNotice(chatId, false);
  }, delay);
  timer.unref?.();
  return timer;
}

async function fireChatNotice(chatId: string, force: boolean): Promise<void> {
  const job = jobs.get(chatId);
  if (!job) return;
  clearTimeout(job.timer);
  const chat = one<ChatRow>(job.deps.db, "SELECT * FROM chats WHERE id = ?", chatId);
  if (!chat) {
    jobs.delete(chatId);
    return;
  }
  const delay = nextChatPushDelay(chat.last_push_at, job.deps.now());
  if (!force && delay > CHAT_BATCH_MS) {
    job.timer = arm(chatId, delay);
    return;
  }
  jobs.delete(chatId);
  const latest = one<{ user_id: string }>(
    job.deps.db,
    "SELECT user_id FROM messages WHERE chat_id = ? AND kind = 'text' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1",
    chatId,
  );
  const recipients = listMembers(job.deps.db, chat.circle_id).filter((member) => {
    if (isMuted(job.deps.db, chatId, member.id)) return false;
    if (job.count === 1 && latest?.user_id === member.id) return false;
    return true;
  });
  if (recipients.length === 0) return;
  const title = chat.kind === "circle" ? (chat.title || "Circle chat") : (chat.title || "Chat");
  const body = job.count === 1 ? `${job.senderName}: ${job.preview}`.slice(0, 140) : `${job.count} new messages`;
  const ref = chat.kind === "circle" ? "circle" : `${chat.kind}:${chat.ref_id}`;
  job.deps.db.prepare("UPDATE chats SET last_push_at = ? WHERE id = ?").run(job.deps.now(), chatId);
  await notifyUsers(job.deps.db, job.deps.push, job.deps.now(), recipients.map((member) => ({
    userId: member.id,
    title,
    body,
    kind: "chat",
    refId: ref,
    tag: `chat:${chatId}`,
    url: `/?chat=${encodeURIComponent(ref)}`,
  })));
}

function threadPayload(deps: ChatDeps, access: Access, userId: string) {
  const messages = all<MessageRow>(
    deps.db,
    `SELECT m.id, m.user_id, m.body, m.kind, m.created_at, u.name
     FROM messages m JOIN users u ON u.id = m.user_id
     WHERE m.chat_id = ? AND m.deleted_at IS NULL
     ORDER BY m.created_at ASC
     LIMIT 200`,
    access.chat.id,
  );
  const admin = isCircleAdmin(deps.db, access.chat.circle_id, userId);
  const host = access.chat.kind !== "circle" && access.chat.host_id === userId;
  return {
    id: access.chat.id,
    kind: access.chat.kind,
    refId: access.chat.ref_id,
    title: access.title,
    closed: access.closed,
    muted: isMuted(deps.db, access.chat.id, userId),
    messages: messages.map((message) => ({
      id: message.id,
      name: message.name,
      text: message.body,
      at: message.created_at,
      system: message.kind === "system",
      mine: message.user_id === userId,
      canDelete: message.kind === "text"
        ? message.user_id === userId || admin || host
        : admin || host,
    })),
  };
}

type Access = { chat: ChatRow; title: string; closed: boolean; blocked: boolean };

function accessThread(deps: ChatDeps, userId: string, kind: "circle" | "social" | "plan", refId: string, writing: boolean): Access {
  const circleId = memberCircle(deps, userId);
  if (!circleId) throw new ChatError(409, "join a circle first");
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
  if (writing && looked.blocked) throw new ChatError(403, "The host removed you from this.");
  return { chat, title: looked.title || chat.title || "Chat", closed, blocked: looked.blocked };
}

function lookEvent(deps: ChatDeps, circleId: string, userId: string, kind: string, refId: string, now: number): { missing: boolean; closed: boolean; blocked: boolean; title: string; hostId: string | null } {
  if (kind === "circle") {
    return { missing: false, closed: false, blocked: false, title: "Circle chat", hostId: null };
  }
  if (kind === "social") {
    const social = getSocial(deps.db, refId);
    if (!social || social.circle_id !== circleId) {
      const existing = findChat(deps.db, circleId, "social", refId);
      if (!existing) return { missing: true, closed: true, blocked: false, title: "", hostId: null };
      return { missing: false, closed: true, blocked: Boolean(getSocialReply(deps.db, refId, userId)?.blocked), title: existing.title, hostId: existing.host_id };
    }
    return {
      missing: false,
      closed: social.expires_at <= now,
      blocked: Boolean(getSocialReply(deps.db, social.id, userId)?.blocked),
      title: social.note.trim() || "Free now",
      hostId: social.creator_id,
    };
  }
  const plan = getPlan(deps.db, refId);
  if (!plan || plan.circle_id !== circleId) {
    const existing = findChat(deps.db, circleId, "plan", refId);
    if (!existing) return { missing: true, closed: true, blocked: false, title: "", hostId: null };
    return { missing: false, closed: true, blocked: Boolean(getPlanReply(deps.db, refId, userId)?.blocked), title: existing.title, hostId: existing.host_id };
  }
  const today = isoDate(now, deps.config.tz);
  return {
    missing: false,
    closed: plan.for_date < today,
    blocked: Boolean(getPlanReply(deps.db, plan.id, userId)?.blocked),
    title: plan.note.trim() || "Plan",
    hostId: plan.creator_id,
  };
}

function memberCircle(deps: ChatDeps, userId: string): string | null {
  const row = one<{ circle_id: string }>(deps.db, "SELECT circle_id FROM memberships WHERE user_id = ?", userId);
  return row?.circle_id ?? null;
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

function unreadCount(db: DatabaseSync, chatId: string, userId: string): number {
  const row = one<{ n: number | bigint }>(
    db,
    `SELECT COUNT(*) AS n FROM messages m
     LEFT JOIN chat_reads r ON r.chat_id = m.chat_id AND r.user_id = ?
     WHERE m.chat_id = ? AND m.deleted_at IS NULL AND m.user_id != ?
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

export function replyLogText(name: string, reply: "coming" | "declined", eta: number | null, arriveLabel: string, alreadyIn: boolean): string {
  if (reply === "declined") return `${name} can't make it`;
  if (arriveLabel && alreadyIn) return `${name} is arriving ${arriveLabel}`;
  if (arriveLabel) return `${name} is in, arriving ${arriveLabel}`;
  if (eta) return `${name} is there in ${eta} min`;
  return `${name} is in`;
}
