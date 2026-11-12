import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  countAgentTokens,
  deleteAgentToken,
  getAgentTokenByHash,
  getUserById,
  insertAgentToken,
  listAgentTokens,
  touchAgentToken,
  type UserRow,
} from "../db.js";

export const AGENT_TOKEN_PREFIX = "hng_";
export const AGENT_NAME_MAX = 40;
export const MAX_AGENT_TOKENS = 10;
/** Requests per agent token. Keyed by token id, so the secret never sits in memory twice. */
export const AGENT_TOKEN_LIMIT = { limit: 60, windowMs: 60_000 };
/** last_used_at is rewritten at most this often per token. */
export const AGENT_TOUCH_MS = 60_000;

const SHAPE = /^hng_[A-Za-z0-9_-]{43}$/;

export type RequestAuth = { user: UserRow; kind: "session" | "agent"; agentTokenId?: string };

export function hashAgentToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function isAgentTokenShape(token: string): boolean {
  return SHAPE.test(token);
}

/** The person behind a live agent token, or undefined for unknown, revoked, or malformed ones. */
export function authFromAgentToken(db: DatabaseSync, token: string, now: number): RequestAuth | undefined {
  if (!isAgentTokenShape(token)) return undefined;
  const row = getAgentTokenByHash(db, hashAgentToken(token));
  if (!row) return undefined;
  const user = getUserById(db, row.user_id);
  if (!user) return undefined;
  if (row.last_used_at === null || now - row.last_used_at > AGENT_TOUCH_MS) touchAgentToken(db, row.id, now);
  return { user, kind: "agent", agentTokenId: row.id };
}

/** The plain token is in the result once. Only its hash and a short display prefix are stored. */
export function issueAgentToken(db: DatabaseSync, userId: string, name: string, now: number) {
  if (countAgentTokens(db, userId) >= MAX_AGENT_TOKENS) {
    throw new Error(`You already have ${MAX_AGENT_TOKENS} agent tokens. Revoke one first.`);
  }
  const token = AGENT_TOKEN_PREFIX + crypto.randomBytes(32).toString("base64url");
  const id = crypto.randomUUID();
  const tokenPrefix = token.slice(0, 8);
  insertAgentToken(db, {
    id,
    user_id: userId,
    name,
    token_hash: hashAgentToken(token),
    token_prefix: tokenPrefix,
    created_at: now,
    last_used_at: null,
  });
  return { id, name, token, tokenPrefix, createdAt: now };
}

export function listAgentTokensFor(db: DatabaseSync, userId: string) {
  return listAgentTokens(db, userId).map((row) => ({
    id: row.id,
    name: row.name,
    tokenPrefix: row.token_prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }));
}

/** False when the id is not this person's token. */
export function revokeAgentToken(db: DatabaseSync, userId: string, id: string): boolean {
  return deleteAgentToken(db, userId, id);
}
