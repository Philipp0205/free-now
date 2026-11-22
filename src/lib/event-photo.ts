import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { EventKind } from "../db.js";

/** The client sends about 400 KB at most. A little headroom, nothing more. */
export const EVENT_PHOTO_MAX_BYTES = 600 * 1024;

export type EventPhotoKind = { ext: ".jpg" | ".png" | ".webp"; mime: "image/jpeg" | "image/png" | "image/webp" };

const JPEG: EventPhotoKind = { ext: ".jpg", mime: "image/jpeg" };
const PNG: EventPhotoKind = { ext: ".png", mime: "image/png" };
const WEBP: EventPhotoKind = { ext: ".webp", mime: "image/webp" };
const KINDS = [JPEG, PNG, WEBP];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const FILE_RE = /^(social|plan)-([0-9a-f-]{36})\.(jpg|png|webp)$/;

/** By magic bytes only: JPEG, PNG or RIFF....WEBP. SVG, GIF and anything else is not a photo we keep. */
export function eventPhotoKind(data: Buffer): EventPhotoKind | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return JPEG;
  if (data.length >= 8 && PNG_MAGIC.every((byte, index) => data[index] === byte)) return PNG;
  if (data.length >= 12 && data.toString("latin1", 0, 4) === "RIFF" && data.toString("latin1", 8, 12) === "WEBP") return WEBP;
  return null;
}

function fileFor(dir: string, kind: EventKind, id: string, type: EventPhotoKind): string {
  return path.join(dir, `${kind}-${id}${type.ext}`);
}

/** Temp file, then rename, so a reader never sees half a photo. The other formats are removed after. */
export async function writeEventPhoto(dir: string, kind: EventKind, id: string, data: Buffer): Promise<void> {
  const type = eventPhotoKind(data);
  if (!type) throw new Error("not a JPEG, PNG or WebP");
  await fs.promises.mkdir(dir, { recursive: true });
  const temp = path.join(dir, `.${kind}-${id}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  await fs.promises.writeFile(temp, data);
  try {
    await fs.promises.rename(temp, fileFor(dir, kind, id, type));
  } catch (error) {
    await fs.promises.rm(temp, { force: true });
    throw error;
  }
  for (const other of KINDS) if (other !== type) await fs.promises.rm(fileFor(dir, kind, id, other), { force: true });
}

export async function removeEventPhoto(dir: string, kind: EventKind, id: string): Promise<void> {
  for (const type of KINDS) await fs.promises.rm(fileFor(dir, kind, id, type), { force: true });
}

export async function readEventPhoto(dir: string, kind: EventKind, id: string): Promise<{ data: Buffer; mime: string } | null> {
  for (const type of KINDS) {
    try {
      return { data: await fs.promises.readFile(fileFor(dir, kind, id, type)), mime: type.mime };
    } catch {
      /* try the next format */
    }
  }
  return null;
}

/** A file this young may belong to an upload whose revision is not saved yet, so the sweep leaves it. */
export const SWEEP_GRACE_MS = 30_000;

/** Deletes files whose event is gone or has no photo any more. Returns how many it removed. Never throws. */
export async function sweepEventPhotos(dir: string, keep: Record<EventKind, Set<string>>, now = Date.now()): Promise<number> {
  let names: string[] = [];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const match = FILE_RE.exec(name);
    if (!match || keep[match[1] as EventKind].has(match[2])) continue;
    try {
      const file = path.join(dir, name);
      if (now - (await fs.promises.stat(file)).mtimeMs < SWEEP_GRACE_MS) continue;
      await fs.promises.rm(file, { force: true });
      removed += 1;
    } catch {
      /* the next sweep tries again */
    }
  }
  return removed;
}
