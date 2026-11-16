import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_TOKEN_LIMIT, MAX_AGENT_TOKENS } from "../../src/admin/agent-tokens.js";
import { isAgentAllowed, listOperations } from "../../src/admin/openapi.js";
import { api, withApp, type AppCtx, testEmail } from "../http.js";

type Person = { token: string; user: { id: string; name: string } };
type Issued = { id: string; name: string; token: string; tokenPrefix: string; createdAt: number };

const FORBIDDEN = "agent tokens can only use routes in /api/openapi.json";

async function signUp(ctx: AppCtx, name: string, code?: string): Promise<Person> {
  const { json } = await api(ctx, "POST", "/api/auth/start", { body: code ? { name, email: testEmail(), code } : { name, email: testEmail() }, status: 201 });
  return json;
}

async function issue(ctx: AppCtx, person: Person, name: string): Promise<Issued> {
  // Not api() with a status: a failure there would print the plain token.
  const { status, json } = await api(ctx, "POST", "/api/me/agent-tokens", { token: person.token, body: { name } });
  assert.equal(status, 201, "issue agent token");
  return json;
}

/** A person with a circle, so socials and the like work. */
async function member(ctx: AppCtx, name: string) {
  const person = await signUp(ctx, name);
  await api(ctx, "POST", "/api/circles", { token: person.token, body: { name: "friends" }, status: 201 });
  return person;
}

async function statusOf(ctx: AppCtx, token: string, method = "GET", path = "/api/me"): Promise<number> {
  return (await api(ctx, method, path, { token })).status;
}

test("a session creates an agent token, and the list shows it without the secret", async () => {
  await withApp(async (ctx) => {
    const alex = await signUp(ctx, "Alex");
    const created = await api(ctx, "POST", "/api/me/agent-tokens", { token: alex.token, body: { name: "  Home bot  " } });
    assert.equal(created.status, 201);
    const issued = created.json as Issued;
    assert.equal(issued.name, "Home bot");
    assert.ok(issued.token.startsWith("hng_"));
    assert.equal(issued.token.length, 47);
    assert.equal(issued.tokenPrefix, issued.token.slice(0, 8));
    assert.equal(typeof issued.createdAt, "number");
    assert.equal(typeof issued.id, "string");

    const listed = await api(ctx, "GET", "/api/me/agent-tokens", { token: alex.token, status: 200 });
    assert.equal(listed.json.tokens.length, 1);
    const item = listed.json.tokens[0];
    assert.equal(item.id, issued.id);
    assert.equal(item.name, "Home bot");
    assert.equal(item.tokenPrefix, issued.tokenPrefix);
    assert.equal(item.createdAt, issued.createdAt);
    assert.equal("token" in item, false);
    assert.equal("tokenHash" in item, false);
    assert.equal("token_hash" in item, false);
    assert.equal(JSON.stringify(listed.json).includes(issued.token), false);
  });
});

test("the token list is newest first and per person", async () => {
  await withApp(async (ctx) => {
    const alex = await signUp(ctx, "Alex");
    const bea = await signUp(ctx, "Bea");
    const first = await issue(ctx, alex, "first");
    ctx.advance(1000);
    const second = await issue(ctx, alex, "second");
    ctx.advance(1000);
    const third = await issue(ctx, alex, "third");
    await issue(ctx, bea, "bea's");

    const listed = await api(ctx, "GET", "/api/me/agent-tokens", { token: alex.token, status: 200 });
    assert.deepEqual(listed.json.tokens.map((t: { id: string }) => t.id), [third.id, second.id, first.id]);
    assert.deepEqual(listed.json.tokens.map((t: { name: string }) => t.name), ["third", "second", "first"]);
  });
});

test("only a hash and a short prefix are stored", async () => {
  await withApp(async (ctx) => {
    const alex = await signUp(ctx, "Alex");
    const issued = await issue(ctx, alex, "bot");
    const rows = ctx.db.prepare("SELECT * FROM agent_tokens").all() as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.match(String(row.token_hash), /^[0-9a-f]{64}$/);
    assert.notEqual(row.token_hash, issued.token);
    assert.equal(row.token_prefix, issued.token.slice(0, 8));
    assert.equal(row.user_id, alex.user.id);
    for (const value of Object.values(row)) {
      assert.equal(typeof value === "string" && value.includes(issued.token), false, "plain token is not stored");
    }
  });
});

test("an agent token reads and writes as its owner, and never sees the recovery code", async () => {
  await withApp(async (ctx) => {
    const alex = await member(ctx, "Alex");
    const { token } = await issue(ctx, alex, "bot");

    const asAgent = await api(ctx, "GET", "/api/me", { token, status: 200 });
    assert.equal(asAgent.json.user.id, alex.user.id);
    assert.equal("buzzToken" in asAgent.json.user, false);

    const asSession = await api(ctx, "GET", "/api/me", { token: alex.token, status: 200 });
    assert.equal(asSession.json.user.id, alex.user.id);
    assert.equal(typeof asSession.json.user.buzzToken, "string");
    assert.ok(asSession.json.user.buzzToken.length > 0);

    const set = await api(ctx, "PUT", "/api/me/status", { token, body: { type: "busy", text: "In a meeting" }, status: 200 });
    assert.equal(set.json.user.status.type, "busy");
    assert.equal(set.json.user.status.text, "In a meeting");
    assert.equal("buzzToken" in set.json.user, false);
    const seen = await api(ctx, "GET", "/api/me", { token: alex.token, status: 200 });
    assert.equal(seen.json.user.status.type, "busy");

    const away = await api(ctx, "PUT", "/api/me/status", { token, body: { type: "away", text: "Trip" }, status: 200 });
    assert.equal(away.json.user.status.type, "away");

    await api(ctx, "PUT", "/api/me/status", { token, body: { type: "nope" }, status: 400 });
  });
});

test("an agent token can start a social and join one as its owner", async () => {
  await withApp(async (ctx) => {
    const alex = await member(ctx, "Alex");
    const circle = (await api(ctx, "GET", "/api/me", { token: alex.token, status: 200 })).json.circle;
    const bea = await signUp(ctx, "Bea", circle.inviteCode);
    const alexAgent = await issue(ctx, alex, "bot");
    const beaAgent = await issue(ctx, bea, "bot");

    const created = await api(ctx, "POST", "/api/socials", { token: alexAgent.token, body: { note: "Coffee?" }, status: 201 });
    assert.equal(created.json.social.creator.name, "Alex");
    const id = created.json.social.id as string;

    await api(ctx, "POST", `/api/socials/${id}/join`, { token: beaAgent.token, body: {}, status: 200 });
    const listed = await api(ctx, "GET", "/api/socials", { token: alex.token, status: 200 });
    assert.deepEqual(listed.json.socials[0].joined.map((p: { name: string }) => p.name), ["Bea"]);
  });
});

test("an agent token is refused on account, token, and admin routes", async () => {
  await withApp(async (ctx) => {
    const alex = await member(ctx, "Alex");
    const other = await issue(ctx, alex, "other");
    const { token } = await issue(ctx, alex, "bot");

    const calls: Array<[string, string, unknown?]> = [
      ["GET", "/api/me/agent-tokens"],
      ["POST", "/api/me/agent-tokens", { name: "sneaky" }],
      ["DELETE", `/api/me/agent-tokens/${other.id}`],
      ["POST", "/api/auth/logout", {}],
      ["POST", "/api/me/buzz-token", {}],
      ["PUT", "/api/me/avatar"],
      ["DELETE", "/api/me/avatar"],
      ["POST", "/api/admin/query", { sql: "select 1" }],
      ["GET", "/api/admin/feedback"],
    ];
    for (const [method, path, body] of calls) {
      const res = await api(ctx, method, path, { token, body });
      assert.equal(res.status, 403, `${method} ${path}`);
      assert.equal(res.json.error, FORBIDDEN, `${method} ${path}`);
    }

    // Nothing above changed anything.
    const listed = await api(ctx, "GET", "/api/me/agent-tokens", { token: alex.token, status: 200 });
    assert.equal(listed.json.tokens.length, 2);
    assert.equal(await statusOf(ctx, other.token), 200);
    const buzz = (await api(ctx, "GET", "/api/me", { token: alex.token, status: 200 })).json.user.buzzToken;
    assert.equal(typeof buzz, "string");
  });
});

test("agent logout is refused and leaves the session alive", async () => {
  await withApp(async (ctx) => {
    const alex = await signUp(ctx, "Alex");
    const { token } = await issue(ctx, alex, "bot");
    const res = await api(ctx, "POST", "/api/auth/logout", { token, body: {} });
    assert.equal(res.status, 403);
    assert.equal(res.json.error, FORBIDDEN);
    assert.equal(await statusOf(ctx, alex.token), 200);
    assert.equal(await statusOf(ctx, token), 200);
  });
});

test("revoking a token stops it at once and leaves the session and other tokens alone", async () => {
  await withApp(async (ctx) => {
    const alex = await signUp(ctx, "Alex");
    const doomed = await issue(ctx, alex, "doomed");
    const kept = await issue(ctx, alex, "kept");
    assert.equal(await statusOf(ctx, doomed.token), 200);

    const res = await api(ctx, "DELETE", `/api/me/agent-tokens/${doomed.id}`, { token: alex.token });
    assert.equal(res.status, 204);
    assert.equal(await statusOf(ctx, doomed.token), 401);
    assert.equal(await statusOf(ctx, kept.token), 200);
    assert.equal(await statusOf(ctx, alex.token), 200);

    const listed = await api(ctx, "GET", "/api/me/agent-tokens", { token: alex.token, status: 200 });
    assert.deepEqual(listed.json.tokens.map((t: { id: string }) => t.id), [kept.id]);
    await api(ctx, "DELETE", `/api/me/agent-tokens/${doomed.id}`, { token: alex.token, status: 404 });
  });
});

test("revoking someone else's token, or a made-up id, is a 404 and revokes nothing", async () => {
  await withApp(async (ctx) => {
    const alex = await signUp(ctx, "Alex");
    const bea = await signUp(ctx, "Bea");
    const mine = await issue(ctx, alex, "mine");
    const theirs = await issue(ctx, bea, "theirs");

    await api(ctx, "DELETE", `/api/me/agent-tokens/${theirs.id}`, { token: alex.token, status: 404 });
    await api(ctx, "DELETE", "/api/me/agent-tokens/not-a-real-id", { token: alex.token, status: 404 });
    await api(ctx, "DELETE", "/api/me/agent-tokens/%E0%A4%A", { token: alex.token, status: 404 });
    assert.equal(await statusOf(ctx, theirs.token), 200);
    assert.equal(await statusOf(ctx, mine.token), 200);
    await api(ctx, "DELETE", `/api/me/agent-tokens/${mine.id}`, { status: 401 });
  });
});

test("a person holds at most ten agent tokens, and names must not be blank", async () => {
  await withApp(async (ctx) => {
    const alex = await signUp(ctx, "Alex");
    const bea = await signUp(ctx, "Bea");
    const issued: Issued[] = [];
    for (let i = 0; i < MAX_AGENT_TOKENS; i += 1) issued.push(await issue(ctx, alex, `bot ${i}`));

    const over = await api(ctx, "POST", "/api/me/agent-tokens", { token: alex.token, body: { name: "one more" } });
    assert.equal(over.status, 409);
    assert.equal(over.json.error, "You already have 10 agent tokens. Revoke one first.");
    assert.equal("token" in over.json, false);
    assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM agent_tokens").get()?.n, MAX_AGENT_TOKENS);

    // Another person has their own allowance, and revoking frees a slot.
    await issue(ctx, bea, "bea's bot");
    await api(ctx, "DELETE", `/api/me/agent-tokens/${issued[0].id}`, { token: alex.token, status: 204 });
    await issue(ctx, alex, "replacement");

    for (const name of ["", "   ", "\n\t"]) {
      await api(ctx, "POST", "/api/me/agent-tokens", { token: bea.token, body: { name }, status: 400 });
    }
    await api(ctx, "POST", "/api/me/agent-tokens", { token: bea.token, body: {}, status: 400 });
    await api(ctx, "POST", "/api/me/agent-tokens", { token: bea.token, body: { name: "x".repeat(41) }, status: 400 });
  });
});

test("an agent token is limited per token: the 61st request is a 429 with Retry-After", async () => {
  await withApp(async (ctx) => {
    const alex = await signUp(ctx, "Alex");
    const bea = await signUp(ctx, "Bea");
    const alexAgent = await issue(ctx, alex, "bot");
    const alexSecond = await issue(ctx, alex, "second bot");
    const beaAgent = await issue(ctx, bea, "bot");
    assert.equal(AGENT_TOKEN_LIMIT.limit, 60);

    const fetchMe = (token: string) =>
      fetch(`http://127.0.0.1:${ctx.port}/api/me`, { headers: { authorization: `Bearer ${token}` } });

    for (let i = 0; i < AGENT_TOKEN_LIMIT.limit; i += 1) {
      const res = await fetchMe(alexAgent.token);
      await res.text();
      assert.equal(res.status, 200, `request ${i + 1}`);
    }

    const limited = await fetchMe(alexAgent.token);
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), { error: "too many requests" });
    const retryAfter = limited.headers.get("retry-after");
    assert.match(retryAfter ?? "", /^[1-9][0-9]*$/);
    assert.ok(Number(retryAfter) <= AGENT_TOKEN_LIMIT.windowMs / 1000);

    // Forbidden routes count against the same budget, and stay limited.
    const stillLimited = await api(ctx, "POST", "/api/auth/logout", { token: alexAgent.token, body: {} });
    assert.equal(stillLimited.status, 429);

    // The session, the same person's other token, and another person's token are not affected.
    assert.equal(await statusOf(ctx, alex.token), 200);
    assert.equal(await statusOf(ctx, alexSecond.token), 200);
    assert.equal(await statusOf(ctx, beaAgent.token), 200);

    // Retry-After shrinks as the window runs down, and the next window starts fresh.
    ctx.advance(AGENT_TOKEN_LIMIT.windowMs - 1500);
    const later = await fetchMe(alexAgent.token);
    await later.text();
    assert.equal(later.status, 429);
    assert.equal(later.headers.get("retry-after"), "2");

    ctx.advance(1500);
    assert.equal(await statusOf(ctx, alexAgent.token), 200);
  });
});

test("session requests are never rate limited like agent requests", async () => {
  await withApp(async (ctx) => {
    const alex = await signUp(ctx, "Alex");
    for (let i = 0; i < AGENT_TOKEN_LIMIT.limit + 5; i += 1) {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/api/me`, { headers: { authorization: `Bearer ${alex.token}` } });
      await res.text();
      assert.equal(res.status, 200, `request ${i + 1}`);
    }
  });
});

test("wrong or malformed tokens are 401", async () => {
  await withApp(async (ctx) => {
    const alex = await signUp(ctx, "Alex");
    const real = await issue(ctx, alex, "bot");

    // Right length and shape, but never issued.
    const unknown = "hng_" + "A".repeat(43);
    assert.equal(unknown.length, real.token.length);
    // One character off a real token.
    const flipped = real.token.slice(0, -1) + (real.token.endsWith("A") ? "B" : "A");
    // Wrong length, bad characters, bare prefix.
    const wrong = [unknown, flipped, real.token.slice(0, -1), real.token + "A", "hng_" + "!".repeat(43), "hng_" + "A".repeat(20), "hng_"];
    for (const token of wrong) {
      assert.equal(await statusOf(ctx, token), 401, `agent-shaped token of length ${token.length}`);
    }

    // Session-shaped but not real, and a real session token with another prefix.
    assert.equal(await statusOf(ctx, "B".repeat(43)), 401);
    assert.equal(await statusOf(ctx, "x".repeat(300)), 401);
    assert.equal(await statusOf(ctx, "HNG_" + real.token.slice(4)), 401);
    assert.equal(await statusOf(ctx, "hng_" + alex.token.slice(0, 43)), 401);
    assert.equal(await api(ctx, "GET", "/api/me", {}).then((r) => r.status), 401);

    // The real ones still work, and an agent token is not a session token.
    assert.equal(await statusOf(ctx, real.token), 200);
    assert.equal(await statusOf(ctx, alex.token), 200);
  });
});

const UUID = "123e4567-e89b-42d3-a456-426614174000";

test("the agent allow-list is exactly the documented operations", () => {
  for (const { method, path } of listOperations()) {
    const concrete = path.replace(/\{[^}]+\}/g, UUID);
    assert.equal(isAgentAllowed(method, concrete), true, `${method} ${path}`);
  }
  const notDocumented: Array<[string, string]> = [
    ["GET", "/api/chats"],
    ["GET", "/api/definitely-not-a-route"],
    ["POST", "/api/circles/chat"],
    ["POST", "/api/circles/leave"],
    ["PATCH", "/api/me"],
    ["GET", "/api/me/calendar-sync"],
    ["GET", "/api/me/agent-tokens"],
    ["POST", "/api/auth/logout"],
    ["GET", "/api/admin/feedback"],
    // Documented path, undocumented method.
    ["DELETE", "/api/socials"],
    ["POST", "/api/me"],
    // Exact paths do not match longer or shorter ones, and {id} is one segment.
    ["GET", "/api/me/extra"],
    ["GET", "/api/me/"],
    ["GET", "/api"],
    ["GET", "/x/api/me"],
    ["POST", `/api/socials/${UUID}/join/extra`],
    ["POST", `/api/socials/${UUID}/x/join`],
    ["POST", "/api/socials//join"],
  ];
  for (const [method, path] of notDocumented) {
    assert.equal(isAgentAllowed(method, path), false, `${method} ${path}`);
  }
});

test("an agent token is refused on undocumented routes that the session can still use", async () => {
  await withApp(async (ctx) => {
    const alex = await member(ctx, "Alex");
    const { token } = await issue(ctx, alex, "bot");

    // Documented, so still fine.
    assert.equal(await statusOf(ctx, token, "GET", "/api/health"), 200);
    assert.equal(await statusOf(ctx, token), 200);

    const calls: Array<[string, string, unknown?]> = [
      ["POST", "/api/circles/chat", { text: "hi" }],
      ["GET", "/api/me/calendar-sync"],
      ["POST", "/api/me/calendar-sync", {}],
      ["PUT", "/api/me/calendar-sync", {}],
      ["POST", "/api/circles/leave", {}],
      ["PATCH", "/api/me", { name: "Mallory" }],
      ["GET", "/api/definitely-not-a-route"],
    ];
    for (const [method, path, body] of calls) {
      const res = await api(ctx, method, path, { token, body });
      assert.equal(res.status, 403, `${method} ${path}`);
      assert.deepEqual(res.json, { error: FORBIDDEN }, `${method} ${path}`);
    }

    // The session is unchanged: nothing above took effect, and each route still works.
    await api(ctx, "POST", "/api/circles/chat", { token: alex.token, body: { text: "hi" }, status: 201 });
    await api(ctx, "GET", "/api/me/calendar-sync", { token: alex.token, status: 200 });
    const renamed = await api(ctx, "PATCH", "/api/me", { token: alex.token, body: { name: "Alexa" }, status: 200 });
    assert.equal(renamed.json.user.name, "Alexa");
    await api(ctx, "POST", "/api/circles/leave", { token: alex.token, body: {}, status: 200 });
  });
});
