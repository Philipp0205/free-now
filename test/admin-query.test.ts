import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  adminFailureSlots,
  adminTokensMatch,
  closeAdminReaders,
  configuredAdminToken,
  resetAdminFailures,
} from "../src/admin-query.js";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import type { PushSender } from "../src/push.js";

const START = Date.parse("2026-06-01T15:00:00.000Z");
const TOKEN = "a".repeat(32);

type Hit = { status: number; headers: Headers; json: unknown; text: string };

type Ctx = {
  port: number;
  db: DatabaseSync;
  file: string;
  logs: string[];
  errors: string[];
  at: (ms: number) => void;
};

test("admin token is ignored until it is 32 characters", () => {
  assert.equal(configuredAdminToken(undefined), null);
  assert.equal(configuredAdminToken("  short  "), null);
  assert.equal(configuredAdminToken("b".repeat(31)), null);
  assert.equal(configuredAdminToken(` ${TOKEN} `), TOKEN);
  assert.equal(adminTokensMatch(TOKEN, TOKEN), true);
  assert.equal(adminTokensMatch("b".repeat(32), TOKEN), false);
  assert.equal(adminTokensMatch("short", TOKEN), false);
});

test.describe("admin database endpoint", { concurrency: 1 }, () => {
  test("stays hidden when ADMIN_TOKEN is unset or too short", async () => {
    await withFileApp({}, async ({ port, logs }) => {
      const query = await hit(port, "POST", "/api/admin/query", { body: { sql: "SELECT 1" } });
      const schema = await hit(port, "GET", "/api/admin/schema", { token: TOKEN });
      assert.equal(query.status, 404);
      assert.deepEqual(query.json, { error: "not found" });
      assert.equal(schema.status, 404);
      assert.deepEqual(schema.json, { error: "not found" });
      assert.equal(logs.some((line) => line.includes("admin query")), false);
    });

    const short = "c".repeat(31);
    await withFileApp({ ADMIN_TOKEN: short }, async ({ port, logs }) => {
      const query = await hit(port, "POST", "/api/admin/query", {
        token: short,
        body: { sql: "SELECT 1" },
      });
      assert.equal(query.status, 404);
      assert.deepEqual(query.json, { error: "not found" });
      assert.equal(logs.some((line) => line.includes("admin query")), false);
    });
  });

  test("a missing or wrong token is a 404 and is not logged", async () => {
    await withFileApp({ ADMIN_TOKEN: TOKEN }, async ({ port, logs, errors }) => {
      const missing = await hit(port, "POST", "/api/admin/query", { body: { sql: "SELECT 1" } });
      const wrong = await hit(port, "GET", "/api/admin/schema", { token: "b".repeat(32) });
      assert.equal(missing.status, 404);
      assert.deepEqual(missing.json, { error: "not found" });
      assert.equal(wrong.status, 404);
      assert.deepEqual(wrong.json, { error: "not found" });
      assert.deepEqual(logs, ["admin query denied", "admin query denied"]);
      assert.equal(errors.length, 0);
      assert.equal(logs.some((line) => line.includes(TOKEN)), false);
    });
  });

  test("write and multi-statement SQL is rejected and the database stays unchanged", async () => {
    await withFileApp({ ADMIN_TOKEN: TOKEN }, async ({ port, db, file, logs, errors }) => {
      db.prepare(
        "INSERT INTO users (id, name, token_hash, buzz_token, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run("u1", "Ada", "hash-1", "BUZZ1", START);
      const attached = path.join(path.dirname(file), "attached.sqlite");
      const writes = [
        "INSERT INTO users (id, name, token_hash, buzz_token, created_at) VALUES ('x', 'x', 'x', 'x', 1)",
        "UPDATE users SET name = 'hacked'",
        "DELETE FROM users",
        `ATTACH DATABASE '${attached}' AS extra`,
        "SELECT 1; SELECT 2",
        "SELECT 1; -- hide\nDELETE FROM users",
        "WITH c AS (SELECT 1) INSERT INTO users (id, name, token_hash, buzz_token, created_at) SELECT 'z', 'z', 'z', 'z', 1",
      ];
      for (const sql of writes) {
        const response = await hit(port, "POST", "/api/admin/query", {
          token: TOKEN,
          body: { sql },
        });
        assert.equal(response.status, 400, sql);
        assert.deepEqual(response.json, { error: "query is not allowed" });
      }
      assert.equal(userCount(db), 1);
      assert.equal(userName(db), "Ada");
      assert.equal(fs.existsSync(attached), false);
      assert.equal(logs.every((line) => line === "admin query denied"), true);
      assert.equal(logs.length, writes.length);
      const leaked = logs.join("\n") + errors.join("\n");
      assert.equal(leaked.includes("hacked"), false);
      assert.equal(leaked.includes("ATTACH"), false);
      assert.equal(leaked.includes(TOKEN), false);
      assert.equal(errors.length, 0);

      const reader = new DatabaseSync(file, { readOnly: true });
      try {
        assert.throws(
          () => reader.exec("UPDATE users SET name = 'hacked'"),
          /readonly/i,
        );
      } finally {
        reader.close();
      }
      assert.equal(userName(db), "Ada");
    });
  });

  test("a select returns columns and rows with no-store and no CORS", async () => {
    await withFileApp({ ADMIN_TOKEN: TOKEN }, async ({ port, db, logs, errors }) => {
      db.prepare(
        "INSERT INTO users (id, name, token_hash, buzz_token, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run("u1", "Ada", "hash-1", "BUZZ1", START);
      const response = await hit(port, "POST", "/api/admin/query", {
        token: TOKEN,
        body: { sql: "SELECT name, ';' AS semi FROM users WHERE name = ?", params: ["Ada"] },
      });
      assert.equal(response.status, 200);
      assert.deepEqual(response.json, { columns: ["name", "semi"], rows: [["Ada", ";"]], truncated: false });
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("access-control-allow-origin"), null);
      assert.deepEqual(logs, ["admin query ok rows=1"]);
      assert.equal(logs.some((line) => line.includes("Ada") || line.includes(TOKEN) || line.includes("SELECT")), false);
      assert.equal(errors.length, 0);

      db.prepare(
        "INSERT INTO users (id, name, token_hash, buzz_token, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run("u2", "Bea", "hash-2", "BUZZ2", START);
      const again = await hit(port, "POST", "/api/admin/query", {
        token: TOKEN,
        body: { sql: "SELECT name FROM users ORDER BY name" },
      });
      assert.deepEqual(again.json, { columns: ["name"], rows: [["Ada"], ["Bea"]], truncated: false });

      const info = await hit(port, "POST", "/api/admin/query", {
        token: TOKEN,
        body: { sql: "PRAGMA table_info(users)" },
      });
      assert.equal(info.status, 200);
      const infoBody = info.json as { columns: string[]; rows: unknown[][] };
      assert.ok(infoBody.columns.includes("name"));
      assert.ok(infoBody.rows.some((row) => row.includes("id")));

      const wrongMethod = await hit(port, "GET", "/api/admin/query", { token: TOKEN });
      assert.equal(wrongMethod.status, 404);
    });
  });

  test("results stop at 500 rows", async () => {
    await withFileApp({ ADMIN_TOKEN: TOKEN }, async ({ port, logs }) => {
      const response = await hit(port, "POST", "/api/admin/query", {
        token: TOKEN,
        body: {
          sql: "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n < 600) SELECT n FROM c",
        },
      });
      assert.equal(response.status, 200);
      const body = response.json as { columns: string[]; rows: unknown[][] };
      assert.deepEqual(body.columns, ["n"]);
      assert.equal(body.rows.length, 500);
      assert.equal((response.json as { truncated: boolean }).truncated, true);
      assert.deepEqual(body.rows[0], [1]);
      assert.deepEqual(body.rows[499], [500]);
      assert.ok(logs.includes("admin query ok rows=500"));
    });
  });

  test("schema lists tables and their CREATE statements", async () => {
    await withFileApp({ ADMIN_TOKEN: TOKEN }, async ({ port, logs }) => {
      const response = await hit(port, "GET", "/api/admin/schema", { token: TOKEN });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("access-control-allow-origin"), null);
      const body = response.json as { tables: Array<{ name: string; sql: string }> };
      const users = body.tables.find((table) => table.name === "users");
      assert.ok(users);
      assert.match(users.sql, /CREATE TABLE/i);
      assert.match(users.sql, /\bname\b/);
      assert.equal(body.tables.some((table) => table.name.startsWith("sqlite_")), false);
      assert.deepEqual(logs, [`admin query ok rows=${body.tables.length}`]);

      const post = await hit(port, "POST", "/api/admin/schema", { token: TOKEN, body: {} });
      assert.equal(post.status, 404);
    });
  });

  test("eight failures lock the address out until the window passes", async () => {
    await withFileApp({ ADMIN_TOKEN: TOKEN }, async ({ port, logs, at }) => {
      for (let i = 0; i < 8; i += 1) {
        const denied = await hit(port, "POST", "/api/admin/query", {
          token: "b".repeat(32),
          body: { sql: "SELECT 1" },
        });
        assert.equal(denied.status, 404);
      }
      const stillWrong = await hit(port, "POST", "/api/admin/query", {
        token: "b".repeat(32),
        body: { sql: "SELECT 1" },
      });
      assert.equal(stillWrong.status, 404);
      const open = await hit(port, "POST", "/api/admin/query", {
        token: TOKEN,
        body: { sql: "SELECT 1 AS ok" },
      });
      assert.equal(open.status, 200);
      assert.deepEqual(open.json, { columns: ["ok"], rows: [[1]], truncated: false });
      assert.equal(logs.every((line) => line === "admin query denied" || line === "admin query ok rows=1"), true);
      assert.equal(logs.at(-1), "admin query ok rows=1");
      assert.equal(logs.some((line) => line.includes(TOKEN)), false);

      at(START + 60_000);
      const again = await hit(port, "POST", "/api/admin/query", {
        token: "b".repeat(32),
        body: { sql: "SELECT 1" },
      });
      assert.equal(again.status, 404);
      assert.equal(adminFailureSlots(), 1);
    });
  });

  test("the failure limit follows the rightmost forwarded address", async () => {
    await withFileApp({ ADMIN_TOKEN: TOKEN }, async ({ port }) => {
      for (let i = 0; i < 8; i += 1) {
        const denied = await hit(port, "POST", "/api/admin/query", {
          token: "b".repeat(32),
          body: { sql: "SELECT 1" },
          headers: { "x-forwarded-for": "203.0.113.9, 198.51.100.10" },
        });
        assert.equal(denied.status, 404);
      }
      assert.equal(adminFailureSlots(), 1);
      const locked = await hit(port, "POST", "/api/admin/query", {
        token: "b".repeat(32),
        body: { sql: "SELECT 1" },
        headers: { "x-forwarded-for": "198.51.100.10" },
      });
      assert.equal(locked.status, 404);
      assert.equal(adminFailureSlots(), 1);
      const other = await hit(port, "POST", "/api/admin/query", {
        token: "b".repeat(32),
        body: { sql: "SELECT 1" },
        headers: { "x-forwarded-for": "203.0.113.20" },
      });
      assert.equal(other.status, 404);
      assert.equal(adminFailureSlots(), 2);
      const allowed = await hit(port, "POST", "/api/admin/query", {
        token: TOKEN,
        body: { sql: "SELECT 1 AS ok" },
        headers: { "x-forwarded-for": "198.51.100.10" },
      });
      assert.equal(allowed.status, 200);
      const otherStillOpen = await hit(port, "POST", "/api/admin/query", {
        token: TOKEN,
        body: { sql: "SELECT 1 AS ok" },
        headers: { "x-forwarded-for": "203.0.113.20" },
      });
      assert.equal(otherStillOpen.status, 200);
    });
  });

  test("expired failure records are dropped", async () => {
    await withFileApp({ ADMIN_TOKEN: TOKEN }, async ({ port, at }) => {
      for (const address of ["198.51.100.1", "198.51.100.2"]) {
        const denied = await hit(port, "POST", "/api/admin/query", {
          token: "b".repeat(32),
          body: { sql: "SELECT 1" },
          headers: { "x-forwarded-for": address },
        });
        assert.equal(denied.status, 404);
      }
      assert.equal(adminFailureSlots(), 2);
      at(START + 60_000);
      const later = await hit(port, "POST", "/api/admin/query", {
        token: "b".repeat(32),
        body: { sql: "SELECT 1" },
        headers: { "x-forwarded-for": "198.51.100.3" },
      });
      assert.equal(later.status, 404);
      assert.equal(adminFailureSlots(), 1);
    });
  });

  test("a sql failure is logged apart from a denied token", async () => {
    await withFileApp({ ADMIN_TOKEN: TOKEN }, async ({ port, logs }) => {
      const response = await hit(port, "POST", "/api/admin/query", {
        token: TOKEN,
        body: { sql: "SELECT * FROM not_a_table" },
      });
      assert.equal(response.status, 400);
      assert.deepEqual(response.json, { error: "query is not allowed" });
      assert.ok(logs.includes("admin query error"));
      assert.equal(logs.some((line) => line.includes("not_a_table") || line.includes(TOKEN) || line.includes("SELECT")), false);
    });
  });

  test("a heavy query times out and health stays responsive", async () => {
    await withFileApp({ ADMIN_TOKEN: TOKEN }, async ({ port, logs }) => {
      const query = hit(port, "POST", "/api/admin/query", {
        token: TOKEN,
        body: {
          sql: "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n < 40000000) SELECT COUNT(*) AS n FROM c",
        },
      });
      const started = Date.now();
      const health = await hit(port, "GET", "/api/health");
      const waited = Date.now() - started;
      assert.equal(health.status, 200);
      assert.ok(waited < 400, `health took ${waited}ms`);
      const response = await query;
      assert.equal(response.status, 408);
      assert.deepEqual(response.json, { error: "timeout" });
      assert.equal("rows" in (response.json as object), false);
      assert.ok(logs.includes("admin query timeout"));
      assert.equal(logs.some((line) => line.includes("RECURSIVE") || line.includes(TOKEN)), false);
    });
  });
});

async function withFileApp(env: NodeJS.ProcessEnv, fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  resetAdminFailures();
  closeAdminReaders();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hangry-admin-"));
  const file = path.join(dir, "app.sqlite");
  const db = openDb(file);
  const config = loadConfig({ PORT: "3000", APP_TZ: "UTC", DB_PATH: file, ...env });
  assert.equal(config.dbPath, file);
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
    await fn({ port, db, file, logs, errors, at(ms) { now = ms; } });
  } finally {
    console.log = originalLog;
    console.error = originalError;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeAdminReaders();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function hit(
  port: number,
  method: string,
  pathname: string,
  options: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Hit> {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: {
      ...(options.headers ?? {}),
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    text,
    json: text ? JSON.parse(text) as unknown : null,
  };
}

function userCount(db: DatabaseSync): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
  return row.n;
}

function userName(db: DatabaseSync): string {
  const row = db.prepare("SELECT name FROM users").get() as { name: string };
  return row.name;
}
