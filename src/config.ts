import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configuredAdminToken } from "./admin-query.js";
import { readPmtilesHeader, type PmtilesInfo } from "./pmtiles.js";
import { safeUrl, type PmtilesSource } from "./pmtiles-fetch.js";
import { assertTimeZone } from "./time.js";

export type VapidConfig = {
  publicKey: string;
  privateKey: string;
  subject: string;
};

export type Config = {
  port: number;
  dbPath: string;
  /** Profile photos, one file per person, next to the database (same volume). */
  avatarDir: string;
  publicBaseUrl: string;
  vapid: VapidConfig | null;
  socialTtlMs: number;
  tz: string;
  /** Same note will not push again until this gap has passed. */
  renotifyMs: number;
  mapTileUrl: string;
  mapTileAttribution: string;
  /** A local PMTiles v3 basemap and its coverage. Null keeps the raster basemap everywhere. */
  mapPmtiles: PmtilesInfo | null;
  /**
   * Set with MAP_PMTILES_SHA256 (and optionally MAP_PMTILES_URL). The archive is then checked, and
   * fetched if needed, in the background by startPmtilesFetch, which fills mapPmtiles when ready.
   */
  mapPmtilesSource: PmtilesSource | null;
  /** Set only when ADMIN_TOKEN is at least 32 characters. Otherwise the admin routes stay hidden. */
  adminToken: string | null;
  /**
   * CALENDAR_SYNC_KEY: 32 bytes for AES-256-GCM over imported calendar links and titles.
   * Null: a random key is made once and kept in the database (app_meta).
   */
  calendarSyncKey: Buffer | null;
  /** Both set (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET) turns on Connect Google Calendar. Otherwise null. */
  googleClientId: string | null;
  googleClientSecret: string | null;
  /** Google endpoints. Defaults are the real ones; the GOOGLE_OAUTH_* overrides exist for tests. */
  googleUrls: GoogleUrls;
};

export type GoogleUrls = { auth: string; token: string; freebusy: string; revoke: string };

const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;
// CARTO Voyager and dark_all on the public raster CDN both return an
// "API KEY REQUIRED" tile. Esri World Street Map is the no-key basemap that
// still names the city and the streets at zooms 12–16. It has data through
// zoom 19 here; 20+ is the "Map data not yet available" placeholder.
const DEFAULT_MAP_TILE_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}";
const DEFAULT_MAP_TILE_ATTRIBUTION = "Powered by Esri | © Esri, HERE, Garmin, USGS, OpenStreetMap contributors";
export const MAP_PMTILES_URL = "/tiles/basemap.pmtiles";
export const MAP_PMTILES_ATTRIBUTION =
  '<a href="https://protomaps.com">Protomaps</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Config {
  const port = readPort(env.PORT);
  const rawDb = env.DB_PATH?.trim() ?? "";
  const dbPath = rawDb
    ? path.resolve(cwd, rawDb)
    : path.join(cwd, "data", "free-now.sqlite");
  const publicBaseUrl = readBaseUrl(env.PUBLIC_BASE_URL);
  const socialTtlMs = readTtl(env.SOCIAL_TTL_MS);
  const tz = (env.APP_TZ?.trim() || "Europe/Berlin");
  assertTimeZone(tz);
  return {
    port,
    dbPath,
    avatarDir: avatarDirFor(rawDb === ":memory:" ? ":memory:" : dbPath),
    publicBaseUrl,
    vapid: readVapid(env),
    socialTtlMs,
    tz,
    renotifyMs: 30_000,
    mapTileUrl: readTileUrl(env.MAP_TILE_URL),
    mapTileAttribution: readAttribution(env.MAP_TILE_ATTRIBUTION),
    ...readPmtilesConfig(env),
    adminToken: configuredAdminToken(env.ADMIN_TOKEN),
    calendarSyncKey: readCalendarSyncKey(env.CALENDAR_SYNC_KEY),
    ...readGoogle(env),
  };
}

/** `{dir of the db}/avatars`. An in-memory db (tests) gets a per-process temp dir, never the cwd or /data. */
export function avatarDirFor(dbPath: string): string {
  if (dbPath === ":memory:" || path.basename(dbPath) === ":memory:") {
    return path.join(os.tmpdir(), `hangry-avatars-${process.pid}`);
  }
  return path.join(path.dirname(dbPath), "avatars");
}

function readPort(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 3000;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${value}`);
  }
  return port;
}

function readBaseUrl(value: string | undefined): string {
  const raw = value?.trim() ?? "";
  if (!raw) return "";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`PUBLIC_BASE_URL is not a URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("PUBLIC_BASE_URL must be http or https");
  }
  return raw.replace(/\/+$/, "");
}

function readTtl(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_TTL_MS;
  const ttl = Number(value);
  if (!Number.isFinite(ttl) || ttl < 60_000 || ttl > 7 * 24 * 60 * 60 * 1000) {
    throw new Error("SOCIAL_TTL_MS must be between 1 minute and 7 days");
  }
  return ttl;
}

function readTileUrl(value: string | undefined): string {
  const raw = value?.trim() || DEFAULT_MAP_TILE_URL;
  if (!raw.startsWith("https://") || !raw.includes("{z}") || !raw.includes("{x}") || !raw.includes("{y}")) {
    throw new Error("MAP_TILE_URL must be an https template containing {z}, {x}, and {y}");
  }
  if (raw.length > 400) throw new Error("MAP_TILE_URL is too long");
  return raw;
}

function readAttribution(value: string | undefined): string {
  const raw = value?.trim() || DEFAULT_MAP_TILE_ATTRIBUTION;
  if (raw.length > 240) throw new Error("MAP_TILE_ATTRIBUTION is too long");
  return raw;
}

/**
 * MAP_PMTILES_PATH alone: checked right here, as before. With a valid MAP_PMTILES_SHA256 the
 * file is hashed in the background instead (it can be large), and with MAP_PMTILES_URL as well a
 * missing or wrong file is downloaded (with MAP_PMTILES_TOKEN as a bearer token). Until then mapPmtiles stays null: raster only.
 * A bad URL or sha is logged and ignored rather than stopping the server.
 */
function readPmtilesConfig(env: NodeJS.ProcessEnv): Pick<Config, "mapPmtiles" | "mapPmtilesSource"> {
  const file = env.MAP_PMTILES_PATH?.trim() ?? "";
  if (file && !path.isAbsolute(file)) throw new Error("MAP_PMTILES_PATH must be an absolute path");
  let url = env.MAP_PMTILES_URL?.trim() || null;
  let sha256 = env.MAP_PMTILES_SHA256?.trim().toLowerCase() || null;
  if (url && !file) {
    console.warn("MAP_PMTILES_URL ignored: MAP_PMTILES_PATH is not set");
    url = null;
  }
  if (sha256 && !/^[0-9a-f]{64}$/.test(sha256)) {
    console.warn("MAP_PMTILES_SHA256 ignored: not 64 hex characters");
    sha256 = null;
  }
  if (url) {
    let parsed: URL | null = null;
    try {
      parsed = new URL(url);
    } catch {
      // Logged below.
    }
    if (!parsed || parsed.protocol !== "https:" || parsed.username || parsed.password) {
      console.warn(`MAP_PMTILES_URL ignored: must be a plain https URL (${parsed ? safeUrl(parsed) : "not a URL"})`);
      url = null;
    } else if (!sha256) {
      console.warn("MAP_PMTILES_URL ignored: MAP_PMTILES_SHA256 is required with it");
      url = null;
    }
  }
  // A secret: only its presence is ever logged.
  let token = env.MAP_PMTILES_TOKEN?.trim() || null;
  if (token && !/^[\x21-\x7e]+$/.test(token)) {
    console.warn("MAP_PMTILES_TOKEN ignored: must be printable ASCII without spaces");
    token = null;
  }
  if (token && !url) {
    console.warn("MAP_PMTILES_TOKEN ignored: no usable MAP_PMTILES_URL");
    token = null;
  }
  if (file && sha256) return { mapPmtiles: null, mapPmtilesSource: { path: file, sha256, url, token } };
  return { mapPmtiles: readPmtiles(file), mapPmtilesSource: null };
}

/**
 * Unset: null. Set to a missing file, a directory, or anything that is not a PMTiles v3
 * archive with sane bounds: null with a warning, so the raster map keeps working.
 */
function readPmtiles(value: string | undefined): PmtilesInfo | null {
  const raw = value?.trim() ?? "";
  if (!raw) return null;
  if (!path.isAbsolute(raw)) throw new Error("MAP_PMTILES_PATH must be an absolute path");
  try {
    if (!fs.statSync(raw).isFile()) throw new Error("not a file");
    return readPmtilesHeader(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`MAP_PMTILES_PATH disabled (${reason}), keeping the raster basemap: ${raw}`);
    return null;
  }
}

function readVapid(env: NodeJS.ProcessEnv): VapidConfig | null {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim() ?? "";
  const privateKey = env.VAPID_PRIVATE_KEY?.trim() ?? "";
  const subject = env.VAPID_SUBJECT?.trim() || "mailto:admin@localhost";
  if (!publicKey && !privateKey) return null;
  if (!publicKey || !privateKey) {
    throw new Error("Set both VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY, or neither");
  }
  if (!subject.startsWith("mailto:") && !subject.startsWith("https:")) {
    throw new Error("VAPID_SUBJECT must be a mailto: or https: URL");
  }
  return { publicKey, privateKey, subject };
}

/** 64 hex characters or base64 of 32 bytes. The value is a secret and never echoed. */
export function readCalendarSyncKey(value: string | undefined): Buffer | null {
  const raw = value?.trim() ?? "";
  if (!raw) return null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(raw)) {
    const key = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (key.length === 32) return key;
  }
  throw new Error("CALENDAR_SYNC_KEY must be 64 hex characters or base64 of 32 bytes");
}

function readGoogle(env: NodeJS.ProcessEnv): Pick<Config, "googleClientId" | "googleClientSecret" | "googleUrls"> {
  const id = env.GOOGLE_CLIENT_ID?.trim() ?? "";
  const secret = env.GOOGLE_CLIENT_SECRET?.trim() ?? "";
  if ((id || secret) && !(id && secret)) {
    console.warn("Google Calendar is off: set both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET");
  }
  const url = (name: string, fallback: string): string => {
    const raw = env[name]?.trim() || fallback;
    try {
      const parsed = new URL(raw);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") return raw;
    } catch {
      /* falls through */
    }
    throw new Error(`${name} must be an http or https URL`);
  };
  return {
    googleClientId: id && secret ? id : null,
    googleClientSecret: id && secret ? secret : null,
    googleUrls: {
      auth: url("GOOGLE_OAUTH_AUTH_URL", "https://accounts.google.com/o/oauth2/v2/auth"),
      token: url("GOOGLE_OAUTH_TOKEN_URL", "https://oauth2.googleapis.com/token"),
      freebusy: url("GOOGLE_OAUTH_FREEBUSY_URL", "https://www.googleapis.com/calendar/v3/freeBusy"),
      revoke: url("GOOGLE_OAUTH_REVOKE_URL", "https://oauth2.googleapis.com/revoke"),
    },
  };
}
