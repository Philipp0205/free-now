import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { loadConfig, readCalendarSyncKey } from "../src/config.js";
import { openDb } from "../src/db.js";
import {
  ERR,
  fetchIcs,
  isBlockedAddress,
  nodeTransport,
  normalizeCalendarUrl,
  seal,
  syncCalendarFeeds,
  syncKey,
  unseal,
  type CalendarNet,
  type Transport,
} from "../src/freebusy.js";
import { api, START, withApp } from "./http.js";

const H = 3_600_000;
const SECRET_PATH = "/private-0123456789abcdef/basic.ics";
const LINK = `https://calendar.example.test${SECRET_PATH}`;

type FakeReply = { status?: number; headers?: Record<string, string>; body?: string | Buffer; fail?: boolean; hang?: boolean };

/** Fake DNS (always a public documentation-free address) and an in-memory HTTP client. */
function fakeNet(routes: Record<string, FakeReply | (() => FakeReply)>, dnsMap: Record<string, string[]> = {}) {
  const hits: string[] = [];
  const net: CalendarNet = {
    async resolve(host) {
      const list = dnsMap[host] ?? ["93.184.216.34"];
      return list.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    },
    request: (async (url, _target, signal) => {
      hits.push(url.toString());
      const route = routes[url.toString()];
      const reply = typeof route === "function" ? route() : route;
      if (!reply || reply.fail) throw new Error("connect failed");
      if (reply.hang) {
        await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
      }
      const body = Buffer.isBuffer(reply.body) ? reply.body : Buffer.from(reply.body ?? "");
      return {
        status: reply.status ?? 200,
        headers: reply.headers ?? {},
        body: (async function* () {
          for (let i = 0; i < body.length; i += 64 * 1024) yield body.subarray(i, i + 64 * 1024);
        })(),
        destroy() {},
      };
    }) as Transport,
  };
  return { net, hits };
}

function ics(...events: Array<{ start: number; end: number; title: string }>): string {
  const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    ...events.flatMap((e, i) => [
      "BEGIN:VEVENT",
      `UID:e${i}`,
      `DTSTART:${stamp(e.start)}`,
      `DTEND:${stamp(e.end)}`,
      `SUMMARY:${e.title}`,
      "LOCATION:Secret Street 1",
      "DESCRIPTION:Private notes",
      "ATTENDEE:mailto:someone@example.test",
      "END:VEVENT",
    ]),
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

async function captureLogs<T>(fn: () => Promise<T>): Promise<{ value: T; logs: string[] }> {
  const logs: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
  try {
    return { value: await fn(), logs };
  } finally {
    console.log = log;
    console.error = error;
  }
}

test("blocks private, loopback, link-local, and special addresses, v4 and v6", () => {
  for (const address of [
    "0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255",
    "192.0.0.8", "192.0.2.1", "192.168.1.1", "198.18.0.1", "198.51.100.7", "203.0.113.9", "224.0.0.1",
    "240.0.0.1", "255.255.255.255", "::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "fec0::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::a9fe:a9fe", "2002:c0a8:0101::1", "2001:db8::1", "2001:0:1::1",
    "not-an-ip", "",
  ]) {
    assert.equal(isBlockedAddress(address), true, address);
  }
  for (const address of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700::1111", "::ffff:8.8.8.8", "2002:0808:0808::1"]) {
    assert.equal(isBlockedAddress(address), false, address);
  }
});

test("normalizes webcal and refuses bad schemes, userinfo, localhost, and private literals", () => {
  assert.equal(normalizeCalendarUrl("  webcal://cal.example.test/a.ics ").toString(), "https://cal.example.test/a.ics");
  assert.equal(normalizeCalendarUrl("webcals://cal.example.test/a.ics").protocol, "https:");
  for (const bad of ["", "ftp://cal.example.test/a.ics", "file:///etc/passwd", "javascript:alert(1)", "nope", 42, `https://x.test/${"a".repeat(2100)}`]) {
    assert.throws(() => normalizeCalendarUrl(bad), { message: ERR.badUrl });
  }
  for (const bad of ["https://user:pw@cal.example.test/a.ics", "http://localhost/a.ics", "http://127.0.0.1/a.ics", "http://[::1]/a.ics", "http://169.254.169.254/latest", "http://10.0.0.5/x.ics"]) {
    assert.throws(() => normalizeCalendarUrl(bad), { message: ERR.blocked });
  }
});

test("fetchIcs refuses hosts that resolve or redirect somewhere private", async () => {
  const body = ics({ start: START + H, end: START + 2 * H, title: "x" });
  const { net } = fakeNet(
    {
      "https://cal.example.test/a.ics": { status: 302, headers: { location: "http://10.0.0.1/a.ics" } },
      "https://hop.example.test/a.ics": { status: 302, headers: { location: "https://inside.example.test/a.ics" } },
      "https://loop.example.test/a.ics": { status: 302, headers: { location: "/a.ics" } },
      "https://ok.example.test/a.ics": { body },
    },
    { "evil.example.test": ["93.184.216.34", "127.0.0.1"], "inside.example.test": ["fd00::5"] },
  );
  await assert.rejects(fetchIcs(new URL("https://evil.example.test/a.ics"), net), { message: ERR.blocked });
  await assert.rejects(fetchIcs(new URL("https://cal.example.test/a.ics"), net), { message: ERR.blocked });
  await assert.rejects(fetchIcs(new URL("https://hop.example.test/a.ics"), net), { message: ERR.blocked });
  await assert.rejects(fetchIcs(new URL("https://loop.example.test/a.ics"), net), { message: ERR.redirects });
  const ok = await fetchIcs(new URL("https://ok.example.test/a.ics"), net);
  assert.equal(ok.host, "ok.example.test");
});

test("fetchIcs maps size, type, status, and timeout failures to safe messages", async () => {
  const big = Buffer.alloc(6 * 1024 * 1024, 65);
  const { net } = fakeNet({
    "https://a.test/len.ics": { headers: { "content-length": String(10 * 1024 * 1024) }, body: "BEGIN:VCALENDAR" },
    "https://a.test/big.ics": { body: Buffer.concat([Buffer.from("BEGIN:VCALENDAR\r\n"), big]) },
    "https://a.test/html": { body: "<html>login</html>" },
    "https://a.test/404": { status: 404 },
    "https://a.test/401": { status: 401 },
    "https://a.test/500": { status: 500 },
    "https://a.test/down": { fail: true },
    "https://a.test/slow": { hang: true },
  });
  await assert.rejects(fetchIcs(new URL("https://a.test/len.ics"), net), { message: ERR.tooLarge });
  await assert.rejects(fetchIcs(new URL("https://a.test/big.ics"), net), { message: ERR.tooLarge });
  await assert.rejects(fetchIcs(new URL("https://a.test/html"), net), { message: ERR.notCalendar });
  await assert.rejects(fetchIcs(new URL("https://a.test/404"), net), { message: ERR.notFound });
  await assert.rejects(fetchIcs(new URL("https://a.test/401"), net), { message: ERR.signIn });
  await assert.rejects(fetchIcs(new URL("https://a.test/500"), net), { message: ERR.unreachable });
  await assert.rejects(fetchIcs(new URL("https://a.test/down"), net), { message: ERR.unreachable });
  await assert.rejects(fetchIcs(new URL("https://a.test/slow"), { ...net, timeoutMs: 50 }), { message: ERR.timeout });
});

test("the real transport connects to the pinned address, not to what the name resolves to", async () => {
  const seen: Array<{ host: string | undefined; encoding: string | undefined }> = [];
  const server = http.createServer((req, res) => {
    seen.push({ host: req.headers.host, encoding: req.headers["accept-encoding"] as string | undefined });
    res.writeHead(200, { "content-type": "text/calendar" });
    res.end("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  try {
    // This name does not exist in DNS. The pinned lookup sends the socket to 127.0.0.1 anyway.
    const response = await nodeTransport(
      new URL(`http://calendar.invalid:${port}/x.ics`),
      { address: "127.0.0.1", family: 4 },
      new AbortController().signal,
    );
    let text = "";
    for await (const chunk of response.body) text += Buffer.from(chunk).toString("utf8");
    assert.equal(response.status, 200);
    assert.match(text, /BEGIN:VCALENDAR/);
    assert.equal(seen[0].host, `calendar.invalid:${port}`);
    assert.equal(seen[0].encoding, "identity");
    // And the guarded fetch with real DNS never reaches a loopback server.
    await assert.rejects(fetchIcs(new URL(`http://127.0.0.1:${port}/x.ics`)), { message: ERR.blocked });
    await assert.rejects(fetchIcs(new URL(`http://localhost:${port}/x.ics`)), { message: ERR.blocked });
    assert.equal(seen.length, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("links are sealed with AES-GCM bound to the owner; a missing key is made once per database", () => {
  const db = openDb(":memory:");
  try {
    const key = syncKey(db, { calendarSyncKey: null });
    assert.equal(key.length, 32);
    assert.equal(syncKey(db, { calendarSyncKey: null }), key);
    const sealed = seal(key, LINK, "user-a");
    assert.match(sealed, /^v1:/);
    assert.equal(sealed.includes("private-0123"), false);
    assert.equal(unseal(key, sealed, "user-a"), LINK);
    assert.equal(unseal(key, sealed, "user-b"), null);
    assert.equal(unseal(Buffer.alloc(32, 7), sealed, "user-a"), null);
    assert.equal(unseal(key, "garbage", "user-a"), null);
  } finally {
    db.close();
  }
  const hex = "ab".repeat(32);
  assert.deepEqual(readCalendarSyncKey(hex), Buffer.from(hex, "hex"));
  assert.equal(readCalendarSyncKey(Buffer.alloc(32, 9).toString("base64"))?.length, 32);
  assert.equal(readCalendarSyncKey(""), null);
  const secretish = "not-a-real-key-but-do-not-echo-it";
  assert.throws(
    () => loadConfig({ CALENDAR_SYNC_KEY: secretish }),
    (error: Error) => !error.message.includes(secretish) && /CALENDAR_SYNC_KEY/.test(error.message),
  );
});

async function circleOf(port: number) {
  const alex = await api(port, "POST", "/api/auth/start", { body: { name: "Alex" }, status: 201 });
  const friends = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Friends" }, status: 201 });
  const bea = await api(port, "POST", "/api/auth/start", { body: { name: "Bea", code: friends.circle.inviteCode }, status: 201 });
  const work = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Work" }, status: 201 });
  const cleo = await api(port, "POST", "/api/auth/start", { body: { name: "Cleo", code: work.circle.inviteCode }, status: 201 });
  const dan = await api(port, "POST", "/api/auth/start", { body: { name: "Dan" }, status: 201 });
  await api(port, "POST", "/api/circles", { token: dan.token, body: { name: "Elsewhere" }, status: 201 });
  return { alex, bea, cleo, dan, friends: friends.circle, work: work.circle };
}

function memberAvailability(me: any, id: string) {
  return me.circle.members.find((member: { id: string }) => member.id === id)?.availability;
}

test("connect, share with one circle, and friends there see busy or free, never titles", async () => {
  const feed = ics(
    { start: START - 30 * 60_000, end: START + 90 * 60_000, title: "Tennis lesson" },
    { start: START + 5 * H, end: START + 6 * H, title: "Dentist" },
  );
  const { net } = fakeNet({ [LINK]: { body: feed } });
  await withApp(async ({ port, db, advance }) => {
    const { alex, bea, cleo, friends, work } = await circleOf(port);

    const before = await api(port, "GET", "/api/me/calendar-sync", { token: alex.token, status: 200 });
    assert.deepEqual(before, {
      connected: false, googleAvailable: false, source: null, host: null, lastSyncAt: null, lastSyncOk: null, lastError: null, sharedCircleIds: [],
      circles: [{ id: friends.id, name: "Friends" }, { id: work.id, name: "Work" }],
    });
    const notYet = await api(port, "PATCH", "/api/me/calendar-sync", { token: alex.token, body: { sharedCircleIds: [friends.id] }, status: 409 });
    assert.equal(notYet.error, "Connect a calendar first.");

    const { value: connected, logs } = await captureLogs(() =>
      api(port, "PUT", "/api/me/calendar-sync", { token: alex.token, body: { url: LINK }, status: 200 }),
    );
    assert.equal(connected.connected, true);
    assert.equal(connected.host, "calendar.example.test");
    assert.equal(connected.lastSyncOk, true);
    assert.equal(connected.lastSyncAt, START);
    assert.deepEqual(connected.sharedCircleIds, []);
    assert.equal(JSON.stringify(connected).includes(SECRET_PATH), false);
    assert.ok(logs.some((line) => line.startsWith("calendar sync ok host=calendar.example.test status=200")));
    assert.equal(logs.some((line) => line.includes(SECRET_PATH) || line.includes("Tennis")), false);

    // Stored: sealed link, busy intervals, sealed titles. Nothing in plain text.
    const dump = JSON.stringify([
      db.prepare("SELECT * FROM calendar_sync").all(),
      db.prepare("SELECT * FROM calendar_busy").all(),
      db.prepare("SELECT * FROM calendar_event").all(),
    ]);
    for (const secret of [SECRET_PATH, "Tennis", "Dentist", "Secret Street", "Private notes", "someone@"]) {
      assert.equal(dump.includes(secret), false, secret);
    }
    assert.deepEqual(db.prepare("SELECT start_ms, end_ms FROM calendar_busy ORDER BY start_ms").all().map((r: any) => [r.start_ms, r.end_ms]), [
      [START, START + 90 * 60_000],
      [START + 5 * H, START + 6 * H],
    ]);

    // Off until shared: nobody sees anything yet.
    let beaMe = await api(port, "GET", `/api/me?circle=${friends.id}`, { token: bea.token, status: 200 });
    assert.equal(memberAvailability(beaMe, alex.user.id), null);

    const shared = await api(port, "PATCH", "/api/me/calendar-sync", { token: alex.token, body: { sharedCircleIds: [friends.id] }, status: 200 });
    assert.deepEqual(shared.sharedCircleIds, [friends.id]);
    const notMine = await api(port, "PATCH", "/api/me/calendar-sync", { token: bea.token, body: { sharedCircleIds: [] }, status: 409 });
    assert.ok(notMine.error);
    const outsider = await api(port, "PATCH", "/api/me/calendar-sync", { token: alex.token, body: { sharedCircleIds: ["00000000-0000-4000-8000-000000000000"] }, status: 400 });
    assert.equal(outsider.error, "You are not in that circle");
    await api(port, "PATCH", "/api/me/calendar-sync", { token: alex.token, body: { sharedCircleIds: "nope" }, status: 400 });

    beaMe = await api(port, "GET", `/api/me?circle=${friends.id}`, { token: bea.token, status: 200 });
    assert.deepEqual(memberAvailability(beaMe, alex.user.id), { state: "busy", until: START + 90 * 60_000 });
    assert.equal(memberAvailability(beaMe, bea.user.id), null);
    // Alex sees no availability line for himself.
    const alexMe = await api(port, "GET", `/api/me?circle=${friends.id}`, { token: alex.token, status: 200 });
    assert.equal(memberAvailability(alexMe, alex.user.id), null);
    // Cleo shares Work with Alex, which he did not share.
    const cleoMe = await api(port, "GET", `/api/me?circle=${work.id}`, { token: cleo.token, status: 200 });
    assert.equal(memberAvailability(cleoMe, alex.user.id), null);
    const cleoAt = await api(port, "GET", `/api/circles/availability?circle=${work.id}`, { token: cleo.token, status: 200 });
    assert.deepEqual(cleoAt.people, []);

    // Later times.
    const later = await api(port, "GET", `/api/circles/availability?circle=${friends.id}&at=${START + 2 * H}`, { token: bea.token, status: 200 });
    assert.deepEqual(later.people, [{ id: alex.user.id, state: "free", until: START + 5 * H }]);
    const during = await api(port, "GET", `/api/circles/availability?circle=${friends.id}&at=${START + 5.5 * H}`, { token: bea.token, status: 200 });
    assert.deepEqual(during.people, [{ id: alex.user.id, state: "busy", until: START + 6 * H }]);
    const after = await api(port, "GET", `/api/circles/availability?circle=${friends.id}&at=${START + 7 * H}`, { token: bea.token, status: 200 });
    assert.deepEqual(after.people, [{ id: alex.user.id, state: "free", until: null }]);
    const beyond = await api(port, "GET", `/api/circles/availability?circle=${friends.id}&at=${START + 15 * 24 * H}`, { token: bea.token, status: 200 });
    assert.deepEqual(beyond.people, []);
    await api(port, "GET", `/api/circles/availability?circle=${friends.id}&at=${START + 40 * 24 * H}`, { token: bea.token, status: 400 });
    await api(port, "GET", `/api/circles/availability?circle=${friends.id}&at=soon`, { token: bea.token, status: 400 });
    await api(port, "GET", "/api/circles/availability", { status: 401 });

    // Stale data shows nothing.
    db.prepare("UPDATE calendar_sync SET next_sync_at = ?").run(START + 100 * H);
    advance(25 * H);
    beaMe = await api(port, "GET", `/api/me?circle=${friends.id}`, { token: bea.token, status: 200 });
    assert.equal(memberAvailability(beaMe, alex.user.id), null);
  }, { calendarNet: net });
});

test("own day events: titles for the owner only, absent from everything a friend can read", async () => {
  const feed = ics(
    { start: START + H, end: START + 2 * H, title: "Tennis lesson" },
    { start: START + 26 * H, end: START + 27 * H, title: "Other day" },
  );
  const { net } = fakeNet({ [LINK]: { body: feed } });
  await withApp(async ({ port }) => {
    const { alex, bea, friends } = await circleOf(port);
    await api(port, "PUT", "/api/me/calendar-sync", { token: alex.token, body: { url: LINK }, status: 200 });
    await api(port, "PATCH", "/api/me/calendar-sync", { token: alex.token, body: { sharedCircleIds: [friends.id] }, status: 200 });

    const day = await api(port, "GET", "/api/me/calendar-sync/day?date=2026-06-01", { token: alex.token, status: 200 });
    assert.deepEqual(day, {
      connected: true,
      date: "2026-06-01",
      events: [{ title: "Tennis lesson", start: START + H, end: START + 2 * H, allDay: false }],
    });
    const beaDay = await api(port, "GET", "/api/me/calendar-sync/day?date=2026-06-01", { token: bea.token, status: 200 });
    assert.deepEqual(beaDay, { connected: false, date: "2026-06-01", events: [] });
    await api(port, "GET", "/api/me/calendar-sync/day?date=2026-02-30", { token: alex.token, status: 400 });
    await api(port, "GET", "/api/me/calendar-sync/day?date=2026-06-01", { status: 401 });

    const plan = await api(port, "POST", "/api/plans", { token: alex.token, body: { note: "Dinner", circleId: friends.id }, status: 201 });
    const social = await api(port, "POST", "/api/socials", { token: alex.token, body: { note: "Coffee", circleId: friends.id }, status: 201 });
    const reads = [
      `/api/me?circle=${friends.id}`,
      `/api/circles/availability?circle=${friends.id}`,
      `/api/circles/availability?circle=${friends.id}&at=${START + 90 * 60_000}`,
      "/api/me/calendar-sync",
      "/api/me/calendar-sync/day?date=2026-06-01",
      "/api/me/calendar-sync/day?date=bad",
      `/api/plans?circle=${friends.id}`,
      `/api/socials?circle=${friends.id}`,
      `/api/plans/${plan.plan.id}`,
      `/api/socials/${social.social.id}`,
      "/api/me/calendar-sync/nope",
    ];
    for (const path of reads) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { authorization: `Bearer ${bea.token}` } });
      const text = await response.text();
      assert.equal(text.includes("Tennis"), false, path);
      assert.equal(text.includes("Other day"), false, path);
      assert.equal(text.includes(SECRET_PATH), false, path);
    }
    const busy = await api(port, "GET", `/api/circles/availability?circle=${friends.id}&at=${START + 90 * 60_000}`, { token: bea.token, status: 200 });
    assert.deepEqual(busy.people, [{ id: alex.user.id, state: "busy", until: START + 2 * H }]);
  }, { calendarNet: net });
});

test("blocked links store nothing; other first-fetch failures are kept with the reason", async () => {
  const { net } = fakeNet(
    { "https://down.example.test/a.ics": { fail: true }, "https://html.example.test/a.ics": { body: "<html></html>" } },
    { "inside.example.test": ["10.0.0.7"] },
  );
  await withApp(async ({ port, db }) => {
    const { alex } = await circleOf(port);
    for (const url of ["http://127.0.0.1/a.ics", "https://inside.example.test/a.ics", "https://u:p@cal.example.test/a.ics"]) {
      const res = await api(port, "PUT", "/api/me/calendar-sync", { token: alex.token, body: { url }, status: 400 });
      assert.equal(res.error, ERR.blocked);
    }
    const bad = await api(port, "POST", "/api/me/calendar-sync", { token: alex.token, body: { url: "ftp://x.test/a" }, status: 400 });
    assert.equal(bad.error, ERR.badUrl);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM calendar_sync").get()!.n, 0);

    const down = await api(port, "POST", "/api/me/calendar-sync", { token: alex.token, body: { url: "https://down.example.test/a.ics" }, status: 200 });
    assert.equal(down.connected, true);
    assert.equal(down.lastSyncOk, false);
    assert.equal(down.lastError, ERR.unreachable);
    const html = await api(port, "PUT", "/api/me/calendar-sync", { token: alex.token, body: { url: "https://html.example.test/a.ics" }, status: 200 });
    assert.equal(html.lastError, ERR.notCalendar);
    assert.equal(html.host, "html.example.test");
  }, { calendarNet: net });
});

test("sync backs off on failure, keeps old busy time, and drops a result after a replace", async () => {
  let mode: "ok" | "down" = "ok";
  const feed = ics({ start: START + H, end: START + 2 * H, title: "Busy" });
  const { net } = fakeNet({ [LINK]: () => (mode === "ok" ? { body: feed } : { fail: true }) });
  await withApp(async ({ port, db, at }) => {
    const { alex, friends, bea } = await circleOf(port);
    await api(port, "PUT", "/api/me/calendar-sync", { token: alex.token, body: { url: LINK }, status: 200 });
    await api(port, "PATCH", "/api/me/calendar-sync", { token: alex.token, body: { sharedCircleIds: [friends.id] }, status: 200 });
    const row = () => db.prepare("SELECT * FROM calendar_sync").get() as any;
    assert.equal(row().next_sync_at, START + 20 * 60_000);

    let now = START;
    const deps = { db, config: { calendarSyncKey: null, tz: "UTC" }, now: () => now, calendarNet: net };
    assert.equal(await syncCalendarFeeds(deps), 0);
    mode = "down";
    const waits: number[] = [];
    for (let i = 0; i < 5; i++) {
      now = row().next_sync_at;
      await captureLogs(() => syncCalendarFeeds(deps));
      waits.push(row().next_sync_at - now);
    }
    assert.deepEqual(waits.map((ms) => ms / 60_000), [15, 30, 60, 120, 120]);
    assert.equal(row().fail_count, 5);
    assert.equal(row().last_error, ERR.unreachable);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM calendar_busy").get()!.n, 1);
    at(START + 30 * 60_000);
    const status = await api(port, "GET", "/api/me/calendar-sync", { token: alex.token, status: 200 });
    assert.equal(status.lastSyncOk, false);
    const seen = await api(port, "GET", `/api/circles/availability?circle=${friends.id}&at=${START + 90 * 60_000}`, { token: bea.token, status: 200 });
    assert.equal(seen.people[0].state, "busy");

    // A result that lands after the link was replaced is thrown away.
    mode = "ok";
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow: CalendarNet = {
      resolve: net.resolve,
      request: async (url, target, signal) => {
        await gate;
        return net.request!(url, target, signal);
      },
    };
    const running = syncCalendarFeeds({ ...deps, now: () => row().next_sync_at, calendarNet: slow });
    await new Promise((resolve) => setTimeout(resolve, 10));
    db.prepare("UPDATE calendar_sync SET rev = 'replaced'").run();
    release();
    await captureLogs(() => running);
    assert.equal(row().fail_count, 5);
    assert.equal(row().last_ok, 0);
  }, { calendarNet: net });
});

test("replace keeps shares, leave and kick drop them, delete removes everything, and connects are rate limited", async () => {
  const feed = ics({ start: START + H, end: START + 2 * H, title: "Busy" });
  const other = "https://other.example.test/b.ics";
  const { net } = fakeNet({ [LINK]: { body: feed }, [other]: { body: ics() } });
  await withApp(async ({ port, db }) => {
    const { alex, bea, friends, work } = await circleOf(port);
    await api(port, "PUT", "/api/me/calendar-sync", { token: alex.token, body: { url: LINK }, status: 200 });
    await api(port, "PATCH", "/api/me/calendar-sync", { token: alex.token, body: { sharedCircleIds: [friends.id, work.id] }, status: 200 });
    const replaced = await api(port, "PUT", "/api/me/calendar-sync", { token: alex.token, body: { url: other }, status: 200 });
    assert.equal(replaced.host, "other.example.test");
    assert.deepEqual(replaced.sharedCircleIds, [friends.id, work.id]);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM calendar_busy").get()!.n, 0);

    await api(port, "PUT", "/api/me/calendar-sync", { token: bea.token, body: { url: LINK }, status: 200 });
    await api(port, "PATCH", "/api/me/calendar-sync", { token: bea.token, body: { sharedCircleIds: [friends.id] }, status: 200 });
    await api(port, "POST", "/api/circles/leave", { token: bea.token, body: { circleId: friends.id }, status: 200 });
    assert.deepEqual((await api(port, "GET", "/api/me/calendar-sync", { token: bea.token })).sharedCircleIds, []);

    const cleo2 = await circleOfCleo(port, work.inviteCode);
    const shares = () => db.prepare("SELECT COUNT(*) AS n FROM calendar_share WHERE user_id = ?").get(cleo2.user.id)!.n;
    assert.equal(shares(), 1);
    await api(port, "DELETE", `/api/circles/members/${cleo2.user.id}?circle=${work.id}`, { token: alex.token, status: 204 });
    assert.equal(shares(), 0);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);

    const removed = await api(port, "DELETE", "/api/me/calendar-sync", { token: alex.token, status: 200 });
    assert.equal(removed.connected, false);
    assert.deepEqual(removed.sharedCircleIds, []);
    for (const table of ["calendar_busy", "calendar_event", "calendar_share"]) {
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).get(alex.user.id)!.n, 0, table);
    }

    let limited = 0;
    for (let i = 0; i < 12; i++) {
      const res = await api({ port }, "POST", "/api/me/calendar-sync/refresh", { token: bea.token });
      if (res.status === 429) limited++;
    }
    assert.ok(limited >= 1);
  }, { calendarNet: net });
});

async function circleOfCleo(port: number, code: string) {
  const cleo = await api(port, "POST", "/api/auth/start", { body: { name: "Cleo two", code }, status: 201 });
  await api(port, "PUT", "/api/me/calendar-sync", { token: cleo.token, body: { url: LINK }, status: 200 });
  const me = await api(port, "GET", "/api/me", { token: cleo.token });
  await api(port, "PATCH", "/api/me/calendar-sync", { token: cleo.token, body: { sharedCircleIds: [me.circle.id] }, status: 200 });
  return cleo;
}
