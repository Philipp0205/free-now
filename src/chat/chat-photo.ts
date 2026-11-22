import type http from "node:http";
import type { DatabaseSync } from "node:sqlite";
import type { AppDeps } from "../app.js";
import type { UserRow } from "../db.js";
import { readAvatarBody } from "../lib/avatar.js";
import { EVENT_PHOTO_MAX_BYTES, eventPhotoKind, sweepChatPhotos } from "../lib/event-photo.js";
import { HttpError, sendJson } from "../lib/http.js";
import { parseId, readRequestedCircle } from "../lib/validate.js";
import { postPhoto, readChatPhoto } from "./chat.js";

const UPLOAD_PATH = /^\/api\/(?:circles\/chat|(socials|plans)\/([^/]+)\/chat)\/photo$/;
const SERVE_PATH = /^\/api\/messages\/([^/]+)\/photo$/;

/** True for the chat photo upload routes and for GET /api/messages/:id/photo. */
export function isChatPhotoPath(pathname: string): boolean {
  return UPLOAD_PATH.test(pathname) || SERVE_PATH.test(pathname);
}

/** Drops chat photo files whose message is gone or deleted. Best effort: the next sweep retries a failure. */
export async function sweepOrphanChatPhotos(db: DatabaseSync, dir: string): Promise<void> {
  try {
    await sweepChatPhotos(dir, () => livePhotoIds(db));
  } catch {
    /* the hourly sweep tries again */
  }
}

function livePhotoIds(db: DatabaseSync): Set<string> {
  const rows = db.prepare("SELECT id FROM messages WHERE kind = 'photo' AND deleted_at IS NULL").all() as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}

/** Upload a photo into a chat, or serve one to someone in that chat. Read before the JSON body parser, like avatars. */
export async function handleChatPhoto(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: AppDeps,
  method: string,
  url: URL,
  me: UserRow,
): Promise<void> {
  try {
    const serve = SERVE_PATH.exec(url.pathname);
    if (serve) {
      if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "method not allowed");
      return await servePhoto(res, deps, method, me, parseId(serve[1]));
    }
    if (method !== "POST") throw new HttpError(405, "method not allowed");
    await uploadPhoto(req, res, deps, url, me);
  } catch (error) {
    req.resume();
    throw error;
  }
}

async function uploadPhoto(req: http.IncomingMessage, res: http.ServerResponse, deps: AppDeps, url: URL, me: UserRow): Promise<void> {
  const match = UPLOAD_PATH.exec(url.pathname);
  if (!match) throw new HttpError(404, "not found");
  const kind = match[1] === "socials" ? "social" : match[1] === "plans" ? "plan" : "circle";
  const refId = match[2] ? parseId(match[2]) : "";
  const data = await readAvatarBody(req, EVENT_PHOTO_MAX_BYTES);
  if (!data) throw new HttpError(413, "That photo is too big.");
  if (!eventPhotoKind(data)) throw new HttpError(415, "Send a JPEG, PNG or WebP photo.");
  const requested = readRequestedCircle(req, url, {});
  const replyTo = url.searchParams.get("replyTo");
  const chat = await postPhoto(deps, me.id, me.name, kind, refId, data, requested, replyTo);
  sendJson(res, 201, { chat });
}

async function servePhoto(res: http.ServerResponse, deps: AppDeps, method: string, me: UserRow, messageId: string): Promise<void> {
  const file = await readChatPhoto(deps, me.id, messageId);
  res.writeHead(200, {
    "content-type": file.mime,
    "content-length": file.data.length,
    "cache-control": "private, max-age=300",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  if (method === "HEAD") res.end();
  else res.end(file.data);
}
