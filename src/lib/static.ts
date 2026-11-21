import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRange } from "../map/range-file.js";
import { sendJson } from "./http.js";

/** The repo root (or /app in the image). Same depth under tsx (src/lib) and node (dist/lib). */
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** `npm run build` writes the bundled client here, next to the server in dist/. */
export const CLIENT_DIR = path.join(ROOT_DIR, "dist", "client");

/** The built client when there is one, else the raw sources in public/ (npm start before any build). */
export const PUBLIC_DIR = fs.existsSync(path.join(CLIENT_DIR, "index.html")) ? CLIENT_DIR : path.join(ROOT_DIR, "public");

/** Leaflet and protomaps-leaflet under /vendor: a week, then checked again. */
const VENDOR_CACHE = "public, max-age=604800";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
  ".m4a": "audio/mp4",
};

export async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<void> {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendJson(res, 400, { error: "bad path" });
    return;
  }
  if (decoded.includes("\0")) {
    sendJson(res, 400, { error: "bad path" });
    return;
  }
  const rel = decoded.replace(/^\/+/, "");
  const filePath = path.resolve(PUBLIC_DIR, rel);
  const relative = path.relative(PUBLIC_DIR, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const ext = path.extname(relative);
  if (ext) {
    try {
      const data = await fs.promises.readFile(filePath);
      const headers = staticHeaders(ext, data.length);
      // Third-party files at a fixed version. A new version gets a new path.
      if (relative.startsWith(`vendor${path.sep}`)) headers["cache-control"] = VENDOR_CACHE;
      // The emoji picker asks for an ETag before it re-downloads its data (assets/ holds only that one file).
      if (relative.startsWith(`assets${path.sep}`)) headers.etag = `"${crypto.createHash("sha1").update(data).digest("base64")}"`;
      const { status, body } = sliceForRange(req, ext, data, headers);
      res.writeHead(status, headers);
      res.end(req.method === "HEAD" ? undefined : body);
    } catch {
      sendJson(res, 404, { error: "not found" });
    }
    return;
  }
  try {
    const data = await fs.promises.readFile(path.join(PUBLIC_DIR, "index.html"));
    res.writeHead(200, staticHeaders(".html", data.length));
    if (req.method === "HEAD") res.end();
    else res.end(data);
  } catch {
    sendJson(res, 404, { error: "not found" });
  }
}

/** Audio answers byte ranges, because iOS media elements ask for them: 206 slice, 416 if unsatisfiable, else the whole file. */
function sliceForRange(
  req: http.IncomingMessage,
  ext: string,
  data: Buffer,
  headers: http.OutgoingHttpHeaders,
): { status: number; body: Buffer } {
  if (ext !== ".m4a") return { status: 200, body: data };
  headers["accept-ranges"] = "bytes";
  const raw = req.headers.range;
  const range = parseRange(Array.isArray(raw) ? raw[0] : raw, data.length);
  if (range === null) return { status: 200, body: data };
  if (range === "invalid") {
    headers["content-range"] = `bytes */${data.length}`;
    headers["content-length"] = 0;
    return { status: 416, body: Buffer.alloc(0) };
  }
  headers["content-range"] = `bytes ${range.start}-${range.end}/${data.length}`;
  headers["content-length"] = range.end - range.start + 1;
  return { status: 206, body: data.subarray(range.start, range.end + 1) };
}

/** The public landing page. Static: same bytes for everyone, no session, no user data. */
export async function serveWelcome(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const data = await fs.promises.readFile(path.join(PUBLIC_DIR, "welcome.html"));
  res.writeHead(200, staticHeaders(".html", data.length));
  if (req.method === "HEAD") res.end();
  else res.end(data);
}

/** The public privacy policy. Static like /welcome: same bytes for everyone, no session, no user data. */
export async function servePrivacy(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const data = await fs.promises.readFile(path.join(PUBLIC_DIR, "privacy.html"));
  res.writeHead(200, staticHeaders(".html", data.length));
  if (req.method === "HEAD") res.end();
  else res.end(data);
}

export function staticHeaders(ext: string, length: number): http.OutgoingHttpHeaders {
  return {
    "content-type": MIME[ext] ?? "application/octet-stream",
    "content-length": length,
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
  };
}
