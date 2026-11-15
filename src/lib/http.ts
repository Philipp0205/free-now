import http from "node:http";
import type { Config } from "../config.js";
import { HttpError as KitHttpError, SECURITY_HEADERS, readJson as kitReadJson, sendEmpty, sendJson } from "../app-kit/http.ts";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Extra fields for the JSON error body, for example retryAt on a 429. */
    public extra: Record<string, unknown> = {},
    /** Extra response headers, for example Retry-After on a 429. */
    public headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

/** Same limit as before: a JSON body over 32 KiB is a 413. */
const JSON_MAX_BYTES = 32_768;

/**
 * The kit reads the body. Its errors are the kit's own HttpError, which the app's error handler
 * does not know, so they are turned into Hangry's HttpError here (same status, same message).
 */
export async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  try {
    return await kitReadJson(req, { max: JSON_MAX_BYTES });
  } catch (error) {
    if (error instanceof KitHttpError) throw new HttpError(error.status, error.message);
    throw error;
  }
}

export { sendEmpty, sendJson };

/** Static docs: same bytes for everyone, no session, no user data. */
export function sendPublic(req: http.IncomingMessage, res: http.ServerResponse, type: string, text: string): void {
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "content-type": type,
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-cache",
  });
  if (req.method === "HEAD") res.end();
  else res.end(text);
}

export function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

export function requestOrigin(req: http.IncomingMessage, config: Config): string {
  if (config.publicBaseUrl) return config.publicBaseUrl;
  const forwardedProto = firstHeader(req.headers["x-forwarded-proto"]);
  const forwardedHost = firstHeader(req.headers["x-forwarded-host"]);
  const proto = forwardedProto === "https" ? "https" : "http";
  const host = safeHost(forwardedHost || firstHeader(req.headers.host) || "localhost");
  return `${proto}://${host}`;
}

export function firstHeader(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function safeHost(host: string): string {
  const trimmed = host.split(",")[0]?.trim() ?? "";
  if (/^[A-Za-z0-9.-]+(?::\d+)?$/.test(trimmed)) return trimmed;
  return "localhost";
}

export function matchPath(pathname: string, pattern: RegExp): RegExpExecArray | null {
  return pattern.exec(pathname);
}
