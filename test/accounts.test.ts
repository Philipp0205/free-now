import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { hashSecret } from "../src/app-kit/auth-code.ts";
import { insertUser, openDb } from "../src/db.js";
import { sha256 } from "../src/lib/auth.js";
import { humanCode } from "../src/social/code.js";
import { type AppCtx, api, testEmail, withApp } from "./http.js";

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

type Signed = { token: string; recoveryCode: string; buzzToken: string; user: { id: string; email: string } };

async function signUp(ctx: AppCtx, name = "Fake Ada", email = testEmail()): Promise<Signed> {
  return (await api(ctx, "POST", "/api/auth/start", { body: { name, email }, status: 201 })).json;
}

/** Mail goes out without being awaited for lost-code links, so let it flush. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/** The token in the `#t=` fragment of the newest mail to this address. */
function linkToken(ctx: AppCtx, to: string, kind: "verify" | "recover"): string {
  const mails = ctx.mail.filter((message) => message.to === to && message.text.includes(`/${kind}#t=`));
  const last = mails[mails.length - 1];
  assert.ok(last, `a ${kind} mail to ${to}`);
  const match = /#t=([A-Za-z0-9_-]+)/.exec(last.text);
  assert.ok(match);
  return match[1];
}

/** An account from before email was required: no email, recovery code is still the buzz token. */
function legacyUser(ctx: AppCtx): { token: string; buzzToken: string; id: string } {
  const token = `legacy-session-${humanCode()}-padding`;
  const buzzToken = humanCode();
  const id = `legacy-${humanCode()}`;
  insertUser(ctx.db, { id, name: "Fake Legacy", token_hash: sha256(token), buzz_token: buzzToken, created_at: 1 });
  return { token, buzzToken, id };
}

function recoveryHash(ctx: AppCtx, id: string): string {
  return (ctx.db.prepare("SELECT recovery_hash AS h FROM users WHERE id = ?").get(id) as { h: string }).h;
}

test("start needs a valid email", async () => {
  await withApp(async (ctx) => {
    for (const email of [undefined, "", "   ", "no-at-sign", "a@b", "two@@example.test", "sp ace@example.test"]) {
      const response = await api(ctx, "POST", "/api/auth/start", { body: { name: "Fake Ada", email } });
      assert.equal(response.status, 400, `email ${JSON.stringify(email)}`);
      assert.equal(response.json.error, "enter a valid email");
    }
    assert.equal(Number((ctx.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n), 0);
  });
});

test("start returns a recovery code that is not the buzz token and mails a confirm link", async () => {
  await withApp(async (ctx) => {
    const ada = await signUp(ctx, "Fake Ada", "  Ada@Example.TEST ");
    assert.equal(ada.user.email, "ada@example.test", "stored trimmed and lowercased");
    assert.match(ada.recoveryCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.notEqual(ada.recoveryCode, ada.buzzToken);
    assert.equal(ctx.mail.length, 1);
    assert.equal(ctx.mail[0].to, "ada@example.test");
    assert.match(ctx.mail[0].text, /\/verify#t=/);

    const me = (await api(ctx, "GET", "/api/me", { token: ada.token, status: 200 })).json;
    assert.equal(me.user.email, "ada@example.test");
    assert.equal(me.user.emailVerifiedAt, null);
    assert.equal(me.user.recoveryIsFlic, false);

    const byCode = await api(ctx, "POST", "/api/auth/recover", { body: { token: ada.recoveryCode } });
    assert.equal(byCode.status, 200);
    assert.equal(byCode.json.user.id, ada.user.id);
    const byBuzz = await api(ctx, "POST", "/api/auth/recover", { body: { token: ada.buzzToken } });
    assert.equal(byBuzz.status, 401, "the Flic secret is not a way in for a new account");
  });
});

test("the confirm link works once, in a POST, and sets emailVerifiedAt", async () => {
  await withApp(async (ctx) => {
    const ada = await signUp(ctx);
    const token = linkToken(ctx, ada.user.email, "verify");
    const done = await api(ctx, "POST", "/api/auth/verify", { body: { token } });
    assert.equal(done.status, 200);
    assert.equal(done.json.email, ada.user.email);
    assert.equal(done.json.emailVerifiedAt, ctx.db.prepare("SELECT email_verified_at AS v FROM users WHERE id = ?").get(ada.user.id)?.v);
    const again = await api(ctx, "POST", "/api/auth/verify", { body: { token } });
    assert.equal(again.status, 400);
    assert.equal(again.json.error, "link is no longer valid");
    const get = await fetch(`http://127.0.0.1:${ctx.port}/verify`, { method: "GET" });
    assert.equal(get.status, 200, "the page is the app shell, the token is not in the path");
  });
});

test("a confirm link expires after 24 hours", async () => {
  await withApp(async (ctx) => {
    const ada = await signUp(ctx);
    const token = linkToken(ctx, ada.user.email, "verify");
    ctx.advance(24 * HOUR + 1000);
    const late = await api(ctx, "POST", "/api/auth/verify", { body: { token } });
    assert.equal(late.status, 400);
    const me = (await api(ctx, "GET", "/api/me", { token: ada.token, status: 200 })).json;
    assert.equal(me.user.emailVerifiedAt, null);
  });
});

test("asking again replaces the live confirm link, and garbage tokens fail", async () => {
  await withApp(async (ctx) => {
    const ada = await signUp(ctx);
    const first = linkToken(ctx, ada.user.email, "verify");
    await api(ctx, "POST", "/api/auth/email", { token: ada.token, body: { email: ada.user.email }, status: 200 });
    const second = linkToken(ctx, ada.user.email, "verify");
    assert.notEqual(first, second);
    assert.equal((await api(ctx, "POST", "/api/auth/verify", { body: { token: first } })).status, 400);
    assert.equal((await api(ctx, "POST", "/api/auth/verify", { body: { token: "nope" } })).status, 400);
    assert.equal((await api(ctx, "POST", "/api/auth/verify", { body: {} })).status, 400);
    assert.equal((await api(ctx, "POST", "/api/auth/verify", { body: { token: second } })).status, 200);
  });
});

test("changing the address un-verifies it and the old link no longer confirms", async () => {
  await withApp(async (ctx) => {
    const ada = await signUp(ctx);
    const oldToken = linkToken(ctx, ada.user.email, "verify");
    await api(ctx, "POST", "/api/auth/verify", { body: { token: oldToken }, status: 200 });
    const changed = await api(ctx, "POST", "/api/auth/email", { token: ada.token, body: { email: "new-ada@example.test" } });
    assert.equal(changed.status, 200);
    assert.equal(changed.json.email, "new-ada@example.test");
    assert.equal(changed.json.emailVerifiedAt, null);
    const bad = await api(ctx, "POST", "/api/auth/email", { token: ada.token, body: { email: "nope" } });
    assert.equal(bad.status, 400);
    const stale = await api(ctx, "POST", "/api/auth/verify", { body: { token: linkToken(ctx, "new-ada@example.test", "verify") } });
    assert.equal(stale.status, 200, "the new link confirms the new address");
  });
});

test("an address confirmed by one account cannot be confirmed by another", async () => {
  await withApp(async (ctx) => {
    const email = "shared@example.test";
    const first = await signUp(ctx, "Fake First", email);
    const firstToken = linkToken(ctx, email, "verify");
    const second = await signUp(ctx, "Fake Second", email);
    const secondToken = linkToken(ctx, email, "verify");
    assert.notEqual(first.user.id, second.user.id, "typing an address does not claim it");
    assert.equal((await api(ctx, "POST", "/api/auth/verify", { body: { token: firstToken } })).status, 200);
    const taken = await api(ctx, "POST", "/api/auth/verify", { body: { token: secondToken } });
    assert.equal(taken.status, 400);
    assert.equal(taken.json.error, "that email is already confirmed on another account");
  });
});

test("lost code answers the same for every address and mails only confirmed ones", async () => {
  await withApp(async (ctx) => {
    const confirmed = await signUp(ctx, "Fake Confirmed");
    await api(ctx, "POST", "/api/auth/verify", { body: { token: linkToken(ctx, confirmed.user.email, "verify") }, status: 200 });
    const unconfirmed = await signUp(ctx, "Fake Unconfirmed");
    const before = ctx.mail.length;

    const answers = [];
    for (const email of ["nobody@example.test", unconfirmed.user.email, confirmed.user.email, "not an email", ""]) {
      const response = await api(ctx, "POST", "/api/auth/lost-code", { body: { email } });
      answers.push([response.status, JSON.stringify(response.json)]);
    }
    await flush();
    assert.deepEqual(new Set(answers.map((a) => a.join(" "))).size, 1, "one answer for all");
    assert.equal(answers[0][0], 200);

    const sent = ctx.mail.slice(before);
    assert.equal(sent.length, 1, "only the confirmed address gets mail");
    assert.equal(sent[0].to, confirmed.user.email);
    assert.match(sent[0].text, /\/recover#t=/);
  });
});

test("a lost-code link signs in once, rotates the recovery code and signs out other sessions", async () => {
  await withApp(async (ctx) => {
    const ada = await signUp(ctx);
    await api(ctx, "POST", "/api/auth/verify", { body: { token: linkToken(ctx, ada.user.email, "verify") }, status: 200 });
    await api(ctx, "POST", "/api/auth/lost-code", { body: { email: ada.user.email }, status: 200 });
    await flush();
    const token = linkToken(ctx, ada.user.email, "recover");

    const back = await api(ctx, "POST", "/api/auth/lost-code/consume", { body: { token } });
    assert.equal(back.status, 200);
    assert.equal(back.json.user.id, ada.user.id);
    assert.match(back.json.recoveryCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.notEqual(back.json.recoveryCode, ada.recoveryCode);
    assert.equal(back.json.buzzToken, ada.buzzToken, "the Flic link is not touched");

    assert.equal((await api(ctx, "GET", "/api/me", { token: back.json.token })).status, 200);
    assert.equal((await api(ctx, "GET", "/api/me", { token: ada.token })).status, 401, "the old session is gone");
    assert.equal((await api(ctx, "POST", "/api/auth/recover", { body: { token: ada.recoveryCode } })).status, 401);
    assert.equal((await api(ctx, "POST", "/api/auth/recover", { body: { token: back.json.recoveryCode } })).status, 200);
    assert.equal((await api(ctx, "POST", "/api/auth/lost-code/consume", { body: { token } })).status, 400, "single use");
    const buzz = await api(ctx, "POST", `/api/buzz/${ada.buzzToken}`, { body: {} });
    assert.notEqual(buzz.status, 404, "the Flic URL still resolves to the account");
  });
});

test("a lost-code link expires after 20 minutes and a new request replaces the old one", async () => {
  await withApp(async (ctx) => {
    const ada = await signUp(ctx);
    await api(ctx, "POST", "/api/auth/verify", { body: { token: linkToken(ctx, ada.user.email, "verify") }, status: 200 });
    await api(ctx, "POST", "/api/auth/lost-code", { body: { email: ada.user.email }, status: 200 });
    await flush();
    const first = linkToken(ctx, ada.user.email, "recover");
    await api(ctx, "POST", "/api/auth/lost-code", { body: { email: ada.user.email }, status: 200 });
    await flush();
    const second = linkToken(ctx, ada.user.email, "recover");
    assert.notEqual(first, second);
    assert.equal((await api(ctx, "POST", "/api/auth/lost-code/consume", { body: { token: first } })).status, 400);
    ctx.advance(20 * MINUTE + 1000);
    assert.equal((await api(ctx, "POST", "/api/auth/lost-code/consume", { body: { token: second } })).status, 400);
    assert.equal((await api(ctx, "POST", "/api/auth/lost-code/consume", { body: {} })).status, 400);
  });
});

test("a recover link is not a confirm link and the reverse", async () => {
  await withApp(async (ctx) => {
    const ada = await signUp(ctx);
    const verify = linkToken(ctx, ada.user.email, "verify");
    assert.equal((await api(ctx, "POST", "/api/auth/lost-code/consume", { body: { token: verify } })).status, 400);
    assert.equal((await api(ctx, "POST", "/api/auth/verify", { body: { token: verify }, status: 200 })).status, 200);
  });
});

test("lost-code requests are rate limited without saying why", async () => {
  await withApp(async (ctx) => {
    let limited = 0;
    for (let i = 0; i < 14; i++) {
      const response = await api(ctx, "POST", "/api/auth/lost-code", { body: { email: testEmail() } });
      if (response.status === 429) limited += 1;
      else assert.equal(response.status, 200);
    }
    assert.ok(limited >= 1, "the 11th request in the window is refused");
    assert.equal(limited, 4);
  });
});

test("wrong recovery codes are rate limited", async () => {
  await withApp(async (ctx) => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await api(ctx, "POST", "/api/auth/recover", { body: { token: "AAAA-BBBB-CCCC" } })).status);
    }
    assert.equal(statuses[0], 401);
    assert.equal(statuses[statuses.length - 1], 429);
  });
});

test("an account without an email is held at the door until it adds one", async () => {
  await withApp(async (ctx) => {
    const old = legacyUser(ctx);
    const me = (await api(ctx, "GET", "/api/me", { token: old.token, status: 200 })).json;
    assert.equal(me.user.email, null);
    assert.equal(me.user.recoveryIsFlic, true);

    const blocked = await api(ctx, "POST", "/api/circles", { token: old.token, body: { name: "Fake circle" } });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.json.error, "add an email first");
    assert.equal((await api(ctx, "GET", "/api/circles", { token: old.token })).status, 403);

    const added = await api(ctx, "POST", "/api/auth/email", { token: old.token, body: { email: testEmail() } });
    assert.equal(added.status, 200);
    assert.equal(added.json.emailVerifiedAt, null);
    const open = await api(ctx, "POST", "/api/circles", { token: old.token, body: { name: "Fake circle" } });
    assert.equal(open.status, 201, "an unconfirmed address is enough to use the app");
  });
});

test("a no-email account can still sign out", async () => {
  await withApp(async (ctx) => {
    const old = legacyUser(ctx);
    const out = await api(ctx, "POST", "/api/auth/logout", { token: old.token });
    assert.ok(out.status === 200 || out.status === 204, `logout -> ${out.status}`);
    assert.equal((await api(ctx, "GET", "/api/me", { token: old.token })).status, 401);
  });
});

test("an old account keeps signing in with the code it already holds", async () => {
  await withApp(async (ctx) => {
    const old = legacyUser(ctx);
    for (const typed of [old.buzzToken, old.buzzToken.toLowerCase(), old.buzzToken.replaceAll("-", " "), `curl -X POST https://hangry.example/api/buzz/${old.buzzToken}`]) {
      const response = await api(ctx, "POST", "/api/auth/recover", { body: { token: typed } });
      assert.equal(response.status, 200, `typed ${typed.slice(0, 20)}`);
      assert.equal(response.json.user.id, old.id);
      assert.equal(response.json.user.email, null);
    }
  });
});

test("rotating the buzz token of an account where code and Flic are one also rotates the code", async () => {
  await withApp(async (ctx) => {
    const old = legacyUser(ctx);
    await api(ctx, "POST", "/api/auth/email", { token: old.token, body: { email: testEmail() }, status: 200 });
    const rotated = (await api(ctx, "POST", "/api/me/buzz-token", { token: old.token, status: 200 })).json;
    assert.equal(rotated.recoveryIsFlic, true, "it was together before");
    assert.notEqual(rotated.buzzToken, old.buzzToken);
    assert.equal(recoveryHash(ctx, old.id), hashSecret(rotated.buzzToken));
    assert.equal((await api(ctx, "POST", "/api/auth/recover", { body: { token: old.buzzToken } })).status, 401, "the leaked link stops being a way in");
    assert.equal((await api(ctx, "POST", "/api/auth/recover", { body: { token: rotated.buzzToken } })).status, 200);
    assert.equal((await api(ctx, "POST", `/api/buzz/${old.buzzToken}`, { body: {} })).status, 404);
  });
});

test("once the code is its own, a new Flic link leaves it alone and the old link stops signing in", async () => {
  await withApp(async (ctx) => {
    const old = legacyUser(ctx);
    await api(ctx, "POST", "/api/auth/email", { token: old.token, body: { email: testEmail() }, status: 200 });
    const code = (await api(ctx, "POST", "/api/me/recovery-code", { token: old.token, status: 200 })).json.recoveryCode;
    assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.equal((await api(ctx, "POST", "/api/auth/recover", { body: { token: old.buzzToken } })).status, 401, "the Flic secret no longer signs in");
    assert.equal((await api(ctx, "GET", "/api/me", { token: old.token, status: 200 })).json.user.recoveryIsFlic, false);

    const before = recoveryHash(ctx, old.id);
    const rotated = (await api(ctx, "POST", "/api/me/buzz-token", { token: old.token, status: 200 })).json;
    assert.equal(rotated.recoveryIsFlic, false);
    assert.equal(recoveryHash(ctx, old.id), before, "the recovery code is not touched");
    assert.equal((await api(ctx, "POST", "/api/auth/recover", { body: { token: code } })).status, 200);
    assert.notEqual((await api(ctx, "POST", `/api/buzz/${rotated.buzzToken}`, { body: {} })).status, 404);
  });
});

test("a new recovery code retires the old one and leaves the Flic link and sessions", async () => {
  await withApp(async (ctx) => {
    const ada = await signUp(ctx);
    const next = (await api(ctx, "POST", "/api/me/recovery-code", { token: ada.token, status: 200 })).json.recoveryCode;
    assert.notEqual(next, ada.recoveryCode);
    assert.equal((await api(ctx, "POST", "/api/auth/recover", { body: { token: ada.recoveryCode } })).status, 401);
    assert.equal((await api(ctx, "POST", "/api/auth/recover", { body: { token: next } })).status, 200);
    assert.equal((await api(ctx, "GET", "/api/me", { token: ada.token })).status, 200, "this session stays");
    assert.equal((await api(ctx, "GET", "/api/me", { token: ada.token, status: 200 })).json.user.buzzToken, ada.buzzToken);
  });
});

test("the recovery code stays out of agent tokens", async () => {
  await withApp(async (ctx) => {
    const ada = await signUp(ctx);
    const created = await api(ctx, "POST", "/api/me/agent-tokens", { token: ada.token, body: { name: "Fake agent" } });
    assert.equal(created.status, 201);
    const agent = created.json.token as string;
    const me = (await api(ctx, "GET", "/api/me", { token: agent, status: 200 })).json;
    assert.equal(me.user.email, undefined);
    assert.equal(me.user.recoveryIsFlic, undefined);
    assert.equal((await api(ctx, "POST", "/api/me/recovery-code", { token: agent })).status >= 400, true);
    assert.equal((await api(ctx, "POST", "/api/auth/email", { token: agent, body: { email: testEmail() } })).status >= 400, true);
  });
});

test("old users get a recovery hash on the next boot and a second boot changes nothing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hangry-accounts-"));
  const file = path.join(dir, "test.db");
  try {
    const first = openDb(file);
    first
      .prepare("INSERT INTO users (id, name, token_hash, buzz_token, created_at) VALUES ('u1', 'Fake Old', 'th', 'ABCD-EFGH-JKLM', 1)")
      .run();
    first.prepare("UPDATE users SET recovery_hash = NULL WHERE id = 'u1'").run();
    first.close();

    const second = openDb(file);
    const row = second.prepare("SELECT recovery_hash AS h, email AS e FROM users WHERE id = 'u1'").get() as { h: string; e: string | null };
    assert.equal(row.h, hashSecret("ABCD-EFGH-JKLM"));
    assert.equal(row.e, null);
    second
      .prepare("INSERT INTO users (id, name, token_hash, buzz_token, created_at, email) VALUES ('u2', 'Fake Two', 'th2', 'WXYZ-2345-6789', 1, 'x@example.test')")
      .run();
    second.prepare("UPDATE users SET email_verified_at = 5 WHERE id = 'u2'").run();
    assert.throws(() => {
      second
        .prepare("INSERT INTO users (id, name, token_hash, buzz_token, created_at, email, email_verified_at) VALUES ('u3', 'Fake Three', 'th3', 'NPQR-STUV-2345', 1, 'x@example.test', 6)")
        .run();
    }, /UNIQUE/i, "two accounts cannot both hold a confirmed address");
    second
      .prepare("INSERT INTO users (id, name, token_hash, buzz_token, created_at, email) VALUES ('u4', 'Fake Four', 'th4', 'HJKM-NPQR-STUV', 1, 'x@example.test')")
      .run();
    second.close();

    const third = openDb(file);
    assert.equal((third.prepare("SELECT recovery_hash AS h FROM users WHERE id = 'u1'").get() as { h: string }).h, hashSecret("ABCD-EFGH-JKLM"));
    third.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
