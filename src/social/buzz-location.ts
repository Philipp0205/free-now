import { readPoint } from "../lib/validate.js";

export type BuzzPoint = { lat: number; lng: number };

const PAIRS: Array<[string, string]> = [["lat", "lng"], ["latitude", "longitude"]];
const PREFIXES = ["", "x-", "flic-", "x-flic-"];
const COMBINED = ["location", "gps"];

/** Rounds and range checks like the app does. Anything unusable is null, never an error. */
function point(lat: unknown, lng: unknown): BuzzPoint | null {
  const usable = (value: unknown) => (typeof value === "number" && Number.isFinite(value)) || (typeof value === "string" && value.trim() !== "");
  if (!usable(lat) || !usable(lng)) return null;
  try {
    return readPoint({ lat: typeof lat === "string" ? lat.trim() : lat, lng: typeof lng === "string" ? lng.trim() : lng }) ?? null;
  } catch {
    return null;
  }
}

/** "lat,lng", "lat;lng" or "lat lng" as one string. */
function fromText(value: unknown): BuzzPoint | null {
  if (typeof value !== "string") return null;
  const parts = value.trim().split(/\s*[,;]\s*|\s+/);
  return parts.length === 2 ? point(parts[0], parts[1]) : null;
}

/** A body or header value shaped as {lat,lng}, {latitude,longitude} or "lat,lng". */
function fromValue(value: unknown): BuzzPoint | null {
  if (typeof value === "string") return fromText(value);
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const [a, b] of PAIRS) {
    const found = point(record[a], record[b]);
    if (found) return found;
  }
  return null;
}

function fromPairs(read: (key: string) => unknown): BuzzPoint | null {
  for (const prefix of PREFIXES) {
    for (const [a, b] of PAIRS) {
      const found = point(read(prefix + a), read(prefix + b));
      if (found) return found;
    }
    for (const key of COMBINED) {
      const found = fromText(read(prefix + key));
      if (found) return found;
    }
  }
  return null;
}

/** Where a Flic press happened: body, then query, then headers. Null when nothing usable came along. */
export function readBuzzPoint(
  body: Record<string, unknown>,
  query: URLSearchParams,
  headers: Record<string, string | string[] | undefined>,
): BuzzPoint | null {
  for (const [a, b] of PAIRS) {
    const found = point(body[a], body[b]);
    if (found) return found;
  }
  const inBody = fromValue(body.location);
  if (inBody) return inBody;
  const inQuery = fromPairs((key) => query.get(key));
  if (inQuery) return inQuery;
  return fromPairs((key) => {
    const value = headers[key];
    return Array.isArray(value) ? value[0] : value;
  });
}

/** Header names and body keys only, so prod logs show Flic's real format without any value, token or path. */
export function describeBuzzRequest(body: Record<string, unknown>, headers: Record<string, unknown>): string {
  return `flic press without location headers=[${Object.keys(headers).sort().join(",")}] body=[${Object.keys(body).sort().join(",")}]`;
}
