/**
 * Google Calendar availability over OAuth, with the one scope that returns busy blocks only.
 * Authorization code + PKCE (S256) + a stored one-time state. Only the refresh token is kept, sealed
 * by freebusy.ts. Access tokens live for one call. Logs carry status, duration, and counts only:
 * never a code, a token, or a busy time. No import from freebusy.ts, which imports this.
 */
import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Config } from "../config.js";
import { FREEBUSY_WINDOW_MS, mergeBusy } from "./ics-parse.js";

export const GOOGLE_FREEBUSY_SCOPE = "https://www.googleapis.com/auth/calendar.freebusy";
export const GOOGLE_CALLBACK_PATH = "/api/calendar/google/callback";
export const GOOGLE_STATE_TTL_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

export type GoogleConfig = Partial<Pick<Config, "googleClientId" | "googleClientSecret" | "googleUrls">>;

export class GoogleError extends Error {
  constructor(message: string, public reconnect = false) {
    super(message);
  }
}

export function googleEnabled(config: GoogleConfig): boolean {
  return Boolean(config.googleClientId && config.googleClientSecret && config.googleUrls);
}

function creds(config: GoogleConfig): { id: string; secret: string; urls: Config["googleUrls"] } {
  if (!config.googleClientId || !config.googleClientSecret || !config.googleUrls) {
    throw new GoogleError("Google Calendar is not available right now");
  }
  return { id: config.googleClientId, secret: config.googleClientSecret, urls: config.googleUrls };
}

const b64url = (buf: Buffer) => buf.toString("base64url");

// ---------- state ----------

/** Stores a one-time state and verifier for the person and returns the Google consent URL. */
export function startGoogleAuth(db: DatabaseSync, config: GoogleConfig, userId: string, origin: string, now: number): string {
  const { id, urls } = creds(config);
  const state = b64url(crypto.randomBytes(32));
  const verifier = b64url(crypto.randomBytes(32));
  db.prepare("DELETE FROM google_oauth_state WHERE expires_at <= ?").run(now);
  db.prepare("INSERT INTO google_oauth_state (state, user_id, code_verifier, created_at, expires_at) VALUES (?, ?, ?, ?, ?)").run(
    state,
    userId,
    verifier,
    now,
    now + GOOGLE_STATE_TTL_MS,
  );
  const url = new URL(urls.auth);
  url.search = new URLSearchParams({
    client_id: id,
    redirect_uri: `${origin}${GOOGLE_CALLBACK_PATH}`,
    response_type: "code",
    scope: GOOGLE_FREEBUSY_SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: b64url(crypto.createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

/** Always deletes the row. Null when the state is unknown, expired, or already used. */
export function consumeGoogleState(db: DatabaseSync, state: string, now: number): { userId: string; verifier: string } | null {
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(state)) return null;
  const row = db.prepare("SELECT user_id, code_verifier, expires_at FROM google_oauth_state WHERE state = ?").get(state) as
    | { user_id: string; code_verifier: string; expires_at: number }
    | undefined;
  if (!row) return null;
  db.prepare("DELETE FROM google_oauth_state WHERE state = ?").run(state);
  if (row.expires_at <= now) return null;
  return { userId: row.user_id, verifier: row.code_verifier };
}

// ---------- Google calls ----------

async function post(url: string, init: { form?: Record<string, string>; json?: unknown; bearer?: string }): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { accept: "application/json" };
  let body: string;
  if (init.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(init.form).toString();
  } else {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  let response: Response;
  try {
    response = await fetch(url, { method: "POST", headers, body, redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    throw new GoogleError("Could not reach Google Calendar");
  }
  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    /* empty or not JSON */
  }
  return { status: response.status, body: parsed && typeof parsed === "object" ? parsed : {} };
}

function tokenFailure(reply: { status: number; body: any }): GoogleError {
  if (reply.body.error === "invalid_grant") return new GoogleError("Reconnect your calendar", true);
  return new GoogleError("Google did not accept the sign-in");
}

/** Only the freebusy scope, nothing broader. */
export function onlyFreebusyScope(scope: unknown): boolean {
  if (typeof scope !== "string") return false;
  const granted = scope.split(/\s+/).filter(Boolean);
  return granted.length === 1 && granted[0] === GOOGLE_FREEBUSY_SCOPE;
}

export async function revokeGoogleToken(config: GoogleConfig, token: string): Promise<boolean> {
  try {
    const { urls } = creds(config);
    const reply = await post(urls.revoke, { form: { token } });
    console.log(`google calendar revoke status=${reply.status}`);
    return reply.status >= 200 && reply.status < 300;
  } catch {
    console.log("google calendar revoke failed");
    return false;
  }
}

/** Trades the code for tokens. Refuses, and revokes what it got, unless the grant is freebusy alone. */
export async function exchangeGoogleCode(
  config: GoogleConfig,
  code: string,
  verifier: string,
  origin: string,
): Promise<{ refreshToken: string; accessToken: string }> {
  const { id, secret, urls } = creds(config);
  const started = Date.now();
  const reply = await post(urls.token, {
    form: {
      client_id: id,
      client_secret: secret,
      code,
      redirect_uri: `${origin}${GOOGLE_CALLBACK_PATH}`,
      grant_type: "authorization_code",
      code_verifier: verifier,
    },
  });
  console.log(`google calendar token status=${reply.status} ms=${Date.now() - started}`);
  const { access_token: access, refresh_token: refresh, scope } = reply.body;
  if (reply.status < 200 || reply.status >= 300 || typeof access !== "string" || !access) throw tokenFailure(reply);
  if (!onlyFreebusyScope(scope)) {
    const spare = typeof refresh === "string" && refresh ? refresh : access;
    await revokeGoogleToken(config, spare);
    throw new GoogleError("Google gave more access than Hangry asked for");
  }
  if (typeof refresh !== "string" || !refresh) throw new GoogleError("Google did not allow ongoing access");
  return { refreshToken: refresh, accessToken: access };
}

export async function refreshGoogleAccess(config: GoogleConfig, refreshToken: string): Promise<string> {
  const { id, secret, urls } = creds(config);
  const reply = await post(urls.token, {
    form: { client_id: id, client_secret: secret, refresh_token: refreshToken, grant_type: "refresh_token" },
  });
  const access = reply.body.access_token;
  if (reply.status < 200 || reply.status >= 300 || typeof access !== "string" || !access) throw tokenFailure(reply);
  return access;
}

/** Merged busy intervals from the primary calendar for the next 14 days. Times only. */
export async function fetchGoogleBusy(config: GoogleConfig, accessToken: string, now: number): Promise<Array<[number, number]>> {
  const { urls } = creds(config);
  const windowEnd = now + FREEBUSY_WINDOW_MS;
  const started = Date.now();
  const reply = await post(urls.freebusy, {
    bearer: accessToken,
    json: { timeMin: new Date(now).toISOString(), timeMax: new Date(windowEnd).toISOString(), items: [{ id: "primary" }] },
  });
  const primary = reply.body.calendars?.primary;
  const failed = reply.status < 200 || reply.status >= 300 || !primary || primary.error || (Array.isArray(primary.errors) && primary.errors.length > 0);
  if (failed) {
    console.log(`google calendar freebusy failed status=${reply.status} ms=${Date.now() - started}`);
    throw new GoogleError("Google Calendar did not return your busy times");
  }
  const spans: Array<{ start: number; end: number }> = [];
  for (const item of Array.isArray(primary.busy) ? primary.busy : []) {
    const start = Date.parse(item?.start);
    const end = Date.parse(item?.end);
    if (Number.isFinite(start) && Number.isFinite(end)) spans.push({ start, end });
  }
  const busy = mergeBusy(spans, now, windowEnd);
  console.log(`google calendar freebusy ok status=${reply.status} ms=${Date.now() - started} busy=${busy.length}`);
  return busy;
}
