import { spawn } from "node:child_process";
import crypto from "node:crypto";
import type http from "node:http";
import { clientKey } from "./client-key.js";

export const ADMIN_TOKEN_MIN = 32;
export const ADMIN_ROW_CAP = 500;
export const ADMIN_SQL_MAX = 4_000;
export const ADMIN_FAIL_LIMIT = 8;
export const ADMIN_FAIL_WINDOW_MS = 60_000;
const ADMIN_BUSY_MS = 1_000;
const ADMIN_DEADLINE_MS = 1_000;

const READ_PRAGMAS = new Set([
  "table_info",
  "table_xinfo",
  "table_list",
  "index_list",
  "index_info",
  "index_xinfo",
  "foreign_key_list",
  "database_list",
]);

const failures = new Map<string, { count: number; resetAt: number }>();

export class AdminQueryTimeout extends Error {
  constructor() {
    super("timeout");
    this.name = "AdminQueryTimeout";
  }
}

/** SQLite rejected a statement that the allowlist had already accepted. */
export class AdminQueryFailed extends Error {
  constructor() {
    super("query failed");
    this.name = "AdminQueryFailed";
  }
}

export function configuredAdminToken(value: string | undefined): string | null {
  const token = value?.trim() ?? "";
  if (token.length < ADMIN_TOKEN_MIN) return null;
  return token;
}

export function adminTokensMatch(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    crypto.timingSafeEqual(b, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

export function resetAdminFailures(): void {
  failures.clear();
}

export function closeAdminReaders(): void {
  // Queries open their own short-lived process. Nothing is cached on the server.
}

/** Client address for the failure limiter. See clientKey for which X-Forwarded-For hop is trusted. */
export function adminFailureKey(req: http.IncomingMessage): string {
  return clientKey(req);
}

function pruneAdminFailures(now: number): void {
  for (const [key, slot] of failures) {
    if (now >= slot.resetAt) failures.delete(key);
  }
}

export function adminFailureSlots(): number {
  return failures.size;
}

export function adminFailuresOpen(key: string, now: number): boolean {
  pruneAdminFailures(now);
  const slot = failures.get(key);
  if (!slot) return true;
  return slot.count < ADMIN_FAIL_LIMIT;
}

export function noteAdminFailure(key: string, now: number): void {
  pruneAdminFailures(now);
  const slot = failures.get(key);
  if (!slot) {
    failures.set(key, { count: 1, resetAt: now + ADMIN_FAIL_WINDOW_MS });
    return;
  }
  slot.count += 1;
}

export function clearAdminFailures(key: string): void {
  failures.delete(key);
}

export function bearerToken(header: string | string[] | undefined): string {
  const raw = Array.isArray(header) ? header[0] ?? "" : header ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(raw.trim());
  return match?.[1] ?? "";
}

/** One SELECT, WITH … SELECT, or read-only schema PRAGMA. No second statement. */
export function assertSingleRead(sql: string): void {
  const text = sql.trim();
  if (!text || text.length > ADMIN_SQL_MAX) throw new Error("query is not allowed");
  if (text.includes("\0")) throw new Error("query is not allowed");
  if (hasExtraStatement(text)) throw new Error("query is not allowed");
  const word = /^([a-z]+)/i.exec(text)?.[1]?.toLowerCase() ?? "";
  if (word === "select") return;
  if (word === "with") {
    if (/\b(insert|update|delete|replace)\b/i.test(text)) throw new Error("query is not allowed");
    return;
  }
  if (word === "pragma") {
    if (text.includes("=")) throw new Error("query is not allowed");
    const name = /^pragma\s+([a-z_]+)/i.exec(text)?.[1]?.toLowerCase() ?? "";
    if (!READ_PRAGMAS.has(name)) throw new Error("query is not allowed");
    return;
  }
  throw new Error("query is not allowed");
}

function hasExtraStatement(sql: string): boolean {
  let quote: "'" | '"' | "`" | null = null;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (quote) {
      if (ch === quote) {
        if (sql[i + 1] === quote) i += 1;
        else quote = null;
      }
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i + 2);
      i = nl === -1 ? sql.length : nl;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) return true;
      i = end + 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === ";" && remainderHasSql(sql.slice(i + 1))) return true;
  }
  return false;
}

/** True when anything after a semicolon is still SQL, not just a trailing comment. */
function remainderHasSql(rest: string): boolean {
  let i = 0;
  while (i < rest.length) {
    const ch = rest[i];
    if (ch === " " || ch === "\n" || ch === "\r" || ch === "\t" || ch === "\f") {
      i += 1;
      continue;
    }
    if (ch === "-" && rest[i + 1] === "-") {
      const nl = rest.indexOf("\n", i + 2);
      if (nl === -1) return false;
      i = nl + 1;
      continue;
    }
    if (ch === "/" && rest[i + 1] === "*") {
      const end = rest.indexOf("*/", i + 2);
      if (end === -1) return true;
      i = end + 2;
      continue;
    }
    return true;
  }
  return false;
}

export type AdminRows = { columns: string[]; rows: unknown[][]; truncated: boolean };

/**
 * node:sqlite cannot interrupt a statement, and worker.terminate waits out the
 * native call. The query runs in a child process that is killed at the deadline,
 * so the server stays responsive and a timeout is not a partial result.
 */
const ADMIN_CHILD = `
import { DatabaseSync } from "node:sqlite";
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
function fail(kind) {
  process.stdout.write(JSON.stringify({ ok: false, kind }));
}
function jsonValue(value) {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  return value ?? null;
}
try {
  const db = new DatabaseSync(input.dbPath, { readOnly: true, timeout: ${ADMIN_BUSY_MS} });
  let stmt;
  try {
    stmt = db.prepare(input.sql);
  } catch {
    fail("failed");
    db.close();
    process.exit(0);
  }
  const columns = stmt.columns().map((column) => column.name);
  const reader = stmt.reader;
  if (typeof reader === "boolean" ? reader === false : columns.length === 0) {
    fail("denied");
    db.close();
    process.exit(0);
  }
  const rows = [];
  let truncated = false;
  try {
    for (const row of stmt.iterate(...input.params)) {
      if (rows.length >= input.rowCap) {
        truncated = true;
        break;
      }
      rows.push(columns.map((name) => jsonValue(row[name])));
    }
  } catch {
    fail("failed");
    db.close();
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({ ok: true, columns, rows, truncated }));
  db.close();
} catch {
  fail("failed");
}
`;

export async function runReadQuery(dbPath: string, sql: string, params: unknown[]): Promise<AdminRows> {
  assertSingleRead(sql);
  const values = readParams(params);
  return runChildQuery(dbPath, sql, values);
}

export async function readSchema(dbPath: string): Promise<Array<{ name: string; sql: string }>> {
  const result = await runReadQuery(
    dbPath,
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    [],
  );
  return result.rows.map((row) => ({ name: String(row[0] ?? ""), sql: String(row[1] ?? "") }));
}

function runChildQuery(
  dbPath: string,
  sql: string,
  params: Array<string | number | null | bigint>,
): Promise<AdminRows> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--disable-warning=ExperimentalWarning",
      "--input-type=module",
      "--eval",
      ADMIN_CHILD,
    ], { stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      done(() => {
        child.kill("SIGKILL");
        reject(new AdminQueryTimeout());
      });
    }, ADMIN_DEADLINE_MS);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
    });
    child.stdout.on("error", () => {});
    child.on("error", () => done(() => reject(new AdminQueryFailed())));
    child.on("exit", () => {
      done(() => {
        let message: { ok?: boolean; kind?: string; columns?: string[]; rows?: unknown[][]; truncated?: boolean };
        try {
          message = JSON.parse(out) as typeof message;
        } catch {
          reject(new AdminQueryFailed());
          return;
        }
        if (message.ok) {
          resolve({
            columns: message.columns ?? [],
            rows: message.rows ?? [],
            truncated: Boolean(message.truncated),
          });
          return;
        }
        if (message.kind === "failed") reject(new AdminQueryFailed());
        else reject(new Error("query is not allowed"));
      });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ dbPath, sql, params, rowCap: ADMIN_ROW_CAP }));
  });
}

function readParams(params: unknown[]): Array<string | number | null | bigint> {
  if (params.length > 32) throw new Error("query is not allowed");
  return params.map((value) => {
    if (value === null) return null;
    if (typeof value === "string") {
      if (value.length > 10_000) throw new Error("query is not allowed");
      return value;
    }
    if (typeof value === "boolean") return value ? 1 : 0;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error("query is not allowed");
      return value;
    }
    throw new Error("query is not allowed");
  });
}

