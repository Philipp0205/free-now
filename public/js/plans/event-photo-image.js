import { PHOTO_COPY } from "./event-photo-copy.js";

/** Long edge of a stored cover photo, and the byte budget the server expects (it accepts up to 600 KB). */
export const PHOTO_EDGE = 1600;
export const PHOTO_MAX_BYTES = 400 * 1024;

/** The size that fits `max` on the long edge. Never enlarges. */
export function fitEdge(width, height, max) {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

async function decode(file) {
  if ("createImageBitmap" in window) {
    try {
      return await createImageBitmap(file);
    } catch {
      /* fall back to <img> */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function canvasBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** WebP where the browser can encode it, else JPEG. Lowers the quality until it fits, or returns null. */
async function encode(canvas) {
  for (const type of ["image/webp", "image/jpeg"]) {
    let quality = 0.82;
    let blob = await canvasBlob(canvas, type, quality);
    if (!blob || blob.type !== type) continue;
    while (blob && blob.size > PHOTO_MAX_BYTES && quality > 0.4) {
      quality -= 0.1;
      blob = await canvasBlob(canvas, type, quality);
    }
    if (blob && blob.size <= PHOTO_MAX_BYTES) return blob;
  }
  return null;
}

function looksLikeHeic(file) {
  return /hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name || "");
}

/** Decodes the picked file. A HEIC the browser cannot read gets its own message. */
async function readPicked(file) {
  try {
    const image = await decode(file);
    const width = image.width || image.naturalWidth;
    const height = image.height || image.naturalHeight;
    if (!width || !height) throw new Error("empty");
    return { image, width, height };
  } catch {
    throw new Error(looksLikeHeic(file) ? PHOTO_COPY.heic : PHOTO_COPY.unreadable);
  }
}

/** Draws the image on a white canvas (so a transparent PNG does not turn black as a JPEG). */
function drawScaled(source, edge) {
  const size = fitEdge(source.width, source.height, edge);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, size.width, size.height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source.image, 0, 0, size.width, size.height);
  return canvas;
}

/** A picked photo as a WebP or JPEG blob: long edge at most 1600 px, at most 400 KB. Throws a friendly Error. */
export async function compressPhoto(file) {
  const source = await readPicked(file);
  try {
    let edge = PHOTO_EDGE;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const blob = await encode(drawScaled(source, edge));
      if (blob) return blob;
      edge = Math.round(edge * 0.75);
    }
    throw new Error(PHOTO_COPY.tooBig);
  } finally {
    source.image.close?.();
  }
}
