import fs from "node:fs";
import type http from "node:http";

export type ByteRange = { start: number; end: number };

/**
 * One `bytes=` range against a file of `size` bytes. Null means no Range header (send it all).
 * "invalid" is a malformed, multi-part, or unsatisfiable range (send 416).
 */
export function parseRange(header: string | undefined, size: number): ByteRange | null | "invalid" {
  if (header === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return "invalid";
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix === 0 || size === 0) return "invalid";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const last = match[2] === "" ? size - 1 : Number(match[2]);
  // Digits only, so never negative; past 2^53 is not a real offset, reject rather than clamp.
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(last) || start >= size || start > last) return "invalid";
  return { start, end: Math.min(last, size - 1) };
}

/** Largest single range, and largest file sent whole to a GET without Range. */
export const MAX_RANGE_BYTES = 16 * 1024 * 1024;

export type RangeFileOptions = {
  contentType?: string;
  /** Ranges longer than this, and a Range-less GET of a file larger than this, get a 416. */
  maxRangeBytes?: number;
  /** Runs on every request after stat. "broken" answers 503 instead of serving the file. */
  check?: (stat: fs.Stats) => "ok" | "broken";
};

const BASE_HEADERS: http.OutgoingHttpHeaders = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

/** GET or HEAD a local file with single-range byte serving. The file is stat'ed per request, so it can be swapped. */
export async function serveRangeFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  filePath: string,
  options: RangeFileOptions = {},
): Promise<void> {
  const contentType = options.contentType ?? "application/octet-stream";
  const maxBytes = options.maxRangeBytes ?? MAX_RANGE_BYTES;
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) throw new Error("not a file");
  } catch {
    plain(req, res, 404, "not found");
    return;
  }
  if (options.check && options.check(stat) !== "ok") {
    plain(req, res, 503, "archive unavailable");
    return;
  }
  const size = stat.size;
  const headers: http.OutgoingHttpHeaders = {
    ...BASE_HEADERS,
    "content-type": contentType,
    "accept-ranges": "bytes",
    "cache-control": "public, max-age=31536000",
    etag: `"${size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`,
    "last-modified": stat.mtime.toUTCString(),
  };
  const raw = req.headers.range;
  const range = parseRange(Array.isArray(raw) ? raw[0] : raw, size);
  const tooBig = range === null
    ? req.method !== "HEAD" && size > maxBytes
    : range !== "invalid" && range.end - range.start + 1 > maxBytes;
  if (range === "invalid" || tooBig) {
    res.writeHead(416, { ...headers, "content-range": `bytes */${size}`, "content-length": 0 });
    res.end();
    return;
  }
  const { start, end } = range ?? { start: 0, end: size - 1 };
  const length = size === 0 ? 0 : end - start + 1;
  if (range) headers["content-range"] = `bytes ${start}-${end}/${size}`;
  headers["content-length"] = length;
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === "HEAD" || length === 0) {
    res.end();
    return;
  }
  await new Promise<void>((resolve) => {
    const stream = fs.createReadStream(filePath, { start, end });
    let sent = 0;
    stream.on("data", (chunk) => { sent += chunk.length; });
    // A file that shrank mid-read ends early. Cut the connection, so the client errors instead of
    // waiting for bytes that Content-Length promised and will never come.
    stream.on("end", () => {
      if (sent < length) res.destroy();
    });
    stream.on("error", () => {
      res.destroy();
      resolve();
    });
    res.on("close", () => {
      stream.destroy();
      resolve();
    });
    stream.pipe(res);
  });
}

function plain(req: http.IncomingMessage, res: http.ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    ...BASE_HEADERS,
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(req.method === "HEAD" ? undefined : text);
}
