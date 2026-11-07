import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { api, withApp } from "./http.js";

const WELCOME = fs.readFileSync(new URL("../public/welcome.html", import.meta.url), "utf8");
const INDEX = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const MANIFEST = JSON.parse(fs.readFileSync(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"));
const SW = fs.readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");

async function get(port: number, pathname: string, init: RequestInit = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { redirect: "manual", ...init });
  return { status: response.status, headers: response.headers, text: await response.text() };
}

test("/welcome serves the static landing page, not the app shell", async () => {
  await withApp(async ({ port }) => {
    for (const pathname of ["/welcome", "/welcome/", "/welcome?ref=x"]) {
      const page = await get(port, pathname);
      assert.equal(page.status, 200, pathname);
      assert.match(page.headers.get("content-type") ?? "", /^text\/html/);
      assert.equal(page.text, WELCOME, pathname);
      assert.doesNotMatch(page.text, /app\.js/, "the landing page does not boot the app");
    }
    const head = await fetch(`http://127.0.0.1:${port}/welcome`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
  });
});

test("/ and app paths still serve the app shell", async () => {
  await withApp(async ({ port }) => {
    for (const pathname of ["/", "/join/ABCDEFGH", "/?plan=x&circle=y", "/some/unknown/route", "/welcomex", "/welcome/extra"]) {
      const page = await get(port, pathname);
      assert.equal(page.status, 200, pathname);
      assert.equal(page.text, INDEX, `${pathname} is the app shell`);
    }
  });
});

test("/welcome does not mask API errors or unknown files", async () => {
  await withApp(async ({ port }) => {
    const anonApi = await get(port, "/api/welcome");
    assert.equal(anonApi.status, 401, "anonymous unknown API stays an auth error");
    assert.match(anonApi.headers.get("content-type") ?? "", /application\/json/);
    assert.doesNotMatch(anonApi.text, /<html/i);
    const me = await api(port, "POST", "/api/auth/start", { body: { name: "Fake Tester" }, status: 201 });
    const unknownApi = await get(port, "/api/welcome", { headers: { authorization: `Bearer ${me.token}` } });
    assert.equal(unknownApi.status, 404);
    assert.deepEqual(JSON.parse(unknownApi.text), { error: "not found" });
    const noAuth = await get(port, "/api/me");
    assert.equal(noAuth.status, 401);
    assert.match(noAuth.headers.get("content-type") ?? "", /application\/json/);
    const missingFile = await get(port, "/welcome.missing.css");
    assert.equal(missingFile.status, 404);
    assert.deepEqual(JSON.parse(missingFile.text), { error: "not found" });
    const post = await get(port, "/welcome", { method: "POST" });
    assert.equal(post.status, 405);
    const feed = await get(port, "/cal/not-a-token.ics");
    assert.equal(feed.status, 404);
    assert.equal(feed.text, "");
  });
});

test("/welcome is the same on every host and never redirects", async () => {
  await withApp(async ({ port }) => {
    for (const host of ["www.imhangry.app", "hangry.up.railway.app", "localhost"]) {
      const page = await get(port, "/welcome", { headers: { host } });
      assert.equal(page.status, 200, host);
      assert.equal(page.text, WELCOME, host);
    }
    const root = await get(port, "/", { headers: { host: "www.imhangry.app" } });
    assert.equal(root.status, 200);
    assert.equal(root.text, INDEX, "/ is not redirected to /welcome");
  }, { env: { PUBLIC_BASE_URL: "https://www.imhangry.app" } });
});

test("a signed-in token does not change /welcome or /", async () => {
  await withApp(async ({ port }) => {
    const me = await api(port, "POST", "/api/auth/start", { body: { name: "Fake Tester" }, status: 201 });
    await api(port, "POST", "/api/circles", { token: me.token, body: { name: "Fake circle" }, status: 201 });
    const auth = { authorization: `Bearer ${me.token}` };
    assert.equal((await get(port, "/welcome", { headers: auth })).text, WELCOME);
    assert.equal((await get(port, "/", { headers: auth })).text, INDEX);
  });
});

test("the landing page holds no private data and links to the app", () => {
  assert.doesNotMatch(WELCOME, /fn_token|localStorage|<script/i, "no script, no session access");
  assert.doesNotMatch(WELCOME, /\u2014/, "no em dashes");
  assert.match(WELCOME, /href="\/"[^>]*>Open Hangry</);
  assert.match(WELCOME, /href="\/"[^>]*>Get started</);
  assert.match(WELCOME, /Example/);
  assert.match(WELCOME, /href="\/welcome\.css"/);
});

test("the PWA still starts at / and the worker never caches /welcome as the shell", () => {
  assert.equal(MANIFEST.start_url, "/");
  assert.equal(MANIFEST.scope, "/");
  assert.equal(MANIFEST.id, "/");
  const shell = /const SHELL = (\[[^\]]*\]);/.exec(SW)?.[1] ?? "[]";
  assert.ok(JSON.parse(shell).includes("/"));
  assert.ok(!JSON.parse(shell).includes("/welcome"), "the landing page is not part of the app shell");
});
