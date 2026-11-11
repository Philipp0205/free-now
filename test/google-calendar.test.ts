import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { GOOGLE_FREEBUSY_SCOPE, onlyFreebusyScope } from "../src/google-calendar.js";
import { syncCalendarFeeds, type CalendarNet } from "../src/freebusy.js";
import { fakeGoogle, REFRESH, type Fake } from "./fake-google.js";
import { api, START, withApp } from "./http.js";

const H = 3_600_000;
const SCOPE = "https://www.googleapis.com/auth/calendar.freebusy";
const LINK = "https://calendar.example.test/private-0123456789abcdef/basic.ics";
const sha = (text: string) => crypto.createHash("sha256").update(text).digest("hex");

async function withGoogle(fn: (ctx: Parameters<Parameters<typeof withApp>[0]>[0], fake: Fake) => Promise<void>, calendarNet?: CalendarNet) {
  const fake = await fakeGoogle();
  try {
    await withApp((ctx) => fn(ctx, fake), { env: fake.env, calendarNet });
  } finally {
    await fake.close();
  }
}

function icsNet(body: string): CalendarNet {
  return {
    async resolve() {
      return [{ address: "93.184.216.34", family: 4 }];
    },
    request: (async () => ({
      status: 200,
      headers: {},
      body: (async function* () {
        yield Buffer.from(body);
      })(),
      destroy() {},
    })) as any,
  };
}

function icsFile(title: string, start: number, end: number): string {
  const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:a", `DTSTART:${stamp(start)}`, `DTEND:${stamp(end)}`, `SUMMARY:${title}`, "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
}

async function setup(port: number) {
  const alex = await api(port, "POST", "/api/auth/start", { body: { name: "Alex" }, status: 201 });
  const friends = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Friends" }, status: 201 });
  const bea = await api(port, "POST", "/api/auth/start", { body: { name: "Bea", code: friends.circle.inviteCode }, status: 201 });
  return { alex, bea, friends: friends.circle };
}

async function begin(port: number, token: string): Promise<{ authUrl: URL; state: string }> {
  const started = await api(port, "GET", "/api/calendar/google/start", { token, status: 200 });
  const authUrl = new URL(started.url);
  return { authUrl, state: authUrl.searchParams.get("state")! };
}

async function callback(port: number, query: Record<string, string>): Promise<{ status: number; location: string }> {
  const response = await fetch(`http://127.0.0.1:${port}/api/calendar/google/callback?${new URLSearchParams(query)}`, { redirect: "manual" });
  return { status: response.status, location: response.headers.get("location") ?? "" };
}

function stored(db: any) {
  return db.prepare("SELECT * FROM calendar_sync").all()[0] as any;
}

test("the scope constant is freebusy alone, and broader grants are refused", () => {
  assert.equal(GOOGLE_FREEBUSY_SCOPE, SCOPE);
  assert.equal(onlyFreebusyScope(SCOPE), true);
  for (const bad of [
    undefined, "", "https://www.googleapis.com/auth/calendar", "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/calendar.events", `${SCOPE} https://www.googleapis.com/auth/calendar.readonly`,
    `${SCOPE} openid`, "https://www.googleapis.com/auth/calendar.freebusy.extra",
  ]) {
    assert.equal(onlyFreebusyScope(bad), false, String(bad));
  }
});

test("config: Google is on only with both id and secret; bad override URLs throw", () => {
  const base = { PORT: "3000", DB_PATH: ":memory:", APP_TZ: "UTC" };
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  try {
    assert.equal(loadConfig(base).googleClientId, null);
    const half = loadConfig({ ...base, GOOGLE_CLIENT_ID: "only-id-value" });
    assert.equal(half.googleClientId, null);
    assert.equal(half.googleClientSecret, null);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].includes("only-id-value"), false);
    const blank = loadConfig({ ...base, GOOGLE_CLIENT_ID: "  ", GOOGLE_CLIENT_SECRET: "x" });
    assert.equal(blank.googleClientId, null);
    const on = loadConfig({ ...base, GOOGLE_CLIENT_ID: " id ", GOOGLE_CLIENT_SECRET: " secret " });
    assert.equal(on.googleClientId, "id");
    assert.equal(on.googleClientSecret, "secret");
    assert.equal(on.googleUrls.auth, "https://accounts.google.com/o/oauth2/v2/auth");
    assert.equal(on.googleUrls.token, "https://oauth2.googleapis.com/token");
    assert.equal(on.googleUrls.freebusy, "https://www.googleapis.com/calendar/v3/freeBusy");
    assert.equal(on.googleUrls.revoke, "https://oauth2.googleapis.com/revoke");
    assert.throws(() => loadConfig({ ...base, GOOGLE_OAUTH_TOKEN_URL: "ftp://x.test" }), /GOOGLE_OAUTH_TOKEN_URL/);
  } finally {
    console.warn = warn;
  }
});

test("without the env the feature is hidden and the link flow still works", async () => {
  const net = icsNet(icsFile("Tennis", START + H, START + 2 * H));
  await withApp(async ({ port }) => {
    const { alex } = await setup(port);
    await api(port, "GET", "/api/calendar/google/start", { token: alex.token, status: 404 });
    const cb = await fetch(`http://127.0.0.1:${port}/api/calendar/google/callback?code=x&state=y`, { redirect: "manual" });
    assert.equal(cb.status, 404);
    const status = await api(port, "GET", "/api/me/calendar-sync", { token: alex.token, status: 200 });
    assert.equal(status.googleAvailable, false);
    const linked = await api(port, "PUT", "/api/me/calendar-sync", { token: alex.token, body: { url: LINK }, status: 200 });
    assert.equal(linked.connected, true);
    assert.equal(linked.source, "ics");
    assert.equal(linked.googleAvailable, false);
  }, { calendarNet: net });
});

test("start needs a session and returns a consent URL with PKCE, state, and the freebusy scope only", async () => {
  await withGoogle(async ({ port, db }, fake) => {
    const { alex } = await setup(port);
    await api(port, "GET", "/api/calendar/google/start", { status: 401 });
    const { authUrl, state } = await begin(port, alex.token);
    assert.equal(authUrl.origin + authUrl.pathname, fake.env.GOOGLE_OAUTH_AUTH_URL);
    const q = authUrl.searchParams;
    assert.equal(q.get("client_id"), "test-client");
    assert.ok(q.get("redirect_uri")!.endsWith("/api/calendar/google/callback"));
    assert.equal(q.get("response_type"), "code");
    assert.equal(q.get("access_type"), "offline");
    assert.equal(q.get("prompt"), "consent");
    assert.equal(q.get("code_challenge_method"), "S256");
    assert.equal(q.get("scope"), SCOPE);
    assert.ok(state.length >= 43);
    const row = db.prepare("SELECT * FROM google_oauth_state").get() as any;
    assert.equal(row.state, state);
    assert.equal(row.user_id, alex.user.id);
    assert.equal(row.expires_at - row.created_at, 10 * 60_000);
    assert.equal(q.get("code_challenge"), crypto.createHash("sha256").update(row.code_verifier).digest("base64url"));
    assert.equal(authUrl.href.includes(alex.token), false);
    assert.equal(authUrl.href.includes("test-secret"), false);
    const status = await api(port, "GET", "/api/me/calendar-sync", { token: alex.token, status: 200 });
    assert.equal(status.googleAvailable, true);
    assert.equal(status.source, null);
  });
});

test("callback refuses unknown, malformed, expired, and reused state, and a failed try burns the state", async () => {
  await withGoogle(async ({ port, db, advance }, fake) => {
    const { alex } = await setup(port);
    const fail = "/?calendar=google-error";
    for (const query of [{}, { code: "good-code" }, { code: "good-code", state: "nope" }, { code: "good-code", state: "x".repeat(43) }]) {
      const out = await callback(port, query);
      assert.equal(out.status, 302);
      assert.ok(out.location.endsWith(fail), JSON.stringify(query));
    }
    assert.equal(fake.tokenForms.length, 0);

    const expired = await begin(port, alex.token);
    advance(10 * 60_000 + 1);
    assert.ok((await callback(port, { code: "good-code", state: expired.state })).location.endsWith(fail));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM google_oauth_state").get().n, 0);
    assert.equal(fake.tokenForms.length, 0);

    const used = await begin(port, alex.token);
    assert.ok((await callback(port, { code: "good-code", state: used.state })).location.endsWith("/?calendar=google"));
    assert.ok((await callback(port, { code: "good-code", state: used.state })).location.endsWith(fail));
    assert.equal(fake.tokenForms.length, 1);

    const denied = await begin(port, alex.token);
    assert.ok((await callback(port, { error: "access_denied", state: denied.state })).location.endsWith(fail));
    assert.ok((await callback(port, { code: "good-code", state: denied.state })).location.endsWith(fail));
    assert.equal(fake.tokenForms.length, 1);

    const wrongCode = await begin(port, alex.token);
    assert.ok((await callback(port, { code: "bad-code", state: wrongCode.state })).location.endsWith(fail));
    assert.ok((await callback(port, { code: "good-code", state: wrongCode.state })).location.endsWith(fail));

    await begin(port, alex.token);
    await begin(port, alex.token);
    advance(11 * 60_000);
    await begin(port, alex.token);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM google_oauth_state").get().n, 1);
  });
});

test("happy path: tokens sealed, busy blocks shared with friends, no titles anywhere", async () => {
  await withGoogle(async ({ port, db }, fake) => {
    fake.busy = [
      { start: START - H, end: START + H },
      { start: START + 30 * 60_000, end: START + 2 * H },
      { start: START + 5 * H, end: START + 6 * H },
    ];
    const { alex, bea, friends } = await setup(port);
    const { state } = await begin(port, alex.token);
    const logs: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
    let out;
    try {
      out = await callback(port, { code: "good-code", state });
    } finally {
      console.log = log;
    }
    assert.equal(out.status, 302);
    assert.equal(out.location, `http://127.0.0.1:${port}/?calendar=google`);

    const form = fake.tokenForms[0];
    assert.equal(form.get("grant_type"), "authorization_code");
    assert.equal(form.get("client_id"), "test-client");
    assert.equal(form.get("redirect_uri"), `http://127.0.0.1:${port}/api/calendar/google/callback`);
    assert.ok((form.get("code_verifier") ?? "").length >= 43);
    assert.equal(fake.freebusyCalls.length, 1);
    assert.ok(fake.freebusyCalls[0].bearer.startsWith("Bearer access-"));
    assert.deepEqual(fake.freebusyCalls[0].body, {
      timeMin: new Date(START).toISOString(),
      timeMax: new Date(START + 14 * 24 * H).toISOString(),
      items: [{ id: "primary" }],
    });
    assert.equal(logs.some((line) => line.includes(REFRESH) || line.includes("good-code") || line.includes("access-") || line.includes("test-secret")), false);

    const row = stored(db);
    assert.equal(row.source, "google");
    assert.equal(row.host, "Google");
    assert.equal(row.url_enc, "");
    assert.match(row.token_enc, /^v1:/);
    const dump = JSON.stringify([db.prepare("SELECT * FROM calendar_sync").all(), db.prepare("SELECT * FROM calendar_busy").all(), db.prepare("SELECT * FROM calendar_event").all()]);
    assert.equal(dump.includes(REFRESH), false);
    assert.equal(dump.includes("access-"), false);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM google_oauth_state").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM calendar_event").get().n, 0);
    assert.deepEqual(db.prepare("SELECT start_ms, end_ms FROM calendar_busy ORDER BY start_ms").all().map((r: any) => [r.start_ms, r.end_ms]), [
      [START, START + 2 * H],
      [START + 5 * H, START + 6 * H],
    ]);

    const status = await api(port, "GET", "/api/me/calendar-sync", { token: alex.token, status: 200 });
    assert.equal(status.connected, true);
    assert.equal(status.source, "google");
    assert.equal(status.host, "Google");
    assert.equal(status.lastSyncOk, true);
    assert.equal(status.googleAvailable, true);
    assert.equal(JSON.stringify(status).includes("v1:"), false);

    await api(port, "PATCH", "/api/me/calendar-sync", { token: alex.token, body: { sharedCircleIds: [friends.id] }, status: 200 });
    const now = await api(port, "GET", `/api/circles/availability?circle=${friends.id}`, { token: bea.token, status: 200 });
    assert.deepEqual(now.people, [{ id: alex.user.id, state: "busy", until: START + 2 * H }]);
    const later = await api(port, "GET", `/api/circles/availability?circle=${friends.id}&at=${START + 3 * H}`, { token: bea.token, status: 200 });
    assert.deepEqual(later.people, [{ id: alex.user.id, state: "free", until: START + 5 * H }]);
    const day = await api(port, "GET", "/api/me/calendar-sync/day?date=2026-06-01", { token: alex.token, status: 200 });
    assert.deepEqual(day.events, []);
  });
});

test("a grant broader than freebusy, or without a refresh token, is refused and nothing is stored", async () => {
  await withGoogle(async ({ port, db }, fake) => {
    const { alex } = await setup(port);
    for (const scope of ["https://www.googleapis.com/auth/calendar", `${SCOPE} https://www.googleapis.com/auth/calendar.readonly`, "https://www.googleapis.com/auth/calendar.events", ""]) {
      fake.mode.scope = scope;
      const { state } = await begin(port, alex.token);
      const out = await callback(port, { code: "good-code", state });
      assert.ok(out.location.endsWith("/?calendar=google-error"), scope);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM calendar_sync").get().n, 0);
    }
    assert.equal(fake.freebusyCalls.length, 0);
    assert.equal(fake.revokes.length, 4);
    assert.ok(fake.revokes.every((token) => token === REFRESH));

    fake.mode.scope = SCOPE;
    fake.mode.refreshToken = null;
    const { state } = await begin(port, alex.token);
    assert.ok((await callback(port, { code: "good-code", state })).location.endsWith("/?calendar=google-error"));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM calendar_sync").get().n, 0);
  });
});

async function connected(port: number, fake: Fake) {
  const world = await setup(port);
  const { state } = await begin(port, world.alex.token);
  await callback(port, { code: "good-code", state });
  await api(port, "PATCH", "/api/me/calendar-sync", { token: world.alex.token, body: { sharedCircleIds: [world.friends.id] }, status: 200 });
  fake.freebusyCalls.length = 0;
  fake.tokenForms.length = 0;
  return world;
}

test("refresh trades the stored token for a fresh access token and replaces the busy blocks", async () => {
  await withGoogle(async ({ port, db, advance }, fake) => {
    fake.busy = [{ start: START + H, end: START + 2 * H }];
    const { alex } = await connected(port, fake);
    fake.busy = [{ start: START + 7 * H, end: START + 8 * H }];
    advance(5 * 60_000);
    const status = await api(port, "POST", "/api/me/calendar-sync/refresh", { token: alex.token, status: 200 });
    assert.equal(status.lastSyncOk, true);
    assert.equal(status.source, "google");
    assert.equal(fake.tokenForms.length, 1);
    assert.equal(fake.tokenForms[0].get("grant_type"), "refresh_token");
    assert.equal(sha(fake.tokenForms[0].get("refresh_token")!), sha(REFRESH));
    assert.equal(fake.freebusyCalls.length, 1);
    assert.equal(fake.freebusyCalls[0].bearer, `Bearer access-${fake.mode.accessCount}`);
    assert.deepEqual(db.prepare("SELECT start_ms FROM calendar_busy").all().map((r: any) => r.start_ms), [START + 7 * H]);
    assert.equal(JSON.stringify(db.prepare("SELECT * FROM calendar_sync").all()).includes("access-"), false);
  });
});

test("the timer syncs Google rows too, on the same cadence", async () => {
  await withGoogle(async ({ port, db }, fake) => {
    const { alex } = await connected(port, fake);
    const config = { ...loadConfig({ PORT: "3000", DB_PATH: ":memory:", APP_TZ: "UTC", ...fake.env }) };
    let now = START;
    const deps = { db, config, now: () => now };
    assert.equal(await syncCalendarFeeds(deps), 0);
    fake.busy = [{ start: START + 3 * H, end: START + 4 * H }];
    now = START + 21 * 60_000;
    assert.equal(await syncCalendarFeeds(deps), 1);
    assert.deepEqual(db.prepare("SELECT start_ms FROM calendar_busy WHERE user_id = ?").all(alex.user.id).map((r: any) => r.start_ms), [START + 3 * H]);
  });
});

test("a failed refresh or a Google error keeps the old blocks and backs off", async () => {
  await withGoogle(async ({ port, db, advance }, fake) => {
    fake.busy = [{ start: START + H, end: START + 2 * H }];
    const { alex } = await connected(port, fake);
    advance(5 * 60_000);

    fake.mode.refreshFails = true;
    let status = await api(port, "POST", "/api/me/calendar-sync/refresh", { token: alex.token, status: 200 });
    assert.equal(status.lastSyncOk, false);
    assert.equal(status.lastError, "Reconnect your calendar");
    assert.equal(fake.freebusyCalls.length, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM calendar_busy").get().n, 1);
    assert.ok(stored(db).next_sync_at > START + 5 * 60_000);

    fake.mode.refreshFails = false;
    fake.mode.freebusyError = true;
    status = await api(port, "POST", "/api/me/calendar-sync/refresh", { token: alex.token, status: 200 });
    assert.equal(status.lastSyncOk, false);
    assert.equal(status.lastError, "Google Calendar did not return your busy times");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM calendar_busy").get().n, 1);

    fake.mode.freebusyError = false;
    status = await api(port, "POST", "/api/me/calendar-sync/refresh", { token: alex.token, status: 200 });
    assert.equal(status.lastSyncOk, true);
    assert.equal(status.lastError, null);
  });
});

test("disconnect revokes the refresh token and deletes everything; a failed revoke still deletes", async () => {
  await withGoogle(async ({ port, db }, fake) => {
    fake.busy = [{ start: START + H, end: START + 2 * H }];
    const { alex } = await connected(port, fake);
    const gone = await api(port, "DELETE", "/api/me/calendar-sync", { token: alex.token, status: 200 });
    assert.equal(gone.connected, false);
    assert.equal(gone.source, null);
    assert.deepEqual(fake.revokes.map(sha), [sha(REFRESH)]);
    for (const table of ["calendar_sync", "calendar_busy", "calendar_event", "calendar_share"]) {
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
    }
  });
  await withGoogle(async ({ port, db }, fake) => {
    const { alex } = await connected(port, fake);
    fake.mode.revokeStatus = 500;
    await api(port, "DELETE", "/api/me/calendar-sync", { token: alex.token, status: 200 });
    assert.equal(fake.revokes.length, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM calendar_sync").get().n, 0);
  });
  await withGoogle(async ({ port, db }, fake) => {
    const { alex } = await connected(port, fake);
    await fake.close();
    await api(port, "DELETE", "/api/me/calendar-sync", { token: alex.token, status: 200 });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM calendar_sync").get().n, 0);
  });
});

test("link and Google replace each other; only Google is revoked; shares stay", async () => {
  const feed = icsFile("Tennis lesson", START + H, START + 2 * H);
  await withGoogle(async ({ port, db }, fake) => {
    const { alex, friends } = await setup(port);
    await api(port, "PUT", "/api/me/calendar-sync", { token: alex.token, body: { url: LINK }, status: 200 });
    await api(port, "PATCH", "/api/me/calendar-sync", { token: alex.token, body: { sharedCircleIds: [friends.id] }, status: 200 });
    const day = () => api(port, "GET", "/api/me/calendar-sync/day?date=2026-06-01", { token: alex.token, status: 200 });
    assert.equal((await day()).events.length, 1);

    fake.busy = [{ start: START + 4 * H, end: START + 5 * H }];
    const { state } = await begin(port, alex.token);
    await callback(port, { code: "good-code", state });
    let row = stored(db);
    assert.equal(row.source, "google");
    assert.equal(row.url_enc, "");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM calendar_event").get().n, 0);
    assert.deepEqual((await day()).events, []);
    assert.deepEqual(db.prepare("SELECT circle_id FROM calendar_share").all().map((r: any) => r.circle_id), [friends.id]);
    assert.deepEqual(db.prepare("SELECT start_ms FROM calendar_busy").all().map((r: any) => r.start_ms), [START + 4 * H]);
    assert.equal(fake.revokes.length, 0);

    const linked = await api(port, "PUT", "/api/me/calendar-sync", { token: alex.token, body: { url: LINK }, status: 200 });
    assert.equal(linked.source, "ics");
    assert.equal(linked.host, "calendar.example.test");
    row = stored(db);
    assert.equal(row.token_enc, null);
    assert.match(row.url_enc, /^v1:/);
    assert.deepEqual(fake.revokes.map(sha), [sha(REFRESH)]);
    assert.equal((await day()).events.length, 1);
    assert.deepEqual(db.prepare("SELECT circle_id FROM calendar_share").all().map((r: any) => r.circle_id), [friends.id]);

    await api(port, "DELETE", "/api/me/calendar-sync", { token: alex.token, status: 200 });
    assert.equal(fake.revokes.length, 1);
  }, icsNet(feed));
});

test("an existing database gains source and token_enc, and old link rows read as ics", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hangry-gcal-"));
  const file = path.join(dir, "old.sqlite");
  try {
    let db = openDb(file);
    db.prepare("INSERT INTO users (id, name, token_hash, buzz_token, created_at) VALUES ('u1', 'Old', 'h', 'b', 1)").run();
    db.exec("ALTER TABLE calendar_sync DROP COLUMN source");
    db.exec("ALTER TABLE calendar_sync DROP COLUMN token_enc");
    db.prepare("INSERT INTO calendar_sync (user_id, url_enc, host, rev, created_at, next_sync_at) VALUES ('u1', 'v1:x', 'cal.test', 'r', 1, 1)").run();
    db.close();
    db = openDb(file);
    const columns = (db.prepare("PRAGMA table_info(calendar_sync)").all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(columns.includes("source") && columns.includes("token_enc"));
    const row = db.prepare("SELECT source, token_enc FROM calendar_sync").get() as any;
    assert.equal(row.source, "ics");
    assert.equal(row.token_enc, null);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
