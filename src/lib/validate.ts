import http from "node:http";
import { HttpError, firstHeader } from "./http.js";
import { isoDate, zonedDateTime } from "./time.js";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** GET /api/socials, /api/plans and /api/calendar-month with ?all=1 merge every circle the caller belongs to. */
export function isAllCircles(method: string, pathname: string, url: URL): boolean {
  return (
    method === "GET" &&
    (pathname === "/api/socials" || pathname === "/api/plans" || pathname === "/api/calendar-month") &&
    url.searchParams.get("all") === "1"
  );
}

export function readRequestedCircle(req: http.IncomingMessage, url: URL, body: Record<string, unknown>): string | null {
  const header = firstHeader(req.headers["x-circle"]);
  const fromBody = typeof body.circleId === "string" ? body.circleId : "";
  const raw = (header || url.searchParams.get("circle") || fromBody).trim();
  if (!raw) return null;
  return parseId(raw);
}

export function parseId(value: string): string {
  const id = decodeURIComponent(value).toLowerCase();
  if (!UUID_RE.test(id)) throw new HttpError(404, "not found");
  return id;
}

export function cleanLabel(value: unknown, label: string, max: number): string {
  if (typeof value !== "string") throw new HttpError(400, `${label} is required`);
  const text = value.replace(/[\u0000-\u001f]/g, "").trim();
  if (text.length < 1 || text.length > max) {
    throw new HttpError(400, `${label} must be 1–${max} characters`);
  }
  return text;
}

/** ~100 m for a GPS reading. An explicitly chosen place keeps finer coordinates. Undefined means the client did not mention location. */
export function readPoint(body: Record<string, unknown>): { lat: number; lng: number } | null | undefined {
  const hasLat = Object.prototype.hasOwnProperty.call(body, "lat");
  const hasLng = Object.prototype.hasOwnProperty.call(body, "lng");
  if (!hasLat && !hasLng) return undefined;
  if (body.lat == null && body.lng == null) return null;
  if (!hasLat || !hasLng || body.lat == null || body.lng == null) {
    throw new HttpError(400, "lat and lng are both required");
  }
  const precise = body.precise === true;
  const lat = roundCoord(body.lat, "lat", precise ? 6 : 3);
  const lng = roundCoord(body.lng, "lng", precise ? 6 : 3);
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) throw new HttpError(400, "location is out of range");
  return { lat, lng };
}

/** Undefined keeps a scheduled start. Null means free right now. A clock time is later today in APP_TZ. */
export function readStart(body: Record<string, unknown>, now: number, tz: string): number | null | undefined {
  if (body.later === true && body.startsAt == null && body.startsInMin == null) {
    throw new HttpError(400, "Pick a time later today.");
  }
  if (!Object.prototype.hasOwnProperty.call(body, "startsAt") && !Object.prototype.hasOwnProperty.call(body, "startsInMin")) {
    return undefined;
  }
  if (body.startsInMin != null) {
    const minutes = Number(body.startsInMin);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 18 * 60) {
      throw new HttpError(400, "Pick a time later today.");
    }
    return assertLaterToday(now + minutes * 60 * 1000, now, tz);
  }
  if (body.startsAt == null) return null;
  if (typeof body.startsAt === "string") {
    if (!/^\d{2}:\d{2}$/.test(body.startsAt)) throw new HttpError(400, "Pick a time later today.");
    try {
      return assertLaterToday(zonedDateTime(isoDate(now, tz), body.startsAt, tz), now, tz);
    } catch {
      throw new HttpError(400, "Pick a time later today.");
    }
  }
  const instant = Number(body.startsAt);
  if (!Number.isFinite(instant)) throw new HttpError(400, "Pick a time later today.");
  return assertLaterToday(instant, now, tz);
}

export function readClock(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) throw new HttpError(400, "Pick a valid time, like 19:30");
  const hour = Number(value.slice(0, 2));
  const minute = Number(value.slice(3, 5));
  if (hour > 23 || minute > 59) throw new HttpError(400, "Pick a valid time, like 19:30");
  return value;
}

function assertLaterToday(instant: number, now: number, tz: string): number {
  if (instant <= now) throw new HttpError(400, "Pick a time later today.");
  if (isoDate(instant, tz) !== isoDate(now, tz)) throw new HttpError(400, "Pick a time later today.");
  return instant;
}

export function readPlace(body: Record<string, unknown>): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(body, "place")) return undefined;
  return cleanPlace(body.place);
}

function roundCoord(value: unknown, label: string, digits: number): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) throw new HttpError(400, `${label} is not a number`);
  const scale = 10 ** digits;
  return Math.round(number * scale) / scale;
}

export function cleanPlace(value: unknown): string {
  if (value == null || value === "") return "";
  if (typeof value !== "string") throw new HttpError(400, "place must be a string");
  const place = value.replace(/[\r\n\t]+/g, " ").replace(/[\u0000-\u001f]/g, "").trim();
  if (place.length > 80) throw new HttpError(400, "place is too long (80)");
  return place;
}

export function cleanNote(value: unknown, required: boolean): string {
  if (value == null || value === "") {
    if (required) throw new HttpError(400, "note is required");
    return "";
  }
  if (typeof value !== "string") throw new HttpError(400, "note must be a string");
  const note = value.replace(/[\r\n\t]+/g, " ").replace(/[\u0000-\u001f]/g, "").trim();
  if (note.length > 80) throw new HttpError(400, "note is too long (80)");
  if (required && note.length === 0) throw new HttpError(400, "note is required");
  return note;
}

/** Plain text, one line, at most 280 characters. Longer text is cut, not refused. */
export function cleanDescription(value: unknown): string {
  if (value == null || value === "") return "";
  if (typeof value !== "string") throw new HttpError(400, "description must be a string");
  const text = value.replace(/[\r\n\t]+/g, " ").replace(/[\u0000-\u001f\u007f]/g, "").replace(/ {2,}/g, " ").trim();
  return text.slice(0, 280).trim();
}

export function cleanCode(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "invite code is required");
  const code = value.toUpperCase().replace(/[^A-Z2-9]/g, "");
  if (code.length < 4 || code.length > 12) throw new HttpError(400, "invite code is not valid");
  return code;
}

export function cleanSubscription(body: Record<string, unknown>): { endpoint: string; p256dh: string; auth: string } {
  if (typeof body.endpoint !== "string" || body.endpoint.length > 2000) {
    throw new HttpError(400, "invalid push endpoint");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(body.endpoint);
  } catch {
    throw new HttpError(400, "invalid push endpoint");
  }
  const local = endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1";
  if (endpoint.protocol !== "https:" && !local) throw new HttpError(400, "push endpoint must be https");
  const keys = body.keys;
  if (!keys || typeof keys !== "object") throw new HttpError(400, "invalid push keys");
  const p256dh = (keys as { p256dh?: unknown }).p256dh;
  const auth = (keys as { auth?: unknown }).auth;
  if (
    typeof p256dh !== "string" ||
    typeof auth !== "string" ||
    p256dh.length < 1 ||
    auth.length < 1 ||
    p256dh.length > 256 ||
    auth.length > 256
  ) {
    throw new HttpError(400, "invalid push keys");
  }
  return { endpoint: body.endpoint, p256dh, auth };
}
