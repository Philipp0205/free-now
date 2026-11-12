import crypto from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";

/** The client sends ≤50 KB. A little headroom, nothing more. */
export const AVATAR_MAX_BYTES = 80 * 1024;

type AvatarKind = { ext: ".webp" | ".jpg"; mime: "image/webp" | "image/jpeg" };

const WEBP: AvatarKind = { ext: ".webp", mime: "image/webp" };
const JPEG: AvatarKind = { ext: ".jpg", mime: "image/jpeg" };

/** By magic bytes only: RIFF….WEBP or FF D8 FF. Anything else is not a photo we keep. */
export function avatarKind(data: Buffer): AvatarKind | null {
  if (data.length >= 12 && data.toString("latin1", 0, 4) === "RIFF" && data.toString("latin1", 8, 12) === "WEBP") return WEBP;
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return JPEG;
  return null;
}

export function avatarMime(data: Buffer): string | null {
  return avatarKind(data)?.mime ?? null;
}

/** The raw body, or null once it passes `max` (the rest is drained, not kept). */
export function readAvatarBody(req: http.IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > max) {
      req.resume();
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > max) {
        done = true;
        chunks.length = 0;
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!done) resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

function fileFor(dir: string, userId: string, kind: AvatarKind): string {
  return path.join(dir, `${userId}${kind.ext}`);
}

/** Temp file, then rename, so a reader never sees half a photo. The other format is removed after. */
export async function writeAvatarFile(dir: string, userId: string, data: Buffer): Promise<void> {
  const kind = avatarKind(data);
  if (!kind) throw new Error("not a WebP or JPEG");
  await fs.promises.mkdir(dir, { recursive: true });
  const target = fileFor(dir, userId, kind);
  const temp = path.join(dir, `.${userId}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  await fs.promises.writeFile(temp, data);
  try {
    await fs.promises.rename(temp, target);
  } catch (error) {
    await fs.promises.rm(temp, { force: true });
    throw error;
  }
  const other = kind === WEBP ? JPEG : WEBP;
  await fs.promises.rm(fileFor(dir, userId, other), { force: true });
}

export async function removeAvatarFile(dir: string, userId: string): Promise<void> {
  await fs.promises.rm(fileFor(dir, userId, WEBP), { force: true });
  await fs.promises.rm(fileFor(dir, userId, JPEG), { force: true });
}

export async function avatarFile(dir: string, userId: string): Promise<{ data: Buffer; mime: string } | null> {
  for (const kind of [WEBP, JPEG]) {
    try {
      const data = await fs.promises.readFile(fileFor(dir, userId, kind));
      return { data, mime: kind.mime };
    } catch {
      /* try the next one */
    }
  }
  return null;
}
