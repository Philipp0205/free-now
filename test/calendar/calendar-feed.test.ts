import assert from "node:assert/strict";
import test from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { DURATION_NOTE, FEED_MAX_EVENTS } from "../../src/calendar/calendar.js";
import { escapeText } from "../../src/calendar/ics.js";
import { api, START, withApp, testEmail } from "../http.js";

type Person = { token: string; user: { id: string; name: string } };
const DAY = 24 * 60 * 60 * 1000;

/** Friends: Alex (host), Bea, Dan, Kim. Climbing: Alex, Cam. Olli is elsewhere. */
async function seed(port: number) {
  const start = (name: string, code?: string): Promise<Person> =>
    api(port, "POST", "/api/auth/start", { body: code ? { name, email: testEmail(), code } : { name, email: testEmail() }, status: 201 });
  const alex = await start("Alex");
  const a = (await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Friends" }, status: 201 })).circle;
  const bea = await start("Bea", a.inviteCode);
  const dan = await start("Dan", a.inviteCode);
  const kim = await start("Kim", a.inviteCode);
  const b = (await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Climbing" }, status: 201 })).circle;
  const cam = await start("Cam", b.inviteCode);
  const olli = await start("Olli");
  await api(port, "POST", "/api/circles", { token: olli.token, body: { name: "Elsewhere" }, status: 201 });
  return { alex, bea, dan, kim, cam, olli, a, b };
}

async function makePlan(port: number, host: Person, circleId: string, body: Record<string, unknown> = {}) {
  return (await api(port, "POST", `/api/plans?circle=${circleId}`, {
    token: host.token,
    body: { note: "Sushi night", place: "Sushi Bar, Main St; 2nd floor", date: "2026-06-02", time: "19:00", ...body },
    status: 201,
  })).plan as { id: string; note: string };
}

async function reply(port: number, person: Person, planId: string, circleId: string, value: string) {
  await api(port, "POST", `/api/plans/${planId}/reply?circle=${circleId}`, { token: person.token, body: { reply: value }, status: 200 });
}

async function raw(port: number, pathname: string, token?: string, method = "GET") {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: response.status, headers: response.headers, text: await response.text() };
}

/** Unfolded content lines. */
function lines(text: string): string[] {
  return text.replace(/\r\n /g, "").split("\r\n").filter(Boolean);
}

/** VEVENT blocks keyed by UID. */
function events(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of lines(text)) {
    if (line === "BEGIN:VEVENT") current = [];
    else if (line === "END:VEVENT" && current) {
      const uid = current.find((row) => row.startsWith("UID:"))?.slice(4) ?? "";
      out.set(uid, current);
      current = null;
    } else if (current) current.push(line);
  }
  return out;
}

function field(event: string[] | undefined, name: string): string | undefined {
  return event?.find((row) => row.startsWith(`${name}:`) || row.startsWith(`${name};`))?.replace(/^[^:]*:/, "");
}

/** Not api(): its status error prints the body, and this body holds the feed link. */
async function turnOnFeed(port: number, person: Person) {
  const response = await fetch(`http://127.0.0.1:${port}/api/me/calendar-feed`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${person.token}` },
    body: "{}",
  });
  assert.equal(response.status, 201, "turn on calendar feed");
  return (await response.json()) as { active: boolean; createdAt: number; url: string; webcalUrl: string };
}

function feedPath(url: string): string {
  return new URL(url).pathname;
}

// Feed links are secrets. Node's test reporter prints an assertion's actual and
// expected values even with a custom message, so anything that holds a link is
// only ever compared as a boolean.
function check(ok: boolean, label: string): void {
  assert.ok(ok, label);
}

test("GET /api/plans/:id/calendar.ics is one event for people who can see the plan", async () => {
  await withApp(async ({ port }) => {
    const { alex, bea, dan, cam, olli, a } = await seed(port);
    const plan = await makePlan(port, alex, a.id, { note: "Sushi, then karaoke" });
    await api(port, "PATCH", `/api/plans/${plan.id}?circle=${a.id}`, {
      token: alex.token,
      body: { description: "Bring cash; table for 6" },
      status: 200,
    });
    await reply(port, bea, plan.id, a.id, "in");
    await reply(port, dan, plan.id, a.id, "maybe");

    const host = await raw(port, `/api/plans/${plan.id}/calendar.ics`, alex.token);
    assert.equal(host.status, 200);
    assert.equal(host.headers.get("content-type"), "text/calendar; charset=utf-8");
    assert.equal(host.headers.get("content-disposition"), 'attachment; filename="sushi-then-karaoke.ics"');
    assert.match(host.headers.get("cache-control") ?? "", /no-store/);
    assert.equal(host.headers.get("referrer-policy"), "no-referrer");
    const all = lines(host.text);
    assert.equal(all[0], "BEGIN:VCALENDAR");
    assert.ok(all.includes("METHOD:PUBLISH"));
    assert.ok(all.includes("X-WR-TIMEZONE:Europe/Berlin"));
    assert.equal(all.some((row) => row.startsWith("X-WR-CALNAME")), false, "a one-off file is not a named calendar");
    const event = events(host.text).get(`${plan.id}@hangry`);
    assert.ok(event, "UID is planId@hangry without PUBLIC_BASE_URL");
    assert.equal(field(event, "SUMMARY"), "Sushi\\, then karaoke");
    assert.equal(field(event, "DTSTART"), "20260602T170000Z", "19:00 Berlin in June");
    assert.equal(field(event, "DTEND"), "20260602T190000Z");
    assert.equal(field(event, "STATUS"), "CONFIRMED");
    assert.equal(field(event, "LOCATION"), "Sushi Bar\\, Main St\\; 2nd floor");
    assert.equal(
      field(event, "DESCRIPTION"),
      `Hosted by Alex\\n\\nBring cash\\; table for 6\\n\\n${escapeText(DURATION_NOTE)}\\n\\nSpontaco: http://127.0.0.1:${port}/?plan=${plan.id}`,
    );
    assert.equal(field(event, "SEQUENCE"), "1", "the description edit counts as a change");
    assert.equal(field(event, "DTSTAMP"), "20260601T150000Z");

    const going = events((await raw(port, `/api/plans/${plan.id}/calendar.ics`, bea.token)).text).get(`${plan.id}@hangry`);
    assert.equal(field(going, "STATUS"), "CONFIRMED");
    const maybe = events((await raw(port, `/api/plans/${plan.id}/calendar.ics`, dan.token)).text).get(`${plan.id}@hangry`);
    assert.equal(field(maybe, "STATUS"), "TENTATIVE");

    for (const text of [host.text]) {
      for (const secret of ["Bea", "Dan", "Kim", "/p/", "inviteCode", a.inviteCode]) assert.equal(text.includes(secret), false, secret);
    }

    assert.equal((await raw(port, `/api/plans/${plan.id}/calendar.ics`, cam.token)).status, 404, "other circle");
    assert.equal((await raw(port, `/api/plans/${plan.id}/calendar.ics`, olli.token)).status, 404, "stranger");
    assert.equal((await raw(port, `/api/plans/${plan.id}/calendar.ics`)).status, 401);
    assert.equal((await raw(port, "/api/plans/not-a-uuid/calendar.ics", alex.token)).status, 404);
  }, { tz: "Europe/Berlin" });
});

test("single export: removed and unlinked people get 404, ended plans 410, no time is all day", async () => {
  await withApp(async ({ port, at }) => {
    const { alex, bea, cam, a, b } = await seed(port);
    const plan = await makePlan(port, alex, a.id, { time: null });
    const text = (await raw(port, `/api/plans/${plan.id}/calendar.ics`, alex.token)).text;
    const event = events(text).get(`${plan.id}@hangry`);
    assert.ok(event?.includes("DTSTART;VALUE=DATE:20260602"));
    assert.ok(event?.includes("DTEND;VALUE=DATE:20260603"));
    assert.equal(text.includes("no end time"), false, "an all-day plan has no 2 hour note");

    await api(port, "PATCH", `/api/plans/${plan.id}?circle=${a.id}`, { token: alex.token, body: { circleIds: [a.id, b.id] }, status: 200 });
    assert.equal((await raw(port, `/api/plans/${plan.id}/calendar.ics`, cam.token)).status, 200, "linked circle");
    await api(port, "PATCH", `/api/plans/${plan.id}?circle=${a.id}`, { token: alex.token, body: { circleIds: [a.id] }, status: 200 });
    assert.equal((await raw(port, `/api/plans/${plan.id}/calendar.ics`, cam.token)).status, 404, "unlinked again");

    await api(port, "DELETE", `/api/plans/${plan.id}/people/${bea.user.id}?circle=${a.id}`, { token: alex.token, status: 204 });
    assert.equal((await raw(port, `/api/plans/${plan.id}/calendar.ics`, bea.token)).status, 404, "removed guest");

    at(START + 2 * DAY);
    assert.equal((await raw(port, `/api/plans/${plan.id}/calendar.ics`, alex.token)).status, 410, "past day");
    at(START);
    await api(port, "DELETE", `/api/plans/${plan.id}?circle=${a.id}`, { token: alex.token, status: 204 });
    assert.equal((await raw(port, `/api/plans/${plan.id}/calendar.ics`, alex.token)).status, 410, "ended");
  }, { tz: "Europe/Berlin" });
});

test("feed management: shown once, only the hash is stored, reset and turn off kill the old link", async () => {
  await withApp(async ({ port, db }) => {
    const { alex } = await seed(port);
    assert.deepEqual(await api(port, "GET", "/api/me/calendar-feed", { token: alex.token, status: 200 }), { active: false, createdAt: null });
    assert.equal((await raw(port, "/api/me/calendar-feed")).status, 401);

    const first = await turnOnFeed(port, alex);
    assert.equal(first.active, true);
    assert.equal(first.createdAt, START);
    const token = /\/cal\/([A-Za-z0-9_-]+)\.ics$/.exec(first.url)?.[1] ?? "";
    assert.equal(token.length, 43, "32 random bytes as base64url");
    check(first.webcalUrl === first.url.replace(/^http:\/\//, "webcal://"), "webcal link is the same link");
    assert.deepEqual(await api(port, "GET", "/api/me/calendar-feed", { token: alex.token, status: 200 }), { active: true, createdAt: START });
    assertNoPlainToken(db, token);

    const ok = await raw(port, feedPath(first.url));
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "text/calendar; charset=utf-8");
    assert.equal(ok.headers.get("cache-control"), "private, no-store");
    assert.equal(ok.headers.get("referrer-policy"), "no-referrer");
    assert.equal(ok.headers.get("content-disposition"), null);
    assert.ok(lines(ok.text).includes("X-WR-CALNAME:Spontaco"));
    assert.equal((await raw(port, feedPath(first.url), undefined, "HEAD")).status, 200);

    const second = await turnOnFeed(port, alex);
    check(second.url !== first.url, "reset makes a new link");
    const gone = await raw(port, feedPath(first.url));
    assert.equal(gone.status, 404);
    assert.equal(gone.text, "", "a dead link says nothing");
    assert.equal((await raw(port, feedPath(second.url))).status, 200);

    await api(port, "DELETE", "/api/me/calendar-feed", { token: alex.token, status: 204 });
    assert.equal((await raw(port, feedPath(second.url))).status, 404);
    assert.deepEqual(await api(port, "GET", "/api/me/calendar-feed", { token: alex.token, status: 200 }), { active: false, createdAt: null });

    for (const bad of ["/cal/x.ics", `/cal/${"A".repeat(43)}.ics`, `/cal/${"%".repeat(3)}.ics`]) {
      const response = await raw(port, bad);
      assert.equal(response.status, 404, bad);
      assert.equal(response.text, "", bad);
    }
    // Without .ics it is the plain app shell, never calendar data.
    const shell = await raw(port, `/cal/${token}`);
    assert.equal(shell.text.includes("BEGIN:VCALENDAR"), false);
  });
});

function assertNoPlainToken(db: DatabaseSync, token: string): void {
  const rows = db.prepare("SELECT * FROM calendar_feeds").all() as Array<Record<string, unknown>>;
  assert.equal(rows.length, 1);
  assert.equal(JSON.stringify(rows).includes(token), false);
  assert.match(String(rows[0].token_hash), /^[0-9a-f]{64}$/);
}

test("the feed lists hosted, in, and maybe plans the person can still see, nothing else", async () => {
  await withApp(async ({ port }) => {
    const { alex, bea, dan, kim, cam, a, b } = await seed(port);
    const hosted = await makePlan(port, alex, a.id, { note: "Hosted by Alex" });
    const going = await makePlan(port, bea, a.id, { note: "Bea going" });
    const maybe = await makePlan(port, dan, a.id, { note: "Dan maybe" });
    const declined = await makePlan(port, kim, a.id, { note: "Kim declined" });
    const silent = await makePlan(port, bea, a.id, { note: "Never answered" });
    const removed = await makePlan(port, dan, a.id, { note: "Removed from" });
    const climbing = await makePlan(port, cam, b.id, { note: "Climbing" });
    await reply(port, alex, going.id, a.id, "in");
    await reply(port, alex, maybe.id, a.id, "maybe");
    await reply(port, alex, declined.id, a.id, "cant");
    await reply(port, alex, removed.id, a.id, "in");
    await api(port, "DELETE", `/api/plans/${removed.id}/people/${alex.user.id}?circle=${a.id}`, { token: dan.token, status: 204 });
    await reply(port, alex, climbing.id, b.id, "in");

    const { url } = await turnOnFeed(port, alex);
    const feed = events((await raw(port, feedPath(url))).text);
    assert.deepEqual([...feed.keys()].sort(), [hosted.id, going.id, maybe.id, climbing.id].map((id) => `${id}@hangry`).sort());
    assert.equal(field(feed.get(`${hosted.id}@hangry`), "STATUS"), "CONFIRMED");
    assert.equal(field(feed.get(`${going.id}@hangry`), "STATUS"), "CONFIRMED");
    assert.equal(field(feed.get(`${maybe.id}@hangry`), "STATUS"), "TENTATIVE");
    assert.equal(field(feed.get(`${silent.id}@hangry`), "STATUS"), undefined);

    const text = (await raw(port, feedPath(url))).text;
    for (const secret of ["Kim", a.inviteCode, b.inviteCode, "/p/"]) assert.equal(text.includes(secret), false, secret);
    assert.ok(text.includes("Hosted by Bea"), "host names are fine");

    // Leaving Climbing drops its plan on the next fetch.
    await api(port, "POST", `/api/circles/leave?circle=${b.id}`, { token: alex.token, body: {}, status: 200 });
    const after = events((await raw(port, feedPath(url))).text);
    assert.equal(after.has(`${climbing.id}@hangry`), false);
    assert.equal(after.size, 3);

    // Saying can't after in also drops it.
    await reply(port, alex, going.id, a.id, "cant");
    assert.equal(events((await raw(port, feedPath(url))).text).has(`${going.id}@hangry`), false);
  });
});

test("edits bump SEQUENCE, ending keeps the UID as CANCELLED, past plans age out after 30 days", async () => {
  await withApp(async ({ port, at, db }) => {
    const { alex, a } = await seed(port);
    const plan = await makePlan(port, alex, a.id);
    const { url } = await turnOnFeed(port, alex);
    const uid = `${plan.id}@hangry`;
    const read = async () => events((await raw(port, feedPath(url))).text).get(uid);

    const fresh = await read();
    assert.equal(field(fresh, "SEQUENCE"), "0");
    assert.equal(field(fresh, "LAST-MODIFIED"), "20260601T150000Z");

    at(START + 60_000);
    await api(port, "PATCH", `/api/plans/${plan.id}?circle=${a.id}`, { token: alex.token, body: { time: "20:00" }, status: 200 });
    const moved = await read();
    assert.equal(field(moved, "SEQUENCE"), "60");
    assert.equal(field(moved, "DTSTART"), "20260602T200000Z");
    assert.equal(field(moved, "LAST-MODIFIED"), "20260601T150100Z");

    // Nothing the calendar shows changed: SEQUENCE stays.
    at(START + 120_000);
    await api(port, "PATCH", `/api/plans/${plan.id}?circle=${a.id}`, { token: alex.token, body: { time: "20:00" }, status: 200 });
    assert.equal(field(await read(), "SEQUENCE"), "60");

    at(START + 180_000);
    await api(port, "DELETE", `/api/plans/${plan.id}?circle=${a.id}`, { token: alex.token, status: 204 });
    const ended = await read();
    assert.equal(field(ended, "STATUS"), "CANCELLED");
    assert.equal(field(ended, "SEQUENCE"), "180");
    const stamp = db.prepare("SELECT updated_at FROM plans WHERE id = ?").get(plan.id) as { updated_at: number };
    assert.equal(stamp.updated_at, START + 180_000);

    at(START + 25 * DAY);
    assert.ok(await read(), "25 days after, still there");
    at(START + 32 * DAY);
    assert.equal(await read(), undefined, "over 30 days after the plan day, gone");
  });
});

test("the feed caps at 200 events: upcoming first, then the most recent past", async () => {
  await withApp(async ({ port, db, at }) => {
    const { alex, a } = await seed(port);
    const insert = db.prepare(
      "INSERT INTO plans (id, circle_id, creator_id, note, for_date, created_at, place) VALUES (?, ?, ?, ?, ?, ?, '')",
    );
    const link = db.prepare("INSERT INTO plan_circles (plan_id, circle_id, added_at) VALUES (?, ?, ?)");
    const ids: string[] = [];
    for (let i = 0; i < 220; i += 1) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      const day = new Date(Date.parse("2026-06-20T00:00:00Z") + (i - 20) * DAY).toISOString().slice(0, 10);
      insert.run(id, a.id, alex.user.id, `Plan ${i}`, day, START);
      link.run(id, a.id, START);
      ids.push(id);
    }
    at(Date.parse("2026-06-20T12:00:00Z"));
    const { url } = await turnOnFeed(port, alex);
    const feed = events((await raw(port, feedPath(url))).text);
    assert.equal(feed.size, FEED_MAX_EVENTS);
    // 200 upcoming (index 20 to 219) fill the cap, so no past plan fits.
    assert.equal(feed.has(`${ids[219]}@hangry`), true);
    assert.equal(feed.has(`${ids[19]}@hangry`), false);

    db.prepare("DELETE FROM plans WHERE id IN (SELECT id FROM plans ORDER BY for_date DESC LIMIT 30)").run();
    const trimmed = events((await raw(port, feedPath(url))).text);
    assert.equal(trimmed.size, 190);
    assert.equal(trimmed.has(`${ids[19]}@hangry`), true, "yesterday fills the room first");
  });
});

test("with PUBLIC_BASE_URL the UID host and links use it, the same UID in file and feed", async () => {
  await withApp(async ({ port }) => {
    const { alex, a } = await seed(port);
    const plan = await makePlan(port, alex, a.id);
    const feed = await turnOnFeed(port, alex);
    check(/^https:\/\/hangry\.example\.com\/cal\/[A-Za-z0-9_-]{43}\.ics$/.test(feed.url), "feed link uses PUBLIC_BASE_URL");
    check(/^webcal:\/\/hangry\.example\.com\/cal\//.test(feed.webcalUrl), "webcal link uses PUBLIC_BASE_URL");
    const uid = `${plan.id}@hangry.example.com`;
    const file = events((await raw(port, `/api/plans/${plan.id}/calendar.ics`, alex.token)).text).get(uid);
    const sub = events((await raw(port, feedPath(feed.url))).text).get(uid);
    assert.ok(file && sub);
    assert.equal(field(file, "URL"), `https://hangry.example.com/?plan=${plan.id}`);
    assert.equal(field(sub, "URL"), field(file, "URL"));
  }, { env: { PUBLIC_BASE_URL: "https://hangry.example.com" } });
});

test("the feed keeps DST times: a missing spring time moves to 03:30 with a note, a repeated fall time is the first one", async () => {
  await withApp(async ({ port, db, at }) => {
    const { alex, a } = await seed(port);
    const insert = db.prepare(
      "INSERT INTO plans (id, circle_id, creator_id, note, for_date, at_time, created_at, place) VALUES (?, ?, ?, ?, ?, ?, ?, '')",
    );
    const link = db.prepare("INSERT INTO plan_circles (plan_id, circle_id, added_at) VALUES (?, ?, ?)");
    const spring = "00000000-0000-4000-8000-000000000001";
    const fall = "00000000-0000-4000-8000-000000000002";
    insert.run(spring, a.id, alex.user.id, "Night owls", "2027-03-28", "02:30", START);
    insert.run(fall, a.id, alex.user.id, "Extra hour", "2026-10-25", "02:30", START);
    link.run(spring, a.id, START);
    link.run(fall, a.id, START);
    at(Date.parse("2026-10-01T12:00:00Z"));
    const { url } = await turnOnFeed(port, alex);
    const feed = events((await raw(port, feedPath(url))).text);

    const gap = feed.get(`${spring}@hangry`);
    assert.equal(field(gap, "DTSTART"), "20270328T013000Z", "02:30 CET read before the gap is 03:30 CEST");
    assert.equal(field(gap, "DTEND"), "20270328T033000Z");
    assert.ok(field(gap, "DESCRIPTION")?.includes(
      escapeText("Planned for 02:30, a time that does not exist on this day because clocks move forward. Shown at 03:30."),
    ));
    assert.ok(field(gap, "DESCRIPTION")?.includes(escapeText(DURATION_NOTE)));

    const twice = feed.get(`${fall}@hangry`);
    assert.equal(field(twice, "DTSTART"), "20261025T003000Z", "the first 02:30, still CEST");
    assert.equal(field(twice, "DESCRIPTION")?.includes("does not exist"), false);
  }, { tz: "Europe/Berlin" });
});

test("a feed fetch that throws logs a redacted line, never the token", async () => {
  await withApp(async ({ port, db }) => {
    const { alex, a } = await seed(port);
    await makePlan(port, alex, a.id);
    const { url } = await turnOnFeed(port, alex);
    const path = feedPath(url);
    const token = /\/cal\/([^/]+)\.ics$/.exec(path)?.[1] ?? "";
    check(token.length === 43, "got a token");

    // Fail inside the feed query with an error that carries the path and token, as a careless one might.
    const prepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      if (sql.includes("plan_circles pc JOIN memberships")) throw new Error(`boom while serving ${path} (token ${token})`);
      return prepare(sql);
    }) as typeof db.prepare;

    const printed: string[] = [];
    const saved = { error: console.error, log: console.log, warn: console.warn, info: console.info };
    const capture = (...args: unknown[]) => {
      printed.push(args.map((arg) => (arg instanceof Error ? `${arg.stack} ${arg.message}` : String(arg))).join(" "));
    };
    console.error = capture;
    console.log = capture;
    console.warn = capture;
    console.info = capture;
    let status = 0;
    try {
      status = (await raw(port, path)).status;
      // A percent-encoded copy of the same path must not leak either.
      await raw(port, `/cal/${encodeURIComponent(token).replace(/A/g, "%41")}.ics`);
    } finally {
      Object.assign(console, saved);
      db.prepare = prepare;
    }
    assert.equal(status, 500);
    check(printed.length >= 1, "the failure was logged");
    check(printed.every((line) => line.startsWith("feed error")), "logged as a feed error");
    check(printed.every((line) => !line.includes(token)), "no log line holds the token");
    check(printed.some((line) => line.includes("/cal/[token]")), "the path is redacted, not dropped");
    assert.equal((await raw(port, path)).status, 200, "back to normal once the fault is gone");
  });
});
