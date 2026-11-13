import crypto from "node:crypto";
import http from "node:http";
import { AGENT_TOKEN_PREFIX, type RequestAuth, authFromAgentToken } from "../admin/agent-tokens.js";
import type { AppDeps } from "../app.js";
import { type UserRow, getUserByTokenHash } from "../db.js";
import { HttpError } from "./http.js";

export function authFromRequest(req: http.IncomingMessage, deps: AppDeps): RequestAuth | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(Array.isArray(header) ? header[0] : header);
  if (!match) return undefined;
  const token = match[1];
  if (token.length < 20 || token.length > 256) return undefined;
  if (token.startsWith(AGENT_TOKEN_PREFIX)) return authFromAgentToken(deps.db, token, deps.now());
  const user = getUserByTokenHash(deps.db, sha256(token));
  return user ? { user, kind: "session" } : undefined;
}

export function requireUser(user: UserRow | undefined): UserRow {
  if (!user) throw new HttpError(401, "sign in required");
  return user;
}

export function randomToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
