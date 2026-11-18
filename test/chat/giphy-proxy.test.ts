import assert from "node:assert/strict";
import test from "node:test";
import { flushChatNotices } from "../../src/chat/chat.js";
import type { GiphyFetch } from "../../src/chat/giphy.js";
import { api, testEmail, withApp, type AppCtx } from "../http.js";

// Fake key, fake Giphy. Nothing here reaches api.giphy.com: the app gets a stub fetch, and a global guard
// below fails the run if anything else tries.

const KEY = "test-giphy-key";

const realFetch = globalThis.fetch;
const outside: string[] = [];
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith("http://127.0.0.1")) {
    outside.push(url);
    return Promise.reject(new Error("the tests never leave the machine"));
  }
  return realFetch(input, init);
}) as typeof fetch;

type Seen = { url: string; headers: Record<string, string> };

function image(path: string, width = 200, height = 150) {
  return { url: `https://media2.giphy.com/media/${path}?cid=abc&ep=v1&rid=giphy.gif`, width: String(width), height: String(height) };
}

function entry(id: string, title = `Title ${id}`) {
  return {
    id,
    title,
    images: {
      fixed_width: image(`${id}/200w.gif`, 200, 150),
      fixed_width_small: image(`${id}/100w.gif`, 100, 75),
      original: image(`${id}/giphy.gif`, 480, 360),
    },
  };
}

function fakeGiphy(data: unknown[] = [entry("abc123"), entry("def456")]) {
  const seen: Seen[] = [];
  const fetcher: GiphyFetch = async (url, init) => {
    seen.push({ url, headers: init.headers });
    return { ok: true, status: 200, json: async () => ({ data }) };
  };
  return { fetcher, seen };
}

type Person = { token: string; user: { id: string; name: string } };

async function signUp(port: number, name = "Alex"): Promise<Person> {
  return api(port, "POST", "/api/auth/start", { body: { email: testEmail(), name }, status: 201 });
}

function withGiphy(
  fn: (ctx: AppCtx, seen: Seen[]) => Promise<void>,
  options: { env?: Record<string, string>; fetcher?: GiphyFetch; data?: unknown[] } = {},
) {
  const fake = fakeGiphy(options.data);
  return withApp(async (ctx) => {
    try {
      await fn(ctx, fake.seen);
    } finally {
      await flushChatNotices(true);
    }
  }, { env: { GIPHY_API_KEY: KEY, ...options.env }, giphyFetch: options.fetcher ?? fake.fetcher });
}

test("trending needs a login, asks Giphy for PG-13 with the server's key, and returns only what the picker needs", async () => {
  await withGiphy(async ({ port }, seen) => {
    await api(port, "GET", "/api/giphy/trending", { status: 401 });
    const alex = await signUp(port);
    const result = await api(port, "GET", "/api/giphy/trending", { token: alex.token, status: 200 });
    assert.deepEqual(result, {
      gifs: [
        { id: "abc123", title: "Title abc123", width: 200, height: 150, url: "https://media2.giphy.com/media/abc123/200w.gif", preview: "https://media2.giphy.com/media/abc123/100w.gif" },
        { id: "def456", title: "Title def456", width: 200, height: 150, url: "https://media2.giphy.com/media/def456/200w.gif", preview: "https://media2.giphy.com/media/def456/100w.gif" },
      ],
    });
    assert.equal(seen.length, 1);
    const asked = new URL(seen[0].url);
    assert.equal(`${asked.origin}${asked.pathname}`, "https://api.giphy.com/v1/gifs/trending");
    assert.equal(asked.searchParams.get("rating"), "pg-13");
    assert.equal(asked.searchParams.get("limit"), "24");
    assert.equal(asked.searchParams.get("api_key"), KEY);
    assert.ok(!JSON.stringify(result).includes(KEY), "the key never leaves the server");
    assert.ok(!JSON.stringify(result).includes("cid="), "Giphy tracking query strings are stripped");
  });
});

test("search sends the cleaned phrase, needs one, and is rate limited per person", async () => {
  await withGiphy(async ({ port }, seen) => {
    const alex = await signUp(port);
    const found = await api(port, "GET", "/api/giphy/search?q=%20%20happy%20%20dog%0A", { token: alex.token, status: 200 });
    assert.equal(found.gifs.length, 2);
    const asked = new URL(seen[0].url);
    assert.equal(asked.pathname, "/v1/gifs/search");
    assert.equal(asked.searchParams.get("q"), "happy dog");
    assert.equal(asked.searchParams.get("rating"), "pg-13");

    const long = await api(port, "GET", `/api/giphy/search?q=${"a".repeat(80)}`, { token: alex.token, status: 200 });
    assert.equal(long.gifs.length, 2);
    assert.equal(new URL(seen[1].url).searchParams.get("q")?.length, 50);

    for (const bad of ["/api/giphy/search", "/api/giphy/search?q=", "/api/giphy/search?q=%20%20"]) {
      const refused = await api(port, "GET", bad, { token: alex.token, status: 400 });
      assert.equal(refused.error, "Type something to search for.");
    }
    assert.equal(seen.length, 2, "an empty search never reaches Giphy");

    const bea = await signUp(port, "Bea");
    for (let i = 0; i < 60; i += 1) await api(port, "GET", "/api/giphy/trending", { token: bea.token, status: 200 });
    await api(port, "GET", "/api/giphy/trending", { token: bea.token, status: 429 });
    await api(port, "GET", "/api/giphy/trending", { token: alex.token, status: 200 });
  });
});

test("GIPHY_RATING picks the rating, an unknown one falls back to pg-13, and the default is never r", async () => {
  for (const [asked, expected] of [["g", "g"], ["pg", "pg"], ["r", "r"], ["x-rated", "pg-13"], ["", "pg-13"]] as const) {
    await withGiphy(async ({ port }, seen) => {
      const alex = await signUp(port);
      await api(port, "GET", "/api/giphy/trending", { token: alex.token, status: 200 });
      assert.equal(new URL(seen[0].url).searchParams.get("rating"), expected, `GIPHY_RATING=${asked}`);
    }, { env: { GIPHY_RATING: asked } });
  }
});

test("with no key the GIF routes are not there, the app says so, and a GIF post is refused", async () => {
  for (const env of [{}, { GIPHY_API_KEY: "" }, { GIPHY_API_KEY: "   " }]) {
    await withApp(async ({ port }) => {
      const alex = await signUp(port);
      const meta = await api(port, "GET", "/api/meta", { token: alex.token, status: 200 });
      assert.equal(meta.giphy, false);
      await api(port, "GET", "/api/giphy/trending", { token: alex.token, status: 404 });
      await api(port, "GET", "/api/giphy/search?q=cat", { token: alex.token, status: 404 });
      await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "friends" }, status: 201 });
      const gif = { id: "abc123", title: "x", width: 200, height: 150, url: "https://media2.giphy.com/media/abc123/200w.gif" };
      await api(port, "POST", "/api/circles/chat", { token: alex.token, body: { gif }, status: 404 });
    }, { env });
  }
  await withGiphy(async ({ port }) => {
    const alex = await signUp(port);
    const meta = await api(port, "GET", "/api/meta", { token: alex.token, status: 200 });
    assert.equal(meta.giphy, true);
  });
});

test("a Giphy failure, a bad answer or a timeout is one generic 502 that never carries the key", async () => {
  const failures: Array<[string, GiphyFetch]> = [
    ["http error", async () => ({ ok: false, status: 500, json: async () => ({}) })],
    ["not a list", async () => ({ ok: true, status: 200, json: async () => ({ data: "nope" }) })],
    ["network error", async (url) => { throw new Error(`connect failed for ${url}`); }],
    ["timeout", async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    })],
  ];
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args); };
  const timers = globalThis.setTimeout;
  // Only the 5 second Giphy timeout is shortened. Everything else keeps its real delay.
  globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) =>
    timers(fn, ms === 5000 ? 20 : ms, ...rest)) as typeof setTimeout;
  try {
    for (const [name, fetcher] of failures) {
      await withGiphy(async ({ port }) => {
        const alex = await signUp(port);
        const result = await api(port, "GET", "/api/giphy/trending", { token: alex.token, status: 502 });
        assert.equal(result.error, "GIFs are unavailable right now.", name);
        assert.ok(!JSON.stringify(result).includes(KEY), name);
      }, { fetcher });
    }
  } finally {
    console.error = original;
    globalThis.setTimeout = timers;
  }
  assert.ok(!JSON.stringify(logged).includes(KEY), "the log never has the key");
  assert.ok(!JSON.stringify(logged).includes("connect failed"), "the log has the error name only");
});

test("results with a non-Giphy or non-https image are dropped, and no test reached the real Giphy", async () => {
  const data = [
    entry("good1"),
    { ...entry("evil1"), images: { fixed_width: { url: "https://evil.example/x.gif", width: "200", height: "150" }, fixed_width_small: image("evil1/100w.gif") } },
    { ...entry("plain1"), images: { fixed_width: { url: "http://media1.giphy.com/media/plain1/200w.gif", width: "200", height: "150" }, fixed_width_small: image("plain1/100w.gif") } },
    { id: "bad id!", title: "x", images: entry("z").images },
    entry("good2"),
  ];
  await withGiphy(async ({ port }) => {
    const alex = await signUp(port);
    const result = await api(port, "GET", "/api/giphy/trending", { token: alex.token, status: 200 });
    assert.deepEqual(result.gifs.map((item: { id: string }) => item.id), ["good1", "good2"]);
  }, { data });
  assert.deepEqual(outside, [], "nothing left the machine");
});
