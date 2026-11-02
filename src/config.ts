import path from "node:path";
import { assertTimeZone } from "./time.js";

export type VapidConfig = {
  publicKey: string;
  privateKey: string;
  subject: string;
};

export type Config = {
  port: number;
  dbPath: string;
  publicBaseUrl: string;
  vapid: VapidConfig | null;
  socialTtlMs: number;
  tz: string;
  /** Same note will not push again until this gap has passed. */
  renotifyMs: number;
  mapTileUrl: string;
  mapTileAttribution: string;
};

const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;
// CARTO Dark Matter's public raster CDN now returns an API-key watermark.
// Esri World Dark Gray is a no-key dark street map. Override both env vars
// to switch to CARTO, Stadia, or OpenFreeMap later.
const DEFAULT_MAP_TILE_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}";
const DEFAULT_MAP_TILE_ATTRIBUTION = "© Esri, HERE, Garmin, OpenStreetMap contributors";

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Config {
  const port = readPort(env.PORT);
  const dbPath = env.DB_PATH?.trim()
    ? path.resolve(cwd, env.DB_PATH.trim())
    : path.join(cwd, "data", "free-now.sqlite");
  const publicBaseUrl = readBaseUrl(env.PUBLIC_BASE_URL);
  const socialTtlMs = readTtl(env.SOCIAL_TTL_MS);
  const tz = (env.APP_TZ?.trim() || "UTC");
  assertTimeZone(tz);
  return {
    port,
    dbPath,
    publicBaseUrl,
    vapid: readVapid(env),
    socialTtlMs,
    tz,
    renotifyMs: 30_000,
    mapTileUrl: readTileUrl(env.MAP_TILE_URL),
    mapTileAttribution: readAttribution(env.MAP_TILE_ATTRIBUTION),
  };
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
