import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { adminFailureSlots, closeAdminReaders, resetAdminFailures } from "../../src/admin/admin-query.js";
import { createApp } from "../../src/app.js";
import { writeAvatarFile } from "../../src/lib/avatar.js";
import { loadConfig } from "../../src/config.js";
import { bumpAvatarRev, openDb } from "../../src/db.js";
import type { PushSender } from "../../src/push/push.js";

const START = Date.parse("2026-06-01T15:00:00.000Z");
const TOKEN = "a".repeat(32);
const WRONG = "b".repeat(32);

/** Modernizr's 1x1 lossless WebP. */
const WEBP = Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64");
/** SOI + APP0/JFIF header + EOI. The server only checks the magic bytes. */
const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);

type Hit = { status: number; headers: Headers; json: unknown; body: Buffer };

type Ctx = {
  port: number;
  db: DatabaseSync;
  root: string;
  avatarDir: string;
  logs: string[];
  errors: string[];
  at: (ms: number) => void;
};

test.describe("admin avatar export", { concurrency: 1 }, () => {
  test("stays hidden when ADMIN_TOKEN is unset or too short", async () => {
    await withFileApp({}, async ({ port, db, avatarDir, logs }) => {
      const id = addUser(db, "Ada");
      await writeAvatarFile(avatarDir, id, WEBP);
      for (const pathname of ["/api/admin/avatars", `/api/admin/avatars/${id}`]) {
        const bare = await hit(port, "GET", pathname);
        const bearer = await hit(port, "GET", pathname, { token: TOKEN });
        for (const response of [bare, bearer]) {
          assert.equal(response.status, 404, pathname);
          assert.deepEqual(response.json, { error: "not found" });
        }
      }
      assert.equal(logs.some((line) => line.includes("admin")), false);
    });

    const short = "c".repeat(31);
    await withFileApp({ ADMIN_TOKEN: short }, async ({ port, db, avatarDir, logs }) => {
      const id = addUser(db, "Ada");
      await writeAvatarFile(avatarDir, id, WEBP);
      for (const pathname of ["/api/admin/avatars", `/api/admin/avatars/${id}`]) {
        const response = await hit(port, "GET", pathname, { token: short });
        assert.equal(response.status, 404, pathname);
        assert.deepEqual(response.json, { error: "not found" });
      }
      assert.equal(logs.some((line) => line.includes("admin")), false);
    });
  });

  test("a missing or wrong token is a 404 and counts toward the shared limiter", async () => {
    await withFileApp({ ADMIN_TOKEN: TOKEN }, async ({ port, db, avatarDir, logs, errors }) => {
      const id = addUser(db, "Ada");
      await writeAvatarFile(avatarDir, id, WEBP);
      const missing = await hit(port, "GET", "/api/admin/avatars");
      const wrong = await hit(port, "GET", `/api/admin/avatars/${id}`, { token: WRONG });
      for (const response of [missing, wrong]) {
        assert.equal(response.status, 404);
        assert.deepEqual(response.json, { error: "not found" });
        assert.equal(response.body.includes(WEBP), false);
      }
      assert.equal(adminFailureSlots(), 1);
      assert.deepEqual(logs, ["admin query denied", "admin query denied"]);
      assert.equal(errors.length, 0);
      assert.equal(logs.some((line) => line.includes(TOKEN)), false);
    });
  });

  test("failures on avatars and query share one lockout per address", async () => {
    await withFileApp({ ADMIN_TOKEN: TOKEN }, async ({ port, db, avatarDir, logs, at }) => {
      const id = addUser(db, "Ada");
      await writeAvatarFile(avatarDir, id, WEBP);
      const locked = { "x-forwarded-for": "198.51.100.10" };
      const other = { "x-forwarded-for": "203.0.113.20" };
      for (let i = 0; i < 4; i += 1) {
        const denied = await hit(port, "GET", "/api/admin/avatars", { token: WRONG, headers: locked });
        assert.equal(denied.status, 404);
      }
      for (let i = 0; i < 4; i += 1) {
        const denied = await hit(port, "POST", "/api/admin/query", {
          token: WRONG,
          body: { sql: "SELECT 1" },
          headers: locked,
        });
        assert.equal(denied.status, 404);
      }
      assert.equal(adminFailureSlots(), 1);

      const stillWrong = await hit(port, "GET", `/api/admin/avatars/${id}`, { token: WRONG, headers: locked });
      assert.equal(stillWrong.status, 404);
      assert.deepEqual(stillWrong.json, { error: "not found" });

      const otherOk = await hit(port, "GET", "/api/admin/avatars", { token: TOKEN, headers: other });
      assert.equal(otherOk.status, 200);
      assert.equal((otherOk.json as { avatars: unknown[] }).avatars.length, 1);

      at(START + 60_000);
      const later = await hit(port, "GET", `/api/admin/avatars/${id}`, { token: TOKEN, headers: locked });
      assert.equal(later.status, 200);
      assert.deepEqual(later.body, WEBP);
      assert.equal(adminFailureSlots(), 0);
      assert.equal(logs.some((line) => line.includes(TOKEN)), false);
    });
  });

  test("the shared limiter matches the existing query lockout", async () => {
    await withFileApp({ ADMIN_TOKEN: TOKEN }, async ({ port, db, avatarDir }) => {
      const id = addUser(db, "Ada");
      await writeAvatarFile(avatarDir, id, WEBP);
      // A correct token before the limit clears the slot, same as the query endpoint.
      for (let i = 0; i < 7; i += 1) {
        assert.equal((await hit(port, "GET", "/api/admin/avatars", { token: WRONG })).status, 404);
      }
      assert.equal((await hit(port, "GET", "/api/admin/avatars", { token: TOKEN })).status, 200);
      assert.equal(adminFailureSlots(), 0);
      for (let i = 0; i < 8; i += 1) {
        assert.equal((await hit(port, "GET", "/api/admin/avatars", { token: WRONG })).status, 404);
      }
      assert.equal(adminFailureSlots(), 1);
    });
  });

  test("lists stored photos and downloads exact bytes with no-store", async () => {
    await withFileApp({ ADMIN_TOKEN: TOKEN }, async ({ port, db, avatarDir, logs, errors }) => {
      const ada = addUser(db, "Ada");
      const bea = addUser(db, "Bea");
      await writeAvatarFile(avatarDir, ada, WEBP);
      const adaRev = bumpAvatarRev(db, ada, START);
      await writeAvatarFile(avatarDir, bea, JPEG);
      const beaRev = bumpAvatarRev(db, bea, START + 5_000);

      const list = await hit(port, "GET", "/api/admin/avatars", { token: TOKEN });
      assert.equal(list.status, 200);
      assert.equal(list.headers.get("cache-control"), "no-store");
      const avatars = (list.json as { avatars: Array<Record<string, unknown>> }).avatars;
      const byId = new Map(avatars.map((entry) => [entry.id, entry]));
      assert.equal(avatars.length, 2);
      assert.deepEqual(byId.get(ada), { id: ada, avatarRev: adaRev, mime: "image/webp", bytes: WEBP.length });
      assert.deepEqual(byId.get(bea), { id: bea, avatarRev: beaRev, mime: "image/jpeg", bytes: JPEG.length });
      assert.equal(list.text().includes("Ada"), false);
      assert.equal(list.text().includes("Bea"), false);

      const webp = await hit(port, "GET", `/api/admin/avatars/${ada}`, { token: TOKEN });
      assert.equal(webp.status, 200);
      assert.deepEqual(webp.body, WEBP);
      assert.equal(webp.headers.get("content-type"), "image/webp");
      assert.equal(webp.headers.get("content-length"), String(WEBP.length));
      assert.equal(webp.headers.get("cache-control"), "no-store");
      assert.equal(webp.headers.get("x-content-type-options"), "nosniff");
      assert.equal(webp.headers.get("etag"), null);

      const jpeg = await hit(port, "GET", `/api/admin/avatars/${bea.toUpperCase()}`, { token: TOKEN });
      assert.equal(jpeg.status, 200);
      assert.deepEqual(jpeg.body, JPEG);
      assert.equal(jpeg.headers.get("content-type"), "image/jpeg");
      assert.equal(jpeg.headers.get("cache-control"), "no-store");

      const head = await hit(port, "HEAD", `/api/admin/avatars/${ada}`, { token: TOKEN });
      assert.equal(head.status, 200);
      assert.equal(head.body.length, 0);
      assert.equal(head.headers.get("content-length"), String(WEBP.length));

      // Read only: the files are untouched.
      assert.deepEqual(fs.readFileSync(path.join(avatarDir, `${ada}.webp`)), WEBP);
      assert.deepEqual(fs.readFileSync(path.join(avatarDir, `${bea}.jpg`)), JPEG);
      assert.deepEqual(fs.readdirSync(avatarDir).sort(), [`${ada}.webp`, `${bea}.jpg`].sort());
      assert.equal(errors.length, 0);
      assert.equal(logs.some((line) => line.includes(TOKEN)), false);
    });
  });

  test("an empty store is an empty list and a user without a photo is left out", async () => {
    await withFileApp({ ADMIN_TOKEN: TOKEN }, async ({ port, db, avatarDir }) => {
      const empty = await hit(port, "GET", "/api/admin/avatars", { token: TOKEN });
      assert.equal(empty.status, 200);
      assert.deepEqual(empty.json, { avatars: [] });

      const ada = addUser(db, "Ada");
      const plain = addUser(db, "Cy");
      // A rev with no file on disk is not a backup candidate either.
      const ghost = addUser(db, "Dee");
      bumpAvatarRev(db, ghost, START);
      await writeAvatarFile(avatarDir, ada, WEBP);

      const list = await hit(port, "GET", "/api/admin/avatars", { token: TOKEN });
      assert.equal(list.status, 200);
      assert.deepEqual(list.json, { avatars: [{ id: ada, avatarRev: null, mime: "image/webp", bytes: WEBP.length }] });
      const ids = (list.json as { avatars: Array<{ id: string }> }).avatars.map((entry) => entry.id);
      assert.equal(ids.includes(plain), false);
      assert.equal(ids.includes(ghost), false);
    });
  });

  test("a bad id is a 404 and never reads outside the avatar dir", async () => {
    await withFileApp({ ADMIN_TOKEN: TOKEN }, async ({ port, root, logs }) => {
      fs.writeFileSync(path.join(root, "secret.webp"), WEBP);
      fs.writeFileSync(path.join(root, "secret.jpg"), JPEG);
      const bad = [
        "/api/admin/avatars/foo",
        "/api/admin/avatars/",
        "/api/admin/avatars/..%2Fsecret",
        "/api/admin/avatars/%2E%2E%2Fsecret",
        "/api/admin/avatars/..%2F..%2Fetc%2Fpasswd",
        "/api/admin/avatars/%",
        `/api/admin/avatars/${crypto.randomUUID()}%2F..%2F..%2Fsecret`,
      ];
      for (const pathname of bad) {
        const response = await hit(port, "GET", pathname, { token: TOKEN });
        assert.equal(response.status, 404, pathname);
        assert.deepEqual(response.json, { error: "not found" }, pathname);
        assert.equal(response.body.includes(WEBP), false, pathname);
        assert.equal(response.body.includes(JPEG), false, pathname);
      }
      assert.equal(logs.some((line) => line.includes(TOKEN)), false);
    });
  });

  test("a valid id with no photo or no user is a 404", async () => {
    await withFileApp({ ADMIN_TOKEN: TOKEN }, async ({ port, db, avatarDir }) => {
      const plain = addUser(db, "Cy");
      const stranger = crypto.randomUUID();
      // A file for an id that is not a user is not served.
      await writeAvatarFile(avatarDir, stranger, WEBP);
      for (const id of [plain, stranger, crypto.randomUUID()]) {
        const response = await hit(port, "GET", `/api/admin/avatars/${id}`, { token: TOKEN });
        assert.equal(response.status, 404, id);
        assert.deepEqual(response.json, { error: "not found" });
      }
    });
  });

  test("only GET and HEAD are served", async () => {
    await withFileApp({ ADMIN_TOKEN: TOKEN }, async ({ port, db, avatarDir }) => {
      const ada = addUser(db, "Ada");
      await writeAvatarFile(avatarDir, ada, WEBP);
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        for (const pathname of ["/api/admin/avatars", `/api/admin/avatars/${ada}`]) {
          const response = await hit(port, method, pathname, { token: TOKEN, body: {} });
          assert.equal(response.status, 404, `${method} ${pathname}`);
          assert.deepEqual(response.json, { error: "not found" });
        }
      }
      assert.deepEqual(fs.readFileSync(path.join(avatarDir, `${ada}.webp`)), WEBP);
    });
  });
});

function addUser(db: DatabaseSync, name: string): string {
  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO users (id, name, token_hash, buzz_token, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, name, `hash-${id}`, `BUZZ-${id}`, START);
  return id;
}

async function withFileApp(env: NodeJS.ProcessEnv, fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  resetAdminFailures();
  closeAdminReaders();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hangry-admin-avatars-"));
  const file = path.join(root, "app.sqlite");
  const db = openDb(file);
  const config = loadConfig({ PORT: "3000", APP_TZ: "UTC", DB_PATH: file, ...env });
  assert.equal(config.avatarDir, path.join(root, "avatars"));
  let now = START;
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((part) => String(part)).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map((part) => String(part)).join(" "));
  };
  const push: PushSender = { async send() {} };
  const server = http.createServer(createApp({ db, push, config, now: () => now }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn({ port, db, root, avatarDir: config.avatarDir, logs, errors, at(ms) { now = ms; } });
  } finally {
    console.log = originalLog;
    console.error = originalError;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeAdminReaders();
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** Raw http so a path like /../ reaches the server as sent, not normalised by fetch. */
function hit(
  port: number,
  method: string,
  pathname: string,
  options: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Hit & { text: () => string }> {
  const payload = options.body !== undefined ? JSON.stringify(options.body) : undefined;
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      method,
      path: pathname,
      headers: {
        ...(options.headers ?? {}),
        ...(payload !== undefined ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks);
        const headers = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : String(value));
        }
        const type = headers.get("content-type") ?? "";
        let json: unknown = null;
        if (type.startsWith("application/json") && body.length) json = JSON.parse(body.toString("utf8"));
        resolve({ status: res.statusCode ?? 0, headers, json, body, text: () => body.toString("utf8") });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
