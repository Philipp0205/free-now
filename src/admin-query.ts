import crypto from "node:crypto";
import http from "node:http";
import { DatabaseSync, type StatementSync } from "node:sqlite";

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

const readers = new Map<string, DatabaseSync>();
const failures = new Map<string, { count: number; resetAt: number }>();

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
  for (const db of readers.values()) db.close();
  readers.clear();
}

function readerFor(dbPath: string): DatabaseSync {
  const existing = readers.get(dbPath);
  if (existing) return existing;
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: ADMIN_BUSY_MS });
  readers.set(dbPath, db);
  return db;
}

export function adminFailureKey(req: http.IncomingMessage): string {
  return req.socket?.remoteAddress || "unknown";
}

export function adminFailuresOpen(key: string, now: number): boolean {
  const slot = failures.get(key);
  if (!slot || now >= slot.resetAt) return true;
  return slot.count < ADMIN_FAIL_LIMIT;
}

export function noteAdminFailure(key: string, now: number): void {
  const slot = failures.get(key);
  if (!slot || now >= slot.resetAt) {
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

export type AdminRows = { columns: string[]; rows: unknown[][] };

/**
 * Node 22's StatementSync does not expose `reader` yet. When it does, that flag
 * is sqlite3_stmt_readonly (false for INSERT RETURNING). Otherwise a statement
 * that returns no columns is not a read (INSERT, ATTACH, BEGIN).
 */
function isReadStatement(stmt: StatementSync): boolean {
  const flagged = (stmt as StatementSync & { reader?: boolean }).reader;
  if (typeof flagged === "boolean") return flagged;
  return stmt.columns().length > 0;
}

export function runReadQuery(dbPath: string, sql: string, params: unknown[]): AdminRows {
  assertSingleRead(sql);
  const values = readParams(params);
  const db = readerFor(dbPath);
  let stmt: StatementSync;
  try {
    stmt = db.prepare(sql);
  } catch {
    throw new Error("query is not allowed");
  }
  if (!isReadStatement(stmt)) throw new Error("query is not allowed");
  const columns = stmt.columns().map((column) => column.name);
  const rows: unknown[][] = [];
  const deadline = Date.now() + ADMIN_DEADLINE_MS;
  try {
    for (const row of stmt.iterate(...values)) {
      if (rows.length >= ADMIN_ROW_CAP || Date.now() > deadline) break;
      const record = row as Record<string, unknown>;
      rows.push(columns.map((name) => jsonValue(record[name])));
    }
  } catch {
    throw new Error("query is not allowed");
  }
  return { columns, rows };
}

export function readSchema(dbPath: string): Array<{ name: string; sql: string }> {
  const result = runReadQuery(
    dbPath,
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    [],
  );
  return result.rows.map((row) => ({ name: String(row[0] ?? ""), sql: String(row[1] ?? "") }));
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

function jsonValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  return value ?? null;
}
