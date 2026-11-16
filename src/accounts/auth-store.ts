import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AuthStore, AuthUser } from "../app-kit/auth.ts";
import { humanCode } from "../social/code.js";

type Row = { id: string; name: string; email: string | null; email_verified_at: number | null };

function toUser(row: unknown): AuthUser | undefined {
  if (!row) return undefined;
  const r = row as Row;
  return { id: r.id, name: r.name, email: r.email ?? null, emailVerifiedAt: r.email_verified_at ?? null };
}

const COLUMNS = "u.id, u.name, u.email, u.email_verified_at";

/** The kit's AuthStore over Hangry's users, sessions and auth_links tables. */
export function createAuthStore(db: DatabaseSync): AuthStore {
  return {
    insertUser({ id, name, email, recoveryHash, createdAt }) {
      // token_hash is the legacy single-session column. Nobody holds its preimage: real sessions
      // live in the sessions table. buzz_token is the Flic link secret, independent of the recovery code.
      const deadHash = crypto.randomBytes(32).toString("hex");
      db.prepare(
        "INSERT INTO users (id, name, token_hash, buzz_token, recovery_hash, email, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(id, name, deadHash, humanCode(), recoveryHash, email, createdAt);
    },
    findUserById(id) {
      return toUser(db.prepare(`SELECT ${COLUMNS} FROM users u WHERE u.id = ?`).get(id));
    },
    findUserByRecoveryHash(hash) {
      return toUser(db.prepare(`SELECT ${COLUMNS} FROM users u WHERE u.recovery_hash = ?`).get(hash));
    },
    findUserByVerifiedEmail(email) {
      return toUser(
        db.prepare(`SELECT ${COLUMNS} FROM users u WHERE u.email = ? AND u.email_verified_at IS NOT NULL`).get(email),
      );
    },
    setRecoveryHash(userId, hash) {
      db.prepare("UPDATE users SET recovery_hash = ? WHERE id = ?").run(hash, userId);
    },
    setEmail(userId, email) {
      db.prepare("UPDATE users SET email = ?, email_verified_at = NULL WHERE id = ?").run(email, userId);
    },
    markEmailVerified(userId, email, at) {
      try {
        const result = db
          .prepare("UPDATE users SET email_verified_at = ? WHERE id = ? AND email = ?")
          .run(at, userId, email);
        return Number(result.changes) > 0;
      } catch (error) {
        // The partial unique index on verified addresses: someone else confirmed it first.
        if (error instanceof Error && /UNIQUE constraint/i.test(error.message)) return false;
        throw error;
      }
    },
    insertSession({ userId, tokenHash, createdAt }) {
      db.prepare("INSERT INTO sessions (id, user_id, token_hash, created_at) VALUES (?, ?, ?, ?)").run(
        crypto.randomUUID(),
        userId,
        tokenHash,
        createdAt,
      );
    },
    findUserBySessionHash(tokenHash) {
      return toUser(
        db.prepare(`SELECT ${COLUMNS} FROM users u JOIN sessions s ON s.user_id = u.id WHERE s.token_hash = ?`).get(tokenHash),
      );
    },
    deleteSession(tokenHash) {
      db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
    },
    deleteSessionsForUser(userId, exceptTokenHash) {
      db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").run(userId, exceptTokenHash ?? "");
      // Old accounts keep their first session hash in users.token_hash and boot re-creates a session
      // from it when none matches. Replace it so a revoked session cannot come back.
      db.prepare("UPDATE users SET token_hash = ? WHERE id = ?").run(crypto.randomBytes(32).toString("hex"), userId);
    },
    insertLink({ tokenHash, userId, kind, email, expiresAt }) {
      db.prepare("INSERT INTO auth_links (token_hash, user_id, kind, email, expires_at) VALUES (?, ?, ?, ?, ?)").run(
        tokenHash,
        userId,
        kind,
        email,
        expiresAt,
      );
    },
    takeLink(tokenHash, kind, now) {
      const row = db
        .prepare("DELETE FROM auth_links WHERE token_hash = ? AND kind = ? RETURNING user_id, email, expires_at")
        .get(tokenHash, kind) as { user_id: string; email: string; expires_at: number } | undefined;
      if (!row || row.expires_at <= now) return undefined;
      return { userId: row.user_id, email: row.email };
    },
    deleteLinksForUser(userId, kind) {
      db.prepare("DELETE FROM auth_links WHERE user_id = ? AND kind = ?").run(userId, kind);
    },
  };
}
