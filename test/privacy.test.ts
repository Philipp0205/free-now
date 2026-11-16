import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { api, withApp, testEmail } from "./http.js";
import { builtPrecache } from "./built.js";

const read = (file: string) => fs.readFileSync(new URL(file, import.meta.url), "utf8");
const PRIVACY = read("../public/privacy.html");
const INDEX = read("../public/index.html");
const SW = read("../sw/sw.js");
const ROBOTS = read("../public/robots.txt");
const VERIFY_PATH = "/googlee48df27048aaa965.html";
const VERIFY_BODY = "google-site-verification: googlee48df27048aaa965.html";
const TOKEN = "LdD2ulfZ_5JbtIVCJnza_UQNI8d9to6WRHoq067jzBE";

async function get(port: number, pathname: string, init: RequestInit = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { redirect: "manual", ...init });
  return { status: response.status, headers: response.headers, text: await response.text() };
}

/** Visible text of a page, without tags or comments. */
function visibleText(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<head>[\s\S]*?<\/head>/, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

test("the Search Console verification file is served as is, not as the app shell", async () => {
  assert.equal(read("../public/googlee48df27048aaa965.html").trim(), VERIFY_BODY);
  await withApp(async ({ port }) => {
    const me = await api(port, "POST", "/api/auth/start", { body: { email: testEmail(), name: "Fake Tester" }, status: 201 });
    for (const headers of [{}, { authorization: `Bearer ${me.token}` }]) {
      const file = await get(port, VERIFY_PATH, { headers });
      assert.equal(file.status, 200);
      assert.match(file.headers.get("content-type") ?? "", /^text\/html/);
      assert.equal(file.text.trim(), VERIFY_BODY);
      assert.doesNotMatch(file.text, /app\.js|<html/i);
      assert.notEqual(file.text, INDEX);
      const cache = file.headers.get("cache-control") ?? "";
      assert.doesNotMatch(cache, /max-age=\d{3,}/, "no long max-age");
      assert.equal(cache, "no-cache");
    }
    const head = await fetch(`http://127.0.0.1:${port}${VERIFY_PATH}`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
  });
});

test("/privacy serves the static policy at both paths, logged out or in", async () => {
  await withApp(async ({ port }) => {
    for (const pathname of ["/privacy", "/privacy/"]) {
      const page = await get(port, pathname);
      assert.equal(page.status, 200, pathname);
      assert.match(page.headers.get("content-type") ?? "", /^text\/html/);
      assert.equal(page.text, PRIVACY, pathname);
      assert.doesNotMatch(page.text, /app\.js/);
      assert.equal(page.headers.get("cache-control"), "no-cache");
      assert.equal(page.headers.get("referrer-policy"), "no-referrer");
      assert.equal(page.headers.get("x-frame-options"), "DENY");
    }
    const me = await api(port, "POST", "/api/auth/start", { body: { email: testEmail(), name: "Fake Tester" }, status: 201 });
    const signedIn = await get(port, "/privacy", { headers: { authorization: `Bearer ${me.token}` } });
    assert.equal(signedIn.text, PRIVACY);
    const head = await fetch(`http://127.0.0.1:${port}/privacy`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    assert.equal((await get(port, "/privacy", { method: "POST" })).status, 405);
  });
});

test("the policy has no script, no dashes or parentheses, and no invented email", () => {
  assert.doesNotMatch(PRIVACY, /<script|fn_token|localStorage/i);
  assert.doesNotMatch(PRIVACY, /[\u2014\u2013]/, "no em or en dashes");
  assert.doesNotMatch(visibleText(PRIVACY), /[()]/, "no parentheses");
  assert.doesNotMatch(PRIVACY, /@|mailto:/, "no email address");
  assert.match(PRIVACY, /href="\/welcome"[^>]*aria-label="Hangry home"/);
  assert.match(PRIVACY, /href="\/">Open Hangry</);
  assert.match(PRIVACY, /href="\/css\/welcome\.css"/);
  assert.match(PRIVACY, /<h1>Privacy<\/h1>/);
});

test("the policy states the facts", () => {
  const text = visibleText(PRIVACY);
  assert.match(text, /Last updated: 15 November 2026/);
  assert.match(text, /invite-only/);
  assert.match(text, /We do not show ads, and we do not sell your data\./);
  assert.match(text, /calendar\.freebusy permission, which is busy and free times/);
  assert.match(text, /Hangry never receives event titles or details, and never stores them/);
  assert.match(text, /we delete the token and the busy times, and we tell Google to revoke access/);
  assert.match(text, /we store only a hash of it/);
  assert.match(text, /Railway in the EU, in the europe-west4 region/);
  assert.match(text, /ask in the app with Send feedback, or contact the admin/);
  assert.match(text, /Questions about this policy: ask in the app, or contact the admin\./);
  assert.match(text, /We do not track your location in the background\./);
  for (const heading of ["Your account", "Circles, plans, and chat", "Location", "Notifications", "Calendar", "Assistant tokens", "Feedback", "Where it is hosted", "Deleting your data", "Contact"]) {
    assert.match(PRIVACY, new RegExp(`<h2>${heading}</h2>`), heading);
  }
});

test("index.html carries the Search Console meta tag", () => {
  assert.match(INDEX, new RegExp(`<meta name="google-site-verification" content="${TOKEN}" />`));
  assert.ok(INDEX.indexOf("google-site-verification") < INDEX.indexOf("</head>"));
});

test("the service worker leaves the verification file and /privacy alone", () => {
  const shell = builtPrecache();
  for (const pathname of [VERIFY_PATH, "/privacy", "/privacy/"]) {
    assert.ok(!shell.includes(pathname), `${pathname} is not precached`);
    assert.ok(SW.includes(`url.pathname === "${pathname}"`), `${pathname} is skipped`);
  }
  const fetchHandler = SW.slice(SW.indexOf('addEventListener("fetch"'), SW.indexOf('addEventListener("push"'));
  assert.ok(fetchHandler.indexOf(VERIFY_PATH) < fetchHandler.indexOf("event.respondWith"), "skipped before any respondWith");
  assert.match(fetchHandler, /url\.pathname === "\/googlee48df27048aaa965\.html"[^;]*\) return;/);
});

test("robots.txt allows the public URLs and disallows the rest", async () => {
  assert.equal(
    ROBOTS,
    "User-agent: *\nAllow: /googlee48df27048aaa965.html\nAllow: /privacy\nAllow: /privacy/\nAllow: /$\nDisallow: /\n",
  );
  await withApp(async ({ port }) => {
    const robots = await get(port, "/robots.txt");
    assert.equal(robots.status, 200);
    assert.equal(robots.text, ROBOTS);
  });
});
