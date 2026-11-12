import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { setTimeout as sleep } from "node:timers/promises";
import type { Config } from "../config.js";
import { readPmtilesHeader, type PmtilesInfo } from "./pmtiles.js";

/** Hard cap on a downloaded archive. Bigger is aborted and the partial file deleted. */
export const PMTILES_DOWNLOAD_MAX_BYTES = 1024 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * Where the archive should live, its expected sha256, where to fetch it when it is not there, and
 * an optional bearer token for that URL (private GitHub release assets). The token is a secret:
 * it only ever goes into an Authorization header, never into a URL or a log line.
 */
export type PmtilesSource = { path: string; sha256: string; url: string | null; token: string | null };

export type PmtilesFetchTuning = {
  attempts: number;
  /** First retry waits this long, then doubles. */
  baseDelayMs: number;
  maxBytes: number;
  /** Abort an attempt when no bytes arrive for this long. */
  idleTimeoutMs: number;
  /** Tests only: let plain http through, for a local http.createServer. */
  allowHttp: boolean;
  log: Pick<Console, "log" | "warn">;
};

const DEFAULTS: PmtilesFetchTuning = {
  attempts: 4,
  baseDelayMs: 2000,
  maxBytes: PMTILES_DOWNLOAD_MAX_BYTES,
  idleTimeoutMs: 60_000,
  allowHttp: false,
  log: console,
};

/** Not worth another attempt: the same bytes would fail the same way. */
class FatalError extends Error {}

/** Origin and path only: release asset redirects carry signatures in the query string. */
export function safeUrl(url: URL | string): string {
  try {
    const parsed = typeof url === "string" ? new URL(url) : url;
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "(invalid url)";
  }
}

/** Headers for one hop. Authorization only when this hop may carry the token. */
export function pmtilesRequestHeaders(url: URL, token: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    // GitHub's release asset API answers JSON metadata unless asked for the bytes.
    accept: url.hostname.toLowerCase() === "api.github.com" ? "application/octet-stream" : "*/*",
    "accept-encoding": "identity",
    "user-agent": "hangry-pmtiles-fetch",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

/** Keeps the token out of every line, whatever a URL or an error message happens to contain. */
function redactingLog(log: Pick<Console, "log" | "warn">, token: string | null): Pick<Console, "log" | "warn"> {
  if (!token) return log;
  const clean = (line: string): string => String(line).split(token).join("[redacted]");
  return { log: (line: string) => log.log(clean(line)), warn: (line: string) => log.warn(clean(line)) };
}

function reasonOf(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: unknown }).cause;
  return cause instanceof Error && cause.message ? `${error.message}: ${cause.message}` : error.message;
}

/**
 * Background half of MAP_PMTILES_SHA256 / MAP_PMTILES_URL. Uses the file at the path when it is a
 * valid v3 archive with the expected sha256; otherwise downloads it (when a URL is set). On success
 * sets config.mapPmtiles, which the app reads per request, so the vector map turns on without a
 * restart. Never rejects. Null when there is nothing to do.
 */
export function startPmtilesFetch(config: Config, tuning: Partial<PmtilesFetchTuning> = {}): Promise<PmtilesInfo | null> | null {
  const source = config.mapPmtilesSource;
  if (!source) return null;
  return ensurePmtiles(source, (info) => { config.mapPmtiles = info; }, tuning);
}

export async function ensurePmtiles(
  source: PmtilesSource,
  onReady: (info: PmtilesInfo) => void,
  tuning: Partial<PmtilesFetchTuning> = {},
): Promise<PmtilesInfo | null> {
  const o = { ...DEFAULTS, ...tuning };
  o.log = redactingLog(o.log, source.token);
  try {
    const present = await checkPresent(source.path, source.sha256);
    if (present.ok) {
      onReady(present.info);
      o.log.log(`PMTiles archive verified (sha256 ok): ${source.path}`);
      return present.info;
    }
    if (!source.url) {
      o.log.warn(`MAP_PMTILES_PATH disabled (${present.reason}), keeping the raster basemap: ${source.path}`);
      return null;
    }
    o.log.log(`PMTiles archive not usable (${present.reason}); downloading in the background from ${safeUrl(source.url)}`);
    return await download(source.url, source, onReady, o);
  } catch (error) {
    o.log.warn(`PMTiles setup failed (${reasonOf(error)}), keeping the raster basemap`);
    return null;
  }
}

async function checkPresent(file: string, sha256: string): Promise<{ ok: true; info: PmtilesInfo } | { ok: false; reason: string }> {
  try {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile()) return { ok: false, reason: "not a file" };
    const info = readPmtilesHeader(file);
    const got = await hashFile(file);
    if (got !== sha256) return { ok: false, reason: `sha256 mismatch, got ${got}` };
    return { ok: true, info };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, reason: code === "ENOENT" ? "missing" : reasonOf(error) };
  }
}

async function hashFile(file: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest("hex");
}

function tempPrefix(target: string): string {
  return `.${path.basename(target)}.`;
}

/** Partial downloads from a run that was killed mid-way. */
async function removeStaleTemps(target: string): Promise<void> {
  const dir = path.dirname(target);
  const prefix = tempPrefix(target);
  for (const name of await fs.promises.readdir(dir)) {
    if (name.startsWith(prefix) && name.endsWith(".download")) {
      await fs.promises.rm(path.join(dir, name), { force: true });
    }
  }
}

async function download(
  rawUrl: string,
  source: PmtilesSource,
  onReady: (info: PmtilesInfo) => void,
  o: PmtilesFetchTuning,
): Promise<PmtilesInfo | null> {
  const url = new URL(rawUrl);
  assertAllowed(url, o.allowHttp);
  const target = source.path;
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await removeStaleTemps(target).catch(() => {});
  for (let attempt = 1; attempt <= o.attempts; attempt++) {
    const tmp = path.join(path.dirname(target), `${tempPrefix(target)}${process.pid}-${crypto.randomBytes(4).toString("hex")}.download`);
    try {
      const got = await downloadOnce(url, source.token, tmp, o);
      if (got !== source.sha256) throw new FatalError(`sha256 mismatch, got ${got}`);
      try {
        readPmtilesHeader(tmp);
      } catch (error) {
        throw new FatalError(`not a usable PMTiles v3 archive: ${reasonOf(error)}`);
      }
      await fs.promises.rename(tmp, target);
      const info = readPmtilesHeader(target);
      onReady(info);
      o.log.log(`PMTiles archive downloaded and enabled: ${target}`);
      return info;
    } catch (error) {
      await fs.promises.rm(tmp, { force: true }).catch(() => {});
      const fatal = error instanceof FatalError;
      const last = fatal || attempt === o.attempts;
      o.log.warn(`PMTiles download attempt ${attempt}/${o.attempts} failed: ${reasonOf(error)}${fatal ? " (not retrying)" : ""}`);
      if (last) break;
      await sleep(o.baseDelayMs * 2 ** (attempt - 1));
    }
  }
  o.log.warn(`PMTiles download gave up, keeping the raster basemap: ${safeUrl(url)}`);
  return null;
}

function assertAllowed(url: URL, allowHttp: boolean): void {
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    throw new FatalError(`refusing non-https URL ${safeUrl(url)}`);
  }
  if (url.username || url.password) throw new FatalError("refusing a URL with credentials");
}

/** Streams one attempt into tmp and returns the sha256 of what arrived. */
async function downloadOnce(start: URL, token: string | null, tmp: string, o: PmtilesFetchTuning): Promise<string> {
  const controller = new AbortController();
  let idle: NodeJS.Timeout | undefined;
  const arm = (): void => {
    clearTimeout(idle);
    idle = setTimeout(() => controller.abort(new Error(`no data for ${o.idleTimeoutMs} ms`)), o.idleTimeoutMs);
  };
  arm();
  try {
    const response = await follow(start, token, controller.signal, o.allowHttp);
    const declared = Number(response.headers.get("content-length") ?? NaN);
    if (Number.isFinite(declared) && declared > o.maxBytes) {
      throw new FatalError(`file is ${declared} bytes, over the ${o.maxBytes} byte cap`);
    }
    if (!response.body) throw new Error("response has no body");
    const hash = crypto.createHash("sha256");
    let total = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        total += chunk.length;
        if (total > o.maxBytes) {
          done(new FatalError(`download passed the ${o.maxBytes} byte cap`));
          return;
        }
        hash.update(chunk);
        arm();
        done(null, chunk);
      },
    });
    const body = Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>);
    await pipeline(body, meter, fs.createWriteStream(tmp, { flags: "wx", mode: 0o644 }));
    return hash.digest("hex");
  } finally {
    clearTimeout(idle);
    controller.abort();
  }
}

/**
 * Follows redirects by hand so every hop is checked for https. The token goes to the first host
 * only: once a redirect leaves that host (GitHub sends asset downloads to a signed
 * objects.githubusercontent.com URL) it is dropped for good, even if a later hop comes back.
 */
async function follow(start: URL, token: string | null, signal: AbortSignal, allowHttp: boolean): Promise<Response> {
  let current = start;
  let auth = token;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    assertAllowed(current, allowHttp);
    const response = await fetch(current, { redirect: "manual", signal, headers: pmtilesRequestHeaders(current, auth) });
    if (REDIRECTS.has(response.status)) {
      await response.body?.cancel().catch(() => {});
      const location = response.headers.get("location");
      if (!location) throw new Error(`HTTP ${response.status} redirect without Location`);
      const next = new URL(location, current);
      if (next.host.toLowerCase() !== current.host.toLowerCase() || next.protocol !== current.protocol) auth = null;
      current = next;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const retry = response.status >= 500 || response.status === 408 || response.status === 429;
      const message = `HTTP ${response.status} from ${safeUrl(current)}`;
      throw retry ? new Error(message) : new FatalError(message);
    }
    return response;
  }
  throw new FatalError(`more than ${MAX_REDIRECTS} redirects`);
}
