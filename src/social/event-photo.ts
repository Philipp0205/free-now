import type http from "node:http";
import type { DatabaseSync } from "node:sqlite";
import type { AppDeps } from "../app.js";
import { sweepOrphanChatPhotos } from "../chat/chat-photo.js";
import { type UserRow, bumpEventPhotoRev, clearEventPhotoRev, listEventsWithPhoto } from "../db.js";
import { readAvatarBody } from "../lib/avatar.js";
import {
  EVENT_PHOTO_MAX_BYTES,
  eventPhotoKind,
  readEventPhoto,
  removeEventPhoto,
  sweepEventPhotos,
  writeEventPhoto,
} from "../lib/event-photo.js";
import { HttpError, firstHeader, sendJson } from "../lib/http.js";
import { parseId } from "../lib/validate.js";
import { canViewEventPhoto, loadEvent } from "./event-photo-access.js";
import type { EventKind } from "./visibility.js";

const PHOTO_PATH = /^\/api\/(socials|plans)\/([^/]+)\/photo$/;

/** True for /api/socials/:id/photo and /api/plans/:id/photo. */
export function isEventPhotoPath(pathname: string): boolean {
  return PHOTO_PATH.test(pathname);
}

type Target = { kind: EventKind; id: string; hostId: string; rev: number | null };

/** The event for this caller, or a 404 for a missing event and for one they cannot see. Never a 403 here. */
function findTarget(deps: AppDeps, pathname: string, me: UserRow): Target {
  const match = PHOTO_PATH.exec(pathname);
  if (!match) throw new HttpError(404, "not found");
  const kind: EventKind = match[1] === "socials" ? "social" : "plan";
  const event = loadEvent(deps.db, kind, parseId(match[2]));
  if (!event || !canViewEventPhoto(deps.db, kind, event, me.id)) throw new HttpError(404, "not found");
  return { kind, id: event.id, hostId: event.creator_id, rev: event.photo_rev ?? null };
}

/** Drops photo files whose event row is gone or lost its photo, and chat photos whose message is gone. Best effort: a failure is retried by the next sweep. */
export async function sweepOrphanPhotos(db: DatabaseSync, dir: string): Promise<void> {
  try {
    await sweepEventPhotos(dir, { social: listEventsWithPhoto(db, "social"), plan: listEventsWithPhoto(db, "plan") });
  } catch {
    /* the hourly sweep tries again */
  }
  await sweepOrphanChatPhotos(db, dir);
}

/** Upload, replace, serve or remove an event's cover photo. Read before the JSON body parser, like avatars. */
export async function handleEventPhoto(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: AppDeps,
  method: string,
  pathname: string,
  me: UserRow,
): Promise<void> {
  try {
    const target = findTarget(deps, pathname, me);
    if (method === "GET" || method === "HEAD") return await servePhoto(req, res, deps, method, target);
    if (method !== "PUT" && method !== "POST" && method !== "DELETE") throw new HttpError(405, "method not allowed");
    if (target.hostId !== me.id) throw new HttpError(403, "Only the host can change the photo.");
    if (method === "DELETE") return await removePhoto(res, deps, target);
    await storePhoto(req, res, deps, target);
  } catch (error) {
    req.resume();
    throw error;
  }
}

async function storePhoto(req: http.IncomingMessage, res: http.ServerResponse, deps: AppDeps, target: Target): Promise<void> {
  const data = await readAvatarBody(req, EVENT_PHOTO_MAX_BYTES);
  if (!data) throw new HttpError(413, "That photo is too big.");
  if (!eventPhotoKind(data)) throw new HttpError(415, "Send a JPEG, PNG or WebP photo.");
  await writeEventPhoto(deps.config.eventPhotosDir, target.kind, target.id, data);
  const photoRev = bumpEventPhotoRev(deps.db, target.kind, target.id, deps.now());
  sendJson(res, 200, { photoRev });
}

async function removePhoto(res: http.ServerResponse, deps: AppDeps, target: Target): Promise<void> {
  await removeEventPhoto(deps.config.eventPhotosDir, target.kind, target.id);
  clearEventPhotoRev(deps.db, target.kind, target.id);
  sendJson(res, 200, { photoRev: null });
}

async function servePhoto(req: http.IncomingMessage, res: http.ServerResponse, deps: AppDeps, method: string, target: Target): Promise<void> {
  const file = target.rev ? await readEventPhoto(deps.config.eventPhotosDir, target.kind, target.id) : null;
  if (!file) throw new HttpError(404, "not found");
  const etag = `"${target.rev}"`;
  const headers: http.OutgoingHttpHeaders = {
    "content-type": file.mime,
    "cache-control": "private, max-age=300",
    etag,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
  if (firstHeader(req.headers["if-none-match"]) === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(200, { ...headers, "content-length": file.data.length });
  if (method === "HEAD") res.end();
  else res.end(file.data);
}
