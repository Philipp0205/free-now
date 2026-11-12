import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getPlan, openDb } from "../../src/db.js";
import { ensureShareId, escapeHtml, newShareId } from "../../src/social/plan-share.js";
import { api, withApp } from "../http.js";

const PLACE = "Secret Garden Bar, Hauptstr. 12";
const LEAKS = [PLACE, "Hauptstr", "52.52", "13.405", "lat", "lng", "location", "joined", "members", "creator", "push", "chat", "place"];

async function circleOf(port: number, name: string) {
  const host = await api(port, "POST", "/api/auth/start", { body: { name }, status: 201 });
  const circle = await api(port, "POST", "/api/circles", { token: host.token, body: { name: "Kreuzberg crew" }, status: 201 });
  return { host, circle: circle.circle };
}

async function joinWith(port: number, name: string, code: string) {
  return api(port, "POST", "/api/auth/start", { body: { name, code }, status: 201 });
}

async function plan(port: number, token: string, body: Record<string, unknown> = {}) {
  return (await api(port, "POST", "/api/plans", {
    token,
    body: { note: "Pizza <b>&</b> \"fun\"", place: PLACE, lat: 52.52, lng: 13.405, time: "19:30", ...body },
    status: 201,
  })).plan;
}

async function page(port: number, pathname: string, userAgent = "WhatsApp/2.23") {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { headers: { "user-agent": userAgent } });
  return { status: response.status, html: await response.text(), headers: response.headers };
}

function ogTags(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of html.matchAll(/<meta (?:property|name)="((?:og|twitter):[a-z_]+)" content="([^"]*)" \/>/g)) out[match[1]] = match[2];
  return out;
}

test("a share id is 24 url-safe characters, made once and kept", () => {
  const id = newShareId();
  assert.match(id, /^[A-Za-z0-9_-]{24}$/);
  assert.notEqual(newShareId(), id);
  const db = openDb(":memory:");
  try {
    db.prepare("INSERT INTO users (id, name, token_hash, buzz_token, created_at) VALUES ('u', 'A', 'h', 'b', 0)").run();
    db.prepare("INSERT INTO circles (id, name, invite_code, created_by, created_at) VALUES ('c', 'C', 'CODE1234', 'u', 0)").run();
    db.prepare("INSERT INTO plans (id, circle_id, creator_id, note, for_date, created_at) VALUES ('p', 'c', 'u', 'x', '2026-06-02', 0)").run();
    const first = ensureShareId(db, "p");
    assert.equal(ensureShareId(db, "p"), first);
    assert.equal(getPlan(db, "p")?.share_id, first);
    assert.notEqual(first, "p");
  } finally {
    db.close();
  }
});

test("an old database gets the share_id column and a unique index, and reopening is fine", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hangry-share-"));
  try {
    const file = path.join(dir, "db.sqlite");
    const old = openDb(file);
    old.exec("DROP INDEX idx_plans_share; ALTER TABLE plans DROP COLUMN share_id;");
    old.close();
    openDb(file).close();
    const db = openDb(file);
    const columns = (db.prepare("PRAGMA table_info(plans)").all() as Array<{ name: string }>).map((row) => row.name);
    assert.ok(columns.includes("share_id"));
    const index = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_plans_share'").get() as { sql: string };
    assert.match(index.sql, /UNIQUE/);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("POST share gives a stable /p/ link that is not the plan id, members only", async () => {
  await withApp(async ({ port }) => {
    const { host, circle } = await circleOf(port, "Hana");
    const friend = await joinWith(port, "Finn", circle.inviteCode);
    const stranger = await circleOf(port, "Sam");
    const made = await plan(port, host.token);
    assert.match(made.shareId, /^[A-Za-z0-9_-]{24}$/);

    const first = await api(port, "POST", `/api/plans/${made.id}/share`, { token: host.token, body: {}, status: 200 });
    const again = await api(port, "POST", `/api/plans/${made.id}/share`, { token: friend.token, body: {}, status: 200 });
    assert.equal(first.shareId, made.shareId);
    assert.equal(again.shareId, first.shareId);
    assert.equal(first.url, `http://127.0.0.1:${port}/p/${first.shareId}`);
    assert.ok(!first.url.includes(made.id));

    await api(port, "POST", `/api/plans/${made.id}/share`, { body: {}, status: 401 });
    await api(port, "POST", `/api/plans/${made.id}/share`, { token: stranger.host.token, body: {}, status: 404 });
  });
});

test("the preview has only title, day and time; a member also gets the plan id", async () => {
  await withApp(async ({ port }) => {
    const { host, circle } = await circleOf(port, "Hana");
    const friend = await joinWith(port, "Finn", circle.inviteCode);
    const stranger = await circleOf(port, "Sam");
    const made = await plan(port, host.token);
    const url = `/api/plans/share/${made.shareId}`;

    const outsider = await api(port, "GET", url, { status: 200 });
    assert.deepEqual(outsider, {
      ended: false,
      note: "Pizza <b>&</b> \"fun\"",
      whenLabel: "Tue 2 Jun",
      time: "19:30",
      member: false,
    });
    const otherCircle = await api(port, "GET", url, { token: stranger.host.token, status: 200 });
    assert.deepEqual(otherCircle, outsider);
    for (const body of [outsider, otherCircle]) {
      const text = JSON.stringify(body);
      for (const leak of [...LEAKS, made.id, circle.id, "Hana", "Kreuzberg crew"]) assert.ok(!text.includes(leak), `leaked ${leak}`);
    }

    const member = await api(port, "GET", url, { token: friend.token, status: 200 });
    assert.equal(member.member, true);
    assert.equal(member.planId, made.id);
    assert.equal(member.circleId, circle.id);
    assert.ok(!JSON.stringify(member).includes(PLACE));
  });
});

test("ended, deleted, unknown and junk links all say the same thing", async () => {
  await withApp(async ({ port, db, at }) => {
    const { host } = await circleOf(port, "Hana");
    const ended = await plan(port, host.token, { note: "Ended one" });
    const deleted = await plan(port, host.token, { note: "Deleted one" });
    const past = await plan(port, host.token, { note: "Past one" });
    await api(port, "DELETE", `/api/plans/${ended.id}`, { token: host.token, status: 204 });
    db.prepare("DELETE FROM plans WHERE id = ?").run(deleted.id);

    const guesses = [
      ended.shareId,
      deleted.shareId,
      newShareId(),
      "short",
      "AAAAAAAAAAAAAAAAAAAAAAAA",
      encodeURIComponent("' OR 1=1 --"),
      ended.id,
      "%E0%A4%A",
    ];
    for (const guess of guesses) {
      const body = await api(port, "GET", `/api/plans/share/${guess}`, { token: host.token, status: 200 });
      assert.deepEqual(body, { ended: true }, guess);
      const shown = await page(port, `/p/${guess}`);
      assert.equal(shown.status, 200, guess);
      assert.equal(ogTags(shown.html)["og:title"], "This link no longer works", guess);
      assert.ok(!shown.html.includes("Ended one") && !shown.html.includes("Deleted one"), guess);
    }
    await api(port, "POST", `/api/plans/${ended.id}/share`, { token: host.token, body: {}, status: 410 });

    // A plan whose day has gone by has ended too.
    assert.equal((await api(port, "GET", `/api/plans/share/${past.shareId}`, { status: 200 })).ended, false);
    at(Date.parse("2026-06-03T12:00:00.000Z"));
    assert.deepEqual(await api(port, "GET", `/api/plans/share/${past.shareId}`, { status: 200 }), { ended: true });
  });
});

test("/p/ serves the app with escaped Open Graph tags: title, then day and time only", async () => {
  await withApp(async ({ port }) => {
    const { host } = await circleOf(port, "Hana");
    const made = await plan(port, host.token, { note: "Pizza <script>alert(1)</script> & \"$&\"", date: "2026-11-14" });
    for (const agent of ["WhatsApp/2.23.20 A", "facebookexternalhit/1.1", "curl/8.0", "Mozilla/5.0 (Linux; Android 14) Chrome/128"]) {
      const shown = await page(port, `/p/${made.shareId}`, agent);
      assert.equal(shown.status, 200);
      assert.match(shown.headers.get("content-type") ?? "", /text\/html/);
      assert.equal(shown.headers.get("x-robots-tag"), "noindex");
      const tags = ogTags(shown.html);
      assert.equal(tags["og:title"], "Pizza &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;$&amp;&quot;");
      assert.equal(tags["og:description"], "Sat 14 Nov · 19:30");
      assert.equal(tags["og:url"], `http://127.0.0.1:${port}/p/${made.shareId}`);
      assert.equal(tags["twitter:card"], "summary");
      assert.equal(tags["twitter:title"], tags["og:title"]);
      assert.equal(tags["twitter:description"], "Sat 14 Nov · 19:30");
      assert.equal(tags["og:image"], `http://127.0.0.1:${port}/icons/icon-512.png`);
      assert.equal(tags["twitter:image"], tags["og:image"]);
      assert.ok(!shown.html.includes("<script>alert"));
      assert.ok(shown.html.includes('<script type="module" src="/js/app.js"></script>'), "boots the app");
      assert.ok(shown.html.includes('name="robots" content="noindex"'));
      for (const leak of [PLACE, "Hauptstr", "52.52", "13.405", "Kreuzberg crew", "Hana", made.id]) {
        assert.ok(!shown.html.includes(leak), `leaked ${leak}`);
      }
    }
    const head = await fetch(`http://127.0.0.1:${port}/p/${made.shareId}`, { method: "HEAD" });
    assert.equal(head.status, 200);
  });
});

test("a plan without a time shows just the day", async () => {
  await withApp(async ({ port }) => {
    const { host } = await circleOf(port, "Hana");
    const made = await plan(port, host.token, { note: "Walk", time: null, place: "", lat: null, lng: null });
    const tags = ogTags((await page(port, `/p/${made.shareId}`)).html);
    assert.equal(tags["og:description"], "Tue 2 Jun");
    const body = await api(port, "GET", `/api/plans/share/${made.shareId}`, { status: 200 });
    assert.equal(body.time, null);
  });
});

test("share lookups are rate limited per client", async () => {
  await withApp(async ({ port }) => {
    let last = 200;
    for (let i = 0; i < 61; i += 1) {
      last = (await fetch(`http://127.0.0.1:${port}/api/plans/share/${newShareId()}`)).status;
    }
    assert.equal(last, 429);
    assert.equal((await fetch(`http://127.0.0.1:${port}/p/${newShareId()}`)).status, 429);
  });
});

test("escapeHtml covers the five characters", () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
});

test("outsiders and link previews get an absolute Berlin day, never Today or Tomorrow; members still open the plan", async () => {
  await withApp(async ({ port }) => {
    const { host, circle } = await circleOf(port, "Hana");
    const friend = await joinWith(port, "Finn", circle.inviteCode);
    // 23:30 UTC on 1 Jun is already 2 Jun in Berlin, so "today" is Tue 2 Jun there.
    const today = await plan(port, host.token, { note: "Late one", time: "23:45" });
    const tags = ogTags((await page(port, `/p/${today.shareId}`)).html);
    assert.match(tags["og:description"], /^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2} · 23:45$/);
    assert.ok(!/Today|Tomorrow/.test(tags["og:description"] + tags["twitter:description"]));
    const outsider = await api(port, "GET", `/api/plans/share/${today.shareId}`, { status: 200 });
    assert.ok(!/Today|Tomorrow/.test(outsider.whenLabel));
    const member = await api(port, "GET", `/api/plans/share/${today.shareId}`, { token: friend.token, status: 200 });
    assert.equal(member.member, true);
  }, { tz: "Europe/Berlin" });
});

test("only the creator can stop sharing; the old link then reads like an unknown one, and sharing again makes a new token", async () => {
  await withApp(async ({ port }) => {
    const { host, circle } = await circleOf(port, "Hana");
    const friend = await joinWith(port, "Finn", circle.inviteCode);
    const stranger = await circleOf(port, "Sam");
    const made = await plan(port, host.token);
    const old = made.shareId;

    await api(port, "DELETE", `/api/plans/${made.id}/share`, { status: 401 });
    await api(port, "DELETE", `/api/plans/${made.id}/share`, { token: friend.token, status: 403 });
    await api(port, "DELETE", `/api/plans/${made.id}/share`, { token: stranger.host.token, status: 404 });
    assert.equal((await api(port, "GET", `/api/plans/share/${old}`, { status: 200 })).ended, false);

    await api(port, "DELETE", `/api/plans/${made.id}/share`, { token: host.token, status: 200 });
    assert.deepEqual(await api(port, "GET", `/api/plans/share/${old}`, { status: 200 }), { ended: true });
    assert.deepEqual(await api(port, "GET", `/api/plans/share/${old}`, { token: friend.token, status: 200 }), { ended: true });
    const shown = await page(port, `/p/${old}`);
    assert.equal(ogTags(shown.html)["og:title"], "This link no longer works");
    assert.ok(!shown.html.includes("Pizza"));

    const fresh = await api(port, "POST", `/api/plans/${made.id}/share`, { token: host.token, body: {}, status: 200 });
    assert.match(fresh.shareId, /^[A-Za-z0-9_-]{24}$/);
    assert.notEqual(fresh.shareId, old);
    assert.deepEqual(await api(port, "GET", `/api/plans/share/${old}`, { status: 200 }), { ended: true });
    assert.equal((await api(port, "GET", `/api/plans/share/${fresh.shareId}`, { status: 200 })).ended, false);
  });
});
