/**
 * Calendar availability import ("free/busy"). Separate from the export feed in calendar.ts.
 *
 * A person pastes a private ICS link. The server fetches it (SSRF guarded, pinned DNS), keeps only
 * merged busy intervals for the next 14 days, and shows friends Busy or Free in the circles the
 * owner opted into. Event titles are kept for the owner alone (encrypted, same window), for the
 * "I'm in" check. Locations, descriptions, and attendees are never stored. The link is encrypted
 * with AES-256-GCM, keyed by CALENDAR_SYNC_KEY or a random key kept in app_meta.
 * Logs carry host, status, duration, and counts only: never the link, a title, or a key.
 *
 * A row is either source "ics" (the link above) or "google" (google-calendar.ts: OAuth with the
 * freebusy scope, only the encrypted refresh token kept, busy blocks and no titles at all).
 */
import crypto from "node:crypto";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { DatabaseSync } from "node:sqlite";
import type { Config } from "./config.js";
import {
  exchangeGoogleCode,
  fetchGoogleBusy,
  googleEnabled,
  GoogleError,
  refreshGoogleAccess,
  revokeGoogleToken,
  type GoogleConfig,
} from "./google-calendar.js";
import { FREEBUSY_WINDOW_MS, parseIcs } from "./ics-parse.js";
import { addDays, zonedDateTime } from "./time.js";

const MINUTE = 60_000;
export const SYNC_OK_EVERY_MS = 20 * MINUTE;
const BACKOFF_BASE_MS = 15 * MINUTE;
const BACKOFF_MAX_MS = 2 * 60 * MINUTE;
/** Older than this, friends see nothing rather than a guess. */
export const STALE_AFTER_MS = 24 * 60 * MINUTE;
export const FETCH_TIMEOUT_MS = 15_000;
export const FETCH_MAX_BYTES = 5 * 1024 * 1024;
export const FETCH_MAX_REDIRECTS = 5;
const MAX_URL = 2048;
const MAX_SHARES = 50;

export const ERR = {
  unreachable: "Could not reach the calendar",
  timeout: "The calendar took too long to answer",
  tooLarge: "The file was too large",
  notCalendar: "That link does not point to a calendar file",
  blocked: "That address is not allowed",
  redirects: "Too many redirects",
  notFound: "The calendar link was not found",
  signIn: "That calendar needs a sign-in. Use the private or secret address",
  reconnect: "Reconnect your calendar",
  badUrl: "Paste a calendar link that starts with https://, http://, or webcal://",
} as const;

export class CalendarError extends Error {
  constructor(message: string, public blocked = false) {
    super(message);
  }
}

// ---------- key and encryption ----------

const dbKeys = new WeakMap<DatabaseSync, Buffer>();

export function syncKey(db: DatabaseSync, config: Pick<Config, "calendarSyncKey">): Buffer {
  if (config.calendarSyncKey) return config.calendarSyncKey;
  const cached = dbKeys.get(db);
  if (cached) return cached;
  db.prepare("INSERT OR IGNORE INTO app_meta (key, value) VALUES ('calendar_sync_key', ?)").run(crypto.randomBytes(32).toString("base64"));
  const row = db.prepare("SELECT value FROM app_meta WHERE key = 'calendar_sync_key'").get() as { value: string };
  const key = Buffer.from(row.value, "base64");
  if (key.length !== 32) throw new Error("calendar sync key in app_meta is not 32 bytes");
  dbKeys.set(db, key);
  return key;
}

export function seal(key: Buffer, plain: string, aad: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64")}`;
}

/** Null when the key changed or the row was tampered with. */
export function unseal(key: Buffer, sealed: string, aad: string): string | null {
  if (!sealed.startsWith("v1:")) return null;
  try {
    const raw = Buffer.from(sealed.slice(3), "base64");
    if (raw.length < 28) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

// ---------- addresses ----------

function parseV4(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

function v4Blocked([a, b, c]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

/** Eight 16-bit groups, or null. Accepts :: and a trailing dotted IPv4. */
function parseV6(text: string): number[] | null {
  let value = text.toLowerCase();
  const zone = value.indexOf("%");
  if (zone >= 0) value = value.slice(0, zone);
  const lastColon = value.lastIndexOf(":");
  if (lastColon < 0) return null;
  const last = value.slice(lastColon + 1);
  if (last.includes(".")) {
    const v4 = parseV4(last);
    if (!v4) return null;
    value = `${value.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const read = (part: string) => (part ? part.split(":") : []);
  const head = read(halves[0]);
  const rest = halves.length === 2 ? read(halves[1]) : [];
  if ([...head, ...rest].some((piece) => !/^[0-9a-f]{1,4}$/.test(piece))) return null;
  const total = head.length + rest.length;
  if (halves.length === 1 && total !== 8) return null;
  if (halves.length === 2 && total > 7) return null;
  const groups = [...head.map((p) => parseInt(p, 16))];
  if (halves.length === 2) for (let i = 0; i < 8 - total; i++) groups.push(0);
  groups.push(...rest.map((p) => parseInt(p, 16)));
  return groups.length === 8 ? groups : null;
}

function v6Blocked(g: number[]): boolean {
  const embedded = (hi: number, lo: number) => v4Blocked([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  // ::ffff:a.b.c.d mapped, and ::a.b.c.d compatible.
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && (g[5] === 0xffff || g[5] === 0)) {
    if (g[5] === 0 && g[6] === 0 && (g[7] === 0 || g[7] === 1)) return true; // :: and ::1
    return embedded(g[6], g[7]);
  }
  // 64:ff9b::/96 NAT64.
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) return embedded(g[6], g[7]);
  // 2002::/16 6to4 carries the IPv4 in groups 1 and 2.
  if (g[0] === 0x2002) return embedded(g[1], g[2]);
  // Global unicast only: 2000::/3, minus Teredo 2001::/32 and documentation 2001:db8::/32.
  if ((g[0] & 0xe000) !== 0x2000) return true;
  if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8)) return true;
  return false;
}

/** True for anything that is not a public unicast address, or not an address at all. */
export function isBlockedAddress(address: string): boolean {
  const v4 = parseV4(address);
  if (v4) return v4Blocked(v4);
  const v6 = parseV6(address);
  if (v6) return v6Blocked(v6);
  return true;
}

function bareHost(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

/** Trims, turns webcal into https, and refuses anything the server should not fetch. */
export function normalizeCalendarUrl(raw: unknown): URL {
  if (typeof raw !== "string") throw new CalendarError(ERR.badUrl);
  let text = raw.trim();
  if (!text || text.length > MAX_URL) throw new CalendarError(ERR.badUrl);
  text = text.replace(/^webcals?:\/\//i, "https://");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new CalendarError(ERR.badUrl);
  }
  checkUrl(url);
  return url;
}

function checkUrl(url: URL): void {
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new CalendarError(ERR.badUrl);
  if (!url.hostname) throw new CalendarError(ERR.badUrl);
  if (url.username || url.password) throw new CalendarError(ERR.blocked, true);
  const host = bareHost(url);
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new CalendarError(ERR.blocked, true);
  }
  if (net.isIP(host) && isBlockedAddress(host)) throw new CalendarError(ERR.blocked, true);
}

// ---------- fetching ----------

export type ResolvedAddress = { address: string; family: number };
export type Resolver = (host: string) => Promise<ResolvedAddress[]>;
export type TransportResponse = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array>;
  destroy(): void;
};
/** One GET to `url`, connecting only to `target`. */
export type Transport = (url: URL, target: ResolvedAddress, signal: AbortSignal) => Promise<TransportResponse>;

/** Injected by tests. Production uses DNS and node:http(s). */
export type CalendarNet = { resolve?: Resolver; request?: Transport };

export const dnsResolver: Resolver = async (host) => {
  const found = await dns.promises.lookup(host, { all: true, verbatim: true });
  return found.map((item) => ({ address: item.address, family: item.family }));
};

/** node:http(s) with the connection pinned to the checked address. TLS still checks the hostname. */
export const nodeTransport: Transport = (url, target, signal) =>
  new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const host = bareHost(url);
    const request = mod.request(
      url,
      {
        method: "GET",
        agent: false,
        signal,
        headers: {
          accept: "text/calendar, text/plain;q=0.8, */*;q=0.5",
          "accept-encoding": "identity",
          "user-agent": "Hangry calendar availability",
        },
        ...(net.isIP(host) ? {} : { servername: host }),
        lookup: ((_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
          if (options?.all) callback(null, [{ address: target.address, family: target.family }]);
          else callback(null, target.address, target.family);
        }) as unknown as typeof dns.lookup,
      },
      (response) => {
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: response,
          destroy: () => response.destroy(),
        });
      },
    );
    request.on("error", reject);
    request.end();
  });

export type FetchOptions = CalendarNet & { timeoutMs?: number; maxBytes?: number; maxRedirects?: number };

export type FetchResult = { text: string; status: number; host: string };

function header(headers: TransportResponse["headers"], name: string): string {
  const value = headers[name];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

async function pickAddress(url: URL, resolve: Resolver): Promise<ResolvedAddress> {
  const host = bareHost(url);
  const family = net.isIP(host);
  if (family) return { address: host, family };
  let found: ResolvedAddress[];
  try {
    found = await resolve(host);
  } catch {
    throw new CalendarError(ERR.unreachable);
  }
  if (!found.length) throw new CalendarError(ERR.unreachable);
  if (found.some((item) => isBlockedAddress(item.address))) throw new CalendarError(ERR.blocked, true);
  return found[0];
}

/** GETs an ICS file. Every hop is checked; errors carry only the safe messages in ERR. */
export async function fetchIcs(start: URL, options: FetchOptions = {}): Promise<FetchResult> {
  const resolve = options.resolve ?? dnsResolver;
  const transport = options.request ?? nodeTransport;
  const maxBytes = options.maxBytes ?? FETCH_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? FETCH_MAX_REDIRECTS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? FETCH_TIMEOUT_MS);
  timer.unref?.();
  let url = start;
  try {
    for (let hop = 0; ; hop++) {
      checkUrl(url);
      const target = await pickAddress(url, resolve);
      if (timedOut) throw new CalendarError(ERR.timeout);
      let response: TransportResponse;
      try {
        response = await transport(url, target, controller.signal);
      } catch {
        throw new CalendarError(timedOut ? ERR.timeout : ERR.unreachable);
      }
      const status = response.status;
      if (status >= 300 && status < 400 && status !== 304) {
        response.destroy();
        const location = header(response.headers, "location");
        if (!location) throw new CalendarError(ERR.unreachable);
        if (hop >= maxRedirects) throw new CalendarError(ERR.redirects);
        try {
          url = new URL(location, url);
        } catch {
          throw new CalendarError(ERR.unreachable);
        }
        continue;
      }
      if (status === 404 || status === 410) {
        response.destroy();
        throw new CalendarError(ERR.notFound);
      }
      if (status === 401 || status === 403) {
        response.destroy();
        throw new CalendarError(ERR.signIn);
      }
      if (status < 200 || status >= 300) {
        response.destroy();
        throw new CalendarError(ERR.unreachable);
      }
      const length = Number(header(response.headers, "content-length"));
      if (Number.isFinite(length) && length > maxBytes) {
        response.destroy();
        throw new CalendarError(ERR.tooLarge);
      }
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        for await (const chunk of response.body) {
          size += chunk.byteLength;
          if (size > maxBytes) {
            response.destroy();
            throw new CalendarError(ERR.tooLarge);
          }
          chunks.push(Buffer.from(chunk));
        }
      } catch (error) {
        if (error instanceof CalendarError) throw error;
        throw new CalendarError(timedOut ? ERR.timeout : ERR.unreachable);
      }
      const text = Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, "");
      if (!/BEGIN:VCALENDAR/i.test(text.slice(0, 4096))) throw new CalendarError(ERR.notCalendar);
      return { text, status, host: bareHost(start) };
    }
  } finally {
    clearTimeout(timer);
  }
}

// ---------- storage and sync ----------

export type FreeBusyDeps = {
  db: DatabaseSync;
  config: Pick<Config, "calendarSyncKey" | "tz"> & GoogleConfig;
  now: () => number;
  calendarNet?: CalendarNet;
};

type SyncRow = {
  user_id: string;
  url_enc: string;
  host: string;
  source: string;
  token_enc: string | null;
  rev: string;
  created_at: number;
  last_sync_at: number | null;
  last_ok: number | null;
  last_ok_at: number | null;
  last_error: string | null;
  fail_count: number;
  next_sync_at: number;
  window_end: number | null;
};

type Outcome =
  | { ok: true; busy: Array<[number, number]>; events: Array<{ start: number; end: number; allDay: boolean; title: string }>; status: number }
  | { ok: false; error: string };

const inFlight = new WeakMap<DatabaseSync, Set<string>>();

function flights(db: DatabaseSync): Set<string> {
  let set = inFlight.get(db);
  if (!set) {
    set = new Set();
    inFlight.set(db, set);
  }
  return set;
}

function getRow(db: DatabaseSync, userId: string): SyncRow | undefined {
  const row = db.prepare("SELECT * FROM calendar_sync WHERE user_id = ?").get(userId);
  return row ? ({ ...row } as SyncRow) : undefined;
}

async function fetchAndParse(deps: FreeBusyDeps, url: URL, now: number): Promise<Outcome> {
  const started = Date.now();
  try {
    const got = await fetchIcs(url, { ...deps.calendarNet });
    const parsed = parseIcs(got.text, { now, tz: deps.config.tz });
    console.log(
      `calendar sync ok host=${got.host} status=${got.status} ms=${Date.now() - started} busy=${parsed.busy.length} events=${parsed.events.length} skipped=${parsed.skipped}`,
    );
    return { ok: true, busy: parsed.busy, events: parsed.events, status: got.status };
  } catch (error) {
    if (error instanceof CalendarError && error.blocked) throw error;
    const message = error instanceof CalendarError ? error.message : ERR.unreachable;
    console.log(`calendar sync failed host=${bareHost(url)} ms=${Date.now() - started} reason="${message}"`);
    return { ok: false, error: message };
  }
}

function writeOutcome(db: DatabaseSync, key: Buffer, userId: string, rev: string, outcome: Outcome, now: number): boolean {
  db.exec("BEGIN");
  try {
    const current = db.prepare("SELECT rev, fail_count FROM calendar_sync WHERE user_id = ?").get(userId) as
      | { rev: string; fail_count: number }
      | undefined;
    // Removed or replaced while this fetch was running: drop the result.
    if (!current || current.rev !== rev) {
      db.exec("ROLLBACK");
      return false;
    }
    if (outcome.ok) {
      db.prepare("DELETE FROM calendar_busy WHERE user_id = ?").run(userId);
      db.prepare("DELETE FROM calendar_event WHERE user_id = ?").run(userId);
      const busy = db.prepare("INSERT INTO calendar_busy (user_id, start_ms, end_ms) VALUES (?, ?, ?)");
      for (const [start, end] of outcome.busy) busy.run(userId, start, end);
      const event = db.prepare("INSERT INTO calendar_event (user_id, start_ms, end_ms, all_day, title_enc) VALUES (?, ?, ?, ?, ?)");
      for (const item of outcome.events) event.run(userId, item.start, item.end, item.allDay ? 1 : 0, seal(key, item.title, userId));
      db.prepare(
        `UPDATE calendar_sync SET last_sync_at = ?, last_ok = 1, last_ok_at = ?, last_error = NULL, fail_count = 0,
         next_sync_at = ?, window_end = ? WHERE user_id = ?`,
      ).run(now, now, now + SYNC_OK_EVERY_MS, now + FREEBUSY_WINDOW_MS, userId);
    } else {
      const fails = Number(current.fail_count) + 1;
      const wait = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(fails - 1, 10));
      db.prepare(
        "UPDATE calendar_sync SET last_sync_at = ?, last_ok = 0, last_error = ?, fail_count = ?, next_sync_at = ? WHERE user_id = ?",
      ).run(now, outcome.error, fails, now + wait, userId);
    }
    db.exec("COMMIT");
    return true;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already rolled back */
    }
    throw error;
  }
}

async function googleOutcome(deps: FreeBusyDeps, key: Buffer, userId: string, row: SyncRow, now: number, access?: string): Promise<Outcome> {
  try {
    if (!access) {
      const refresh = row.token_enc ? unseal(key, row.token_enc, userId) : null;
      if (refresh === null) return { ok: false, error: ERR.reconnect };
      access = await refreshGoogleAccess(deps.config, refresh);
    }
    return { ok: true, busy: await fetchGoogleBusy(deps.config, access, now), events: [], status: 200 };
  } catch (error) {
    return { ok: false, error: error instanceof GoogleError ? (error.reconnect ? ERR.reconnect : error.message) : ERR.unreachable };
  }
}

/** Syncs one person now. A no-op while another sync for them is running. */
export async function syncUser(deps: FreeBusyDeps, userId: string): Promise<void> {
  const running = flights(deps.db);
  if (running.has(userId)) return;
  running.add(userId);
  try {
    const row = getRow(deps.db, userId);
    if (!row) return;
    const key = syncKey(deps.db, deps.config);
    if (row.source === "google") {
      const outcome = await googleOutcome(deps, key, userId, row, deps.now());
      writeOutcome(deps.db, key, userId, row.rev, outcome, deps.now());
      return;
    }
    const plain = unseal(key, row.url_enc, userId);
    const now = deps.now();
    if (plain === null) {
      writeOutcome(deps.db, key, userId, row.rev, { ok: false, error: ERR.reconnect }, now);
      return;
    }
    let outcome: Outcome;
    try {
      outcome = await fetchAndParse(deps, new URL(plain), now);
    } catch (error) {
      // A host that now resolves somewhere private: keep the old data, report it, back off.
      outcome = { ok: false, error: error instanceof CalendarError ? error.message : ERR.unreachable };
    }
    writeOutcome(deps.db, key, userId, row.rev, outcome, deps.now());
  } finally {
    running.delete(userId);
  }
}

/** Everyone due, oldest first, one at a time. For the server timer. */
export async function syncCalendarFeeds(deps: FreeBusyDeps, limit = 25): Promise<number> {
  const due = deps.db
    .prepare("SELECT user_id FROM calendar_sync WHERE next_sync_at <= ? ORDER BY next_sync_at ASC LIMIT ?")
    .all(deps.now(), limit) as Array<{ user_id: string }>;
  for (const { user_id } of due) {
    try {
      await syncUser(deps, user_id);
    } catch (error) {
      console.error("calendar sync error", error instanceof Error ? error.name : "unknown");
    }
  }
  return due.length;
}

/**
 * Connect or replace. Fetches first: a blocked address stores nothing (CalendarError, blocked).
 * Any other first-fetch failure is stored with its message so the person sees it and can retry.
 * Circles already shared stay shared. Old intervals and titles go.
 */
export async function connectCalendar(deps: FreeBusyDeps, userId: string, raw: unknown): Promise<void> {
  const url = normalizeCalendarUrl(raw);
  const now = deps.now();
  const outcome = await fetchAndParse(deps, url, now);
  const key = syncKey(deps.db, deps.config);
  const rev = crypto.randomUUID();
  const sealed = seal(key, url.toString(), userId);
  const old = googleToken(deps, key, userId);
  deps.db.prepare(
    `INSERT INTO calendar_sync (user_id, url_enc, host, source, token_enc, rev, created_at, fail_count, next_sync_at)
     VALUES (?, ?, ?, 'ics', NULL, ?, ?, 0, ?)
     ON CONFLICT(user_id) DO UPDATE SET url_enc = excluded.url_enc, host = excluded.host, source = 'ics', token_enc = NULL,
       rev = excluded.rev, created_at = excluded.created_at, last_sync_at = NULL, last_ok = NULL, last_ok_at = NULL, last_error = NULL,
       fail_count = 0, next_sync_at = excluded.next_sync_at, window_end = NULL`,
  ).run(userId, sealed, bareHost(url), rev, now, now);
  deps.db.prepare("DELETE FROM calendar_busy WHERE user_id = ?").run(userId);
  deps.db.prepare("DELETE FROM calendar_event WHERE user_id = ?").run(userId);
  writeOutcome(deps.db, key, userId, rev, outcome, deps.now());
  if (old) await revokeGoogleToken(deps.config, old);
}

/** The person's Google refresh token, or null when they have none. */
function googleToken(deps: FreeBusyDeps, key: Buffer, userId: string): string | null {
  const row = getRow(deps.db, userId);
  if (!row || row.source !== "google" || !row.token_enc) return null;
  return unseal(key, row.token_enc, userId);
}

/**
 * Finishes a Google connect: trades the code (freebusy scope only), stores the sealed refresh token,
 * and runs the first sync. Replaces any link or earlier Google grant, and revokes an earlier Google grant. Shared circles stay shared.
 */
export async function connectGoogle(deps: FreeBusyDeps, userId: string, code: string, verifier: string, origin: string): Promise<void> {
  if (!googleEnabled(deps.config)) throw new GoogleError("Google Calendar is not available right now");
  const tokens = await exchangeGoogleCode(deps.config, code, verifier, origin);
  const now = deps.now();
  const key = syncKey(deps.db, deps.config);
  const old = googleToken(deps, key, userId);
  const rev = crypto.randomUUID();
  deps.db.prepare(
    `INSERT INTO calendar_sync (user_id, url_enc, host, source, token_enc, rev, created_at, fail_count, next_sync_at)
     VALUES (?, '', 'Google', 'google', ?, ?, ?, 0, ?)
     ON CONFLICT(user_id) DO UPDATE SET url_enc = '', host = 'Google', source = 'google', token_enc = excluded.token_enc,
       rev = excluded.rev, created_at = excluded.created_at, last_sync_at = NULL, last_ok = NULL, last_ok_at = NULL,
       last_error = NULL, fail_count = 0, next_sync_at = excluded.next_sync_at, window_end = NULL`,
  ).run(userId, seal(key, tokens.refreshToken, userId), rev, now, now);
  deps.db.prepare("DELETE FROM calendar_busy WHERE user_id = ?").run(userId);
  deps.db.prepare("DELETE FROM calendar_event WHERE user_id = ?").run(userId);
  const row = getRow(deps.db, userId)!;
  const outcome = await googleOutcome(deps, key, userId, row, now, tokens.accessToken);
  writeOutcome(deps.db, key, userId, rev, outcome, deps.now());
  if (old && old !== tokens.refreshToken) await revokeGoogleToken(deps.config, old);
}

/**
 * Removes the connection. A Google grant is revoked at Google, but the local rows go either way
 * (calendar_busy, calendar_event, and calendar_share go with it via ON DELETE CASCADE).
 */
export async function disconnectCalendar(deps: FreeBusyDeps, userId: string): Promise<void> {
  const token = googleToken(deps, syncKey(deps.db, deps.config), userId);
  deps.db.prepare("DELETE FROM calendar_sync WHERE user_id = ?").run(userId);
  if (token) await revokeGoogleToken(deps.config, token);
}

export function isConnected(db: DatabaseSync, userId: string): boolean {
  return Boolean(db.prepare("SELECT 1 AS ok FROM calendar_sync WHERE user_id = ?").get(userId));
}

/** Replaces the shared circles. Every id must be a circle the person is in. */
export function setSharedCircles(db: DatabaseSync, userId: string, raw: unknown): void {
  if (!Array.isArray(raw) || raw.length > MAX_SHARES || raw.some((id) => typeof id !== "string")) {
    throw new CalendarError("sharedCircleIds must be a list of circle ids");
  }
  const ids = [...new Set(raw as string[])];
  const member = db.prepare("SELECT 1 AS ok FROM memberships WHERE user_id = ? AND circle_id = ?");
  for (const id of ids) if (!member.get(userId, id)) throw new CalendarError("You are not in that circle");
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM calendar_share WHERE user_id = ?").run(userId);
    const insert = db.prepare("INSERT INTO calendar_share (user_id, circle_id) VALUES (?, ?)");
    for (const id of ids) insert.run(userId, id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export type SyncStatus = {
  connected: boolean;
  googleAvailable: boolean;
  source: "ics" | "google" | null;
  host: string | null;
  lastSyncAt: number | null;
  lastSyncOk: boolean | null;
  lastError: string | null;
  sharedCircleIds: string[];
  circles: Array<{ id: string; name: string }>;
};

export function syncStatus(db: DatabaseSync, userId: string, config: GoogleConfig = {}): SyncStatus {
  const googleAvailable = googleEnabled(config);
  const row = getRow(db, userId);
  const circles = (db
    .prepare(
      `SELECT c.id, c.name FROM circles c JOIN memberships m ON m.circle_id = c.id
       WHERE m.user_id = ? ORDER BY m.joined_at ASC, c.name ASC`,
    )
    .all(userId) as Array<{ id: string; name: string }>).map((c) => ({ id: c.id, name: c.name }));
  if (!row) return { connected: false, googleAvailable, source: null, host: null, lastSyncAt: null, lastSyncOk: null, lastError: null, sharedCircleIds: [], circles };
  const shared = (db.prepare("SELECT circle_id FROM calendar_share WHERE user_id = ?").all(userId) as Array<{ circle_id: string }>)
    .map((item) => item.circle_id);
  return {
    connected: true,
    googleAvailable,
    source: row.source === "google" ? "google" : "ics",
    host: row.host,
    lastSyncAt: row.last_sync_at,
    lastSyncOk: row.last_ok === null ? null : Boolean(row.last_ok),
    lastError: row.last_error,
    sharedCircleIds: circles.filter((c) => shared.includes(c.id)).map((c) => c.id),
    circles,
  };
}

// ---------- what friends see ----------

export type Availability = { state: "busy" | "free"; until: number | null } | null;

/**
 * Busy or free at `at` for each member who shares their calendar with this circle, as seen by
 * `viewerId` (who must be in the circle too). Nothing for stale data or past the synced window.
 */
export function circleAvailability(db: DatabaseSync, circleId: string, viewerId: string, at: number, now: number): Map<string, Availability> {
  const out = new Map<string, Availability>();
  const owners = db
    .prepare(
      `SELECT s.user_id, s.window_end, s.last_ok_at FROM calendar_share sh
       JOIN calendar_sync s ON s.user_id = sh.user_id
       JOIN memberships owner ON owner.user_id = sh.user_id AND owner.circle_id = sh.circle_id
       JOIN memberships viewer ON viewer.user_id = ? AND viewer.circle_id = sh.circle_id
       WHERE sh.circle_id = ? AND s.last_ok_at IS NOT NULL AND s.last_ok_at >= ? AND s.window_end IS NOT NULL`,
    )
    .all(viewerId, circleId, now - STALE_AFTER_MS) as Array<{ user_id: string; window_end: number; last_ok_at: number }>;
  const next = db.prepare("SELECT start_ms, end_ms FROM calendar_busy WHERE user_id = ? AND end_ms > ? ORDER BY start_ms ASC LIMIT 1");
  for (const owner of owners) {
    if (at >= owner.window_end || at < owner.last_ok_at) continue;
    const span = next.get(owner.user_id, at) as { start_ms: number; end_ms: number } | undefined;
    const cap = (until: number) => (until >= owner.window_end ? null : until);
    if (span && span.start_ms <= at) out.set(owner.user_id, { state: "busy", until: cap(span.end_ms) });
    else out.set(owner.user_id, { state: "free", until: span ? cap(span.start_ms) : null });
  }
  return out;
}

// ---------- the owner's own titles ----------

export type OwnEvent = { title: string; start: number; end: number; allDay: boolean };

/** The owner's own events that overlap one APP_TZ day. Never call this for anyone else. */
export function ownDayEvents(db: DatabaseSync, config: Pick<Config, "calendarSyncKey" | "tz">, userId: string, day: string): OwnEvent[] {
  const from = zonedDateTime(day, "00:00", config.tz);
  const to = zonedDateTime(addDays(day, 1), "00:00", config.tz);
  const rows = db
    .prepare(
      "SELECT start_ms, end_ms, all_day, title_enc FROM calendar_event WHERE user_id = ? AND end_ms > ? AND start_ms < ? ORDER BY start_ms ASC LIMIT 100",
    )
    .all(userId, from, to) as Array<{ start_ms: number; end_ms: number; all_day: number; title_enc: string }>;
  if (!rows.length) return [];
  const key = syncKey(db, config);
  return rows.map((row) => ({
    title: unseal(key, row.title_enc, userId) ?? "",
    start: row.start_ms,
    end: row.end_ms,
    allDay: Boolean(row.all_day),
  }));
}
