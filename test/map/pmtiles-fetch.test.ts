import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createApp } from "../../src/app.js";
import { loadConfig, type Config } from "../../src/config.js";
import { openDb } from "../../src/db.js";
import { ensurePmtiles, PMTILES_DOWNLOAD_MAX_BYTES, pmtilesRequestHeaders, startPmtilesFetch, type PmtilesFetchTuning } from "../../src/map/pmtiles-fetch.js";
import { readPmtilesHeader, type PmtilesInfo } from "../../src/map/pmtiles.js";

const FIXTURE_PATH = fileURLToPath(new URL("../fixtures/stuttgart-schlossplatz.pmtiles", import.meta.url));
const FIXTURE = fs.readFileSync(FIXTURE_PATH);
const SHA = crypto.createHash("sha256").update(FIXTURE).digest("hex");
/** Straight from the header (north is stored as 48.7849999). */
const BOUNDS = readPmtilesHeader(FIXTURE_PATH).bounds;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "hangry-pmtiles-fetch-"));
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

let seq = 0;
/** A fresh target path inside a directory that does not exist yet. */
function target(): string {
  seq += 1;
  return path.join(DIR, `run-${seq}`, "nested", "basemap.pmtiles");
}

type Log = { lines: string[]; log: Pick<Console, "log" | "warn"> };
function logger(): Log {
  const lines: string[] = [];
  return { lines, log: { log: (line: string) => lines.push(line), warn: (line: string) => lines.push(line) } };
}

function tuning(log: Log, extra: Partial<PmtilesFetchTuning> = {}): Partial<PmtilesFetchTuning> {
  return { allowHttp: true, baseDelayMs: 1, attempts: 3, idleTimeoutMs: 2000, log: log.log, ...extra };
}

type Origin = { url: string; hits: () => number; close: () => Promise<void> };

/** Local origin: /start redirects (with a signed-looking query) to /asset, which `serve` answers. */
async function origin(serve: (req: http.IncomingMessage, res: http.ServerResponse, hit: number) => void): Promise<Origin> {
  let hits = 0;
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith("/start")) {
      res.writeHead(302, { location: "/asset?X-Amz-Signature=secret123" });
      res.end();
      return;
    }
    hits += 1;
    serve(req, res, hits);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/start?token=abc`,
    hits: () => hits,
    async close() {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const serveFixture = (_req: http.IncomingMessage, res: http.ServerResponse): void => {
  res.writeHead(200, { "content-type": "application/octet-stream", "content-length": FIXTURE.length });
  res.end(FIXTURE);
};

function leftovers(file: string): string[] {
  const dir = path.dirname(file);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith(".download")) : [];
}

/** An app whose config the test holds, so the hot-enable is visible through HTTP. */
async function withLiveApp(config: Config, fn: (base: string) => Promise<void>): Promise<void> {
  const db = openDb(":memory:");
  const server = http.createServer(createApp({ db, push: { async send() {} }, config, now: () => Date.now() }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
}

function quietly<T>(fn: () => T): { value: T; warnings: string[] } {
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (line: string) => { warnings.push(line); };
  try {
    return { value: fn(), warnings };
  } finally {
    console.warn = warn;
  }
}

test("the fixture sha256 in test/fixtures/README.md is what the tests use", () => {
  const readme = fs.readFileSync(new URL("../fixtures/README.md", import.meta.url), "utf8");
  assert.ok(readme.includes(SHA));
  assert.equal(PMTILES_DOWNLOAD_MAX_BYTES, 1024 ** 3);
});

test("MAP_PMTILES_URL and MAP_PMTILES_SHA256 are read, validated, and never throw", () => {
  const file = target();
  const url = "https://github.com/o/r/releases/download/v1/basemap.pmtiles";
  const both = loadConfig({ MAP_PMTILES_PATH: file, MAP_PMTILES_URL: url, MAP_PMTILES_SHA256: SHA.toUpperCase() });
  assert.equal(both.mapPmtiles, null, "nothing is enabled until the background check passes");
  assert.deepEqual(both.mapPmtilesSource, { path: file, sha256: SHA, url, token: null });
  const shaOnly = loadConfig({ MAP_PMTILES_PATH: file, MAP_PMTILES_SHA256: SHA });
  assert.deepEqual(shaOnly.mapPmtilesSource, { path: file, sha256: SHA, url: null, token: null });
  assert.equal(loadConfig({}).mapPmtilesSource, null);
  for (const [env, reason] of [
    [{ MAP_PMTILES_PATH: file, MAP_PMTILES_URL: "http://example.com/x.pmtiles", MAP_PMTILES_SHA256: SHA }, /https/],
    [{ MAP_PMTILES_PATH: file, MAP_PMTILES_URL: "ftp://example.com/x.pmtiles", MAP_PMTILES_SHA256: SHA }, /https/],
    [{ MAP_PMTILES_PATH: file, MAP_PMTILES_URL: "https://u:p@example.com/x.pmtiles", MAP_PMTILES_SHA256: SHA }, /https/],
    [{ MAP_PMTILES_PATH: file, MAP_PMTILES_URL: "not a url", MAP_PMTILES_SHA256: SHA }, /https/],
  ] as const) {
    const { value, warnings } = quietly(() => loadConfig({ ...env }));
    assert.equal(value.mapPmtilesSource?.url, null, env.MAP_PMTILES_URL);
    assert.match(warnings.join("\n"), reason);
  }
  const noSha = quietly(() => loadConfig({ MAP_PMTILES_PATH: file, MAP_PMTILES_URL: url }));
  assert.equal(noSha.value.mapPmtilesSource, null);
  assert.equal(noSha.value.mapPmtiles, null);
  assert.match(noSha.warnings.join("\n"), /MAP_PMTILES_SHA256 is required/);
  const badSha = quietly(() => loadConfig({ MAP_PMTILES_PATH: file, MAP_PMTILES_URL: url, MAP_PMTILES_SHA256: "abc" }));
  assert.equal(badSha.value.mapPmtilesSource, null);
  assert.match(badSha.warnings.join("\n"), /64 hex/);
  const noPath = quietly(() => loadConfig({ MAP_PMTILES_URL: url, MAP_PMTILES_SHA256: SHA }));
  assert.equal(noPath.value.mapPmtilesSource, null);
  assert.equal(noPath.value.mapPmtiles, null);
  const secret = quietly(() => loadConfig({ MAP_PMTILES_PATH: file, MAP_PMTILES_URL: "http://example.com/x?sig=hush", MAP_PMTILES_SHA256: SHA }));
  assert.ok(!secret.warnings.join("\n").includes("hush"), "no query string in logs");
});

test("downloads in the background, verifies the sha, renames atomically, and hot-enables the archive", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const server = await origin((req, res) => {
    assert.equal(req.headers.authorization, undefined, "no auth header");
    void gate.then(() => serveFixture(req, res));
  });
  const file = target();
  const config = loadConfig({ MAP_PMTILES_PATH: file, MAP_PMTILES_URL: "https://example.invalid/x.pmtiles", MAP_PMTILES_SHA256: SHA });
  config.mapPmtilesSource = { ...config.mapPmtilesSource!, url: server.url, token: null };
  const log = logger();
  try {
    await withLiveApp(config, async (base) => {
      const pending = startPmtilesFetch(config, tuning(log));
      assert.ok(pending);
      // The download is held open: the app still answers, raster only.
      for (let i = 0; i < 20 && server.hits() === 0; i++) await new Promise((r) => setTimeout(r, 10));
      assert.equal(server.hits(), 1);
      const before = await (await fetch(`${base}/api/meta`)).json();
      assert.equal(before.mapPmtilesUrl, undefined);
      assert.ok(before.mapTileUrl);
      assert.equal((await fetch(`${base}/tiles/basemap.pmtiles`, { headers: { range: "bytes=0-6" } })).status, 404);
      assert.ok(!fs.existsSync(file), "nothing at the target until it is verified");
      release();
      const info = await pending;
      assert.deepEqual(info?.bounds, BOUNDS);
      assert.deepEqual(fs.readFileSync(file), FIXTURE);
      assert.deepEqual(leftovers(file), [], "temp file renamed away");
      const after = await (await fetch(`${base}/api/meta`)).json();
      assert.equal(after.mapPmtilesUrl, "/tiles/basemap.pmtiles");
      assert.deepEqual(after.mapPmtilesBounds, BOUNDS);
      assert.equal(after.mapPmtilesMinZoom, 12);
      assert.equal(after.mapPmtilesMaxZoom, 15);
      const range = await fetch(`${base}/tiles/basemap.pmtiles`, { headers: { range: "bytes=0-6" } });
      assert.equal(range.status, 206);
      assert.equal(Buffer.from(await range.arrayBuffer()).toString("latin1"), "PMTiles");
    });
  } finally {
    release();
    await server.close();
  }
  const text = log.lines.join("\n");
  assert.match(text, /downloaded and enabled/);
  assert.ok(!text.includes("secret123") && !text.includes("token=abc"), "query strings never logged");
});

test("a matching file already present is used without a download", async () => {
  const server = await origin(serveFixture);
  const file = target();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, FIXTURE);
  const mtime = fs.statSync(file).mtimeMs;
  let ready = null as PmtilesInfo | null;
  const log = logger();
  try {
    const info = await ensurePmtiles({ path: file, sha256: SHA, url: server.url, token: null }, (got) => { ready = got; }, tuning(log));
    assert.deepEqual(info?.bounds, BOUNDS);
    assert.equal(ready, info);
    assert.equal(server.hits(), 0, "no request made");
    assert.equal(fs.statSync(file).mtimeMs, mtime, "file untouched");
    assert.match(log.lines.join("\n"), /verified/);
  } finally {
    await server.close();
  }
});

test("a wrong or broken file at the path is replaced by the download", async () => {
  const server = await origin(serveFixture);
  try {
    for (const bad of [Buffer.from("x".repeat(500)), FIXTURE.subarray(0, 1000), Buffer.concat([FIXTURE, Buffer.from("extra")])]) {
      const file = target();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bad);
      const info = await ensurePmtiles({ path: file, sha256: SHA, url: server.url, token: null }, () => {}, tuning(logger()));
      assert.deepEqual(info?.bounds, BOUNDS);
      assert.deepEqual(fs.readFileSync(file), FIXTURE);
    }
  } finally {
    await server.close();
  }
});

test("a sha256 mismatch installs nothing and leaves the raster map", async () => {
  const server = await origin(serveFixture);
  const file = target();
  const log = logger();
  const wrong = "0".repeat(64);
  let ready = false;
  try {
    const info = await ensurePmtiles({ path: file, sha256: wrong, url: server.url, token: null }, () => { ready = true; }, tuning(log));
    assert.equal(info, null);
    assert.equal(ready, false);
    assert.ok(!fs.existsSync(file));
    assert.deepEqual(leftovers(file), []);
    assert.equal(server.hits(), 1, "the same bytes would mismatch again: no retry");
    assert.match(log.lines.join("\n"), /sha256 mismatch/);
    assert.match(log.lines.join("\n"), /gave up/);
  } finally {
    await server.close();
  }
  // Same through the app: the meta stays raster only.
  const config = loadConfig({ MAP_PMTILES_PATH: file, MAP_PMTILES_URL: "https://example.invalid/x", MAP_PMTILES_SHA256: wrong });
  await withLiveApp(config, async (base) => {
    assert.equal((await (await fetch(`${base}/api/meta`)).json()).mapPmtilesUrl, undefined);
    assert.equal((await fetch(`${base}/tiles/basemap.pmtiles`)).status, 404);
  });
});

test("a server error or truncated body is retried with backoff, then given up cleanly", async () => {
  for (const [name, serve] of [
    ["500", (_req: http.IncomingMessage, res: http.ServerResponse) => { res.writeHead(500); res.end("nope"); }],
    ["truncated", (_req: http.IncomingMessage, res: http.ServerResponse) => {
      res.writeHead(200, { "content-length": FIXTURE.length });
      res.write(FIXTURE.subarray(0, 4096), () => res.destroy());
    }],
  ] as const) {
    const server = await origin(serve);
    const file = target();
    const log = logger();
    try {
      const started = Date.now();
      const info = await ensurePmtiles({ path: file, sha256: SHA, url: server.url, token: null }, () => assert.fail("must not enable"), tuning(log, { attempts: 3, baseDelayMs: 20 }));
      assert.equal(info, null, name);
      assert.equal(server.hits(), 3, `${name}: every attempt used`);
      assert.ok(Date.now() - started >= 20 + 40, `${name}: backoff waited`);
      assert.ok(!fs.existsSync(file), name);
      assert.deepEqual(leftovers(file), [], `${name}: temp files removed`);
      const text = log.lines.join("\n");
      assert.match(text, /attempt 1\/3 failed/);
      assert.match(text, /attempt 3\/3 failed/);
      assert.match(text, /gave up, keeping the raster basemap/);
    } finally {
      await server.close();
    }
  }
});

test("a retry after a failure can still succeed", async () => {
  const server = await origin((req, res, hit) => {
    if (hit === 1) { res.writeHead(503); res.end(); return; }
    serveFixture(req, res);
  });
  const file = target();
  try {
    const info = await ensurePmtiles({ path: file, sha256: SHA, url: server.url, token: null }, () => {}, tuning(logger()));
    assert.deepEqual(info?.bounds, BOUNDS);
    assert.equal(server.hits(), 2);
  } finally {
    await server.close();
  }
});

test("a download over the 1 GiB cap is aborted and the temp file deleted", async () => {
  // Declared over the real cap: refused on the headers, before any body is written.
  const declared = await origin((_req, res) => {
    res.writeHead(200, { "content-length": PMTILES_DOWNLOAD_MAX_BYTES + 1 });
    res.write(FIXTURE.subarray(0, 1024));
  });
  const file = target();
  const log = logger();
  try {
    assert.equal(await ensurePmtiles({ path: file, sha256: SHA, url: declared.url, token: null }, () => {}, tuning(log)), null);
    assert.equal(declared.hits(), 1, "not retried");
    assert.match(log.lines.join("\n"), /over the 1073741824 byte cap/);
    assert.ok(!fs.existsSync(file));
    assert.deepEqual(leftovers(file), []);
  } finally {
    await declared.close();
  }
  // No Content-Length: counted while streaming. A lower cap keeps the test small.
  let sent = 0;
  const streaming = await origin((_req, res) => {
    res.writeHead(200);
    const pump = (): void => {
      while (sent < 64 * 1024 * 1024) {
        sent += 64 * 1024;
        if (!res.write(Buffer.alloc(64 * 1024))) { res.once("drain", pump); return; }
      }
      res.end();
    };
    res.on("error", () => {});
    pump();
  });
  const file2 = target();
  const log2 = logger();
  try {
    const cap = 256 * 1024;
    assert.equal(await ensurePmtiles({ path: file2, sha256: SHA, url: streaming.url, token: null }, () => {}, tuning(log2, { maxBytes: cap })), null);
    assert.equal(streaming.hits(), 1, "not retried");
    assert.ok(sent < 64 * 1024 * 1024, "the stream was cut, not read to the end");
    assert.match(log2.lines.join("\n"), /passed the 262144 byte cap/);
    assert.ok(!fs.existsSync(file2));
    assert.deepEqual(leftovers(file2), []);
  } finally {
    await streaming.close();
  }
});

test("a valid download that is not a PMTiles archive is not installed", async () => {
  const junk = Buffer.from("y".repeat(4096));
  const server = await origin((_req, res) => { res.writeHead(200); res.end(junk); });
  const file = target();
  const log = logger();
  try {
    const sha = crypto.createHash("sha256").update(junk).digest("hex");
    assert.equal(await ensurePmtiles({ path: file, sha256: sha, url: server.url, token: null }, () => {}, tuning(log)), null);
    assert.ok(!fs.existsSync(file));
    assert.deepEqual(leftovers(file), []);
    assert.match(log.lines.join("\n"), /not a usable PMTiles v3 archive/);
  } finally {
    await server.close();
  }
});

test("non-https URLs are refused at download time too", async () => {
  const server = await origin(serveFixture);
  const file = target();
  const log = logger();
  try {
    assert.equal(await ensurePmtiles({ path: file, sha256: SHA, url: server.url, token: null }, () => {}, tuning(log, { allowHttp: false })), null);
    assert.equal(server.hits(), 0);
    assert.match(log.lines.join("\n"), /refusing non-https/);
  } finally {
    await server.close();
  }
});

test("without MAP_PMTILES_URL nothing is fetched", async () => {
  const server = await origin(serveFixture);
  try {
    const file = target();
    // Unset everywhere: no background work at all.
    assert.equal(startPmtilesFetch(loadConfig({})), null);
    assert.equal(startPmtilesFetch(quietly(() => loadConfig({ MAP_PMTILES_PATH: file })).value), null);
    // SHA without URL: the file is only checked, and a missing one stays missing.
    const log = logger();
    const config = loadConfig({ MAP_PMTILES_PATH: file, MAP_PMTILES_SHA256: SHA });
    assert.equal(await startPmtilesFetch(config, tuning(log)), null);
    assert.equal(config.mapPmtiles, null);
    assert.ok(!fs.existsSync(path.dirname(file)), "no directory created");
    assert.match(log.lines.join("\n"), /disabled \(missing\)/);
    // ...and a matching one is enabled.
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, FIXTURE);
    assert.deepEqual((await startPmtilesFetch(config, tuning(logger())))?.bounds, BOUNDS);
    assert.deepEqual((config as Config).mapPmtiles?.bounds, BOUNDS, "hot-enabled on the config");
    assert.equal(server.hits(), 0);
  } finally {
    await server.close();
  }
});

const TOKEN = "github_pat_TESTONLY_0123456789abcdefSECRET";

test("request headers: Bearer only with a token, octet-stream Accept for api.github.com", () => {
  const api = pmtilesRequestHeaders(new URL("https://API.GitHub.com/repos/o/r/releases/assets/1"), TOKEN);
  assert.equal(api.authorization, `Bearer ${TOKEN}`);
  assert.equal(api.accept, "application/octet-stream");
  const plain = pmtilesRequestHeaders(new URL("https://github.com/o/r/releases/download/v1/x.pmtiles"), null);
  assert.equal(plain.authorization, undefined);
  assert.notEqual(plain.accept, "application/octet-stream");
  assert.equal(pmtilesRequestHeaders(new URL("https://api.github.com.evil.example/x"), null).accept, "*/*");
  assert.equal(pmtilesRequestHeaders(new URL("https://objects.githubusercontent.com/x"), TOKEN).authorization, `Bearer ${TOKEN}`,
    "the helper is per hop; follow() decides whether a hop gets the token");
});

test("MAP_PMTILES_TOKEN is read into the source and never printed", () => {
  const file = target();
  const url = "https://api.github.com/repos/o/r/releases/assets/1";
  const { value, warnings } = quietly(() => loadConfig({ MAP_PMTILES_PATH: file, MAP_PMTILES_URL: url, MAP_PMTILES_SHA256: SHA, MAP_PMTILES_TOKEN: ` ${TOKEN} ` }));
  assert.deepEqual(value.mapPmtilesSource, { path: file, sha256: SHA, url, token: TOKEN });
  assert.deepEqual(warnings, []);
  assert.equal(loadConfig({ MAP_PMTILES_PATH: file, MAP_PMTILES_URL: url, MAP_PMTILES_SHA256: SHA }).mapPmtilesSource?.token, null);
  assert.equal(loadConfig({ MAP_PMTILES_PATH: file, MAP_PMTILES_URL: url, MAP_PMTILES_SHA256: SHA, MAP_PMTILES_TOKEN: "  " }).mapPmtilesSource?.token, null);
  const lines: string[] = [];
  for (const env of [
    { MAP_PMTILES_PATH: file, MAP_PMTILES_SHA256: SHA, MAP_PMTILES_TOKEN: TOKEN },
    { MAP_PMTILES_PATH: file, MAP_PMTILES_URL: "http://example.com/x", MAP_PMTILES_SHA256: SHA, MAP_PMTILES_TOKEN: TOKEN },
    { MAP_PMTILES_PATH: file, MAP_PMTILES_URL: url, MAP_PMTILES_SHA256: SHA, MAP_PMTILES_TOKEN: `${TOKEN} x` },
    { MAP_PMTILES_URL: url, MAP_PMTILES_SHA256: SHA, MAP_PMTILES_TOKEN: TOKEN },
  ]) {
    const got = quietly(() => loadConfig(env));
    assert.equal(got.value.mapPmtilesSource?.token ?? null, null, JSON.stringify(Object.keys(env)));
    lines.push(...got.warnings);
  }
  assert.ok(lines.some((line) => /MAP_PMTILES_TOKEN ignored/.test(line)));
  assert.ok(!lines.join("\n").includes("TESTONLY"), "no part of the token in a warning");
});

type Seen = { host: string; path: string; authorization?: string; accept?: string };

/** A bare origin that records each request's headers and answers with `serve`. */
async function recorder(serve: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ base: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    seen.push({ host: String(req.headers.host), path: req.url ?? "", authorization: req.headers.authorization, accept: req.headers.accept });
    serve(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    async close() {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("the token goes to the first host and same-host redirects, never to a redirect target on another host", async () => {
  // Like GitHub: the API host redirects to a signed URL on a storage host (here: another port).
  const storage = await recorder(serveFixture);
  const api = await recorder((req, res) => {
    if (req.url === "/repos/o/r/releases/assets/1") {
      res.writeHead(302, { location: "/repos/o/r/releases/assets/1/raw" });
    } else {
      res.writeHead(302, { location: `${storage.base}/blob?sig=signed&expires=1` });
    }
    res.end();
  });
  const file = target();
  const log = logger();
  try {
    const info = await ensurePmtiles(
      { path: file, sha256: SHA, url: `${api.base}/repos/o/r/releases/assets/1`, token: TOKEN },
      () => {},
      tuning(log),
    );
    assert.deepEqual(info?.bounds, BOUNDS);
    assert.deepEqual(fs.readFileSync(file), FIXTURE);
    assert.equal(api.seen.length, 2);
    assert.equal(api.seen[0].authorization, `Bearer ${TOKEN}`, "first request carries the token");
    assert.equal(api.seen[1].authorization, `Bearer ${TOKEN}`, "same-host redirect keeps it");
    assert.equal(storage.seen.length, 1);
    assert.equal(storage.seen[0].authorization, undefined, "cross-host redirect drops it");
    assert.equal(storage.seen[0].path, "/blob?sig=signed&expires=1", "signed query passed through as is");
    for (const hit of [...api.seen, ...storage.seen]) assert.ok(!hit.path.includes(TOKEN), "token never in a URL");
    const text = log.lines.join("\n");
    assert.ok(!text.includes(TOKEN) && !text.includes("sig=signed"), "no token or signature in logs");
  } finally {
    await api.close();
    await storage.close();
  }
});

test("once dropped, the token is not sent again when a later hop returns to the first host", async () => {
  let api: Awaited<ReturnType<typeof recorder>> | null = null;
  const other = await recorder((_req, res) => {
    res.writeHead(302, { location: `${api!.base}/back` });
    res.end();
  });
  api = await recorder((req, res) => {
    if (req.url === "/start") {
      res.writeHead(302, { location: `${other.base}/hop` });
      res.end();
      return;
    }
    serveFixture(req, res);
  });
  try {
    const info = await ensurePmtiles({ path: target(), sha256: SHA, url: `${api.base}/start`, token: TOKEN }, () => {}, tuning(logger()));
    assert.ok(info);
    assert.deepEqual(api.seen.map((hit) => hit.authorization), [`Bearer ${TOKEN}`, undefined]);
    assert.equal(other.seen[0].authorization, undefined);
  } finally {
    await api.close();
    await other.close();
  }
});

test("the token never shows up in logs, even when a server echoes it into a URL or fails", async () => {
  const server = await recorder((req, res) => {
    if (!req.url?.startsWith("/gone/")) {
      // Hostile or confused origin: puts the token into the redirect path and query.
      res.writeHead(302, { location: `/gone/${TOKEN}?t=${TOKEN}` });
      res.end();
      return;
    }
    res.writeHead(500);
    res.end(TOKEN);
  });
  const log = logger();
  const warn = console.warn;
  const logLine = console.log;
  const consoleLines: string[] = [];
  console.warn = (...args: unknown[]) => { consoleLines.push(args.join(" ")); };
  console.log = (...args: unknown[]) => { consoleLines.push(args.join(" ")); };
  try {
    const file = target();
    const info = await ensurePmtiles({ path: file, sha256: SHA, url: `${server.base}/asset`, token: TOKEN }, () => {}, tuning(log, { attempts: 2 }));
    assert.equal(info, null);
    assert.ok(!fs.existsSync(file));
    // 401 from the first host: a bad token is not retried.
    const denied = await recorder((_req, res) => { res.writeHead(401); res.end(`bad credentials ${TOKEN}`); });
    try {
      assert.equal(await ensurePmtiles({ path: target(), sha256: SHA, url: `${denied.base}/x`, token: TOKEN }, () => {}, tuning(log)), null);
      assert.equal(denied.seen.length, 1);
    } finally {
      await denied.close();
    }
    // Same paths through the real console (default logger).
    await ensurePmtiles({ path: target(), sha256: SHA, url: `${server.base}/asset`, token: TOKEN }, () => {}, { allowHttp: true, attempts: 1, baseDelayMs: 1 });
  } finally {
    console.warn = warn;
    console.log = logLine;
    await server.close();
  }
  const all = [...log.lines, ...consoleLines].join("\n");
  assert.match(all, /HTTP 500/);
  assert.match(all, /HTTP 401/);
  assert.match(all, /\[redacted\]/, "the echoed path was scrubbed, not dropped");
  assert.ok(!all.includes(TOKEN), "raw token never logged");
  assert.ok(!all.includes("TESTONLY"), "no fragment of it either");
  assert.ok(!/authorization|bearer/i.test(all), "no Authorization header logged");
});

test("without a token no Authorization header is sent on any hop", async () => {
  const storage = await recorder(serveFixture);
  const api = await recorder((_req, res) => {
    res.writeHead(302, { location: `${storage.base}/blob` });
    res.end();
  });
  try {
    assert.ok(await ensurePmtiles({ path: target(), sha256: SHA, url: `${api.base}/a`, token: null }, () => {}, tuning(logger())));
    assert.equal(api.seen[0].authorization, undefined);
    assert.equal(storage.seen[0].authorization, undefined);
  } finally {
    await api.close();
    await storage.close();
  }
});
