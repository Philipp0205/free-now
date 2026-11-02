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
};

const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;

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
