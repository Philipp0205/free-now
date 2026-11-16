import type http from "node:http";
import type { AppDeps } from "../app.js";
import type { RequestAuth } from "../admin/agent-tokens.js";
import type { UserRow } from "../db.js";
import type { RateLimiter } from "./rate-limit.js";

export type Limits = {
  ack: RateLimiter;
  feedback: RateLimiter;
  share: RateLimiter;
  feed: RateLimiter;
  calendarSync: RateLimiter;
  agent: RateLimiter;
  /** Email, recovery-code and lost-code attempts (see ACCOUNT_LIMIT). */
  accounts: RateLimiter;
};

/** The per-request values every route handler reads. Built once in handle(). */
export type RouteContext = {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  deps: AppDeps;
  limits: Limits;
  url: URL;
  method: string;
  pathname: string;
  user: UserRow | undefined;
  auth: RequestAuth | undefined;
  body: Record<string, unknown>;
  requested: string | null;
};

/** After sign-in is required: the same values plus the caller. */
export type AuthedRouteContext = RouteContext & { me: UserRow; agent: boolean };
