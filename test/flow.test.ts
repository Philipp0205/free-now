import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import type { PushPayload, PushSender, PushSubscription } from "../src/push.js";

type Sent = { endpoint: string; payload: PushPayload };

const START = Date.parse("2026-06-01T15:00:00.000Z");
const TTL = 2 * 60 * 60 * 1000;

type Ctx = {
  port: number;
  server: http.Server;
  db: DatabaseSync;
  sent: Sent[];
  advance: (ms: number) => void;
  at: (ms: number) => void;
};

async function withApp(fn: (ctx: Ctx) => Promise<void>, ttl = TTL, pushOverride?: PushSender): Promise<void> {
  const sent: Sent[] = [];
  let now = START;
  const db = openDb(":memory:");
  const push: PushSender = pushOverride ?? {
    async send(subscription: PushSubscription, payload: PushPayload) {
      sent.push({ endpoint: subscription.endpoint, payload });
    },
  };
  const config = loadConfig({
    PORT: "3000",
    DB_PATH: ":memory:",
    APP_TZ: "UTC",
    SOCIAL_TTL_MS: String(ttl),
  });
  const server = http.createServer(createApp({ db, push, config: { ...config, dbPath: ":memory:" }, now: () => now }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn({
      port,
      server,
      db,
      sent,
      advance(ms: number) {
        now += ms;
      },
      at(ms: number) {
        now = ms;
      },
    });
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
}

async function api(
  ctx: Ctx,
  method: string,
  path: string,
  options: { token?: string; body?: unknown; status?: number } = {},
): Promise<{ status: number; json: any }> {
  const response = await fetch(`http://127.0.0.1:${ctx.port}${path}`, {
    method,
    headers: {
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (options.status !== undefined && response.status !== options.status) {
    throw new Error(`${method} ${path} -> ${response.status} ${text}`);
  }
  return { status: response.status, json };
}

async function signUp(ctx: Ctx, name: string) {
  const { json } = await api(ctx, "POST", "/api/auth/start", { body: { name }, status: 201 });
  return json as { token: string; buzzToken: string; user: { id: string; name: string } };
}

async function subscribe(ctx: Ctx, token: string, endpoint: string) {
  await api(ctx, "POST", "/api/push/subscribe", {
    token,
    body: { endpoint, keys: { p256dh: "p256dh-key", auth: "auth-key" } },
    status: 204,
  });
}

test("two friends can invite, start a social, push, join, and expire", async () => {
  await withApp(async (ctx) => {
    const alex = await signUp(ctx, "Alex");
    const circle = await api(ctx, "POST", "/api/circles", {
      token: alex.token,
      body: { name: "friends" },
      status: 201,
    });
    const code = circle.json.circle.inviteCode as string;
    assert.match(code, /^[A-Z2-9]{8}$/);

    const veit = await signUp(ctx, "Veit");
    await api(ctx, "POST", "/api/circles/join", { token: veit.token, body: { code }, status: 200 });

    const outsider = await signUp(ctx, "Sam");
    await api(ctx, "POST", "/api/circles", { token: outsider.token, body: { name: "other" }, status: 201 });

    await subscribe(ctx, alex.token, "https://push.example/alex");
    await subscribe(ctx, veit.token, "https://push.example/veit");

    const created = await api(ctx, "POST", "/api/socials", {
      token: alex.token,
      body: { note: "Rooftop coffee??" },
      status: 201,
    });
    assert.equal(created.json.social.note, "Rooftop coffee??");
    assert.equal(created.json.social.creator.name, "Alex");
    assert.deepEqual(created.json.social.joined, []);
    assert.equal(created.json.social.expiresAt - created.json.social.createdAt, TTL);

    assert.equal(ctx.sent.length, 1);
    assert.equal(ctx.sent[0].endpoint, "https://push.example/veit");
    assert.equal(ctx.sent[0].payload.title, "Free now");
    assert.equal(ctx.sent[0].payload.body, "Alex is free now");

    const veitNotes = await api(ctx, "GET", "/api/notifications", { token: veit.token });
    assert.equal(veitNotes.json.notifications[0].title, "Free now");
    assert.equal(veitNotes.json.notifications[0].body, "Alex is free now");

    const alexBefore = await api(ctx, "GET", "/api/notifications", { token: alex.token });
    assert.equal(alexBefore.json.notifications.length, 0);

    const listed = await api(ctx, "GET", "/api/socials", { token: veit.token });
    assert.equal(listed.json.socials.length, 1);
    const socialId = listed.json.socials[0].id as string;

    const hidden = await api(ctx, "GET", "/api/socials", { token: outsider.token });
    assert.equal(hidden.json.socials.length, 0);
    await api(ctx, "POST", `/api/socials/${socialId}/join`, { token: outsider.token, body: {}, status: 404 });

    const joined = await api(ctx, "POST", `/api/socials/${socialId}/join`, {
      token: veit.token,
      body: {},
      status: 200,
    });
    assert.deepEqual(
      joined.json.social.joined.map((person: { name: string }) => person.name),
      ["Veit"],
    );

    assert.equal(ctx.sent.length, 2);
    assert.equal(ctx.sent[1].endpoint, "https://push.example/alex");
    assert.equal(ctx.sent[1].payload.title, "Reply");
    assert.equal(ctx.sent[1].payload.body, "Veit is in");

    const alexNotes = await api(ctx, "GET", "/api/notifications", { token: alex.token });
    assert.equal(alexNotes.json.notifications[0].title, "Reply");
    assert.equal(alexNotes.json.notifications[0].body, "Veit is in");

    const again = await api(ctx, "POST", `/api/socials/${socialId}/join`, {
      token: veit.token,
      body: {},
      status: 200,
    });
    assert.equal(again.json.social.joined.length, 1);
    assert.equal(ctx.sent.length, 2);

    await api(ctx, "POST", `/api/socials/${socialId}/join`, { token: alex.token, body: {}, status: 400 });

    const quiet = await api(ctx, "POST", "/api/socials", {
      token: alex.token,
      body: { note: "Rooftop coffee??" },
      status: 200,
    });
    assert.equal(quiet.json.social.id, socialId);
    assert.equal(ctx.sent.length, 2);

    ctx.advance(31_000);
    await api(ctx, "POST", "/api/socials", {
      token: alex.token,
      body: { note: "Rooftop coffee??" },
      status: 200,
    });
    assert.equal(ctx.sent.length, 3);
    assert.equal(ctx.sent[2].payload.body, "Alex is free now");

    ctx.advance(TTL + 1);
    const expired = await api(ctx, "GET", "/api/socials", { token: veit.token });
    assert.deepEqual(expired.json.socials, []);
    await api(ctx, "POST", `/api/socials/${socialId}/join`, { token: veit.token, body: {}, status: 410 });
  });
});

test("buzz token starts a social and notifies the circle", async () => {
  await withApp(async (ctx) => {
    const alex = await signUp(ctx, "Alex");
    await api(ctx, "POST", "/api/circles", { token: alex.token, body: { name: "friends" }, status: 201 });
    const veit = await signUp(ctx, "Veit");
    const me = await api(ctx, "GET", "/api/me", { token: alex.token });
    await api(ctx, "POST", "/api/circles/join", {
      token: veit.token,
      body: { code: me.json.circle.inviteCode },
      status: 200,
    });
    await subscribe(ctx, veit.token, "https://push.example/veit");

    await api(ctx, "POST", "/api/buzz/not-a-real-token", { body: { note: "hi" }, status: 404 });

    const buzzed = await api(ctx, "POST", `/api/buzz/${alex.buzzToken}`, {
      body: { note: "Rooftop coffee??" },
      status: 201,
    });
    assert.equal(buzzed.json.social.note, "Rooftop coffee??");
    assert.equal(ctx.sent.length, 1);
    assert.equal(ctx.sent[0].endpoint, "https://push.example/veit");
    assert.equal(ctx.sent[0].payload.title, "Free now");
    assert.equal(ctx.sent[0].payload.body, "Alex is free now");

    const bare = await fetch(`http://127.0.0.1:${ctx.port}/api/buzz/${alex.buzzToken}`, { method: "POST" });
    assert.equal(bare.status, 200);
    const bareJson = (await bare.json()) as { social: { note: string; createdAt: number; expiresAt: number } };
    assert.equal(bareJson.social.note, "Rooftop coffee??");
    assert.equal(bareJson.social.createdAt, buzzed.json.social.createdAt);
  });
});

test("a bare buzz keeps the note and extends expiry without moving the start", async () => {
  await withApp(async (ctx) => {
    const alex = await signUp(ctx, "Alex");
    await api(ctx, "POST", "/api/circles", { token: alex.token, body: { name: "friends" }, status: 201 });
    const started = await api(ctx, "POST", `/api/buzz/${alex.buzzToken}`, {
      body: { note: "Rooftop coffee??" },
      status: 201,
    });
    ctx.advance(13_000);
    const again = await api(ctx, "POST", `/api/buzz/${alex.buzzToken}`, { status: 200 });
    assert.equal(again.json.social.note, "Rooftop coffee??");
    assert.equal(again.json.social.createdAt, started.json.social.createdAt);
    assert.equal(again.json.social.expiresAt - started.json.social.createdAt, 60_000 + 13_000);
    assert.equal(again.json.social.expiresAt - (started.json.social.createdAt + 13_000), 60_000);
    const replaced = await api(ctx, "POST", `/api/buzz/${alex.buzzToken}`, {
      body: { note: "Park" },
      status: 200,
    });
    assert.equal(replaced.json.social.note, "Park");
    assert.equal(replaced.json.social.createdAt, started.json.social.createdAt);
  }, 60_000);
});

test("tomorrow plans can be joined and disappear after that day", async () => {
  await withApp(async (ctx) => {
    const alex = await signUp(ctx, "Alex");
    const created = await api(ctx, "POST", "/api/circles", {
      token: alex.token,
      body: { name: "friends" },
      status: 201,
    });
    const veit = await signUp(ctx, "Veit");
    await api(ctx, "POST", "/api/circles/join", {
      token: veit.token,
      body: { code: created.json.circle.inviteCode },
      status: 200,
    });
    await subscribe(ctx, alex.token, "https://push.example/alex");
    await subscribe(ctx, veit.token, "https://push.example/veit");

    const plan = await api(ctx, "POST", "/api/plans", {
      token: alex.token,
      body: { note: "Walk and dinner with Alvin?" },
      status: 201,
    });
    assert.equal(plan.json.plan.forDate, "2026-06-02");
    assert.equal(plan.json.plan.whenLabel, "Tomorrow");
    assert.equal(ctx.sent[0].payload.title, "Tomorrow");
    assert.equal(ctx.sent[0].payload.body, "Alex: Walk and dinner with Alvin?");

    const join = await api(ctx, "POST", `/api/plans/${plan.json.plan.id}/join`, {
      token: veit.token,
      body: {},
      status: 200,
    });
    assert.equal(join.json.plan.joined[0].name, "Veit");
    assert.equal(ctx.sent[1].payload.title, "Reply");
    assert.equal(ctx.sent[1].payload.body, "Veit is in for Walk and dinner with Alvin?");

    const declined = await api(ctx, "POST", `/api/plans/${plan.json.plan.id}/reply`, {
      token: veit.token,
      body: { reply: "declined" },
      status: 200,
    });
    assert.equal(declined.json.plan.joined[0].reply, "declined");
    assert.equal(ctx.sent.at(-1)?.payload.title, "Reply");
    assert.equal(ctx.sent.at(-1)?.payload.body, "Veit can't make it to Walk and dinner with Alvin?");
    const back = await api(ctx, "POST", `/api/plans/${plan.json.plan.id}/reply`, {
      token: veit.token,
      body: { reply: "in" },
      status: 200,
    });
    assert.equal(back.json.plan.joined[0].reply, "coming");
    assert.equal(ctx.sent.at(-1)?.payload.title, "Reply");
    assert.equal(ctx.sent.at(-1)?.payload.body, "Veit is in for Walk and dinner with Alvin?");

    ctx.at(Date.parse("2026-06-02T18:00:00.000Z"));
    const today = await api(ctx, "GET", "/api/plans", { token: veit.token });
    assert.equal(today.json.plans.length, 1);
    assert.equal(today.json.plans[0].whenLabel, "Today");

    ctx.at(Date.parse("2026-06-03T00:00:00.000Z"));
    const gone = await api(ctx, "GET", "/api/plans", { token: veit.token });
    assert.deepEqual(gone.json.plans, []);
  });
});

test("logout ends that device and recovery starts another", async () => {
  await withApp(async (ctx) => {
    const alex = await signUp(ctx, "Alex");
    await api(ctx, "POST", "/api/auth/logout", { token: alex.token, body: {}, status: 204 });
    await api(ctx, "GET", "/api/me", { token: alex.token, status: 401 });
    const recovered = await api(ctx, "POST", "/api/auth/recover", {
      body: { token: alex.buzzToken },
      status: 200,
    });
    assert.notEqual(recovered.json.token, alex.token);
    const me = await api(ctx, "GET", "/api/me", { token: recovered.json.token, status: 200 });
    assert.equal(me.json.user.name, "Alex");
    assert.equal(me.json.user.buzzToken, alex.buzzToken);
    await api(ctx, "GET", "/api/me", { token: alex.token, status: 401 });
  });
});

test("config rejects a half-set VAPID pair and reads the public settings", () => {
  assert.equal(loadConfig({}).tz, "Europe/Berlin");
  assert.throws(() => loadConfig({ VAPID_PUBLIC_KEY: "abc" }), /both VAPID/);
  assert.throws(() => loadConfig({ APP_TZ: "Not/AZone" }), /APP_TZ/);
  const config = loadConfig({ PORT: "8080", APP_TZ: "Europe/Berlin", PUBLIC_BASE_URL: "https://hangry.example/" }, "/tmp");
  assert.equal(config.port, 8080);
  assert.equal(config.tz, "Europe/Berlin");
  assert.equal(config.publicBaseUrl, "https://hangry.example");
  assert.equal(config.vapid, null);
  assert.equal(config.socialTtlMs, 2 * 60 * 60 * 1000);
});

test("serves the installable shell", async () => {
  await withApp(async (ctx) => {
    const origin = `http://127.0.0.1:${ctx.port}`;
    const page = await fetch(`${origin}/`);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /<title>Hangry<\/title>/);
    assert.match(html, /manifest\.webmanifest/);
    assert.match(html, /apple-mobile-web-app-capable/);
    assert.match(html, /src="\/app\.js"/);
    const client = await fetch(`${origin}/app.js`);
    assert.match(await client.text(), /serviceWorker\.register/);

    const join = await fetch(`${origin}/join/AB12CD34`);
    assert.equal(join.status, 200);
    assert.match(await join.text(), /id="app"/);

    const manifestResponse = await fetch(`${origin}/manifest.webmanifest`);
    assert.equal(manifestResponse.headers.get("content-type"), "application/manifest+json");
    const manifest = (await manifestResponse.json()) as {
      display: string;
      icons: Array<{ sizes: string; purpose: string }>;
    };
    assert.equal(manifest.name, "Hangry");
    assert.equal(manifest.short_name, "Hangry");
    assert.equal(manifest.display, "standalone");
    assert.ok(manifest.icons.some((icon) => icon.sizes === "192x192"));
    assert.ok(manifest.icons.some((icon) => icon.sizes === "512x512" && icon.purpose === "maskable"));

    const sw = await fetch(`${origin}/sw.js`);
    const source = await sw.text();
    assert.match(source, /title: "Hangry"/);
    assert.match(source, /addEventListener\("push"/);
    assert.match(source, /showNotification/);

    const icon = await fetch(`${origin}/icons/icon-192.png`);
    assert.equal(icon.status, 200);
    assert.equal(icon.headers.get("content-type"), "image/png");
    const bytes = new Uint8Array(await icon.arrayBuffer());
    assert.equal(bytes[0], 137);
    assert.equal(bytes[1], 80);

    const meta = await api(ctx, "GET", "/api/meta");
    assert.equal(meta.json.devMode, true);
    assert.equal(meta.json.vapidPublicKey, null);

    const health = await api(ctx, "GET", "/api/health");
    assert.equal(health.json.ok, true);
  });
});

test("push logs name the user and status, and a test reports the device count", async () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  const endpoint = "https://push.example/secret-endpoint";
  try {
    await withApp(async (ctx) => {
      const alex = await signUp(ctx, "Alex");
      const quiet = await api(ctx, "POST", "/api/push/test", { token: alex.token, body: {}, status: 200 });
      assert.equal(quiet.json.subscriptions, 0);
      await subscribe(ctx, alex.token, endpoint);
      const known = await api(ctx, "POST", "/api/push/status", {
        token: alex.token,
        body: { endpoint },
        status: 200,
      });
      assert.equal(known.json.known, true);
      const other = await api(ctx, "POST", "/api/push/status", {
        token: alex.token,
        body: { endpoint: "https://push.example/someone-else" },
        status: 200,
      });
      assert.equal(other.json.known, false);
      const sent = await api(ctx, "POST", "/api/push/test", { token: alex.token, body: {}, status: 200 });
      assert.equal(sent.json.subscriptions, 1);
    });
    await withApp(async (ctx) => {
      const alex = await signUp(ctx, "Alex");
      await subscribe(ctx, alex.token, endpoint);
      await api(ctx, "POST", "/api/push/test", { token: alex.token, body: {}, status: 200 });
    }, TTL, {
      async send() {
        const error = new Error(`gone ${endpoint} p256dh-key`);
        (error as { statusCode?: number }).statusCode = 410;
        throw error;
      },
    });
  } finally {
    console.log = original;
  }
  const text = lines.join("\n");
  assert.match(text, /push subscribe user=\S+ status=ok/);
  assert.match(text, /push send user=\S+ status=ok/);
  assert.match(text, /push send user=\S+ status=410/);
  assert.equal(text.includes("secret-endpoint"), false);
  assert.equal(text.includes("p256dh"), false);
});

test("a second sign-in keeps the first device signed in", async () => {
  await withApp(async (ctx) => {
    const alex = await signUp(ctx, "Alex");
    const again = await api(ctx, "POST", "/api/auth/recover", {
      body: { token: `curl -X POST http://localhost/api/buzz/${alex.buzzToken} -d '{}'` },
      status: 200,
    });
    assert.notEqual(again.json.token, alex.token);
    const first = await api(ctx, "GET", "/api/me", { token: alex.token, status: 200 });
    const second = await api(ctx, "GET", "/api/me", { token: again.json.token, status: 200 });
    assert.equal(first.json.user.id, second.json.user.id);
    await api(ctx, "POST", "/api/auth/logout", { token: again.json.token, body: {}, status: 204 });
    await api(ctx, "GET", "/api/me", { token: again.json.token, status: 401 });
    await api(ctx, "GET", "/api/me", { token: alex.token, status: 200 });
  });
});
