import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { FEEDBACK_LIMIT, cleanFeedbackText, cleanPrUrl } from "../src/feedback.js";
import { START, api, withApp } from "./http.js";

const ADMIN = "a".repeat(32);
const FIELDS = ["appVersion", "circleId", "circleName", "createdAt", "id", "note", "prUrl", "status", "text", "userId", "userName"];

type Hit = { status: number; json: any };

async function hit(
  port: number,
  method: string,
  pathname: string,
  options: { token?: string; body?: unknown; forwarded?: string; circle?: string } = {},
): Promise<Hit> {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: {
      ...(options.forwarded ? { "x-forwarded-for": options.forwarded } : {}),
      ...(options.circle ? { "x-circle": options.circle } : {}),
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

async function captureLogs<T>(fn: (logs: string[]) => Promise<T>): Promise<T> {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((part) => String(part)).join(" "));
  };
  try {
    return await fn(logs);
  } finally {
    console.log = original;
  }
}

async function people(port: number) {
  const alex = await api(port, "POST", "/api/auth/start", { body: { name: "Alex" }, status: 201 });
  const friends = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Friends" }, status: 201 });
  const bea = await api(port, "POST", "/api/auth/start", { body: { name: "Bea" }, status: 201 });
  const club = await api(port, "POST", "/api/circles", { token: bea.token, body: { name: "Club" }, status: 201 });
  return { alex, bea, friends: friends.circle, club: club.circle };
}

test("text is trimmed, keeps line breaks, and must be 1–2000 characters", () => {
  assert.equal(cleanFeedbackText("  hi  "), "hi");
  assert.equal(cleanFeedbackText("a\r\nb\rc"), "a\nb\nc");
  assert.equal(cleanFeedbackText("tab\there\u0000\u0007"), "tab\there");
  assert.equal(cleanFeedbackText("   \n "), null);
  assert.equal(cleanFeedbackText(42), null);
  assert.equal(cleanFeedbackText("x".repeat(2000))?.length, 2000);
  assert.equal(cleanFeedbackText(`  ${"x".repeat(2000)}  `)?.length, 2000);
  assert.equal(cleanFeedbackText("x".repeat(2001)), null);
  assert.equal(cleanPrUrl(""), null);
  assert.equal(cleanPrUrl(null), null);
  assert.equal(cleanPrUrl("https://github.com/o/r/pull/1"), "https://github.com/o/r/pull/1");
  assert.equal(cleanPrUrl("javascript:alert(1)"), undefined);
  assert.equal(cleanPrUrl("not a url"), undefined);
  assert.equal(cleanPrUrl(`https://x.dev/${"a".repeat(500)}`), undefined);
  assert.deepEqual(FEEDBACK_LIMIT, { limit: 5, windowMs: 600_000 });
});

test("POST /api/feedback stores it with the sender, circle, and build", async () => {
  await withApp(async ({ port, db }) => {
    const { alex, friends } = await people(port);
    const logs = await captureLogs(async (logs) => {
      const sent = await hit(port, "POST", "/api/feedback", {
        token: alex.token,
        forwarded: "203.0.113.1",
        body: { text: "  The map is great.\r\nMore pins please.  ", circleId: friends.id, appVersion: "hangry-v13" },
      });
      assert.equal(sent.status, 201);
      assert.equal(sent.json.ok, true);
      assert.match(sent.json.id, /^[0-9a-f-]{36}$/);
      assert.deepEqual(Object.keys(sent.json).sort(), ["id", "ok"]);
      const row = db.prepare("SELECT * FROM feedback WHERE id = ?").get(sent.json.id) as Record<string, unknown>;
      assert.equal(row.user_id, alex.user.id);
      assert.equal(row.circle_id, friends.id);
      assert.equal(row.text, "The map is great.\nMore pins please.");
      assert.equal(row.app_version, "hangry-v13");
      assert.equal(row.status, "new");
      assert.equal(row.created_at, START);
      assert.equal(row.pr_url, null);
      assert.equal(row.note, null);
      return logs;
    });
    assert.ok(logs.includes("feedback ok"));
    assert.equal(logs.some((line) => line.includes("map is great")), false);
  });
});

test("feedback needs a sign-in and 1–2000 characters", async () => {
  await withApp(async ({ port, db }) => {
    const { alex } = await people(port);
    const anonymous = await hit(port, "POST", "/api/feedback", { forwarded: "203.0.113.2", body: { text: "hi" } });
    assert.equal(anonymous.status, 401);
    for (const text of ["", "   \n\t ", "x".repeat(2001), 7, null]) {
      const bad = await hit(port, "POST", "/api/feedback", { token: alex.token, forwarded: "203.0.113.2", body: { text } });
      assert.equal(bad.status, 400, String(text).slice(0, 10));
      assert.equal(bad.json.error, "feedback must be 1–2000 characters");
    }
    const missing = await hit(port, "POST", "/api/feedback", { token: alex.token, forwarded: "203.0.113.2", body: {} });
    assert.equal(missing.status, 400);
    const longest = await hit(port, "POST", "/api/feedback", {
      token: alex.token,
      forwarded: "203.0.113.2",
      body: { text: "y".repeat(2000) },
    });
    assert.equal(longest.status, 201);
    const count = db.prepare("SELECT COUNT(*) AS n FROM feedback").get() as { n: number };
    assert.equal(Number(count.n), 1);
  });
});

test("a circle the sender is not in, or a malformed one, is dropped and the feedback still saves", async () => {
  await withApp(async ({ port, db }) => {
    const { alex, friends, club } = await people(port);
    const circleOf = (id: string) => (db.prepare("SELECT circle_id AS c FROM feedback WHERE id = ?").get(id) as { c: string | null }).c;
    const cases: Array<[unknown, string | undefined, string | null]> = [
      [club.id, undefined, null],
      [crypto.randomUUID(), undefined, null],
      ["not-a-uuid", undefined, null],
      [42, undefined, null],
      [undefined, friends.id, friends.id],
      [undefined, club.id, null],
      [undefined, "garbage", null],
      [undefined, undefined, null],
    ];
    for (const [circleId, header, expected] of cases) {
      const sent = await hit(port, "POST", "/api/feedback", {
        token: alex.token,
        forwarded: `198.51.100.${cases.findIndex((item) => item[0] === circleId && item[1] === header)}`,
        circle: header,
        body: { text: "hello", ...(circleId === undefined ? {} : { circleId }) },
      });
      assert.equal(sent.status, 201, `${String(circleId)} / ${String(header)}`);
      assert.equal(circleOf(sent.json.id), expected);
    }
  });
});

test("odd build labels are cleaned or dropped", async () => {
  await withApp(async ({ port, db }) => {
    const { alex } = await people(port);
    const versionOf = async (appVersion: unknown, forwarded: string) => {
      const sent = await hit(port, "POST", "/api/feedback", { token: alex.token, forwarded, body: { text: "v", appVersion } });
      assert.equal(sent.status, 201);
      return (db.prepare("SELECT app_version AS v FROM feedback WHERE id = ?").get(sent.json.id) as { v: string | null }).v;
    };
    assert.equal(await versionOf(undefined, "192.0.2.1"), null);
    assert.equal(await versionOf(13, "192.0.2.2"), null);
    assert.equal(await versionOf("   ", "192.0.2.3"), null);
    assert.equal(await versionOf("hangry-v13\n\u0000", "192.0.2.4"), "hangry-v13");
    assert.equal((await versionOf("v".repeat(200), "192.0.2.5"))?.length, 64);
  });
});

test("five sends per client in ten minutes, then 429, keyed on the proxy's hop", async () => {
  await withApp(async ({ port, db, advance }) => {
    const { alex, bea } = await people(port);
    for (let index = 0; index < 5; index += 1) {
      const ok = await hit(port, "POST", "/api/feedback", { token: alex.token, forwarded: "203.0.113.50", body: { text: `n${index}` } });
      assert.equal(ok.status, 201);
    }
    const limited = await hit(port, "POST", "/api/feedback", { token: alex.token, forwarded: "203.0.113.50", body: { text: "six" } });
    assert.equal(limited.status, 429);
    assert.deepEqual(limited.json, { error: "too many requests" });
    // A spoofed left-hand hop does not buy a new bucket. The proxy appends the real one.
    const spoofed = await hit(port, "POST", "/api/feedback", {
      token: bea.token,
      forwarded: "10.0.0.9, 203.0.113.50",
      body: { text: "spoof" },
    });
    assert.equal(spoofed.status, 429);
    // Invalid text never uses up a slot, and does not leak the limit either.
    const other = "203.0.113.51";
    for (let index = 0; index < 8; index += 1) {
      const bad = await hit(port, "POST", "/api/feedback", { token: bea.token, forwarded: other, body: { text: " " } });
      assert.equal(bad.status, 400);
    }
    const stillOpen = await hit(port, "POST", "/api/feedback", { token: bea.token, forwarded: other, body: { text: "ok" } });
    assert.equal(stillOpen.status, 201);

    advance(10 * 60_000);
    const later = await hit(port, "POST", "/api/feedback", { token: alex.token, forwarded: "203.0.113.50", body: { text: "later" } });
    assert.equal(later.status, 201);
    const count = db.prepare("SELECT COUNT(*) AS n FROM feedback").get() as { n: number };
    assert.equal(Number(count.n), 7);
  });
});

test("admin feedback routes stay hidden without the operator token", async () => {
  await withApp(async ({ port }) => {
    const { alex } = await people(port);
    const sent = await hit(port, "POST", "/api/feedback", { token: alex.token, forwarded: "203.0.113.60", body: { text: "hi" } });
    const unset = await hit(port, "GET", "/api/admin/feedback", { token: ADMIN, forwarded: "203.0.113.61" });
    assert.equal(unset.status, 404);
    assert.deepEqual(unset.json, { error: "not found" });
    const update = await hit(port, "POST", `/api/admin/feedback/${sent.json.id}`, {
      token: ADMIN,
      forwarded: "203.0.113.61",
      body: { status: "done" },
    });
    assert.equal(update.status, 404);
  });

  await withApp(async ({ port }) => {
    const { alex } = await people(port);
    const sent = await hit(port, "POST", "/api/feedback", { token: alex.token, forwarded: "203.0.113.62", body: { text: "hi" } });
    const none = await hit(port, "GET", "/api/admin/feedback", { forwarded: "203.0.113.63" });
    assert.equal(none.status, 404);
    assert.deepEqual(none.json, { error: "not found" });
    const wrong = await hit(port, "GET", "/api/admin/feedback", { token: "b".repeat(32), forwarded: "203.0.113.63" });
    assert.equal(wrong.status, 404);
    // A signed-in app user is not an operator.
    const asUser = await hit(port, "GET", "/api/admin/feedback", { token: alex.token, forwarded: "203.0.113.64" });
    assert.equal(asUser.status, 404);
    const write = await hit(port, "POST", `/api/admin/feedback/${sent.json.id}`, {
      token: "b".repeat(32),
      forwarded: "203.0.113.63",
      body: { status: "done" },
    });
    assert.equal(write.status, 404);
    const ok = await hit(port, "GET", "/api/admin/feedback", { token: ADMIN, forwarded: "203.0.113.65" });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.feedback[0].status, "new");
  }, { env: { ADMIN_TOKEN: ADMIN } });
});

test("operators list feedback newest first and filter by status", async () => {
  await withApp(async ({ port, at }) => {
    const { alex, bea, friends, club } = await people(port);
    at(START + 1000);
    const first = await hit(port, "POST", "/api/feedback", {
      token: alex.token,
      forwarded: "203.0.113.70",
      body: { text: "first", circleId: friends.id, appVersion: "hangry-v12" },
    });
    at(START + 2000);
    const second = await hit(port, "POST", "/api/feedback", {
      token: bea.token,
      forwarded: "203.0.113.71",
      body: { text: "second", circleId: club.id },
    });
    at(START + 2000);
    const third = await hit(port, "POST", "/api/feedback", { token: alex.token, forwarded: "203.0.113.70", body: { text: "third" } });

    const logs = await captureLogs(async (logs) => {
      const all = await hit(port, "GET", "/api/admin/feedback", { token: ADMIN, forwarded: "203.0.113.72" });
      assert.equal(all.status, 200);
      assert.deepEqual(all.json.feedback.map((row: { id: string }) => row.id), [third.json.id, second.json.id, first.json.id]);
      for (const row of all.json.feedback) assert.deepEqual(Object.keys(row).sort(), FIELDS);
      assert.deepEqual(all.json.feedback[2], {
        id: first.json.id,
        userId: alex.user.id,
        userName: "Alex",
        circleId: friends.id,
        circleName: "Friends",
        text: "first",
        appVersion: "hangry-v12",
        createdAt: START + 1000,
        status: "new",
        prUrl: null,
        note: null,
      });
      assert.equal(all.json.feedback[1].userName, "Bea");
      assert.equal(all.json.feedback[1].circleName, "Club");
      assert.equal(all.json.feedback[0].circleId, null);
      assert.equal(all.json.feedback[0].circleName, null);
      return logs;
    });
    assert.ok(logs.includes("admin feedback ok rows=3"));
    assert.equal(logs.some((line) => /first|second|third/.test(line)), false);
    assert.equal(logs.some((line) => line.includes(ADMIN)), false);

    await hit(port, "POST", `/api/admin/feedback/${second.json.id}`, {
      token: ADMIN,
      forwarded: "203.0.113.72",
      body: { status: "planned" },
    });
    const planned = await hit(port, "GET", "/api/admin/feedback?status=planned", { token: ADMIN, forwarded: "203.0.113.72" });
    assert.deepEqual(planned.json.feedback.map((row: { id: string }) => row.id), [second.json.id]);
    const fresh = await hit(port, "GET", "/api/admin/feedback?status=new", { token: ADMIN, forwarded: "203.0.113.72" });
    assert.deepEqual(fresh.json.feedback.map((row: { id: string }) => row.id), [third.json.id, first.json.id]);
    const empty = await hit(port, "GET", "/api/admin/feedback?status=", { token: ADMIN, forwarded: "203.0.113.72" });
    assert.equal(empty.json.feedback.length, 3);
    const none = await hit(port, "GET", "/api/admin/feedback?status=rejected", { token: ADMIN, forwarded: "203.0.113.72" });
    assert.deepEqual(none.json, { feedback: [] });
    for (const status of ["NEW", "open", "in progress", "done,new"]) {
      const bad = await hit(port, "GET", `/api/admin/feedback?status=${encodeURIComponent(status)}`, {
        token: ADMIN,
        forwarded: "203.0.113.72",
      });
      assert.equal(bad.status, 400, status);
      assert.deepEqual(bad.json, { error: "invalid status" });
    }
  }, { env: { ADMIN_TOKEN: ADMIN } });
});

test("operators set status, PR link, and note, and get the updated row back", async () => {
  await withApp(async ({ port, at }) => {
    const { alex, friends } = await people(port);
    const sent = await hit(port, "POST", "/api/feedback", {
      token: alex.token,
      forwarded: "203.0.113.80",
      body: { text: "dark mode for the map", circleId: friends.id },
    });
    const id = sent.json.id as string;
    const post = (body: unknown, path = `/api/admin/feedback/${id}`) =>
      hit(port, "POST", path, { token: ADMIN, forwarded: "203.0.113.81", body });

    at(START + 5000);
    const progress = await post({ status: "in_progress", note: "  Looking at tiles  " });
    assert.equal(progress.status, 200);
    assert.deepEqual(Object.keys(progress.json.feedback).sort(), FIELDS);
    assert.equal(progress.json.feedback.status, "in_progress");
    assert.equal(progress.json.feedback.note, "Looking at tiles");
    assert.equal(progress.json.feedback.prUrl, null);
    assert.equal(progress.json.feedback.text, "dark mode for the map");
    assert.equal(progress.json.feedback.circleName, "Friends");

    const done = await post({ status: "done", prUrl: "https://github.com/Philipp0205/free-now/pull/50" });
    assert.equal(done.json.feedback.status, "done");
    assert.equal(done.json.feedback.prUrl, "https://github.com/Philipp0205/free-now/pull/50");
    assert.equal(done.json.feedback.note, "Looking at tiles", "fields not sent stay as they were");

    const cleared = await post({ prUrl: "", note: null });
    assert.equal(cleared.json.feedback.prUrl, null);
    assert.equal(cleared.json.feedback.note, null);
    assert.equal(cleared.json.feedback.status, "done");

    for (const status of ["new", "planned", "in_progress", "done", "rejected"]) {
      const ok = await post({ status });
      assert.equal(ok.json.feedback.status, status);
    }

    const invalid: Array<[unknown, string]> = [
      [{ status: "shipped" }, "invalid status"],
      [{ status: null }, "invalid status"],
      [{ prUrl: "ftp://example.com/x" }, "invalid prUrl"],
      [{ prUrl: "nope" }, "invalid prUrl"],
      [{ prUrl: 5 }, "invalid prUrl"],
      [{ note: "n".repeat(2001) }, "invalid note"],
      [{ note: 5 }, "invalid note"],
      [{}, "nothing to update"],
      [{ other: "field" }, "nothing to update"],
    ];
    for (const [body, error] of invalid) {
      const bad = await post(body);
      assert.equal(bad.status, 400, JSON.stringify(body));
      assert.deepEqual(bad.json, { error });
    }
    const unchanged = await hit(port, "GET", "/api/admin/feedback", { token: ADMIN, forwarded: "203.0.113.81" });
    assert.equal(unchanged.json.feedback[0].status, "rejected");

    const unknown = await post({ status: "done" }, `/api/admin/feedback/${crypto.randomUUID()}`);
    assert.equal(unknown.status, 404);
    assert.deepEqual(unknown.json, { error: "not found" });
    const malformed = await post({ status: "done" }, "/api/admin/feedback/not-an-id");
    assert.equal(malformed.status, 404);
    const wrongMethod = await hit(port, "GET", `/api/admin/feedback/${id}`, { token: ADMIN, forwarded: "203.0.113.81" });
    assert.equal(wrongMethod.status, 404);
  }, { env: { ADMIN_TOKEN: ADMIN } });
});

test("feedback outlives a deleted circle and loses only the circle link", async () => {
  await withApp(async ({ port }) => {
    const { alex, friends } = await people(port);
    const sent = await hit(port, "POST", "/api/feedback", {
      token: alex.token,
      forwarded: "203.0.113.90",
      body: { text: "keep me", circleId: friends.id },
    });
    const removed = await hit(port, "POST", `/api/admin/circles/${friends.id}/delete`, { token: ADMIN, forwarded: "203.0.113.91" });
    assert.equal(removed.status, 200);
    const list = await hit(port, "GET", "/api/admin/feedback", { token: ADMIN, forwarded: "203.0.113.91" });
    assert.equal(list.json.feedback.length, 1);
    assert.equal(list.json.feedback[0].id, sent.json.id);
    assert.equal(list.json.feedback[0].circleId, null);
    assert.equal(list.json.feedback[0].circleName, null);
    assert.equal(list.json.feedback[0].text, "keep me");
  }, { env: { ADMIN_TOKEN: ADMIN } });
});
