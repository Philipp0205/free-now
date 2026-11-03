import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type UserRow = {
  id: string;
  name: string;
  token_hash: string;
  buzz_token: string;
  created_at: number;
};

export type CircleRow = {
  id: string;
  name: string;
  invite_code: string;
  created_by: string;
  created_at: number;
  invite_expires_at: number | null;
};

export type SocialRow = {
  id: string;
  circle_id: string;
  creator_id: string;
  creator_name: string;
  note: string;
  created_at: number;
  expires_at: number;
  last_notified_at: number;
  lat: number | null;
  lng: number | null;
  place: string;
  starts_at: number | null;
  reminded_at: number | null;
};

export type DueStartReminder = {
  id: string;
  note: string;
  place: string;
  creator_name: string;
};

export type JoinRow = {
  id: string;
  name: string;
  joined_at: number;
  reply: string;
  eta_min: number | null;
  arrive_at: number | null;
};

export type PlanRow = {
  id: string;
  circle_id: string;
  creator_id: string;
  creator_name: string;
  note: string;
  for_date: string;
  created_at: number;
  lat: number | null;
  lng: number | null;
  place: string;
  at_time: string | null;
};

export type PushSubRow = {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

export type NotificationRow = {
  id: string;
  user_id: string;
  title: string;
  body: string;
  kind: string;
  ref_id: string | null;
  created_at: number;
  read_at: number | null;
};

export type MemberRow = {
  id: string;
  name: string;
  joined_at: number;
  is_admin: number;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  buzz_token TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS circles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  invite_code TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  invite_expires_at INTEGER
);

CREATE TABLE IF NOT EXISTS memberships (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  circle_id TEXT NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS socials (
  id TEXT PRIMARY KEY,
  circle_id TEXT NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  creator_id TEXT NOT NULL REFERENCES users(id),
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_notified_at INTEGER NOT NULL,
  lat REAL,
  lng REAL,
  place TEXT NOT NULL DEFAULT '',
  starts_at INTEGER,
  reminded_at INTEGER
);

CREATE TABLE IF NOT EXISTS social_joins (
  social_id TEXT NOT NULL REFERENCES socials(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  joined_at INTEGER NOT NULL,
  reply TEXT NOT NULL DEFAULT 'join',
  eta_min INTEGER,
  arrive_at INTEGER,
  PRIMARY KEY (social_id, user_id)
);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  circle_id TEXT NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  creator_id TEXT NOT NULL REFERENCES users(id),
  note TEXT NOT NULL,
  for_date TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  lat REAL,
  lng REAL,
  place TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS plan_joins (
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  joined_at INTEGER NOT NULL,
  reply TEXT NOT NULL DEFAULT 'coming',
  arrive_at INTEGER,
  PRIMARY KEY (plan_id, user_id)
);

CREATE TABLE IF NOT EXISTS push_subs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref_id TEXT,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_membership_circle ON memberships(circle_id);
CREATE INDEX IF NOT EXISTS idx_socials_circle ON socials(circle_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_plans_circle ON plans(circle_id, for_date);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subs(user_id);
CREATE INDEX IF NOT EXISTS idx_notifs_user ON notifications(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
`;

let sqliteWarningPatched = false;

function quietSqliteWarning(): void {
  if (sqliteWarningPatched) return;
  sqliteWarningPatched = true;
  const emit = process.emit.bind(process) as (event: string | symbol, ...args: unknown[]) => boolean;
  process.emit = ((event: string | symbol, ...args: unknown[]) => {
    if (event === "warning") {
      const warning = args[0] as { message?: string } | undefined;
      if (warning?.message?.includes("SQLite is an experimental")) return false;
    }
    return emit(event, ...args);
  }) as typeof process.emit;
}

export function openDb(dbPath: string): DatabaseSync {
  quietSqliteWarning();
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  if (dbPath !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL");
  }
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA);
  ensureColumn(db, "socials", "lat", "lat REAL");
  ensureColumn(db, "socials", "lng", "lng REAL");
  ensureColumn(db, "socials", "place", "place TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "socials", "starts_at", "starts_at INTEGER");
  ensureColumn(db, "socials", "reminded_at", "reminded_at INTEGER");
  ensureColumn(db, "social_joins", "reply", "reply TEXT NOT NULL DEFAULT 'join'");
  ensureColumn(db, "social_joins", "eta_min", "eta_min INTEGER");
  ensureColumn(db, "social_joins", "arrive_at", "arrive_at INTEGER");
  ensureColumn(db, "plan_joins", "arrive_at", "arrive_at INTEGER");
  ensureColumn(db, "social_joins", "blocked", "blocked INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "plan_joins", "blocked", "blocked INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "circles", "invite_expires_at", "invite_expires_at INTEGER");
  ensureColumn(db, "memberships", "is_admin", "is_admin INTEGER NOT NULL DEFAULT 0");
  backfillCircleAdmins(db);
  db.prepare(
    "UPDATE circles SET invite_expires_at = created_at + ? WHERE invite_expires_at IS NULL",
  ).run(14 * 24 * 60 * 60 * 1000);
  ensureColumn(db, "plans", "lat", "lat REAL");
  ensureColumn(db, "plans", "lng", "lng REAL");
  ensureColumn(db, "plans", "place", "place TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "plans", "at_time", "at_time TEXT");
  ensureColumn(db, "plan_joins", "reply", "reply TEXT NOT NULL DEFAULT 'coming'");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  `);
  const missing = db.prepare(
    "SELECT id, token_hash, created_at FROM users u WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.token_hash = u.token_hash)",
  ).all() as Array<{ id: string; token_hash: string; created_at: number }>;
  const insert = db.prepare("INSERT INTO sessions (id, user_id, token_hash, created_at) VALUES (?, ?, ?, ?)");
  for (const user of missing) insert.run(crypto.randomUUID(), user.id, user.token_hash, user.created_at);
  db.prepare("UPDATE social_joins SET reply = 'coming' WHERE reply IN ('join', 'in')").run();
  return db;
}

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
  if (rows.some((row) => row.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

export function withTx(db: DatabaseSync, fn: () => void): void {
  db.exec("BEGIN");
  try {
    fn();
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already rolled back */
    }
    throw error;
  }
}

export function insertUser(db: DatabaseSync, user: UserRow): void {
  db.prepare(
    "INSERT INTO users (id, name, token_hash, buzz_token, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(user.id, user.name, user.token_hash, user.buzz_token, user.created_at);
  insertSession(db, crypto.randomUUID(), user.id, user.token_hash, user.created_at);
}

export function insertSession(db: DatabaseSync, id: string, userId: string, tokenHash: string, createdAt: number): void {
  db.prepare("INSERT INTO sessions (id, user_id, token_hash, created_at) VALUES (?, ?, ?, ?)").run(
    id,
    userId,
    tokenHash,
    createdAt,
  );
}

export function deleteSessionByHash(db: DatabaseSync, tokenHash: string): void {
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
}

export function getUserByTokenHash(db: DatabaseSync, tokenHash: string): UserRow | undefined {
  return one<UserRow>(
    db,
    `SELECT u.* FROM users u JOIN sessions s ON s.user_id = u.id WHERE s.token_hash = ?`,
    tokenHash,
  );
}

export function getUserByBuzzToken(db: DatabaseSync, buzzToken: string): UserRow | undefined {
  return one<UserRow>(db, "SELECT * FROM users WHERE buzz_token = ?", buzzToken);
}

export function getUserById(db: DatabaseSync, id: string): UserRow | undefined {
  return one<UserRow>(db, "SELECT * FROM users WHERE id = ?", id);
}

export function updateUserName(db: DatabaseSync, id: string, name: string): void {
  db.prepare("UPDATE users SET name = ? WHERE id = ?").run(name, id);
}

export function rotateBuzzToken(db: DatabaseSync, id: string, buzzToken: string): void {
  db.prepare("UPDATE users SET buzz_token = ? WHERE id = ?").run(buzzToken, id);
}

export function insertCircle(
  db: DatabaseSync,
  circle: Omit<CircleRow, "invite_expires_at"> & { invite_expires_at?: number | null },
  userId: string,
  joinedAt: number,
): void {
  withTx(db, () => {
    db.prepare(
      "INSERT INTO circles (id, name, invite_code, created_by, created_at, invite_expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      circle.id,
      circle.name,
      circle.invite_code,
      circle.created_by,
      circle.created_at,
      circle.invite_expires_at ?? circle.created_at + 14 * 24 * 60 * 60 * 1000,
    );
    db.prepare("INSERT INTO memberships (user_id, circle_id, joined_at, is_admin) VALUES (?, ?, ?, 1)").run(
      userId,
      circle.id,
      joinedAt,
    );
  });
}

export function getCircleByCode(db: DatabaseSync, code: string): CircleRow | undefined {
  return one<CircleRow>(db, "SELECT * FROM circles WHERE invite_code = ?", code);
}

export function getCircleForUser(db: DatabaseSync, userId: string): CircleRow | undefined {
  return one<CircleRow>(
    db,
    `SELECT c.* FROM circles c
     JOIN memberships m ON m.circle_id = c.id
     WHERE m.user_id = ?`,
    userId,
  );
}

export function listMembers(db: DatabaseSync, circleId: string): MemberRow[] {
  return all<MemberRow>(
    db,
    `SELECT u.id, u.name, m.joined_at, m.is_admin
     FROM memberships m
     JOIN users u ON u.id = m.user_id
     WHERE m.circle_id = ?
     ORDER BY m.joined_at ASC, u.name ASC`,
    circleId,
  );
}

export function isCircleAdmin(db: DatabaseSync, circleId: string, userId: string): boolean {
  const row = one<{ is_admin: number }>(
    db,
    "SELECT is_admin FROM memberships WHERE circle_id = ? AND user_id = ?",
    circleId,
    userId,
  );
  return Boolean(row?.is_admin);
}

export function countCircleAdmins(db: DatabaseSync, circleId: string): number {
  const row = one<{ n: number | bigint }>(
    db,
    "SELECT COUNT(*) AS n FROM memberships WHERE circle_id = ? AND is_admin = 1",
    circleId,
  );
  return Number(row?.n ?? 0);
}

export function setCircleAdmin(db: DatabaseSync, circleId: string, userId: string, admin: boolean): "ok" | "missing" | "last" {
  const member = one<{ is_admin: number }>(
    db,
    "SELECT is_admin FROM memberships WHERE circle_id = ? AND user_id = ?",
    circleId,
    userId,
  );
  if (!member) return "missing";
  if (!admin && member.is_admin && countCircleAdmins(db, circleId) <= 1) return "last";
  db.prepare("UPDATE memberships SET is_admin = ? WHERE circle_id = ? AND user_id = ?").run(admin ? 1 : 0, circleId, userId);
  return "ok";
}

export function addMember(db: DatabaseSync, circleId: string, userId: string, joinedAt: number): void {
  db.prepare("INSERT INTO memberships (user_id, circle_id, joined_at) VALUES (?, ?, ?)").run(
    userId,
    circleId,
    joinedAt,
  );
}

export function removeMember(db: DatabaseSync, circleId: string, userId: string): void {
  withTx(db, () => {
    const admins = countCircleAdmins(db, circleId);
    const leaving = one<{ is_admin: number }>(
      db,
      "SELECT is_admin FROM memberships WHERE circle_id = ? AND user_id = ?",
      circleId,
      userId,
    );
    if (leaving?.is_admin && admins <= 1) {
      const next = one<{ user_id: string }>(
        db,
        "SELECT user_id FROM memberships WHERE circle_id = ? AND user_id != ? ORDER BY joined_at ASC, user_id ASC LIMIT 1",
        circleId,
        userId,
      );
      if (next) {
        db.prepare("UPDATE memberships SET is_admin = 1 WHERE circle_id = ? AND user_id = ?").run(circleId, next.user_id);
      }
    }
    db.prepare("DELETE FROM memberships WHERE circle_id = ? AND user_id = ?").run(circleId, userId);
    const row = one<{ n: number | bigint }>(
      db,
      "SELECT COUNT(*) AS n FROM memberships WHERE circle_id = ?",
      circleId,
    );
    if (!row || Number(row.n) === 0) {
      db.prepare("DELETE FROM circles WHERE id = ?").run(circleId);
    }
  });
}

export function kickMember(db: DatabaseSync, circleId: string, userId: string): "ok" | "missing" | "last" {
  const member = one<{ is_admin: number }>(
    db,
    "SELECT is_admin FROM memberships WHERE circle_id = ? AND user_id = ?",
    circleId,
    userId,
  );
  if (!member) return "missing";
  if (member.is_admin && countCircleAdmins(db, circleId) <= 1) return "last";
  withTx(db, () => {
    db.prepare("DELETE FROM socials WHERE circle_id = ? AND creator_id = ?").run(circleId, userId);
    db.prepare("DELETE FROM plans WHERE circle_id = ? AND creator_id = ?").run(circleId, userId);
    db.prepare("DELETE FROM memberships WHERE circle_id = ? AND user_id = ?").run(circleId, userId);
  });
  return "ok";
}

export function insertSocial(
  db: DatabaseSync,
  social: {
    id: string;
    circleId: string;
    creatorId: string;
    note: string;
    createdAt: number;
    expiresAt: number;
    lat: number | null;
    lng: number | null;
    place?: string;
    startsAt?: number | null;
  },
): void {
  db.prepare(
    `INSERT INTO socials (id, circle_id, creator_id, note, created_at, expires_at, last_notified_at, lat, lng, place, starts_at, reminded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    social.id,
    social.circleId,
    social.creatorId,
    social.note,
    social.createdAt,
    social.expiresAt,
    social.createdAt,
    social.lat,
    social.lng,
    social.place ?? "",
    social.startsAt ?? null,
  );
}

export function getActiveSocialByCreator(
  db: DatabaseSync,
  creatorId: string,
  now: number,
): SocialRow | undefined {
  return one<SocialRow>(
    db,
    `${SOCIAL_SELECT} WHERE s.creator_id = ? AND s.expires_at > ? ORDER BY s.created_at DESC LIMIT 1`,
    creatorId,
    now,
  );
}

export function updateSocial(
  db: DatabaseSync,
  id: string,
  note: string,
  expiresAt: number,
  lastNotifiedAt: number,
  where?: { point: { lat: number; lng: number } | null; place: string },
  schedule?: { startsAt: number | null; remindedAt: number | null },
): void {
  if (!where && !schedule) {
    db.prepare("UPDATE socials SET note = ?, expires_at = ?, last_notified_at = ? WHERE id = ?").run(
      note,
      expiresAt,
      lastNotifiedAt,
      id,
    );
    return;
  }
  if (!where) {
    db.prepare(
      "UPDATE socials SET note = ?, expires_at = ?, last_notified_at = ?, starts_at = ?, reminded_at = ? WHERE id = ?",
    ).run(note, expiresAt, lastNotifiedAt, schedule?.startsAt ?? null, schedule?.remindedAt ?? null, id);
    return;
  }
  if (!schedule) {
    db.prepare(
      "UPDATE socials SET note = ?, expires_at = ?, last_notified_at = ?, lat = ?, lng = ?, place = ? WHERE id = ?",
    ).run(note, expiresAt, lastNotifiedAt, where.point?.lat ?? null, where.point?.lng ?? null, where.place, id);
    return;
  }
  db.prepare(
    `UPDATE socials SET note = ?, expires_at = ?, last_notified_at = ?, lat = ?, lng = ?, place = ?, starts_at = ?, reminded_at = ? WHERE id = ?`,
  ).run(
    note,
    expiresAt,
    lastNotifiedAt,
    where.point?.lat ?? null,
    where.point?.lng ?? null,
    where.place,
    schedule.startsAt,
    schedule.remindedAt,
    id,
  );
}

export function listActiveSocials(db: DatabaseSync, circleId: string, now: number): SocialRow[] {
  clearExpiredSocialPoints(db, now);
  return all<SocialRow>(
    db,
    `${SOCIAL_SELECT} WHERE s.circle_id = ? AND s.expires_at > ? ORDER BY s.created_at DESC`,
    circleId,
    now,
  );
}

export function getSocial(db: DatabaseSync, id: string): SocialRow | undefined {
  return one<SocialRow>(db, `${SOCIAL_SELECT} WHERE s.id = ?`, id);
}

export function listSocialJoins(db: DatabaseSync, socialId: string): JoinRow[] {
  return all<JoinRow>(
    db,
    `SELECT u.id, u.name, j.joined_at, j.reply, j.eta_min, j.arrive_at
     FROM social_joins j
     JOIN users u ON u.id = j.user_id
     WHERE j.social_id = ? AND j.blocked = 0
     ORDER BY j.joined_at ASC`,
    socialId,
  );
}

export function hasSocialJoin(db: DatabaseSync, socialId: string, userId: string): boolean {
  return Boolean(one(db, "SELECT 1 AS ok FROM social_joins WHERE social_id = ? AND user_id = ?", socialId, userId));
}

export function addSocialJoin(db: DatabaseSync, socialId: string, userId: string, joinedAt: number): void {
  db.prepare("INSERT INTO social_joins (social_id, user_id, joined_at, reply, eta_min, arrive_at) VALUES (?, ?, ?, 'coming', NULL, NULL)").run(
    socialId,
    userId,
    joinedAt,
  );
}

export function getSocialReply(
  db: DatabaseSync,
  socialId: string,
  userId: string,
): { reply: string; eta_min: number | null; arrive_at: number | null; blocked: number } | undefined {
  return one(db, "SELECT reply, eta_min, arrive_at, blocked FROM social_joins WHERE social_id = ? AND user_id = ?", socialId, userId);
}

export function blockSocialGuest(db: DatabaseSync, socialId: string, userId: string, now: number): void {
  db.prepare(
    `INSERT INTO social_joins (social_id, user_id, joined_at, reply, eta_min, arrive_at, blocked)
     VALUES (?, ?, ?, 'removed', NULL, NULL, 1)
     ON CONFLICT(social_id, user_id) DO UPDATE SET reply = 'removed', eta_min = NULL, arrive_at = NULL, blocked = 1`,
  ).run(socialId, userId, now);
}

export function setSocialReply(
  db: DatabaseSync,
  socialId: string,
  userId: string,
  joinedAt: number,
  reply: string,
  etaMin: number | null,
  arriveAt: number | null,
): void {
  db.prepare(
    `INSERT INTO social_joins (social_id, user_id, joined_at, reply, eta_min, arrive_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(social_id, user_id) DO UPDATE SET reply = excluded.reply, eta_min = excluded.eta_min, arrive_at = excluded.arrive_at`,
  ).run(socialId, userId, joinedAt, reply, etaMin, arriveAt);
}

export function listComingUserIds(db: DatabaseSync, socialId: string): string[] {
  return all<{ user_id: string }>(
    db,
    "SELECT user_id FROM social_joins WHERE social_id = ? AND reply IN ('join', 'coming')",
    socialId,
  ).map((row) => row.user_id);
}

export function listDueStartReminders(db: DatabaseSync, now: number): DueStartReminder[] {
  return all<DueStartReminder>(
    db,
    `SELECT s.id, s.note, s.place, u.name AS creator_name
     FROM socials s
     JOIN users u ON u.id = s.creator_id
     WHERE s.starts_at IS NOT NULL AND s.starts_at <= ? AND s.reminded_at IS NULL AND s.expires_at > ?`,
    now,
    now,
  );
}

export function markSocialReminded(db: DatabaseSync, socialId: string, remindedAt: number): void {
  db.prepare("UPDATE socials SET reminded_at = ? WHERE id = ?").run(remindedAt, socialId);
}

export function rotateInvite(db: DatabaseSync, circleId: string, code: string, expiresAt: number): void {
  db.prepare("UPDATE circles SET invite_code = ?, invite_expires_at = ? WHERE id = ?").run(code, expiresAt, circleId);
}

export function removeSocialJoin(db: DatabaseSync, socialId: string, userId: string): void {
  db.prepare("DELETE FROM social_joins WHERE social_id = ? AND user_id = ?").run(socialId, userId);
}

export function deleteSocial(db: DatabaseSync, id: string, creatorId: string): number {
  const result = db.prepare("DELETE FROM socials WHERE id = ? AND creator_id = ?").run(id, creatorId);
  return Number(result.changes);
}

export function deleteSocialById(db: DatabaseSync, id: string): number {
  const result = db.prepare("DELETE FROM socials WHERE id = ?").run(id);
  return Number(result.changes);
}

export function patchSocialDetails(
  db: DatabaseSync,
  id: string,
  note: string,
  place: string,
  lat: number | null,
  lng: number | null,
  startsAt: number | null,
  remindedAt: number | null,
  expiresAt: number,
): void {
  db.prepare(
    "UPDATE socials SET note = ?, place = ?, lat = ?, lng = ?, starts_at = ?, reminded_at = ?, expires_at = ? WHERE id = ?",
  ).run(note, place, lat, lng, startsAt, remindedAt, expiresAt, id);
}

export function insertPlan(
  db: DatabaseSync,
  plan: {
    id: string;
    circleId: string;
    creatorId: string;
    note: string;
    forDate: string;
    createdAt: number;
    lat: number | null;
    lng: number | null;
    place: string;
  },
): void {
  db.prepare(
    `INSERT INTO plans (id, circle_id, creator_id, note, for_date, created_at, lat, lng, place)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    plan.id,
    plan.circleId,
    plan.creatorId,
    plan.note,
    plan.forDate,
    plan.createdAt,
    plan.lat,
    plan.lng,
    plan.place,
  );
}

export function listVisiblePlans(db: DatabaseSync, circleId: string, today: string, through: string): PlanRow[] {
  clearExpiredPlanPoints(db, today);
  return all<PlanRow>(
    db,
    `${PLAN_SELECT} WHERE p.circle_id = ? AND p.for_date >= ? AND p.for_date <= ? ORDER BY p.for_date ASC, p.created_at ASC`,
    circleId,
    today,
    through,
  );
}

export function countUpcomingPlans(db: DatabaseSync, circleId: string, today: string): number {
  const row = one<{ n: number | bigint }>(
    db,
    "SELECT COUNT(*) AS n FROM plans WHERE circle_id = ? AND for_date >= ?",
    circleId,
    today,
  );
  return Number(row?.n ?? 0);
}

export function getPlan(db: DatabaseSync, id: string): PlanRow | undefined {
  return one<PlanRow>(db, `${PLAN_SELECT} WHERE p.id = ?`, id);
}

export function listPlanJoins(db: DatabaseSync, planId: string): JoinRow[] {
  return all<JoinRow>(
    db,
    `SELECT u.id, u.name, j.joined_at, j.reply, NULL AS eta_min, j.arrive_at
     FROM plan_joins j
     JOIN users u ON u.id = j.user_id
     WHERE j.plan_id = ? AND j.blocked = 0
     ORDER BY j.joined_at ASC`,
    planId,
  );
}

export function hasPlanJoin(db: DatabaseSync, planId: string, userId: string): boolean {
  return Boolean(one(db, "SELECT 1 AS ok FROM plan_joins WHERE plan_id = ? AND user_id = ?", planId, userId));
}

export function getPlanReply(db: DatabaseSync, planId: string, userId: string): { reply: string; arrive_at: number | null; blocked: number } | undefined {
  return one(db, "SELECT reply, arrive_at, blocked FROM plan_joins WHERE plan_id = ? AND user_id = ?", planId, userId);
}

export function blockPlanGuest(db: DatabaseSync, planId: string, userId: string, now: number): void {
  db.prepare(
    `INSERT INTO plan_joins (plan_id, user_id, joined_at, reply, arrive_at, blocked)
     VALUES (?, ?, ?, 'removed', NULL, 1)
     ON CONFLICT(plan_id, user_id) DO UPDATE SET reply = 'removed', arrive_at = NULL, blocked = 1`,
  ).run(planId, userId, now);
}

export function setPlanReply(
  db: DatabaseSync,
  planId: string,
  userId: string,
  joinedAt: number,
  reply: string,
  arriveAt: number | null,
): void {
  db.prepare(
    `INSERT INTO plan_joins (plan_id, user_id, joined_at, reply, arrive_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(plan_id, user_id) DO UPDATE SET reply = excluded.reply, arrive_at = excluded.arrive_at`,
  ).run(planId, userId, joinedAt, reply, arriveAt);
}

export function removePlanJoin(db: DatabaseSync, planId: string, userId: string): void {
  db.prepare("DELETE FROM plan_joins WHERE plan_id = ? AND user_id = ?").run(planId, userId);
}

export function deletePlan(db: DatabaseSync, id: string, creatorId: string): number {
  const result = db.prepare("DELETE FROM plans WHERE id = ? AND creator_id = ?").run(id, creatorId);
  return Number(result.changes);
}

export function deletePlanById(db: DatabaseSync, id: string): number {
  const result = db.prepare("DELETE FROM plans WHERE id = ?").run(id);
  return Number(result.changes);
}

export function patchPlanDetails(
  db: DatabaseSync,
  id: string,
  note: string,
  place: string,
  lat: number | null,
  lng: number | null,
  atTime: string | null,
): void {
  db.prepare("UPDATE plans SET note = ?, place = ?, lat = ?, lng = ?, at_time = ? WHERE id = ?").run(
    note,
    place,
    lat,
    lng,
    atTime,
    id,
  );
}

function backfillCircleAdmins(db: DatabaseSync): void {
  const circles = all<{ id: string; created_by: string }>(
    db,
    `SELECT c.id, c.created_by FROM circles c
     WHERE NOT EXISTS (SELECT 1 FROM memberships m WHERE m.circle_id = c.id AND m.is_admin = 1)`,
  );
  const creatorIsMember = db.prepare("SELECT 1 AS ok FROM memberships WHERE circle_id = ? AND user_id = ?");
  const earliest = db.prepare(
    "SELECT user_id FROM memberships WHERE circle_id = ? ORDER BY joined_at ASC, user_id ASC LIMIT 1",
  );
  const promote = db.prepare("UPDATE memberships SET is_admin = 1 WHERE circle_id = ? AND user_id = ?");
  for (const circle of circles) {
    const stillThere = creatorIsMember.get(circle.id, circle.created_by) as { ok: number } | undefined;
    if (stillThere) {
      promote.run(circle.id, circle.created_by);
      continue;
    }
    const next = earliest.get(circle.id) as { user_id: string } | undefined;
    if (next) promote.run(circle.id, next.user_id);
  }
}

export function upsertPushSub(
  db: DatabaseSync,
  sub: { id: string; userId: string; endpoint: string; p256dh: string; auth: string; createdAt: number },
): void {
  db.prepare(
    `INSERT INTO push_subs (id, user_id, endpoint, p256dh, auth, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       user_id = excluded.user_id,
       p256dh = excluded.p256dh,
       auth = excluded.auth`,
  ).run(sub.id, sub.userId, sub.endpoint, sub.p256dh, sub.auth, sub.createdAt);
}

export function listPushSubs(db: DatabaseSync, userId: string): PushSubRow[] {
  return all<PushSubRow>(db, "SELECT * FROM push_subs WHERE user_id = ?", userId);
}

export function deletePushSub(db: DatabaseSync, endpoint: string): void {
  db.prepare("DELETE FROM push_subs WHERE endpoint = ?").run(endpoint);
}

export function deletePushSubForUser(db: DatabaseSync, userId: string, endpoint: string): void {
  db.prepare("DELETE FROM push_subs WHERE user_id = ? AND endpoint = ?").run(userId, endpoint);
}

export function insertNotification(
  db: DatabaseSync,
  note: {
    id: string;
    userId: string;
    title: string;
    body: string;
    kind: string;
    refId: string | null;
    createdAt: number;
  },
): void {
  db.prepare(
    `INSERT INTO notifications (id, user_id, title, body, kind, ref_id, created_at, read_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(note.id, note.userId, note.title, note.body, note.kind, note.refId, note.createdAt);
}

export function listNotifications(db: DatabaseSync, userId: string, limit = 50): NotificationRow[] {
  return all<NotificationRow>(
    db,
    `SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
    userId,
    limit,
  );
}

export function markNotificationsRead(db: DatabaseSync, userId: string, readAt: number): void {
  db.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL").run(readAt, userId);
}

function clearExpiredSocialPoints(db: DatabaseSync, now: number): void {
  db.prepare(
    `UPDATE socials
     SET lat = NULL, lng = NULL, place = ''
     WHERE expires_at <= ? AND (lat IS NOT NULL OR lng IS NOT NULL OR place != '')`,
  ).run(now);
}

function clearExpiredPlanPoints(db: DatabaseSync, today: string): void {
  // A typed place is not derived from the pin, so it stays after the coordinates go.
  db.prepare(
    "UPDATE plans SET lat = NULL, lng = NULL WHERE for_date < ? AND (lat IS NOT NULL OR lng IS NOT NULL)",
  ).run(today);
}

export function clearExpiredLocations(db: DatabaseSync, now: number, today: string): void {
  clearExpiredSocialPoints(db, now);
  clearExpiredPlanPoints(db, today);
}

export function sweep(db: DatabaseSync, now: number, planCutoff: string, today = ""): void {
  if (today) clearExpiredLocations(db, now, today);
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const monthAgo = now - 30 * 24 * 60 * 60 * 1000;
  db.prepare("DELETE FROM socials WHERE expires_at < ?").run(weekAgo);
  db.prepare("DELETE FROM plans WHERE for_date < ?").run(planCutoff);
  db.prepare("DELETE FROM notifications WHERE created_at < ?").run(monthAgo);
}

const SOCIAL_SELECT = `
  SELECT s.id, s.circle_id, s.creator_id, u.name AS creator_name, s.note,
         s.created_at, s.expires_at, s.last_notified_at, s.lat, s.lng, s.place, s.starts_at, s.reminded_at
  FROM socials s
  JOIN users u ON u.id = s.creator_id
`;

const PLAN_SELECT = `
  SELECT p.id, p.circle_id, p.creator_id, u.name AS creator_name, p.note, p.for_date, p.created_at,
         p.lat, p.lng, p.place, p.at_time
  FROM plans p
  JOIN users u ON u.id = p.creator_id
`;

function one<T>(db: DatabaseSync, sql: string, ...params: Array<string | number>): T | undefined {
  const row = db.prepare(sql).get(...params);
  return row ? (copy(row) as T) : undefined;
}

function all<T>(db: DatabaseSync, sql: string, ...params: Array<string | number>): T[] {
  return db.prepare(sql).all(...params).map((row) => copy(row) as T);
}

function copy(row: object): Record<string, unknown> {
  return { ...row };
}
