import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { parsePmtilesHeader, pmtilesHeadBytes, type PmtilesInfo } from "../src/pmtiles.js";
import { MAX_RANGE_BYTES, parseRange, serveRangeFile } from "../src/range-file.js";
import { api, withApp } from "./http.js";

/** A PMTiles v3 header for a Stuttgart-sized box, z0–15. */
function pmtilesHeader(options: { magic?: string; version?: number; bounds?: number[]; zoom?: [number, number] } = {}): Buffer {
  const header = Buffer.alloc(127);
  header.write(options.magic ?? "PMTiles", 0, "latin1");
  header[7] = options.version ?? 3;
  const [minzoom, maxzoom] = options.zoom ?? [0, 15];
  header[100] = minzoom;
  header[101] = maxzoom;
  const bounds = options.bounds ?? [9, 48.69, 9.32, 48.86];
  bounds.forEach((value, i) => header.writeInt32LE(Math.round(value * 1e7), 102 + i * 4));
  // Tile data right after the header, 73 bytes: the archive is 200 bytes long.
  header.writeBigUInt64LE(127n, 56);
  header.writeBigUInt64LE(73n, 64);
  return header;
}

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "hangry-pmtiles-"));
const FILE = path.join(DIR, "basemap.pmtiles");
/** Plain bytes 0..99 for the range handler on its own. */
const BYTES = Buffer.from(Array.from({ length: 100 }, (_, i) => i));
fs.writeFileSync(FILE, BYTES);
/** Valid archive used through the app: header plus 73 bytes, 200 in all. */
const ARCHIVE = path.join(DIR, "archive.pmtiles");
const ARCHIVE_BYTES = Buffer.concat([pmtilesHeader(), Buffer.alloc(73, 7)]);
fs.writeFileSync(ARCHIVE, ARCHIVE_BYTES);
/** Sparse file past the range cap. */
const BIG = path.join(DIR, "big.pmtiles");
fs.writeFileSync(BIG, pmtilesHeader());
fs.truncateSync(BIG, MAX_RANGE_BYTES + 1024);
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

function quietly<T>(fn: () => T): T {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.warn = warn;
  }
}

/** A raw request, so "..", "%2e%2e" and friends reach the server as typed. */
function rawGet(port: number, requestPath: string, headers: http.OutgoingHttpHeaders = {}): Promise<{ status: number; type: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: requestPath, method: "GET", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, type: String(res.headers["content-type"] ?? ""), body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function withFileServer(filePath: string, fn: (base: string) => Promise<void>): Promise<void> {
  const server = http.createServer((req, res) => void serveRangeFile(req, res, filePath, { contentType: "application/vnd.pmtiles" }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}/tiles/basemap.pmtiles`);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function bytes(response: Response): Promise<number[]> {
  return [...new Uint8Array(await response.arrayBuffer())];
}

test("parseRange reads one bytes= range and rejects the rest", () => {
  assert.equal(parseRange(undefined, 100), null);
  assert.deepEqual(parseRange("bytes=0-9", 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange("bytes=90-", 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange("bytes=90-500", 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange("bytes=-10", 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange("bytes=-500", 100), { start: 0, end: 99 });
  for (const bad of ["bytes=100-", "bytes=5-2", "bytes=-0", "bytes=-", "bytes=0-1,4-5", "items=0-1", "bytes=a-b", ""]) {
    assert.equal(parseRange(bad, 100), "invalid", bad);
  }
});

test("a request without Range gets the whole file with long cache headers", async () => {
  await withFileServer(FILE, async (url) => {
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("accept-ranges"), "bytes");
    assert.equal(response.headers.get("content-length"), "100");
    assert.match(response.headers.get("cache-control") ?? "", /max-age=31536000/);
    assert.ok(response.headers.get("etag"));
    assert.deepEqual(await bytes(response), [...BYTES]);
  });
});

test("a partial range returns 206 with Content-Range and exactly those bytes", async () => {
  await withFileServer(FILE, async (url) => {
    const response = await fetch(url, { headers: { range: "bytes=10-19" } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-range"), "bytes 10-19/100");
    assert.equal(response.headers.get("content-length"), "10");
    assert.equal(response.headers.get("accept-ranges"), "bytes");
    assert.deepEqual(await bytes(response), [...BYTES.subarray(10, 20)]);
    const open = await fetch(url, { headers: { range: "bytes=95-" } });
    assert.equal(open.status, 206);
    assert.equal(open.headers.get("content-range"), "bytes 95-99/100");
    assert.deepEqual(await bytes(open), [95, 96, 97, 98, 99]);
  });
});

test("a suffix range returns the last bytes", async () => {
  await withFileServer(FILE, async (url) => {
    const response = await fetch(url, { headers: { range: "bytes=-3" } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-range"), "bytes 97-99/100");
    assert.deepEqual(await bytes(response), [97, 98, 99]);
  });
});

test("an unsatisfiable or malformed range is a 416 with the size", async () => {
  await withFileServer(FILE, async (url) => {
    for (const range of ["bytes=100-200", "bytes=9-3", "bytes=0-1,5-6", "nonsense"]) {
      const response = await fetch(url, { headers: { range } });
      assert.equal(response.status, 416, range);
      assert.equal(response.headers.get("content-range"), "bytes */100");
      assert.equal((await response.arrayBuffer()).byteLength, 0);
    }
  });
});

test("HEAD sends the headers and no body", async () => {
  await withFileServer(FILE, async (url) => {
    const full = await fetch(url, { method: "HEAD" });
    assert.equal(full.status, 200);
    assert.equal(full.headers.get("content-length"), "100");
    assert.equal(full.headers.get("accept-ranges"), "bytes");
    assert.equal((await full.arrayBuffer()).byteLength, 0);
    const part = await fetch(url, { method: "HEAD", headers: { range: "bytes=0-15" } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), "bytes 0-15/100");
    assert.equal(part.headers.get("content-length"), "16");
  });
});

test("a missing file is a 404, not a crash", async () => {
  await withFileServer(path.join(DIR, "gone.pmtiles"), async (url) => {
    const response = await fetch(url, { headers: { range: "bytes=0-9" } });
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("cache-control"), "no-store");
  });
});

test("MAP_PMTILES_PATH is optional, absolute, and ignored when the file is missing", () => {
  assert.equal(loadConfig({}).mapPmtiles, null);
  assert.equal(loadConfig({ MAP_PMTILES_PATH: "  " }).mapPmtiles, null);
  assert.deepEqual(loadConfig({ MAP_PMTILES_PATH: ARCHIVE }).mapPmtiles, {
    path: ARCHIVE, bounds: [9, 48.69, 9.32, 48.86], minzoom: 0, maxzoom: 15, bytes: 200, dataOffset: 127,
  });
  assert.equal(quietly(() => loadConfig({ MAP_PMTILES_PATH: DIR }).mapPmtiles), null);
  assert.equal(quietly(() => loadConfig({ MAP_PMTILES_PATH: path.join(DIR, "gone.pmtiles") }).mapPmtiles), null);
  assert.throws(() => loadConfig({ MAP_PMTILES_PATH: "data/basemap.pmtiles" }), /MAP_PMTILES_PATH/);
});

test("a file that is not a PMTiles v3 archive is rejected at startup and the raster map stays", async () => {
  const cases: Array<[string, Buffer, RegExp]> = [
    ["text.pmtiles", Buffer.from("x".repeat(400)), /magic/],
    ["short.pmtiles", Buffer.from("PMTiles\x03"), /shorter/],
    ["v2.pmtiles", pmtilesHeader({ version: 2 }), /version 2/],
    ["mbtiles.pmtiles", pmtilesHeader({ magic: "SQLite " }), /magic/],
    ["zoom.pmtiles", pmtilesHeader({ zoom: [12, 4] }), /zoom/],
    ["bounds.pmtiles", pmtilesHeader({ bounds: [10, 48, 9, 49] }), /bounds/],
    ["world.pmtiles", pmtilesHeader({ bounds: [-200, -90, 180, 90] }), /bounds/],
    ["cut.pmtiles", pmtilesHeader(), /shorter than its header says/],
  ];
  for (const [name, data, reason] of cases) {
    const file = path.join(DIR, name);
    fs.writeFileSync(file, data);
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (line: string) => { warnings.push(line); };
    try {
      assert.equal(loadConfig({ MAP_PMTILES_PATH: file }).mapPmtiles, null, name);
    } finally {
      console.warn = warn;
    }
    assert.match(warnings.join("\n"), reason, name);
  }
  assert.throws(() => parsePmtilesHeader(Buffer.from("PMTiles")), /shorter/);
  const bad = path.join(DIR, "text.pmtiles");
  const warn = console.warn;
  console.warn = () => {};
  try {
    await withApp(async ({ port }) => {
      const meta = await api(port, "GET", "/api/meta");
      assert.equal(meta.mapPmtilesUrl, undefined);
      assert.equal((await fetch(`http://127.0.0.1:${port}/tiles/basemap.pmtiles`)).status, 404);
    }, { env: { MAP_PMTILES_PATH: bad } });
  } finally {
    console.warn = warn;
  }
});

test("a range above the cap and a Range-less GET of a big file are 416; HEAD still reports the size", async () => {
  await withFileServer(BIG, async (url) => {
    const size = String(MAX_RANGE_BYTES + 1024);
    const whole = await fetch(url);
    assert.equal(whole.status, 416);
    assert.equal(whole.headers.get("content-range"), `bytes */${size}`);
    const over = await fetch(url, { headers: { range: `bytes=0-${MAX_RANGE_BYTES}` } });
    assert.equal(over.status, 416);
    const suffix = await fetch(url, { headers: { range: `bytes=-${MAX_RANGE_BYTES + 1}` } });
    assert.equal(suffix.status, 416);
    const atCap = await fetch(url, { method: "HEAD", headers: { range: `bytes=0-${MAX_RANGE_BYTES - 1}` } });
    assert.equal(atCap.status, 206);
    assert.equal(atCap.headers.get("content-length"), String(MAX_RANGE_BYTES));
    const header = await fetch(url, { headers: { range: "bytes=0-126" } });
    assert.equal(header.status, 206);
    assert.equal((await header.arrayBuffer()).byteLength, 127);
    const head = await fetch(url, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), size);
    assert.equal(head.headers.get("accept-ranges"), "bytes");
    assert.equal(head.headers.get("content-type"), "application/vnd.pmtiles");
  });
});

test("request paths around /tiles/ never reach other files", async () => {
  await withApp(async ({ port }) => {
    const ok = await rawGet(port, "/tiles/basemap.pmtiles", { range: "bytes=0-6" });
    assert.equal(ok.status, 206);
    assert.equal(ok.type, "application/vnd.pmtiles");
    assert.equal(ok.body.toString("latin1"), "PMTiles");
    const tries = [
      "/tiles/../package.json",
      "/tiles/../../package.json",
      "/tiles/%2e%2e/%2e%2e/package.json",
      "/tiles/%2e%2e%2f%2e%2e%2fpackage.json",
      "/tiles/..%2f..%2fsrc%2fapp.ts",
      "/tiles/basemap.pmtiles/../../src/config.ts",
      "/tiles/basemap.pmtiles%00.json",
      "/tiles/%2fetc%2fpasswd",
      "/tiles//etc/passwd",
      "/tiles/archive.pmtiles",
      `/tiles/${encodeURIComponent(ARCHIVE)}`,
      "/tiles/basemap.pmtiles?path=/etc/passwd",
    ];
    for (const target of tries) {
      const response = await rawGet(port, target, { range: "bytes=0-63" });
      const text = response.body.toString("utf8");
      if (target.startsWith("/tiles/basemap.pmtiles?")) {
        // The query string is ignored: still the configured archive, nothing else.
        assert.equal(response.body.subarray(0, 7).toString("latin1"), "PMTiles", target);
        continue;
      }
      assert.ok(response.status === 404 || response.status === 400, `${target} -> ${response.status}`);
      assert.ok(!text.includes("PMTiles"), `${target} leaked the archive`);
      assert.ok(!text.includes("free-now") && !text.includes("import ") && !text.includes("root:"), `${target} leaked a file`);
    }
  }, { env: { MAP_PMTILES_PATH: ARCHIVE } });
});

test("with MAP_PMTILES_PATH the app serves the archive and names it in /api/meta", async () => {
  await withApp(async ({ port }) => {
    const meta = await api(port, "GET", "/api/meta");
    assert.equal(meta.mapPmtilesUrl, "/tiles/basemap.pmtiles");
    assert.match(meta.mapPmtilesAttribution, /Protomaps/);
    assert.match(meta.mapPmtilesAttribution, /https:\/\/www\.openstreetmap\.org\/copyright/);
    assert.match(meta.mapPmtilesAttribution, /https:\/\/protomaps\.com/);
    assert.deepEqual(meta.mapPmtilesBounds, [9, 48.69, 9.32, 48.86]);
    assert.equal(meta.mapPmtilesMinZoom, 0);
    assert.equal(meta.mapPmtilesMaxZoom, 15);
    assert.equal(meta.mapPmtilesHead, 200, "the head the app reads ahead: the whole 200-byte archive here");
    assert.ok(meta.mapTileUrl, "the raster template stays for everywhere outside the archive");
    const response = await fetch(`http://127.0.0.1:${port}/tiles/basemap.pmtiles`, { headers: { range: "bytes=0-6" } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-type"), "application/vnd.pmtiles");
    assert.deepEqual(await bytes(response), [...ARCHIVE_BYTES.subarray(0, 7)]);
    const head = await fetch(`http://127.0.0.1:${port}/tiles/basemap.pmtiles`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), "200");
    assert.equal(head.headers.get("accept-ranges"), "bytes");
    assert.match(head.headers.get("cache-control") ?? "", /max-age=31536000/);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
  }, { env: { MAP_PMTILES_PATH: ARCHIVE } });
});

test("without MAP_PMTILES_PATH the meta has no vector basemap and /tiles/ is not served", async () => {
  await withApp(async ({ port }) => {
    const meta = await api(port, "GET", "/api/meta");
    assert.equal(meta.mapPmtilesUrl, undefined);
    assert.equal(meta.mapPmtilesAttribution, undefined);
    const response = await fetch(`http://127.0.0.1:${port}/tiles/basemap.pmtiles`);
    assert.equal(response.status, 404);
  });
});

test("the service worker leaves /tiles/ and range requests alone and keeps the vendor file", () => {
  const sw = fs.readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
  const shell = JSON.parse(/const SHELL = (\[[^\]]*\]);/.exec(sw)?.[1] ?? "[]") as string[];
  assert.ok(shell.includes("/vendor/protomaps-leaflet/protomaps-leaflet.js"));
  assert.ok(shell.includes("/vendor/leaflet/leaflet.js"));
  assert.ok(shell.includes("/vendor/leaflet/leaflet.css"));
  assert.ok(sw.includes('url.pathname.startsWith("/tiles/")'));
  assert.ok(sw.includes('headers.has("range")'));
  assert.ok(fs.existsSync(new URL("../public/vendor/protomaps-leaflet/LICENSE", import.meta.url)));
});

test("parseRange rejects huge, non-numeric and negative numbers instead of clamping them", () => {
  const size = 100;
  for (const bad of [
    "bytes=-1-5",
    "bytes=-5-",
    "bytes=0--5",
    "bytes=1e3-",
    "bytes=0x10-0x20",
    "bytes=1.5-3",
    "bytes= 1-3",
    "bytes=+1-3",
    "bytes=0-Infinity",
    "bytes=NaN-",
    "bytes=9007199254740993-",
    "bytes=0-9007199254740993",
    "bytes=-9007199254740993",
    `bytes=0-${"9".repeat(400)}`,
    `bytes=-${"9".repeat(400)}`,
  ]) {
    assert.equal(parseRange(bad, size), "invalid", bad);
  }
  // Large but real numbers past the end are still fine: the end is clamped to the file.
  assert.deepEqual(parseRange("bytes=0-9007199254740991", size), { start: 0, end: 99 });
  assert.deepEqual(parseRange("bytes=-9007199254740991", size), { start: 0, end: 99 });
});

test("HEAD reports the full file size and every 416 says bytes */size", async () => {
  await withFileServer(FILE, async (url) => {
    const head = await fetch(url, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(Number(head.headers.get("content-length")), fs.statSync(FILE).size);
    for (const range of ["bytes=100-", "bytes=-0", "bytes=-1-5", `bytes=0-${"9".repeat(40)}`, "bytes=0-1,2-3"]) {
      for (const method of ["GET", "HEAD"]) {
        const response = await fetch(url, { method, headers: { range } });
        assert.equal(response.status, 416, `${method} ${range}`);
        assert.equal(response.headers.get("content-range"), "bytes */100", `${method} ${range}`);
      }
    }
  });
});

/** An app on its own copy of the archive, so the test can delete or cut it after startup. */
async function withOwnArchive(fn: (ctx: { port: number; file: string; url: string }) => Promise<void>): Promise<void> {
  const file = path.join(DIR, `live-${process.hrtime.bigint()}.pmtiles`);
  fs.writeFileSync(file, ARCHIVE_BYTES);
  await withApp(async ({ port }) => {
    await fn({ port, file, url: `http://127.0.0.1:${port}/tiles/basemap.pmtiles` });
  }, { env: { MAP_PMTILES_PATH: file } });
}

/** Fails instead of hanging: every request below must answer within two seconds. */
function soon(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(2000) });
}

test("an archive deleted after startup answers a clean 404 on GET and HEAD, and the app keeps running", async () => {
  await withOwnArchive(async ({ port, file, url }) => {
    assert.equal((await soon(url, { headers: { range: "bytes=0-6" } })).status, 206);
    fs.rmSync(file);
    for (const method of ["GET", "HEAD"]) {
      const response = await soon(url, { method, headers: { range: "bytes=0-6" } });
      assert.equal(response.status, 404, method);
      assert.equal(response.headers.get("cache-control"), "no-store", method);
      await response.arrayBuffer();
    }
    assert.equal((await soon(url)).status, 404);
    assert.equal((await api(port, "GET", "/api/health")).ok, true, "server still up");
  });
});

test("an archive cut short or rewritten after startup answers 503, never a short or hanging body", async () => {
  await withOwnArchive(async ({ port, file, url }) => {
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (line: string) => { warnings.push(line); };
    try {
      fs.truncateSync(file, 150);
      for (const [method, range] of [["GET", "bytes=0-6"], ["HEAD", "bytes=0-6"], ["GET", "bytes=140-199"], ["GET", ""]]) {
        const response = await soon(url, { method, headers: range ? { range } : {} });
        assert.equal(response.status, 503, `${method} ${range}`);
        assert.equal(response.headers.get("cache-control"), "no-store");
        await response.arrayBuffer();
      }
      fs.truncateSync(file, 0);
      assert.equal((await soon(url, { headers: { range: "bytes=0-6" } })).status, 503, "empty file");
      fs.writeFileSync(file, Buffer.alloc(300, 1));
      assert.equal((await soon(url, { headers: { range: "bytes=0-6" } })).status, 503, "not PMTiles any more");
      // Put the archive back and it is served again.
      fs.writeFileSync(file, ARCHIVE_BYTES);
      const back = await soon(url, { headers: { range: "bytes=0-6" } });
      assert.equal(back.status, 206);
      assert.equal(Buffer.from(await back.arrayBuffer()).toString("latin1"), "PMTiles");
    } finally {
      console.warn = warn;
    }
    assert.ok(warnings.some((line) => /no longer usable/.test(line)), "the change was logged");
    assert.equal((await api(port, "GET", "/api/health")).ok, true, "server still up");
  });
});

test("a file that shrinks while a range is streaming is cut off, not left hanging", async () => {
  const file = path.join(DIR, "shrinking.bin");
  fs.writeFileSync(file, Buffer.alloc(64));
  // Report the full size, then read from a file that is shorter than that.
  const server = http.createServer((req, res) => {
    const real = fs.promises.stat;
    fs.promises.stat = (async () => {
      const stat = await real(file);
      return { size: 8 * 1024 * 1024, mtime: stat.mtime, mtimeMs: stat.mtimeMs, isFile: () => true };
    }) as unknown as typeof fs.promises.stat;
    void serveRangeFile(req, res, file).finally(() => { fs.promises.stat = real; });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  try {
    const port = (server.address() as AddressInfo).port;
    const outcome = await soon(`http://127.0.0.1:${port}/x`, { headers: { range: "bytes=0-1048575" } })
      .then((response) => response.arrayBuffer())
      .then(() => "complete", (error: Error) => (error.name === "TimeoutError" ? "hung" : "cut"));
    assert.equal(outcome, "cut");
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("the archive head is header and directories, at least 16 KiB, at most 512 KiB, never past the file", () => {
  const info = (dataOffset: number, bytes = 200 * 1024 * 1024): PmtilesInfo => ({
    path: "", bounds: [9, 48, 10, 49], minzoom: 0, maxzoom: 15, bytes, dataOffset,
  });
  assert.equal(pmtilesHeadBytes(info(39180)), 39180, "the Stuttgart region archive");
  assert.equal(pmtilesHeadBytes(info(1425)), 16384, "small directories: the first 16 KiB read");
  assert.equal(pmtilesHeadBytes(info(40 * 1024 * 1024)), 512 * 1024, "huge directories are capped");
  assert.equal(pmtilesHeadBytes(info(127, 200)), 200, "a tiny archive: the whole file");
  assert.equal(parsePmtilesHeader(pmtilesHeader()).dataOffset, 127);
});

/** Range server with a memory head of `head` bytes, counting the file reads that reach the disk. */
async function withHeadServer(filePath: string, head: number, fn: (url: string, reads: () => number) => Promise<void>): Promise<void> {
  let reads = 0;
  const real = fs.createReadStream;
  (fs as { createReadStream: typeof fs.createReadStream }).createReadStream = ((...args: Parameters<typeof fs.createReadStream>) => {
    if (args[0] === filePath) reads += 1;
    return real(...args);
  }) as typeof fs.createReadStream;
  const server = http.createServer((req, res) => void serveRangeFile(req, res, filePath, { contentType: "application/vnd.pmtiles", head }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}/tiles/basemap.pmtiles`, () => reads);
  } finally {
    (fs as { createReadStream: typeof fs.createReadStream }).createReadStream = real;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("ranges inside the head are answered from memory with the same headers; longer ones stream from disk", async () => {
  const file = path.join(DIR, "head.bin");
  fs.writeFileSync(file, BYTES);
  await withHeadServer(file, 40, async (url, reads) => {
    let plain: Headers | undefined;
    await withFileServer(file, async (other) => {
      const response = await fetch(other, { headers: { range: "bytes=0-39" } });
      await response.arrayBuffer();
      plain = response.headers;
    });
    const before = reads();
    for (const [range, from, to] of [["bytes=0-39", 0, 40], ["bytes=5-9", 5, 10], ["bytes=0-0", 0, 1], ["bytes=39-39", 39, 40]] as const) {
      const response = await fetch(url, { headers: { range } });
      assert.equal(response.status, 206, range);
      assert.equal(response.headers.get("content-range"), `bytes ${from}-${to - 1}/100`, range);
      assert.equal(response.headers.get("content-length"), String(to - from), range);
      assert.deepEqual(await bytes(response), [...BYTES.subarray(from, to)], range);
    }
    assert.equal(reads() - before, 0, "no stream opened for ranges inside the head");
    const first = await fetch(url, { headers: { range: "bytes=0-39" } });
    await first.arrayBuffer();
    for (const name of ["etag", "last-modified", "cache-control", "accept-ranges", "content-type"]) {
      assert.equal(first.headers.get(name), plain?.get(name), name);
    }
    const across = await fetch(url, { headers: { range: "bytes=30-49" } });
    assert.deepEqual(await bytes(across), [...BYTES.subarray(30, 50)]);
    const tail = await fetch(url, { headers: { range: "bytes=60-99" } });
    assert.deepEqual(await bytes(tail), [...BYTES.subarray(60, 100)]);
    const whole = await fetch(url);
    assert.equal(whole.status, 200);
    assert.deepEqual(await bytes(whole), [...BYTES]);
    assert.equal(reads() - before, 3, "ranges past the head read the disk");
    for (const range of ["bytes=100-", "bytes=0-1,2-3"]) {
      const bad = await fetch(url, { headers: { range } });
      assert.equal(bad.status, 416, range);
      assert.equal(bad.headers.get("content-range"), "bytes */100", range);
    }
    const head = await fetch(url, { method: "HEAD", headers: { range: "bytes=0-9" } });
    assert.equal(head.status, 206);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
  });
});

test("a rewritten file refills the head, and a head bigger than the file is the file", async () => {
  const file = path.join(DIR, "head-swap.bin");
  fs.writeFileSync(file, BYTES);
  await withHeadServer(file, 40, async (url) => {
    assert.deepEqual(await bytes(await fetch(url, { headers: { range: "bytes=0-3" } })), [0, 1, 2, 3]);
    const next = Buffer.from(Array.from({ length: 100 }, (_, i) => 255 - i));
    fs.writeFileSync(file, next);
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(file, later, later);
    const fresh = await fetch(url, { headers: { range: "bytes=0-3" } });
    assert.deepEqual(await bytes(fresh), [255, 254, 253, 252]);
  });
  const small = path.join(DIR, "head-small.bin");
  fs.writeFileSync(small, BYTES.subarray(0, 10));
  await withHeadServer(small, 64, async (url, reads) => {
    const all = await fetch(url, { headers: { range: "bytes=0-9" } });
    assert.equal(all.headers.get("content-range"), "bytes 0-9/10");
    assert.deepEqual(await bytes(all), [...BYTES.subarray(0, 10)]);
    assert.equal(reads(), 0);
  });
});

test("through the app the archive head comes from memory and a cut archive still answers 503", async () => {
  await withOwnArchive(async ({ file, url }) => {
    const first = await soon(url, { headers: { range: "bytes=0-126" } });
    assert.equal(first.status, 206);
    assert.deepEqual(await bytes(first), [...ARCHIVE_BYTES.subarray(0, 127)]);
    const whole = await soon(url, { headers: { range: "bytes=0-199" } });
    assert.deepEqual(await bytes(whole), [...ARCHIVE_BYTES]);
    const warn = console.warn;
    console.warn = () => {};
    try {
      fs.truncateSync(file, 150);
      const cut = await soon(url, { headers: { range: "bytes=0-6" } });
      assert.equal(cut.status, 503);
      await cut.arrayBuffer();
    } finally {
      console.warn = warn;
    }
  });
});

test("/vendor files are cached for a week; the app shell is still checked every time", async () => {
  await withApp(async ({ port }) => {
    for (const file of ["/vendor/leaflet/leaflet.js", "/vendor/leaflet/leaflet.css", "/vendor/protomaps-leaflet/protomaps-leaflet.js"]) {
      for (const method of ["GET", "HEAD"]) {
        const response = await fetch(`http://127.0.0.1:${port}${file}`, { method });
        assert.equal(response.status, 200, `${method} ${file}`);
        assert.equal(response.headers.get("cache-control"), "public, max-age=604800", `${method} ${file}`);
        await response.arrayBuffer();
      }
    }
    for (const file of ["/", "/app.js", "/map.js", "/styles.css", "/sw.js", "/whats-new.json"]) {
      const response = await fetch(`http://127.0.0.1:${port}${file}`);
      assert.equal(response.headers.get("cache-control"), "no-cache", file);
      await response.arrayBuffer();
    }
  });
});
