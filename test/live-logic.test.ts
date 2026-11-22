import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LIVE_FRESH_MS, POST_HEARTBEAT_MS, POST_MIN_MOVE_M, POST_MIN_MS,
  canShareLive, freshLive, lastSeenText, seenShort, shouldPost, waitMs,
} from "../public/js/map-places/live-logic.js";
import { LIVE_COPY } from "../public/js/map-places/live-copy.js";

const HERE = { lat: 52.52, lng: 13.405 };
/** About 55 m north of HERE. */
const NEAR = { lat: 52.5205, lng: 13.405 };
/** About 5 m north of HERE. */
const TINY = { lat: 52.520045, lng: 13.405 };

test("the first reading is always posted", () => {
  assert.equal(shouldPost(null, HERE, 1000), true);
});

test("a reading inside the minimum wait is held, however far it moved", () => {
  const last = { ...HERE, at: 10_000 };
  assert.equal(shouldPost(last, NEAR, 10_000 + POST_MIN_MS - 1), false);
});

test("after the wait, a move of tens of metres posts and a tiny move does not", () => {
  const last = { ...HERE, at: 10_000 };
  const later = 10_000 + POST_MIN_MS + 1;
  assert.equal(shouldPost(last, NEAR, later), true);
  assert.equal(shouldPost(last, TINY, later), false);
  assert.ok(POST_MIN_MOVE_M > 5 && POST_MIN_MOVE_M < 55);
});

test("a still phone posts a heartbeat so the pin does not age out", () => {
  const last = { ...HERE, at: 10_000 };
  assert.equal(shouldPost(last, TINY, 10_000 + POST_HEARTBEAT_MS), true);
  assert.ok(POST_HEARTBEAT_MS < LIVE_FRESH_MS);
});

test("waitMs counts down to zero", () => {
  assert.equal(waitMs(null, 5000), 0);
  assert.equal(waitMs({ ...HERE, at: 1000 }, 1000 + 3000), POST_MIN_MS - 3000);
  assert.equal(waitMs({ ...HERE, at: 1000 }, 1000 + POST_MIN_MS + 5), 0);
});

test("freshLive drops the viewer's own point and stale points", () => {
  const now = 1_000_000;
  const list = [
    { id: "me", updatedAt: now },
    { id: "bea", updatedAt: now - 1000 },
    { id: "old", updatedAt: now - LIVE_FRESH_MS - 1 },
  ];
  assert.deepEqual(freshLive(list, "me", now).map((point) => point.id), ["bea"]);
  assert.deepEqual(freshLive(undefined, "me", now), []);
});

test("last seen wording is plain and never implies background tracking", () => {
  const now = 10 * 60_000;
  assert.equal(seenShort(now - 20_000, now), "just now");
  assert.equal(seenShort(now - 2 * 60_000, now), "2m ago");
  assert.equal(lastSeenText(now - 20_000, now), "just now");
  assert.equal(lastSeenText(now - 2 * 60_000, now), "last seen 2m ago");
  assert.equal(seenShort(now + 5000, now), "just now", "a clock a little ahead still reads just now");
});

test("only an event the server sent a live list for can be shared", () => {
  assert.equal(canShareLive({ live: [] }), true);
  assert.equal(canShareLive({}), false);
  assert.equal(canShareLive(null), false);
});

test("the copy says it only works while the app is open and has no em dash", () => {
  assert.match(LIVE_COPY.limit, /Only works while Spontaco is open/);
  assert.match(LIVE_COPY.cardLimit, /only while their Spontaco is open/);
  for (const text of Object.values(LIVE_COPY)) assert.ok(!text.includes("\u2014"), text);
});
