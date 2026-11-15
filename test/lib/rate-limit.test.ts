import assert from "node:assert/strict";
import type http from "node:http";
import test from "node:test";
import { adminFailureKey } from "../../src/admin/admin-query.js";
import { ACK_LIMIT } from "../../src/app.js";
import { clientKey } from "../../src/lib/client-key.js";
import { createRateLimiter } from "../../src/lib/rate-limit.js";
import { api, withApp } from "../http.js";

test("a key goes over the limit inside one window and resets in the next", () => {
  const limiter = createRateLimiter({ limit: 3, windowMs: 1000 });
  assert.deepEqual([1, 2, 3, 4].map(() => limiter.hit("a", 0)), [true, true, true, false]);
  assert.equal(limiter.hit("b", 500), true);
  assert.equal(limiter.hit("a", 999), false);
  assert.equal(limiter.hit("a", 1000), true);
});

test("expired keys are pruned and live keys stay under the cap", () => {
  const limiter = createRateLimiter({ limit: 1, windowMs: 1000, maxKeys: 50 });
  for (let i = 0; i < 40; i += 1) limiter.hit(`old-${i}`, 0);
  assert.equal(limiter.size(), 40);
  limiter.hit("fresh", 1000);
  assert.equal(limiter.size(), 1);
  for (let i = 0; i < 200; i += 1) limiter.hit(`flood-${i}`, 1500);
  assert.ok(limiter.size() <= 50);
});

test("push acks past the limit get 429 until the window resets", async () => {
  const log = console.log;
  console.log = () => {};
  try {
    await withApp(async (ctx) => {
      const real = "00000000-0000-4000-8000-000000000000";
      for (let i = 0; i < ACK_LIMIT.limit; i += 1) {
        await api(ctx, "POST", "/api/push/ack", { body: { id: real }, status: 204 });
      }
      await api(ctx, "POST", "/api/push/ack", { body: { id: real }, status: 429 });
      await api(ctx, "POST", "/api/push/ack", { body: { id: "nope" }, status: 429 });
      ctx.advance(ACK_LIMIT.windowMs);
      await api(ctx, "POST", "/api/push/ack", { body: { id: real }, status: 204 });
      // Other routes do not share the ack budget.
      await api(ctx, "GET", "/api/health", { status: 200 });
    });
  } finally {
    console.log = log;
  }
});

function fakeRequest(forwarded: string | string[] | undefined, remote = "10.0.0.1"): http.IncomingMessage {
  return { headers: forwarded === undefined ? {} : { "x-forwarded-for": forwarded }, socket: { remoteAddress: remote } } as unknown as http.IncomingMessage;
}

test("the client key is the rightmost forwarded hop, else the socket", () => {
  assert.equal(clientKey(fakeRequest("203.0.113.9, 198.51.100.10")), "198.51.100.10");
  assert.equal(clientKey(fakeRequest("198.51.100.10")), "198.51.100.10");
  // Several header lines are one list, so the last line's last hop is the proxy's.
  assert.equal(clientKey(fakeRequest(["198.51.100.11", "203.0.113.1"])), "203.0.113.1");
  assert.equal(clientKey(fakeRequest(undefined)), "10.0.0.1");
  assert.equal(clientKey(fakeRequest(" , ")), "10.0.0.1");
  assert.equal(clientKey(fakeRequest("a/b")), "10.0.0.1");
  for (const value of ["203.0.113.9, 198.51.100.10", undefined, "x".repeat(200)]) {
    assert.equal(adminFailureKey(fakeRequest(value)), clientKey(fakeRequest(value)));
  }
});

test("acks behind the proxy get one bucket per rightmost hop, and a spoofed left hop is ignored", async () => {
  const log = console.log;
  console.log = () => {};
  try {
    await withApp(async (ctx) => {
      const id = "00000000-0000-4000-8000-000000000000";
      const ack = async (forwarded: string) => {
        const response = await fetch(`http://127.0.0.1:${ctx.port}/api/push/ack`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": forwarded },
          body: JSON.stringify({ id }),
        });
        await response.text();
        return response.status;
      };
      for (let i = 0; i < ACK_LIMIT.limit; i += 1) {
        assert.equal(await ack("198.51.100.10"), 204);
      }
      assert.equal(await ack("198.51.100.10"), 429);
      // The caller controls everything left of the proxy's hop. That is still the same client.
      assert.equal(await ack("203.0.113.77, 198.51.100.10"), 429);
      assert.equal(await ack("1.2.3.4, 5.6.7.8, 198.51.100.10"), 429);
      // A different client behind the same proxy has its own budget.
      assert.equal(await ack("198.51.100.20"), 204);
      assert.equal(await ack("198.51.100.10, 198.51.100.20"), 204);
      ctx.advance(ACK_LIMIT.windowMs);
      assert.equal(await ack("198.51.100.10"), 204);
    });
  } finally {
    console.log = log;
  }
});

test("the ack limit leaves room for a phone flushing a backlog", () => {
  assert.equal(ACK_LIMIT.limit, 120);
  assert.equal(ACK_LIMIT.windowMs, 60_000);
});
