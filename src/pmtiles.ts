import fs from "node:fs";

export type PmtilesInfo = {
  path: string;
  /** [west, south, east, north] in degrees, straight from the archive header. */
  bounds: [number, number, number, number];
  minzoom: number;
  maxzoom: number;
  /** Smallest file length the header allows: the end of its last section. */
  bytes: number;
};

/** A PMTiles v3 header is exactly 127 bytes. */
export const PMTILES_HEADER_BYTES = 127;

/**
 * Reads the fixed v3 header: magic "PMTiles", version 3, zoom range, and bounds (int32 × 1e7).
 * Throws with a short reason when the file is not a usable v3 archive.
 */
export function readPmtilesHeader(filePath: string): PmtilesInfo {
  const fd = fs.openSync(filePath, "r");
  const header = Buffer.alloc(PMTILES_HEADER_BYTES);
  let read = 0;
  try {
    read = fs.readSync(fd, header, 0, PMTILES_HEADER_BYTES, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (read < PMTILES_HEADER_BYTES) throw new Error("file is shorter than a PMTiles header");
  const info = parsePmtilesHeader(header, filePath);
  const size = fs.statSync(filePath).size;
  if (size < info.bytes) throw new Error(`file is shorter than its header says (${size} < ${info.bytes})`);
  return info;
}

/**
 * Still the archive we validated at startup? Missing: "missing". Shrunk, or rewritten into
 * something that is not a v3 archive: "broken". The header is re-read only when size or mtime moved.
 */
export function createArchiveCheck(info: PmtilesInfo): (stat: fs.Stats) => "ok" | "broken" {
  let seen = "";
  let verdict: "ok" | "broken" = "ok";
  return (stat) => {
    const key = `${stat.size}:${stat.mtimeMs}`;
    if (key === seen) return verdict;
    seen = key;
    try {
      const fresh = readPmtilesHeader(info.path);
      verdict = fresh.bytes <= stat.size ? "ok" : "broken";
    } catch {
      verdict = "broken";
    }
    if (verdict === "broken") console.warn(`PMTiles archive changed and is no longer usable: ${info.path}`);
    return verdict;
  };
}

export function parsePmtilesHeader(header: Buffer, filePath = ""): PmtilesInfo {
  if (header.length < PMTILES_HEADER_BYTES) throw new Error("file is shorter than a PMTiles header");
  if (header.toString("latin1", 0, 7) !== "PMTiles") throw new Error("not a PMTiles archive (bad magic)");
  if (header[7] !== 3) throw new Error(`unsupported PMTiles version ${header[7]}, need 3`);
  const minzoom = header[100];
  const maxzoom = header[101];
  const [west, south, east, north] = [102, 106, 110, 114].map((at) => header.readInt32LE(at) / 1e7);
  if (minzoom > maxzoom || maxzoom > 30) throw new Error(`bad zoom range ${minzoom}-${maxzoom}`);
  const ok = [west, south, east, north].every(Number.isFinite)
    && west >= -180 && east <= 180 && west < east
    && south >= -90 && north <= 90 && south < north;
  if (!ok) throw new Error(`bad bounds ${west},${south},${east},${north}`);
  // Root directory, metadata, leaf directories, tile data: offset and length, uint64 each.
  let bytes = PMTILES_HEADER_BYTES;
  for (const at of [8, 24, 40, 56]) {
    const end = header.readBigUInt64LE(at) + header.readBigUInt64LE(at + 8);
    if (end > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("bad section offsets");
    bytes = Math.max(bytes, Number(end));
  }
  return { path: filePath, bounds: [west, south, east, north], minzoom, maxzoom, bytes };
}
