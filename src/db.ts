import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CHAT_COLORS, chooseColor } from "./chat/chat-color.js";
import { hashSecret } from "./app-kit/auth-code.ts";
import { addDays, isTimeZone } from "./lib/time.js";

export type UserRow = {
  id: string;
  name: string;
  token_hash: string;
  buzz_token: string;
  created_at: number;
  color?: number | null;
  whats_new_seen?: string | null;
  avatar_rev?: number | null;
  timezone?: string | null;
  payment_url?: string | null;
  /** Optional Wero email, separate from the login email. */
  wero_email?: string | null;
  /** Normalized address, null for accounts made before email was required. */
  email?: string | null;
  /** epoch ms of the verify link, null until used. */
  email_verified_at?: number | null;
  /** sha256 of the recovery code. Independent of buzz_token once rotated. */
  recovery_hash?: string | null;
  /** Special buzzer animation every receiver plays for this person's Flic press ("birthday"), or null for the rotation. */
  buzz_animation?: string | null;
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
  creator_color: number | null;
  creator_avatar_rev: number | null;
  creator_buzz_animation?: string | null;
  note: string;
  created_at: number;
  expires_at: number;
  last_notified_at: number;
  lat: number | null;
  lng: number | null;
  place: string;
  starts_at: number | null;
  reminded_at: number | null;
  buzzed_at: number | null;
  price_cents: number | null;
  collector_id: string | null;
  /** The end the host picked. Null means none; expires_at then falls back to the default window. */
  ends_at: number | null;
};

export type DueStartReminder = {
  id: string;
  note: string;
  place: string;
  creator_name: string;
  circle_id: string;
  circle_name: string;
};

export type JoinRow = {
  id: string;
  name: string;
  color: number | null;
  avatar_rev: number | null;
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
  creator_color: number | null;
  creator_avatar_rev: number | null;
  note: string;
  for_date: string;
  created_at: number;
  lat: number | null;
  lng: number | null;
  place: string;
  at_time: string | null;
  ended_at: number | null;
  share_id: string | null;
  description: string | null;
  reminded_at: number | null;
  /** Last content change or end, for calendar SEQUENCE. Null until the first one. */
  updated_at: number | null;
  price_cents: number | null;
  collector_id: string | null;
  /** Card colour slot 0..13 picked by the host. Null means the id hash default. */
  card_color: number | null;
  /** Optional end instant on the plan's day. Null means open ended. ended_at stays the manual end. */
  ends_at: number | null;
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
  circle_id: string | null;
  created_at: number;
  read_at: number | null;
};

export type MemberRow = {
  id: string;
  name: string;
  color: number | null;
  avatar_rev: number | null;
  joined_at: number;
  is_admin: number;
};

function pushDeliveriesTable(name: string): string {
  return `CREATE TABLE IF NOT EXISTS ${name} (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sub_id TEXT NOT NULL,
  circle_id TEXT REFERENCES circles(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  status TEXT NOT NULL,
  http_status INTEGER,
  created_at INTEGER NOT NULL
);`;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  buzz_token TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  display_at INTEGER,
  standalone_at INTEGER,
  push_seen_at INTEGER,
  color INTEGER,
  whats_new_seen TEXT,
  email TEXT,
  email_verified_at INTEGER,
  recovery_hash TEXT
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
  user_id TEXT NOT NULL REFERENCES users(id),
  circle_id TEXT NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  chat_color INTEGER,
  PRIMARY KEY (user_id, circle_id)
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
  reminded_at INTEGER,
  buzzed_at INTEGER
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
  place TEXT NOT NULL DEFAULT '',
  at_time TEXT,
  ended_at INTEGER
);

CREATE TABLE IF NOT EXISTS plan_circles (
  plan_id TEXT NOT NULL,
  circle_id TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (plan_id, circle_id)
);
CREATE INDEX IF NOT EXISTS idx_plan_circles_circle ON plan_circles(circle_id);

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
  circle_id TEXT,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);

CREATE TABLE IF NOT EXISTS busy_hours (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  timezone TEXT NOT NULL,
  blocks TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS buzz_circles (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  press TEXT NOT NULL,
  circle_id TEXT NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, press)
);

CREATE INDEX IF NOT EXISTS idx_membership_circle ON memberships(circle_id);
CREATE INDEX IF NOT EXISTS idx_socials_circle ON socials(circle_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_plans_circle ON plans(circle_id, for_date);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subs(user_id);
CREATE INDEX IF NOT EXISTS idx_notifs_user ON notifications(user_id, created_at DESC);

${pushDeliveriesTable("push_deliveries")}
CREATE INDEX IF NOT EXISTS idx_push_deliveries_ref ON push_deliveries(circle_id, kind, ref_id, created_at);

CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  circle_id TEXT REFERENCES circles(id) ON DELETE SET NULL,
  text TEXT NOT NULL,
  app_version TEXT,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  pr_url TEXT,
  note TEXT,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS circle_removals (
  circle_id TEXT NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invite_code TEXT NOT NULL,
  PRIMARY KEY (circle_id, user_id)
);

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  circle_id TEXT NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  ref_id TEXT NOT NULL DEFAULT '',
  host_id TEXT,
  title TEXT NOT NULL DEFAULT '',
  closed_at INTEGER,
  last_push_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (circle_id, kind, ref_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  reply_to TEXT,
  edited_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at);

CREATE TABLE IF NOT EXISTS chat_reads (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  read_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, chat_id)
);

CREATE TABLE IF NOT EXISTS chat_mutes (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, chat_id)
);

CREATE TABLE IF NOT EXISTS message_reactions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);

-- One row per reactor per message, kept after an unreact, so the author is pinged once.
CREATE TABLE IF NOT EXISTS reaction_notices (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id)
);

-- One vote per person per poll message. A new choice replaces the old row.
CREATE TABLE IF NOT EXISTS poll_votes (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  choice INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id)
);

CREATE TABLE IF NOT EXISTS calendar_feeds (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_agent_tokens_user ON agent_tokens(user_id);

-- Who has paid for an event with a price. Polymorphic on kind (plan or social), so no FK on the event; sweep() drops orphans.
CREATE TABLE IF NOT EXISTS event_payments (
  kind TEXT NOT NULL,
  event_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  set_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  set_at INTEGER NOT NULL,
  PRIMARY KEY (kind, event_id, user_id)
);

-- Who a private event is for. No rows means everyone in the circle. Polymorphic on kind, so no FK on the event; sweep() drops orphans.
CREATE TABLE IF NOT EXISTS event_invitees (
  kind TEXT NOT NULL,
  event_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (kind, event_id, user_id)
);
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
  ensureColumn(db, "socials", "buzzed_at", "buzzed_at INTEGER");
  ensureColumn(db, "socials", "price_cents", "price_cents INTEGER");
  ensureColumn(db, "socials", "collector_id", "collector_id TEXT");
  ensureColumn(db, "socials", "ends_at", "ends_at INTEGER");
  ensureColumn(db, "social_joins", "reply", "reply TEXT NOT NULL DEFAULT 'join'");
  ensureColumn(db, "social_joins", "eta_min", "eta_min INTEGER");
  ensureColumn(db, "social_joins", "arrive_at", "arrive_at INTEGER");
  ensureColumn(db, "plan_joins", "arrive_at", "arrive_at INTEGER");
  ensureColumn(db, "social_joins", "blocked", "blocked INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "plan_joins", "blocked", "blocked INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "social_joins", "removed_by", "removed_by TEXT");
  ensureColumn(db, "plan_joins", "removed_by", "removed_by TEXT");
  ensureColumn(db, "circles", "invite_expires_at", "invite_expires_at INTEGER");
  ensureColumn(db, "memberships", "is_admin", "is_admin INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "memberships", "chat_color", "chat_color INTEGER");
  // The message this one replies to. Checked by the app, so no REFERENCES (ALTER cannot add one).
  ensureColumn(db, "messages", "reply_to", "reply_to TEXT");
  ensureColumn(db, "messages", "edited_at", "edited_at INTEGER");
  migrateMembershipKey(db);
  migratePushDeliveryCascade(db);
  backfillCircleAdmins(db);
  ensureColumn(db, "users", "display_at", "display_at INTEGER");
  ensureColumn(db, "users", "standalone_at", "standalone_at INTEGER");
  ensureColumn(db, "users", "push_seen_at", "push_seen_at INTEGER");
  ensureColumn(db, "users", "color", "color INTEGER");
  ensureColumn(db, "users", "whats_new_seen", "whats_new_seen TEXT");
  ensureColumn(db, "users", "avatar_rev", "avatar_rev INTEGER");
  ensureColumn(db, "users", "status_type", "status_type TEXT");
  ensureColumn(db, "users", "status_text", "status_text TEXT");
  ensureColumn(db, "users", "status_place", "status_place TEXT");
  ensureColumn(db, "users", "status_until", "status_until INTEGER");
  ensureColumn(db, "users", "timezone", "timezone TEXT");
  ensureColumn(db, "users", "payment_url", "payment_url TEXT");
  ensureColumn(db, "users", "wero_email", "wero_email TEXT");
  ensureColumn(db, "users", "email", "email TEXT");
  ensureColumn(db, "users", "email_verified_at", "email_verified_at INTEGER");
  ensureColumn(db, "users", "recovery_hash", "recovery_hash TEXT");
  ensureColumn(db, "users", "buzz_animation", "buzz_animation TEXT");
  migrateAccounts(db);
  backfillUserColors(db);
  ensureColumn(db, "notifications", "circle_id", "circle_id TEXT");
  backfillNotificationCircles(db);
  migrateFeedbackDoneAlert(db);
  ensureFeedbackDoneIndex(db);
  db.prepare(
    "UPDATE circles SET invite_expires_at = created_at + ? WHERE invite_expires_at IS NULL",
  ).run(14 * 24 * 60 * 60 * 1000);
  ensureColumn(db, "plans", "lat", "lat REAL");
  ensureColumn(db, "plans", "lng", "lng REAL");
  ensureColumn(db, "plans", "place", "place TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "plans", "at_time", "at_time TEXT");
  ensureColumn(db, "plans", "ended_at", "ended_at INTEGER");
  ensureColumn(db, "plans", "share_id", "share_id TEXT");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_plans_share ON plans(share_id)");
  ensureColumn(db, "plans", "description", "description TEXT");
  ensureColumn(db, "plans", "reminded_at", "reminded_at INTEGER");
  ensureColumn(db, "plans", "updated_at", "updated_at INTEGER");
  ensureColumn(db, "plans", "price_cents", "price_cents INTEGER");
  ensureColumn(db, "plans", "collector_id", "collector_id TEXT");
  ensureColumn(db, "plans", "card_color", "card_color INTEGER");
  ensureColumn(db, "plans", "ends_at", "ends_at INTEGER");
  ensureColumn(db, "plan_joins", "reply", "reply TEXT NOT NULL DEFAULT 'coming'");
  // Every plan is linked to its home circle. Safe on every boot.
  db.exec("INSERT OR IGNORE INTO plan_circles (plan_id, circle_id, added_at) SELECT id, circle_id, created_at FROM plans");
  ensurePlanReminders(db);
  const missing = db.prepare(
    "SELECT id, token_hash, created_at FROM users u WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.token_hash = u.token_hash)",
  ).all() as Array<{ id: string; token_hash: string; created_at: number }>;
  const insert = db.prepare("INSERT INTO sessions (id, user_id, token_hash, created_at) VALUES (?, ?, ?, ?)");
  for (const user of missing) insert.run(crypto.randomUUID(), user.id, user.token_hash, user.created_at);
  db.prepare("UPDATE social_joins SET reply = 'coming' WHERE reply IN ('join', 'in')").run();
  // After migrateMembershipKey: calendar_share points at the (user_id, circle_id) key.
  db.exec(CALENDAR_SYNC_SCHEMA);
  ensureColumn(db, "calendar_sync", "source", "source TEXT NOT NULL DEFAULT 'ics'");
  ensureColumn(db, "calendar_sync", "token_enc", "token_enc TEXT");
  return db;
}

/**
 * Calendar availability import. Separate from calendar_feeds (the export).
 * calendar_sync holds the encrypted private link and sync state, calendar_busy only merged busy
 * intervals, calendar_event the owner-only titles (encrypted) for the "I'm in" check, and
 * calendar_share the circles the owner opted into. A share row goes when the membership goes.
 * source is 'ics' (url_enc holds the link) or 'google' (token_enc holds the encrypted refresh token,
 * url_enc is empty). google_oauth_state is the short-lived state and PKCE verifier of a connect.
 */
const CALENDAR_SYNC_SCHEMA = `
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS calendar_sync (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  url_enc TEXT NOT NULL,
  host TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'ics',
  token_enc TEXT,
  rev TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_sync_at INTEGER,
  last_ok INTEGER,
  last_ok_at INTEGER,
  last_error TEXT,
  fail_count INTEGER NOT NULL DEFAULT 0,
  next_sync_at INTEGER NOT NULL,
  window_end INTEGER
);
CREATE INDEX IF NOT EXISTS idx_calendar_sync_next ON calendar_sync(next_sync_at);

CREATE TABLE IF NOT EXISTS calendar_busy (
  user_id TEXT NOT NULL REFERENCES calendar_sync(user_id) ON DELETE CASCADE,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calendar_busy_user ON calendar_busy(user_id, start_ms);

CREATE TABLE IF NOT EXISTS calendar_event (
  user_id TEXT NOT NULL REFERENCES calendar_sync(user_id) ON DELETE CASCADE,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0,
  title_enc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calendar_event_user ON calendar_event(user_id, start_ms);

CREATE TABLE IF NOT EXISTS calendar_share (
  user_id TEXT NOT NULL REFERENCES calendar_sync(user_id) ON DELETE CASCADE,
  circle_id TEXT NOT NULL,
  PRIMARY KEY (user_id, circle_id),
  FOREIGN KEY (user_id, circle_id) REFERENCES memberships(user_id, circle_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_calendar_share_circle ON calendar_share(circle_id);

CREATE TABLE IF NOT EXISTS google_oauth_state (
  state TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_verifier TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_google_oauth_state_user ON google_oauth_state(user_id);
`;

/**
 * Who a "Remind friends" reached, per plan. Alerts can be cleared or pruned; this cannot, so the hour holds.
 * Goes with its plan. Created once, and seeded from the reminder Alerts sent before it existed.
 */
function ensurePlanReminders(db: DatabaseSync): void {
  if (one(db, "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'plan_reminders'")) return;
  withTx(db, () => {
    db.exec(`
      CREATE TABLE plan_reminders (
        plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reminded_at INTEGER NOT NULL,
        PRIMARY KEY (plan_id, user_id)
      );
      INSERT INTO plan_reminders (plan_id, user_id, reminded_at)
        SELECT n.ref_id, n.user_id, MIN(n.created_at) FROM notifications n
        WHERE n.kind = 'plan-remind' AND n.ref_id IN (SELECT id FROM plans) AND n.user_id IN (SELECT id FROM users)
        GROUP BY n.ref_id, n.user_id;
    `);
  });
}

/**
 * Accounts with an email and a recovery code of their own. Safe on every boot.
 * Old users get recovery_hash = sha256(buzz_token), so the code they hold keeps working until they
 * rotate it. Only a verified address is unique, so nobody can squat on someone else's address by
 * typing it. auth_links holds the hashed verify and lost-code tokens.
 */
function migrateAccounts(db: DatabaseSync): void {
  const rows = db.prepare("SELECT id, buzz_token FROM users WHERE recovery_hash IS NULL").all() as Array<{
    id: string;
    buzz_token: string;
  }>;
  if (rows.length > 0) {
    const update = db.prepare("UPDATE users SET recovery_hash = ? WHERE id = ?");
    db.exec("BEGIN");
    try {
      for (const row of rows) update.run(hashSecret(row.buzz_token), row.id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_recovery_hash ON users(recovery_hash);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_verified_email ON users(email)
      WHERE email IS NOT NULL AND email_verified_at IS NOT NULL;
    CREATE TABLE IF NOT EXISTS auth_links (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      email TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auth_links_user ON auth_links(user_id, kind);
  `);
}

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
  if (rows.some((row) => row.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

/** Old databases keyed memberships on user_id alone. Rebuild to (user_id, circle_id) and keep every row. */
function migrateMembershipKey(db: DatabaseSync): void {
  const info = db.prepare("PRAGMA table_info(memberships)").all() as Array<{ name: string; pk: number }>;
  const pk = info.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name);
  if (pk.length === 2 && pk[0] === "user_id" && pk[1] === "circle_id") return;
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN");
  try {
    db.exec(`
      DROP TABLE IF EXISTS memberships_next;
      CREATE TABLE memberships_next (
        user_id TEXT NOT NULL REFERENCES users(id),
        circle_id TEXT NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
        joined_at INTEGER NOT NULL,
        is_admin INTEGER NOT NULL DEFAULT 0,
        chat_color INTEGER,
        PRIMARY KEY (user_id, circle_id)
      );
      INSERT INTO memberships_next (user_id, circle_id, joined_at, is_admin, chat_color)
      SELECT user_id, circle_id, joined_at, COALESCE(is_admin, 0), chat_color FROM memberships;
      DROP TABLE memberships;
      ALTER TABLE memberships_next RENAME TO memberships;
      CREATE INDEX IF NOT EXISTS idx_membership_circle ON memberships(circle_id);
    `);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already rolled back */
    }
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

/** The first push_deliveries kept rows after their user was deleted. Rebuild with ON DELETE CASCADE and keep every row. */
function migratePushDeliveryCascade(db: DatabaseSync): void {
  const keys = db.prepare("PRAGMA foreign_key_list(push_deliveries)").all() as Array<{ table: string; from: string; on_delete: string }>;
  const user = keys.find((key) => key.table === "users" && key.from === "user_id");
  if (user?.on_delete === "CASCADE") return;
  // foreign_keys cannot change inside a transaction, so switch it off first and back on after.
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN");
  try {
    db.exec(`
      DROP TABLE IF EXISTS push_deliveries_new;
      ${pushDeliveriesTable("push_deliveries_new")}
      INSERT INTO push_deliveries_new (id, user_id, sub_id, circle_id, kind, ref_id, batch_id, status, http_status, created_at)
      SELECT id, user_id, sub_id, circle_id, kind, ref_id, batch_id, status, http_status, created_at FROM push_deliveries;
      DROP TABLE push_deliveries;
      ALTER TABLE push_deliveries_new RENAME TO push_deliveries;
      CREATE INDEX IF NOT EXISTS idx_push_deliveries_ref ON push_deliveries(circle_id, kind, ref_id, created_at);
    `);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already rolled back */
    }
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

/**
 * Alert kinds addressed to one person, not to a circle. Their rows keep circle_id NULL on purpose,
 * show in every circle the person opens, and survive leaving or deleting the source circle.
 */
export const PERSONAL_ALERT_KINDS = ["feedback-done"] as const;
const PERSONAL_KINDS_SQL = PERSONAL_ALERT_KINDS.map((kind) => `'${kind}'`).join(", ");

/**
 * feedback.done_alert is the delivery marker for "Your suggestion is live".
 * NULL: not sent yet. "legacy": already done before this column existed, never sent.
 * "no-user": the submitter was gone when it became done. Anything else: the notification id.
 * Added and backfilled in one transaction, so a crash cannot leave old done rows unmarked.
 */
function migrateFeedbackDoneAlert(db: DatabaseSync): void {
  const rows = db.prepare("PRAGMA table_info(feedback)").all() as Array<{ name?: string }>;
  if (rows.some((row) => row.name === "done_alert")) return;
  withTx(db, () => {
    db.exec("ALTER TABLE feedback ADD COLUMN done_alert TEXT");
    db.exec("UPDATE feedback SET done_alert = 'legacy' WHERE status = 'done'");
  });
}

/** Second guard behind feedback.done_alert: one "live" alert per feedback row, ever. */
function ensureFeedbackDoneIndex(db: DatabaseSync): void {
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_notifs_feedback_done ON notifications(ref_id) WHERE kind = 'feedback-done'");
}

function backfillNotificationCircles(db: DatabaseSync): void {
  db.exec(`
    UPDATE notifications
    SET circle_id = (
      SELECT m.circle_id FROM memberships m WHERE m.user_id = notifications.user_id
    )
    WHERE circle_id IS NULL
      AND kind NOT IN (${PERSONAL_KINDS_SQL})
      AND (SELECT COUNT(*) FROM memberships m WHERE m.user_id = notifications.user_id) = 1
  `);
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
    "INSERT INTO users (id, name, token_hash, buzz_token, recovery_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(user.id, user.name, user.token_hash, user.buzz_token, hashSecret(user.buzz_token), user.created_at);
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

export function setPaymentUrl(db: DatabaseSync, id: string, url: string | null): void {
  db.prepare("UPDATE users SET payment_url = ? WHERE id = ?").run(url, id);
}

/** Sets or clears (null) the special buzzer animation. The caller has already checked the value. */
export function setBuzzAnimation(db: DatabaseSync, id: string, animation: string | null): void {
  db.prepare("UPDATE users SET buzz_animation = ? WHERE id = ?").run(animation, id);
}

export function setWeroEmail(db: DatabaseSync, id: string, email: string | null): void {
  db.prepare("UPDATE users SET wero_email = ? WHERE id = ?").run(email, id);
}

/** Bumps the photo revision and returns it. A new rev means a new URL, so caches never serve the old photo. */
export function bumpAvatarRev(db: DatabaseSync, id: string, now: number): number {
  // Seconds since epoch as a floor, so a photo set after a remove never reuses an old (cached) rev.
  db.prepare("UPDATE users SET avatar_rev = MAX(COALESCE(avatar_rev, 0) + 1, ?) WHERE id = ?").run(Math.floor(now / 1000), id);
  return Number(one<{ avatar_rev: number }>(db, "SELECT avatar_rev FROM users WHERE id = ?", id)?.avatar_rev ?? 0);
}

export function clearAvatarRev(db: DatabaseSync, id: string): void {
  db.prepare("UPDATE users SET avatar_rev = NULL WHERE id = ?").run(id);
}

export type StatusRow = {
  status_type: string | null;
  status_text: string | null;
  status_place: string | null;
  status_until: number | null;
};

export function getUserStatus(db: DatabaseSync, id: string): StatusRow | undefined {
  return one<StatusRow>(db, "SELECT status_type, status_text, status_place, status_until FROM users WHERE id = ?", id);
}

export function setUserStatus(db: DatabaseSync, id: string, status: StatusRow): void {
  db.prepare("UPDATE users SET status_type = ?, status_text = ?, status_place = ?, status_until = ? WHERE id = ?").run(
    status.status_type,
    status.status_text,
    status.status_place,
    status.status_until,
    id,
  );
}

export function clearUserStatus(db: DatabaseSync, id: string): void {
  db.prepare("UPDATE users SET status_type = NULL, status_text = NULL, status_place = NULL, status_until = NULL WHERE id = ?").run(id);
}

/** The IANA zone the person saved, or null. */
export function getUserTimezone(db: DatabaseSync, id: string): string | null {
  return one<{ timezone: string | null }>(db, "SELECT timezone FROM users WHERE id = ?", id)?.timezone ?? null;
}

/** Stores a valid IANA zone. An unknown name is refused (false) and nothing is written. */
export function setUserTimezone(db: DatabaseSync, id: string, tz: string): boolean {
  if (!isTimeZone(tz)) return false;
  db.prepare("UPDATE users SET timezone = ? WHERE id = ?").run(tz, id);
  return true;
}

/** One weekly block: days 1 (Mon) to 7 (Sun), local times as HH:MM, start before end. */
export type BusyBlock = { days: number[]; start: string; end: string };
export type BusySchedule = { timezone: string; blocks: BusyBlock[]; updatedAt: number };

type BusyHoursRow = { user_id: string; timezone: string; blocks: string; updated_at: number };

function scheduleFromRow(row: BusyHoursRow): BusySchedule | null {
  try {
    const blocks = JSON.parse(row.blocks);
    if (!Array.isArray(blocks)) return null;
    return { timezone: row.timezone, blocks: blocks as BusyBlock[], updatedAt: row.updated_at };
  } catch {
    return null;
  }
}

export function getBusyHours(db: DatabaseSync, userId: string): BusySchedule | null {
  const row = one<BusyHoursRow>(db, "SELECT user_id, timezone, blocks, updated_at FROM busy_hours WHERE user_id = ?", userId);
  return row ? scheduleFromRow(row) : null;
}

/** Saves the schedule and keeps its zone as the person's zone. Blocks are already validated. */
export function setBusyHours(db: DatabaseSync, userId: string, timezone: string, blocks: BusyBlock[], now: number): BusySchedule {
  db.prepare(
    `INSERT INTO busy_hours (user_id, timezone, blocks, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET timezone = excluded.timezone, blocks = excluded.blocks, updated_at = excluded.updated_at`,
  ).run(userId, timezone, JSON.stringify(blocks), now);
  db.prepare("UPDATE users SET timezone = ? WHERE id = ?").run(timezone, userId);
  return { timezone, blocks, updatedAt: now };
}

export function clearBusyHours(db: DatabaseSync, userId: string): void {
  db.prepare("DELETE FROM busy_hours WHERE user_id = ?").run(userId);
}

/** The circle each Flic press posts in, by press. A press with no row uses the default circle. */
export function getBuzzCircles(db: DatabaseSync, userId: string): Record<string, string> {
  const rows = all<{ press: string; circle_id: string }>(db, "SELECT press, circle_id FROM buzz_circles WHERE user_id = ?", userId);
  return Object.fromEntries(rows.map((row) => [row.press, row.circle_id]));
}

/** Sets the circle for one press, or clears it (back to the default) when circleId is null. */
export function setBuzzCircle(db: DatabaseSync, userId: string, press: string, circleId: string | null): void {
  if (circleId === null) {
    db.prepare("DELETE FROM buzz_circles WHERE user_id = ? AND press = ?").run(userId, press);
    return;
  }
  db.prepare(
    `INSERT INTO buzz_circles (user_id, press, circle_id) VALUES (?, ?, ?)
     ON CONFLICT(user_id, press) DO UPDATE SET circle_id = excluded.circle_id`,
  ).run(userId, press, circleId);
}

/** Schedules of the viewer and everyone sharing a circle with them. One query, for visibleStatuses. */
export function listVisibleBusyHours(db: DatabaseSync, viewerId: string): Map<string, BusySchedule> {
  const rows = all<BusyHoursRow>(
    db,
    `SELECT b.user_id, b.timezone, b.blocks, b.updated_at FROM busy_hours b
     WHERE b.user_id = ? OR EXISTS (
       SELECT 1 FROM memberships mine JOIN memberships theirs ON theirs.circle_id = mine.circle_id
       WHERE mine.user_id = ? AND theirs.user_id = b.user_id
     )`,
    viewerId,
    viewerId,
  );
  const map = new Map<string, BusySchedule>();
  for (const row of rows) {
    const schedule = scheduleFromRow(row);
    if (schedule) map.set(row.user_id, schedule);
  }
  return map;
}

// A private social does not make its host look free to the whole circle, so it is left out here.
const LIVE_SOCIAL = `s.expires_at > ? AND (s.starts_at IS NULL OR s.starts_at <= ?)
  AND NOT EXISTS (SELECT 1 FROM event_invitees vi WHERE vi.kind = 'social' AND vi.event_id = s.id)`;

/** True when the person has an "I'm free" that is on now, in any circle. */
export function hasLiveSocial(db: DatabaseSync, userId: string, now: number): boolean {
  return one(db, `SELECT 1 AS found FROM socials s WHERE s.creator_id = ? AND ${LIVE_SOCIAL} LIMIT 1`, userId, now, now) !== undefined;
}

/** Which of these people have a live "I'm free" in any circle. One query. */
export function liveSocialUsers(db: DatabaseSync, userIds: string[], now: number): Set<string> {
  if (!userIds.length) return new Set();
  const marks = userIds.map(() => "?").join(", ");
  const rows = all<{ creator_id: string }>(
    db,
    `SELECT DISTINCT s.creator_id FROM socials s WHERE s.creator_id IN (${marks}) AND ${LIVE_SOCIAL}`,
    ...userIds,
    now,
    now,
  );
  return new Set(rows.map((row) => row.creator_id));
}

/** Every user id with its photo rev, for the admin avatar backup. No profile fields. */
export function listUserAvatarRevs(db: DatabaseSync): Array<{ id: string; avatar_rev: number | null }> {
  return all<{ id: string; avatar_rev: number | null }>(db, "SELECT id, avatar_rev FROM users ORDER BY created_at, id");
}

/** Same person, or someone in at least one circle with them. */
export function sharesCircle(db: DatabaseSync, viewerId: string, userId: string): boolean {
  if (viewerId === userId) return true;
  return Boolean(one(
    db,
    `SELECT 1 AS ok FROM memberships mine
     JOIN memberships theirs ON theirs.circle_id = mine.circle_id
     WHERE mine.user_id = ? AND theirs.user_id = ? LIMIT 1`,
    viewerId,
    userId,
  ));
}

export function updateCircleName(db: DatabaseSync, id: string, name: string): void {
  db.prepare("UPDATE circles SET name = ? WHERE id = ?").run(name, id);
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
    assignUserColor(db, userId);
  });
}

export function getCircleByCode(db: DatabaseSync, code: string): CircleRow | undefined {
  return one<CircleRow>(db, "SELECT * FROM circles WHERE invite_code = ?", code);
}

export function getCircleById(db: DatabaseSync, id: string): CircleRow | undefined {
  return one<CircleRow>(db, "SELECT * FROM circles WHERE id = ?", id);
}

export function listCirclesForUser(db: DatabaseSync, userId: string): CircleRow[] {
  return all<CircleRow>(
    db,
    `SELECT c.* FROM circles c
     JOIN memberships m ON m.circle_id = c.id
     WHERE m.user_id = ?
     ORDER BY m.joined_at ASC, c.name ASC`,
    userId,
  );
}

export function countCirclesForUser(db: DatabaseSync, userId: string): number {
  const row = one<{ n: number | bigint }>(
    db,
    "SELECT COUNT(*) AS n FROM memberships WHERE user_id = ?",
    userId,
  );
  return Number(row?.n ?? 0);
}

export function listMembers(db: DatabaseSync, circleId: string): MemberRow[] {
  return all<MemberRow>(
    db,
    `SELECT u.id, u.name, u.color, u.avatar_rev, m.joined_at, m.is_admin
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
  assignUserColor(db, userId);
}

const CHAT_COLOR_COUNT = CHAT_COLORS.length;

/** Slots held by anyone who shares at least one circle with this person. */
function coMemberColors(db: DatabaseSync, userId: string): Set<number> {
  const rows = all<{ color: number }>(
    db,
    `SELECT DISTINCT u.color FROM users u
     JOIN memberships other ON other.user_id = u.id
     JOIN memberships mine ON mine.circle_id = other.circle_id
     WHERE mine.user_id = ? AND u.id != ? AND u.color IS NOT NULL`,
    userId,
    userId,
  );
  return new Set(rows.map((row) => row.color));
}

/**
 * One color per person, the same in every circle, chat, and device. It is picked
 * once, when the first circle is joined: the hash slot for someone alone, else a
 * hue nobody in a shared circle holds (chooseColor keeps neighbours apart). After
 * that it never moves, so a later circle, or a 13th member, can share a hue with
 * someone already there. Stability wins over distinctness.
 */
export function assignUserColor(db: DatabaseSync, userId: string): number | null {
  const row = one<{ color: number | null }>(db, "SELECT color FROM users WHERE id = ?", userId);
  if (!row) return null;
  if (row.color != null) return row.color;
  const color = chooseColor(userId, coMemberColors(db, userId));
  db.prepare("UPDATE users SET color = ? WHERE id = ? AND color IS NULL").run(color, userId);
  return color;
}

/**
 * Gives a color to everyone in a circle who has none, oldest member first.
 * A person whose old per-circle chat_color agrees across their circles keeps it
 * unless a co-member already took it. Everyone else goes through assignUserColor.
 * Runs on every open and only touches rows still NULL, so stored colors stay.
 */
export function backfillUserColors(db: DatabaseSync): void {
  const users = all<{ id: string }>(
    db,
    `SELECT u.id FROM users u JOIN memberships m ON m.user_id = u.id
     WHERE u.color IS NULL
     GROUP BY u.id
     ORDER BY MIN(m.joined_at) ASC, u.id ASC`,
  );
  if (users.length === 0) return;
  const kept = db.prepare("UPDATE users SET color = ? WHERE id = ? AND color IS NULL");
  withTx(db, () => {
    const rest: string[] = [];
    for (const user of users) {
      const old = all<{ chat_color: number | null }>(
        db,
        "SELECT DISTINCT chat_color FROM memberships WHERE user_id = ? AND chat_color IS NOT NULL",
        user.id,
      ).map((row) => row.chat_color);
      const slot = old.length === 1 ? old[0] : null;
      if (slot != null && slot >= 0 && slot < CHAT_COLOR_COUNT && !coMemberColors(db, user.id).has(slot)) {
        kept.run(slot, user.id);
      } else rest.push(user.id);
    }
    for (const id of rest) assignUserColor(db, id);
  });
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
    endMemberEvents(db, circleId, userId);
    db.prepare("DELETE FROM calendar_share WHERE circle_id = ? AND user_id = ?").run(circleId, userId);
    db.prepare("DELETE FROM memberships WHERE circle_id = ? AND user_id = ?").run(circleId, userId);
    const row = one<{ n: number | bigint }>(
      db,
      "SELECT COUNT(*) AS n FROM memberships WHERE circle_id = ?",
      circleId,
    );
    if (!row || Number(row.n) === 0) {
      dropPlanLinks(db, "circle_id = ?", circleId);
      db.prepare("DELETE FROM plan_circles WHERE circle_id = ?").run(circleId);
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
    endMemberEvents(db, circleId, userId);
    const circle = one<{ invite_code: string }>(db, "SELECT invite_code FROM circles WHERE id = ?", circleId);
    db.prepare(
      `INSERT INTO circle_removals (circle_id, user_id, invite_code) VALUES (?, ?, ?)
       ON CONFLICT(circle_id, user_id) DO UPDATE SET invite_code = excluded.invite_code`,
    ).run(circleId, userId, circle?.invite_code ?? "");
    db.prepare("DELETE FROM calendar_share WHERE circle_id = ? AND user_id = ?").run(circleId, userId);
    db.prepare("DELETE FROM memberships WHERE circle_id = ? AND user_id = ?").run(circleId, userId);
  });
  return "ok";
}

function endMemberEvents(db: DatabaseSync, circleId: string, userId: string): void {
  deleteEventChats(db, "social", "circle_id = ? AND creator_id = ?", circleId, userId);
  db.prepare("DELETE FROM socials WHERE circle_id = ? AND creator_id = ?").run(circleId, userId);
  deleteEventChats(db, "plan", "circle_id = ? AND creator_id = ?", circleId, userId);
  dropPlanLinks(db, "circle_id = ? AND creator_id = ?", circleId, userId);
  db.prepare("DELETE FROM plans WHERE circle_id = ? AND creator_id = ?").run(circleId, userId);
  // Their plans shared into this circle from another one leave with them.
  db.prepare(
    "DELETE FROM plan_circles WHERE circle_id = ? AND plan_id IN (SELECT id FROM plans WHERE creator_id = ?)",
  ).run(circleId, userId);
  db.prepare(
    "DELETE FROM social_joins WHERE user_id = ? AND social_id IN (SELECT id FROM socials WHERE circle_id = ?)",
  ).run(userId, circleId);
  db.prepare(
    "DELETE FROM plan_joins WHERE user_id = ? AND plan_id IN (SELECT id FROM plans WHERE circle_id = ?)",
  ).run(userId, circleId);
}

export function removalBlocksJoin(db: DatabaseSync, circleId: string, userId: string, inviteCode: string): boolean {
  const row = one<{ invite_code: string }>(
    db,
    "SELECT invite_code FROM circle_removals WHERE circle_id = ? AND user_id = ?",
    circleId,
    userId,
  );
  return Boolean(row && row.invite_code === inviteCode);
}

export function clearRemoval(db: DatabaseSync, circleId: string, userId: string): void {
  db.prepare("DELETE FROM circle_removals WHERE circle_id = ? AND user_id = ?").run(circleId, userId);
}

export function clearCircleRemovals(db: DatabaseSync, circleId: string): void {
  db.prepare("DELETE FROM circle_removals WHERE circle_id = ?").run(circleId);
}

export type CircleDeleteCounts = {
  messages: number;
  chat_reads: number;
  chat_mutes: number;
  chats: number;
  social_joins: number;
  socials: number;
  plan_joins: number;
  plan_circles: number;
  plans: number;
  memberships: number;
  circle_removals: number;
  notifications: number;
  push_deliveries: number;
  circles: number;
};

export type CircleDeleteResult = {
  circle: { id: string; name: string };
  counts: CircleDeleteCounts;
};

/**
 * Removes one circle and everything that belongs to it. One transaction.
 *
 * Tables that reference circle_id:
 * memberships, socials, plans, plan_circles, notifications, circle_removals, chats, push_deliveries,
 * calendar_share (not counted; it also goes with its membership by ON DELETE CASCADE),
 * buzz_circles (not counted; goes with the circle by ON DELETE CASCADE).
 * plan_circles also loses every link of a plan whose home is this circle.
 * feedback is the exception: its rows stay and circle_id is set to NULL.
 *
 * Also removed in that same transaction (no circle_id column of their own;
 * they hang off the rows above): social_joins, plan_joins, messages,
 * chat_reads, chat_mutes. plan_reminders goes with its plan (ON DELETE CASCADE).
 *
 * Accounts, sessions, and push subscriptions stay. Those belong to the person.
 */
export function deleteCircle(db: DatabaseSync, circleId: string): CircleDeleteResult | null {
  let result: CircleDeleteResult | null = null;
  withTx(db, () => {
    const circle = one<{ id: string; name: string }>(db, "SELECT id, name FROM circles WHERE id = ?", circleId);
    if (!circle) return;
    const inChats = "chat_id IN (SELECT id FROM chats WHERE circle_id = ?)";
    const inSocials = "social_id IN (SELECT id FROM socials WHERE circle_id = ?)";
    const inPlans = "plan_id IN (SELECT id FROM plans WHERE circle_id = ?)";
    // Feedback outlives the circle it was sent from. Not counted below.
    db.prepare("UPDATE feedback SET circle_id = NULL WHERE circle_id = ?").run(circleId);
    db.prepare("DELETE FROM calendar_share WHERE circle_id = ?").run(circleId);
    const counts: CircleDeleteCounts = {
      messages: removed(db, `DELETE FROM messages WHERE ${inChats}`, circleId),
      chat_reads: removed(db, `DELETE FROM chat_reads WHERE ${inChats}`, circleId),
      chat_mutes: removed(db, `DELETE FROM chat_mutes WHERE ${inChats}`, circleId),
      chats: removed(db, "DELETE FROM chats WHERE circle_id = ?", circleId),
      social_joins: removed(db, `DELETE FROM social_joins WHERE ${inSocials}`, circleId),
      socials: removed(db, "DELETE FROM socials WHERE circle_id = ?", circleId),
      plan_joins: removed(db, `DELETE FROM plan_joins WHERE ${inPlans}`, circleId),
      plan_circles: removed(db, `DELETE FROM plan_circles WHERE circle_id = ? OR ${inPlans}`, circleId, circleId),
      plans: removed(db, "DELETE FROM plans WHERE circle_id = ?", circleId),
      memberships: removed(db, "DELETE FROM memberships WHERE circle_id = ?", circleId),
      circle_removals: removed(db, "DELETE FROM circle_removals WHERE circle_id = ?", circleId),
      notifications: removed(db, "DELETE FROM notifications WHERE circle_id = ?", circleId),
      push_deliveries: removed(db, "DELETE FROM push_deliveries WHERE circle_id = ?", circleId),
      circles: removed(db, "DELETE FROM circles WHERE id = ?", circleId),
    };
    if (counts.circles !== 1) throw new Error("circle missing");
    result = { circle: { id: circle.id, name: circle.name }, counts };
  });
  return result;
}

function removed(db: DatabaseSync, sql: string, ...params: Array<string | number>): number {
  return Number(db.prepare(sql).run(...params).changes);
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
    endsAt?: number | null;
  },
): void {
  db.prepare(
    `INSERT INTO socials (id, circle_id, creator_id, note, created_at, expires_at, last_notified_at, lat, lng, place, starts_at, reminded_at, ends_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
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
    social.endsAt ?? null,
  );
}

export function getActiveSocialByCreator(
  db: DatabaseSync,
  creatorId: string,
  circleId: string,
  now: number,
): SocialRow | undefined {
  return one<SocialRow>(
    db,
    `${SOCIAL_SELECT} WHERE s.creator_id = ? AND s.circle_id = ? AND s.expires_at > ? ORDER BY s.created_at DESC LIMIT 1`,
    creatorId,
    circleId,
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

/** Sets the host's end on a live social. expires_at follows it; null restores the caller's default window. */
export function setSocialEnd(db: DatabaseSync, id: string, endsAt: number | null, expiresAt: number): void {
  db.prepare("UPDATE socials SET ends_at = ?, expires_at = ? WHERE id = ?").run(endsAt, expiresAt, id);
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

/** Every social in the circle with a price, live or over. The bills view needs debts that outlive the event. */
export function listPricedSocials(db: DatabaseSync, circleId: string): SocialRow[] {
  return all<SocialRow>(
    db,
    `${SOCIAL_SELECT} WHERE s.circle_id = ? AND s.price_cents IS NOT NULL ORDER BY s.created_at DESC`,
    circleId,
  );
}

export function getSocial(db: DatabaseSync, id: string): SocialRow | undefined {
  return one<SocialRow>(db, `${SOCIAL_SELECT} WHERE s.id = ?`, id);
}

export function listSocialJoins(db: DatabaseSync, socialId: string): JoinRow[] {
  return all<JoinRow>(
    db,
    `SELECT u.id, u.name, u.color, u.avatar_rev, j.joined_at, j.reply, j.eta_min, j.arrive_at
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
): { reply: string; eta_min: number | null; arrive_at: number | null; blocked: number; removed_by: string | null } | undefined {
  return one(db, "SELECT reply, eta_min, arrive_at, blocked, removed_by FROM social_joins WHERE social_id = ? AND user_id = ?", socialId, userId);
}

export function blockSocialGuest(db: DatabaseSync, socialId: string, userId: string, now: number, actorName: string): void {
  db.prepare(
    `INSERT INTO social_joins (social_id, user_id, joined_at, reply, eta_min, arrive_at, blocked, removed_by)
     VALUES (?, ?, ?, 'removed', NULL, NULL, 1, ?)
     ON CONFLICT(social_id, user_id) DO UPDATE SET reply = 'removed', eta_min = NULL, arrive_at = NULL, blocked = 1, removed_by = excluded.removed_by`,
  ).run(socialId, userId, now, actorName);
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
    `SELECT s.id, s.note, s.place, s.circle_id, c.name AS circle_name, u.name AS creator_name
     FROM socials s
     JOIN users u ON u.id = s.creator_id
     JOIN circles c ON c.id = s.circle_id
     WHERE s.starts_at IS NOT NULL AND s.starts_at <= ? AND s.reminded_at IS NULL AND s.expires_at > ?`,
    now,
    now,
  );
}

export function markSocialReminded(db: DatabaseSync, socialId: string, remindedAt: number): void {
  db.prepare("UPDATE socials SET reminded_at = ? WHERE id = ?").run(remindedAt, socialId);
}

/** Stamps a social as started or re-pressed through the Flic link. */
export function markSocialBuzzed(db: DatabaseSync, socialId: string, buzzedAt: number): void {
  db.prepare("UPDATE socials SET buzzed_at = ? WHERE id = ?").run(buzzedAt, socialId);
}

export function rotateInvite(db: DatabaseSync, circleId: string, code: string, expiresAt: number): void {
  db.prepare("UPDATE circles SET invite_code = ?, invite_expires_at = ? WHERE id = ?").run(code, expiresAt, circleId);
  clearCircleRemovals(db, circleId);
}

export function removeSocialJoin(db: DatabaseSync, socialId: string, userId: string): void {
  db.prepare("DELETE FROM social_joins WHERE social_id = ? AND user_id = ?").run(socialId, userId);
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
  endsAt: number | null,
): void {
  db.prepare(
    "UPDATE socials SET note = ?, place = ?, lat = ?, lng = ?, starts_at = ?, reminded_at = ?, expires_at = ?, ends_at = ? WHERE id = ?",
  ).run(note, place, lat, lng, startsAt, remindedAt, expiresAt, endsAt, id);
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
    atTime?: string | null;
    description?: string | null;
    cardColor?: number | null;
    endsAt?: number | null;
  },
): void {
  db.prepare(
    `INSERT INTO plans (id, circle_id, creator_id, note, for_date, created_at, lat, lng, place, at_time, description, card_color, ends_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    plan.atTime ?? null,
    plan.description || null,
    plan.cardColor ?? null,
    plan.endsAt ?? null,
  );
  linkPlanCircle(db, plan.id, plan.circleId, plan.createdAt);
}

/** Plans still on the calendar: not ended by hand, not past their day, and (with `now`) not past their end time. */
export function listVisiblePlans(db: DatabaseSync, circleId: string, today: string, through: string, now?: number): PlanRow[] {
  clearExpiredPlanPoints(db, today);
  return all<PlanRow>(
    db,
    `${PLAN_SELECT} WHERE ${IN_CIRCLE} AND p.ended_at IS NULL AND p.for_date >= ? AND p.for_date <= ?
     AND (p.ends_at IS NULL OR p.ends_at > ?)
     ORDER BY p.for_date ASC, p.at_time IS NULL, p.at_time ASC, p.created_at ASC`,
    circleId,
    today,
    through,
    now ?? 0,
  );
}

/** Every plan linked to the circle with a price, past, ended or ahead. */
export function listPricedPlans(db: DatabaseSync, circleId: string): PlanRow[] {
  return all<PlanRow>(
    db,
    `${PLAN_SELECT} WHERE ${IN_CIRCLE} AND p.price_cents IS NOT NULL ORDER BY p.for_date DESC, p.created_at DESC`,
    circleId,
  );
}

/** A plan shows in every circle it is linked to. plans.circle_id is its home. */
const IN_CIRCLE = "p.id IN (SELECT plan_id FROM plan_circles WHERE circle_id = ?)";

export function listPlanCircleIds(db: DatabaseSync, planId: string): string[] {
  return all<{ circle_id: string }>(
    db,
    `SELECT pc.circle_id FROM plan_circles pc JOIN plans p ON p.id = pc.plan_id
     WHERE pc.plan_id = ? ORDER BY pc.circle_id = p.circle_id DESC, pc.added_at ASC, pc.circle_id ASC`,
    planId,
  ).map((row) => row.circle_id);
}

/** Linked circles, home first, as {id, name}. */
export function listPlanCircles(db: DatabaseSync, planId: string): Array<{ id: string; name: string }> {
  return all<{ id: string; name: string }>(
    db,
    `SELECT c.id, c.name FROM plan_circles pc
     JOIN plans p ON p.id = pc.plan_id
     JOIN circles c ON c.id = pc.circle_id
     WHERE pc.plan_id = ? ORDER BY pc.circle_id = p.circle_id DESC, pc.added_at ASC, c.name ASC`,
    planId,
  );
}

export function planInCircle(db: DatabaseSync, planId: string, circleId: string): boolean {
  return Boolean(one(db, "SELECT 1 AS ok FROM plan_circles WHERE plan_id = ? AND circle_id = ?", planId, circleId));
}

export function linkPlanCircle(db: DatabaseSync, planId: string, circleId: string, addedAt: number): void {
  db.prepare("INSERT OR IGNORE INTO plan_circles (plan_id, circle_id, added_at) VALUES (?, ?, ?)").run(planId, circleId, addedAt);
}

export function unlinkPlanCircle(db: DatabaseSync, planId: string, circleId: string): void {
  db.prepare("DELETE FROM plan_circles WHERE plan_id = ? AND circle_id = ?").run(planId, circleId);
}

/** The linked circle to show this person the plan in: home first, then link order. */
export function planCircleForUser(db: DatabaseSync, planId: string, userId: string): CircleRow | undefined {
  for (const circleId of listPlanCircleIds(db, planId)) {
    if (one(db, "SELECT 1 AS ok FROM memberships WHERE circle_id = ? AND user_id = ?", circleId, userId)) {
      return getCircleById(db, circleId);
    }
  }
  return undefined;
}

/** Members of every linked circle, once each. */
export function listPlanAudience(db: DatabaseSync, planId: string): MemberRow[] {
  const seen = new Map<string, MemberRow>();
  for (const circleId of listPlanCircleIds(db, planId)) {
    for (const member of listMembers(db, circleId)) if (!seen.has(member.id)) seen.set(member.id, member);
  }
  return [...seen.values()];
}

export function getPlan(db: DatabaseSync, id: string): PlanRow | undefined {
  return one<PlanRow>(db, `${PLAN_SELECT} WHERE p.id = ?`, id);
}

export function getPlanByShareId(db: DatabaseSync, shareId: string): PlanRow | undefined {
  return one<PlanRow>(db, `${PLAN_SELECT} WHERE p.share_id = ?`, shareId);
}

/** Sets the share id once. Returns whatever id the plan has after that. */
export function setPlanShareId(db: DatabaseSync, planId: string, shareId: string): string | null {
  db.prepare("UPDATE plans SET share_id = ? WHERE id = ? AND share_id IS NULL").run(shareId, planId);
  return one<{ share_id: string | null }>(db, "SELECT share_id FROM plans WHERE id = ?", planId)?.share_id ?? null;
}

/** Drops the share id, so the old link stops working. Sharing again makes a new one. */
export function clearPlanShareId(db: DatabaseSync, planId: string): void {
  db.prepare("UPDATE plans SET share_id = NULL WHERE id = ?").run(planId);
}

/** Records a reminder for one person. Keeps the earlier time when they were already reminded at or after `since`. */
const RECORD_REMINDER = `INSERT INTO plan_reminders (plan_id, user_id, reminded_at) VALUES (?, ?, ?)
  ON CONFLICT(plan_id, user_id) DO UPDATE SET reminded_at = excluded.reminded_at
  WHERE plan_reminders.reminded_at < ?`;

/**
 * A full "Remind friends": starts the plan's hour unless another reminder went out after `since`,
 * and records `userIds` as reminded now, plus the sender, who knows already. One transaction.
 * True when this call got the hour.
 */
export function claimPlanReminder(db: DatabaseSync, planId: string, senderId: string, userIds: string[], now: number, since: number): boolean {
  let claimed = false;
  withTx(db, () => {
    const hour = db.prepare(
      "UPDATE plans SET reminded_at = ? WHERE id = ? AND (reminded_at IS NULL OR reminded_at <= ?)",
    ).run(now, planId, since);
    if (Number(hour.changes) === 0) return;
    const record = db.prepare(RECORD_REMINDER);
    for (const userId of [...userIds, senderId]) record.run(planId, userId, now, now);
    claimed = true;
  });
  return claimed;
}

/**
 * A reminder inside the hour that started at `hourStart`: records only the people in `userIds` not
 * reminded since then, and returns them. The sender is recorded too. The hour stays as it is. One transaction.
 */
export function claimLateReminders(db: DatabaseSync, planId: string, senderId: string, userIds: string[], now: number, hourStart: number): string[] {
  const claimed: string[] = [];
  withTx(db, () => {
    const record = db.prepare(RECORD_REMINDER);
    for (const userId of userIds) {
      if (Number(record.run(planId, userId, now, hourStart).changes) > 0) claimed.push(userId);
    }
    if (claimed.length) record.run(planId, senderId, now, hourStart);
  });
  return claimed;
}

/** Everyone reminded for this plan at or after `since`. Kept apart from Alerts, which can be cleared or pruned. */
export function listPlanRemindedUserIds(db: DatabaseSync, planId: string, since: number): Set<string> {
  return new Set(all<{ user_id: string }>(
    db,
    "SELECT user_id FROM plan_reminders WHERE plan_id = ? AND reminded_at >= ?",
    planId,
    since,
  ).map((row) => row.user_id));
}

export function listPlanJoins(db: DatabaseSync, planId: string): JoinRow[] {
  return all<JoinRow>(
    db,
    `SELECT u.id, u.name, u.color, u.avatar_rev, j.joined_at, j.reply, NULL AS eta_min, j.arrive_at
     FROM plan_joins j
     JOIN users u ON u.id = j.user_id
     WHERE j.plan_id = ? AND j.blocked = 0
     ORDER BY j.joined_at ASC`,
    planId,
  );
}

export function getPlanReply(db: DatabaseSync, planId: string, userId: string): { reply: string; arrive_at: number | null; blocked: number; removed_by: string | null } | undefined {
  return one(db, "SELECT reply, arrive_at, blocked, removed_by FROM plan_joins WHERE plan_id = ? AND user_id = ?", planId, userId);
}

export function blockPlanGuest(db: DatabaseSync, planId: string, userId: string, now: number, actorName: string): void {
  db.prepare(
    `INSERT INTO plan_joins (plan_id, user_id, joined_at, reply, arrive_at, blocked, removed_by)
     VALUES (?, ?, ?, 'removed', NULL, 1, ?)
     ON CONFLICT(plan_id, user_id) DO UPDATE SET reply = 'removed', arrive_at = NULL, blocked = 1, removed_by = excluded.removed_by`,
  ).run(planId, userId, now, actorName);
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
  dropPlanLinks(db, "id = ? AND creator_id = ?", id, creatorId);
  const result = db.prepare("DELETE FROM plans WHERE id = ? AND creator_id = ?").run(id, creatorId);
  return Number(result.changes);
}

/** Keep the row and the place name. Drop the pin and mark the hangout over. */
export function finishSocial(db: DatabaseSync, id: string, now: number): boolean {
  db.prepare(
    "UPDATE socials SET expires_at = ?, lat = NULL, lng = NULL WHERE id = ? AND expires_at > ?",
  ).run(now, id, now);
  return Boolean(one(db, "SELECT 1 AS ok FROM socials WHERE id = ?", id));
}

export function finishPlan(db: DatabaseSync, id: string, now: number): boolean {
  // updated_at moves only on the first end, so a repeat end does not bump the calendar SEQUENCE.
  db.prepare(
    `UPDATE plans SET updated_at = CASE WHEN ended_at IS NULL THEN ? ELSE updated_at END,
     ended_at = COALESCE(ended_at, ?), lat = NULL, lng = NULL WHERE id = ?`,
  ).run(now, now, id);
  return Boolean(one(db, "SELECT 1 AS ok FROM plans WHERE id = ?", id));
}

export function listPastSocials(db: DatabaseSync, circleId: string, now: number): SocialRow[] {
  return all<SocialRow>(
    db,
    `${SOCIAL_SELECT} WHERE s.circle_id = ? AND s.expires_at <= ? ORDER BY COALESCE(s.starts_at, s.created_at) DESC`,
    circleId,
    now,
  );
}

/** Socials in a circle that started (starts_at, else created_at) in [fromMs, toMs). Live and ended alike. */
export function listSocialsStartedBetween(db: DatabaseSync, circleId: string, fromMs: number, toMs: number): SocialRow[] {
  return all<SocialRow>(
    db,
    `${SOCIAL_SELECT} WHERE s.circle_id = ? AND COALESCE(s.starts_at, s.created_at) >= ? AND COALESCE(s.starts_at, s.created_at) < ?
     ORDER BY COALESCE(s.starts_at, s.created_at) ASC`,
    circleId,
    fromMs,
    toMs,
  );
}

/** Plans linked to a circle with for_date in [from, to], ended ones too. */
export function listPlansOnDays(db: DatabaseSync, circleId: string, from: string, to: string): PlanRow[] {
  return all<PlanRow>(
    db,
    `${PLAN_SELECT} WHERE ${IN_CIRCLE} AND p.for_date >= ? AND p.for_date <= ?
     ORDER BY p.for_date ASC, p.at_time IS NULL, p.at_time ASC, p.created_at ASC`,
    circleId,
    from,
    to,
  );
}

export function listPastPlans(db: DatabaseSync, circleId: string, today: string, now?: number): PlanRow[] {
  return all<PlanRow>(
    db,
    `${PLAN_SELECT} WHERE ${IN_CIRCLE} AND (p.for_date < ? OR p.ended_at IS NOT NULL OR (p.ends_at IS NOT NULL AND p.ends_at <= ?))
     ORDER BY p.for_date DESC, p.created_at DESC`,
    circleId,
    today,
    now ?? 0,
  );
}

export function patchPlanDetails(
  db: DatabaseSync,
  id: string,
  note: string,
  place: string,
  lat: number | null,
  lng: number | null,
  atTime: string | null,
  forDate: string,
  description: string | null,
  /** Set when the calendar copy changed. Null keeps the last value. */
  updatedAt: number | null = null,
  endsAt: number | null = null,
): void {
  db.prepare(
    `UPDATE plans SET note = ?, place = ?, lat = ?, lng = ?, at_time = ?, for_date = ?, description = ?,
     updated_at = COALESCE(?, updated_at), ends_at = ? WHERE id = ?`,
  ).run(note, place, lat, lng, atTime, forDate, description, updatedAt, endsAt, id);
}

/** Sets or clears (null) the card colour. Not a content change, so updated_at stays. */
export function setPlanCardColor(db: DatabaseSync, id: string, cardColor: number | null): void {
  db.prepare("UPDATE plans SET card_color = ? WHERE id = ?").run(cardColor, id);
}

/** The feed token hash for this person, if the feed is on. */
export function getCalendarFeed(db: DatabaseSync, userId: string): { created_at: number } | undefined {
  return one<{ created_at: number }>(db, "SELECT created_at FROM calendar_feeds WHERE user_id = ?", userId);
}

/** One feed per person. A new token replaces the old one, so the old link stops working. */
export function setCalendarFeed(db: DatabaseSync, userId: string, tokenHash: string, now: number): void {
  db.prepare(
    `INSERT INTO calendar_feeds (user_id, token_hash, created_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at`,
  ).run(userId, tokenHash, now);
}

export function deleteCalendarFeed(db: DatabaseSync, userId: string): void {
  db.prepare("DELETE FROM calendar_feeds WHERE user_id = ?").run(userId);
}

export type AgentTokenRow = {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  token_prefix: string;
  created_at: number;
  last_used_at: number | null;
};

export function insertAgentToken(db: DatabaseSync, row: AgentTokenRow): void {
  db.prepare(
    "INSERT INTO agent_tokens (id, user_id, name, token_hash, token_prefix, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(row.id, row.user_id, row.name, row.token_hash, row.token_prefix, row.created_at, row.last_used_at);
}

export function countAgentTokens(db: DatabaseSync, userId: string): number {
  return one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM agent_tokens WHERE user_id = ?", userId)?.n ?? 0;
}

/** Newest first. */
export function listAgentTokens(db: DatabaseSync, userId: string): AgentTokenRow[] {
  return all<AgentTokenRow>(db, "SELECT * FROM agent_tokens WHERE user_id = ? ORDER BY created_at DESC, rowid DESC", userId);
}

export function getAgentTokenByHash(db: DatabaseSync, tokenHash: string): AgentTokenRow | undefined {
  return one<AgentTokenRow>(db, "SELECT * FROM agent_tokens WHERE token_hash = ?", tokenHash);
}

export function touchAgentToken(db: DatabaseSync, id: string, now: number): void {
  db.prepare("UPDATE agent_tokens SET last_used_at = ? WHERE id = ?").run(now, id);
}

/** False when the id is not this person's token. */
export function deleteAgentToken(db: DatabaseSync, userId: string, id: string): boolean {
  return Number(db.prepare("DELETE FROM agent_tokens WHERE id = ? AND user_id = ?").run(id, userId).changes) > 0;
}

export function getUserByFeedHash(db: DatabaseSync, tokenHash: string): UserRow | undefined {
  const row = one<{ user_id: string }>(db, "SELECT user_id FROM calendar_feeds WHERE token_hash = ?", tokenHash);
  return row ? getUserById(db, row.user_id) : undefined;
}

/**
 * Plans this person can see now (a member of a linked circle) and is part of:
 * host, or a live coming/maybe reply. Blocked, removed, and declined are out.
 * Upcoming first (soonest first), then recent past (newest first), within `limit`.
 */
export function listFeedPlans(db: DatabaseSync, userId: string, fromDate: string, today: string, limit: number): PlanRow[] {
  const where = `p.for_date >= ? AND EXISTS (
      SELECT 1 FROM plan_circles pc JOIN memberships m ON m.circle_id = pc.circle_id
      WHERE pc.plan_id = p.id AND m.user_id = ?)
    AND (p.creator_id = ? OR EXISTS (
      SELECT 1 FROM plan_joins j WHERE j.plan_id = p.id AND j.user_id = ? AND j.blocked = 0 AND j.reply IN ('coming', 'maybe')))`;
  const upcoming = all<PlanRow>(
    db,
    `${PLAN_SELECT} WHERE ${where} ORDER BY p.for_date ASC, COALESCE(p.at_time, '') ASC, p.created_at ASC LIMIT ?`,
    today, userId, userId, userId, limit,
  );
  const room = limit - upcoming.length;
  if (room <= 0) return upcoming;
  const past = all<PlanRow>(
    db,
    `${PLAN_SELECT} WHERE ${where} AND p.for_date < ? ORDER BY p.for_date DESC, p.created_at DESC LIMIT ?`,
    fromDate, userId, userId, userId, today, room,
  );
  return [...upcoming, ...past];
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

/** The first time this person subscribes. A later 404/410 still counts as notifications off, not "never subscribed". */
export function markPushSeen(db: DatabaseSync, userId: string, at: number): void {
  db.prepare("UPDATE users SET push_seen_at = COALESCE(push_seen_at, ?) WHERE id = ?").run(at, userId);
}

/** `standalone` is display-mode standalone (or iOS navigator.standalone). A browser report never clears a previous install. */
/** Newest What's new entry this person has seen. The client decides what newer means. */
export function setWhatsNewSeen(db: DatabaseSync, userId: string, id: string): void {
  db.prepare("UPDATE users SET whats_new_seen = ? WHERE id = ?").run(id, userId);
}

export function recordDisplay(db: DatabaseSync, userId: string, standalone: boolean, at: number): void {
  if (standalone) {
    db.prepare("UPDATE users SET display_at = ?, standalone_at = COALESCE(standalone_at, ?) WHERE id = ?").run(at, at, userId);
    return;
  }
  db.prepare("UPDATE users SET display_at = ? WHERE id = ?").run(at, userId);
}

export type ReachFlags = {
  subs: number;
  displayAt: number | null;
  standaloneAt: number | null;
  pushSeenAt: number | null;
};

export function listReachFlags(db: DatabaseSync, circleId: string): Array<{ id: string } & ReachFlags> {
  return all<{
    id: string;
    subs: number | bigint;
    display_at: number | null;
    standalone_at: number | null;
    push_seen_at: number | null;
  }>(
    db,
    `SELECT u.id,
            (SELECT COUNT(*) FROM push_subs p WHERE p.user_id = u.id) AS subs,
            u.display_at, u.standalone_at, u.push_seen_at
     FROM users u
     JOIN memberships m ON m.user_id = u.id
     WHERE m.circle_id = ?`,
    circleId,
  ).map((row) => ({
    id: row.id,
    subs: Number(row.subs),
    displayAt: row.display_at,
    standaloneAt: row.standalone_at,
    pushSeenAt: row.push_seen_at,
  }));
}

export function insertPushDelivery(
  db: DatabaseSync,
  row: {
    id: string;
    userId: string;
    subId: string;
    circleId: string;
    kind: string;
    refId: string;
    batchId: string;
    createdAt: number;
  },
): void {
  db.prepare(
    `INSERT INTO push_deliveries (id, user_id, sub_id, circle_id, kind, ref_id, batch_id, status, http_status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'sent', NULL, ?)`,
  ).run(row.id, row.userId, row.subId, row.circleId, row.kind, row.refId, row.batchId, row.createdAt);
}

export function markPushDelivered(db: DatabaseSync, id: string): void {
  db.prepare("UPDATE push_deliveries SET status = 'delivered' WHERE id = ? AND status = 'sent'").run(id);
}

export function markPushFailed(db: DatabaseSync, id: string, httpStatus: number | null): void {
  db.prepare(
    "UPDATE push_deliveries SET status = 'failed', http_status = ? WHERE id = ? AND status = 'sent'",
  ).run(httpStatus, id);
}

export function latestPushBatch(db: DatabaseSync, circleId: string, kind: string, refId: string): string | undefined {
  const row = one<{ batch_id: string }>(
    db,
    `SELECT batch_id FROM push_deliveries
     WHERE circle_id = ? AND kind = ? AND ref_id = ?
     ORDER BY created_at DESC, rowid DESC
     LIMIT 1`,
    circleId,
    kind,
    refId,
  );
  return row?.batch_id;
}

export type PushBatchRow = {
  user_id: string;
  status: string;
  http_status: number | null;
};

export function listPushBatch(db: DatabaseSync, batchId: string): PushBatchRow[] {
  return all<PushBatchRow>(
    db,
    "SELECT user_id, status, http_status FROM push_deliveries WHERE batch_id = ?",
    batchId,
  );
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
    circleId?: string | null;
    createdAt: number;
  },
): void {
  db.prepare(
    `INSERT INTO notifications (id, user_id, title, body, kind, ref_id, circle_id, created_at, read_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(note.id, note.userId, note.title, note.body, note.kind, note.refId, note.circleId ?? null, note.createdAt);
}

/** This circle's alerts plus this person's own personal alerts (see PERSONAL_ALERT_KINDS). */
export function listNotifications(db: DatabaseSync, userId: string, circleId: string, limit = 50): NotificationRow[] {
  return all<NotificationRow>(
    db,
    `SELECT * FROM notifications
     WHERE user_id = ? AND (circle_id = ? OR (circle_id IS NULL AND kind IN (${PERSONAL_KINDS_SQL})))
     ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    userId,
    circleId,
    limit,
  );
}

/** Personal alerts only. For someone who is in no circle right now. */
export function listPersonalNotifications(db: DatabaseSync, userId: string, limit = 50): NotificationRow[] {
  return all<NotificationRow>(
    db,
    `SELECT * FROM notifications
     WHERE user_id = ? AND circle_id IS NULL AND kind IN (${PERSONAL_KINDS_SQL})
     ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    userId,
    limit,
  );
}

export function markPersonalNotificationsRead(db: DatabaseSync, userId: string, readAt: number): void {
  db.prepare(
    `UPDATE notifications SET read_at = ?
     WHERE user_id = ? AND circle_id IS NULL AND kind IN (${PERSONAL_KINDS_SQL}) AND read_at IS NULL`,
  ).run(readAt, userId);
}

export function countUnreadNotifications(db: DatabaseSync, userId: string, circleId: string): number {
  const row = one<{ n: number | bigint }>(
    db,
    "SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND circle_id = ? AND read_at IS NULL",
    userId,
    circleId,
  );
  return Number(row?.n ?? 0);
}

/** Unread alerts per circle, only for circles this person is still in. */
export function unreadNotificationsByCircle(db: DatabaseSync, userId: string): Record<string, number> {
  const rows = all<{ circle_id: string; n: number | bigint }>(
    db,
    `SELECT n.circle_id, COUNT(*) AS n FROM notifications n
     JOIN memberships m ON m.circle_id = n.circle_id AND m.user_id = n.user_id
     WHERE n.user_id = ? AND n.read_at IS NULL AND n.circle_id IS NOT NULL
     GROUP BY n.circle_id`,
    userId,
  );
  const totals: Record<string, number> = {};
  for (const row of rows) totals[row.circle_id] = Number(row.n);
  return totals;
}

/** Reading a circle's alerts also reads personal ones, since that list shows them too. */
export function markNotificationsRead(db: DatabaseSync, userId: string, circleId: string, readAt: number): void {
  db.prepare(
    `UPDATE notifications SET read_at = ?
     WHERE user_id = ? AND (circle_id = ? OR (circle_id IS NULL AND kind IN (${PERSONAL_KINDS_SQL}))) AND read_at IS NULL`,
  ).run(readAt, userId, circleId);
}

/**
 * Reading one chat reads that chat's alerts only. Circle chats all share ref_id "circle", so they are scoped
 * by circle. A plan or free-post chat is one conversation across every circle it is linked to.
 */
export function markChatNotificationsRead(db: DatabaseSync, userId: string, ref: string, circleId: string | null, readAt: number): void {
  if (circleId == null) {
    db.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND kind = 'chat' AND ref_id = ? AND read_at IS NULL")
      .run(readAt, userId, ref);
    return;
  }
  db.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND kind = 'chat' AND ref_id = ? AND circle_id = ? AND read_at IS NULL")
    .run(readAt, userId, ref, circleId);
}

function dropPlanLinks(db: DatabaseSync, whereSql: string, ...params: Array<string | number>): void {
  db.prepare(`DELETE FROM plan_circles WHERE plan_id IN (SELECT id FROM plans WHERE ${whereSql})`).run(...params);
}

function deleteEventChats(db: DatabaseSync, kind: "social" | "plan", whereSql: string, ...params: Array<string | number>): void {
  const table = kind === "social" ? "socials" : "plans";
  db.prepare(`DELETE FROM chats WHERE kind = ? AND ref_id IN (SELECT id FROM ${table} WHERE ${whereSql})`).run(kind, ...params);
}

function clearExpiredSocialPoints(db: DatabaseSync, now: number): void {
  db.prepare(
    `UPDATE socials
     SET lat = NULL, lng = NULL
     WHERE expires_at <= ? AND (lat IS NOT NULL OR lng IS NOT NULL)`,
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

export const HISTORY_DAYS = 90;

export type EventKind = "plan" | "social";

export type PaidRow = { user_id: string; set_by: string; set_by_name: string; set_at: number };

/** Sets or clears the price. Clearing it also clears the collector and every paid mark. */
export function setEventPrice(db: DatabaseSync, kind: EventKind, id: string, cents: number | null): void {
  const table = kind === "plan" ? "plans" : "socials";
  if (cents == null) {
    db.prepare(`UPDATE ${table} SET price_cents = NULL, collector_id = NULL WHERE id = ?`).run(id);
    db.prepare("DELETE FROM event_payments WHERE kind = ? AND event_id = ?").run(kind, id);
    return;
  }
  db.prepare(`UPDATE ${table} SET price_cents = ? WHERE id = ?`).run(cents, id);
}

/** Null means the organizer collects. */
export function setEventCollector(db: DatabaseSync, kind: EventKind, id: string, collectorId: string | null): void {
  const table = kind === "plan" ? "plans" : "socials";
  db.prepare(`UPDATE ${table} SET collector_id = ? WHERE id = ?`).run(collectorId, id);
}

export function listEventPaid(db: DatabaseSync, kind: EventKind, id: string): PaidRow[] {
  return all<PaidRow>(
    db,
    `SELECT e.user_id, e.set_by, u.name AS set_by_name, e.set_at
     FROM event_payments e JOIN users u ON u.id = e.set_by
     WHERE e.kind = ? AND e.event_id = ?`,
    kind,
    id,
  );
}

export function setEventPaid(db: DatabaseSync, kind: EventKind, id: string, userId: string, paid: boolean, setBy: string, now: number): void {
  if (!paid) {
    db.prepare("DELETE FROM event_payments WHERE kind = ? AND event_id = ? AND user_id = ?").run(kind, id, userId);
    return;
  }
  db.prepare(
    `INSERT INTO event_payments (kind, event_id, user_id, set_by, set_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (kind, event_id, user_id) DO UPDATE SET set_by = excluded.set_by, set_at = excluded.set_at`,
  ).run(kind, id, userId, setBy, now);
}

export function sweep(db: DatabaseSync, now: number, planCutoff: string, today = ""): void {
  if (today) clearExpiredLocations(db, now, today);
  const socialCutoff = now - HISTORY_DAYS * 24 * 60 * 60 * 1000;
  const monthAgo = now - 30 * 24 * 60 * 60 * 1000;
  const planDay = today ? addDays(today, -HISTORY_DAYS) : planCutoff;
  deleteEventChats(db, "social", "expires_at < ?", socialCutoff);
  db.prepare("DELETE FROM socials WHERE expires_at < ?").run(socialCutoff);
  // A plan goes 90 days after its day. One ended early goes 90 days after it ended, even if its day is far ahead.
  const oldPlan = "for_date < ? OR (ended_at IS NOT NULL AND ended_at < ?)";
  deleteEventChats(db, "plan", oldPlan, planDay, socialCutoff);
  dropPlanLinks(db, oldPlan, planDay, socialCutoff);
  db.prepare(`DELETE FROM plans WHERE ${oldPlan}`).run(planDay, socialCutoff);
  db.prepare("DELETE FROM event_payments WHERE kind = 'plan' AND event_id NOT IN (SELECT id FROM plans)").run();
  db.prepare("DELETE FROM event_payments WHERE kind = 'social' AND event_id NOT IN (SELECT id FROM socials)").run();
  db.prepare("DELETE FROM event_invitees WHERE kind = 'plan' AND event_id NOT IN (SELECT id FROM plans)").run();
  db.prepare("DELETE FROM event_invitees WHERE kind = 'social' AND event_id NOT IN (SELECT id FROM socials)").run();
  db.prepare("DELETE FROM notifications WHERE created_at < ?").run(monthAgo);
  db.prepare("DELETE FROM push_deliveries WHERE created_at < ?").run(monthAgo);
  db.prepare("DELETE FROM auth_links WHERE expires_at < ?").run(now);
}

const SOCIAL_SELECT = `
  SELECT s.id, s.circle_id, s.creator_id, u.name AS creator_name, u.color AS creator_color, u.avatar_rev AS creator_avatar_rev,
         u.buzz_animation AS creator_buzz_animation, s.note,
         s.created_at, s.expires_at, s.last_notified_at, s.lat, s.lng, s.place, s.starts_at, s.reminded_at, s.buzzed_at,
         s.price_cents, s.collector_id, s.ends_at
  FROM socials s
  JOIN users u ON u.id = s.creator_id
`;

const PLAN_SELECT = `
  SELECT p.id, p.circle_id, p.creator_id, u.name AS creator_name, u.color AS creator_color, u.avatar_rev AS creator_avatar_rev, p.note, p.for_date, p.created_at,
         p.lat, p.lng, p.place, p.at_time, p.ended_at, p.share_id, p.description, p.reminded_at, p.updated_at,
         p.price_cents, p.collector_id, p.card_color, p.ends_at
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
