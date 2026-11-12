import assert from "node:assert/strict";
import test from "node:test";
import { api, withApp } from "../http.js";

test("a plan keeps an optional time and a cleared pin drops the coordinates", async () => {
  await withApp(async ({ port, sent }) => {
    const alex = await api(port, "POST", "/api/auth/start", { body: { name: "Alex" }, status: 201 });
    const created = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "friends" }, status: 201 });
    const sam = await api(port, "POST", "/api/auth/start", { body: { name: "Sam", code: created.circle.inviteCode }, status: 201 });
    await api(port, "POST", "/api/push/subscribe", {
      token: sam.token,
      body: { endpoint: "https://push.example/sam", keys: { p256dh: "p", auth: "a" } },
      status: 204,
    });

    const timed = await api(port, "POST", "/api/plans", {
      token: alex.token,
      body: { note: "Dinner", place: "Kitchen", time: "19:00" },
      status: 201,
    });
    assert.equal(timed.plan.time, "19:00");
    assert.equal(sent[0]?.payload.body, "Alex: Dinner · 19:00 · Kitchen");

    const plain = await api(port, "POST", "/api/plans", { token: alex.token, body: { note: "Walk" }, status: 201 });
    assert.equal(plain.plan.time, null);
    assert.equal(sent[1]?.payload.body, "Alex: Walk");

    const late = await api(port, "POST", "/api/plans", { token: alex.token, body: { note: "Nope", time: "25:99" }, status: 400 });
    assert.equal(late.error, "Pick a valid time, like 19:30");
    const words = await api(port, "POST", "/api/plans", { token: alex.token, body: { note: "Nope", time: "evening" }, status: 400 });
    assert.equal(words.error, "Pick a valid time, like 19:30");

    const pinned = await api(port, "POST", "/api/plans", {
      token: alex.token,
      body: { note: "Climb", place: "Gym", lat: 48.7674, lng: 9.1708, precise: true },
      status: 201,
    });
    assert.equal(pinned.plan.location.lat, 48.7674);
    assert.equal(pinned.plan.location.lng, 9.1708);
    const cleared = await api(port, "PATCH", `/api/plans/${pinned.plan.id}`, {
      token: alex.token,
      body: { place: "Somewhere", lat: null, lng: null },
      status: 200,
    });
    assert.equal(cleared.plan.place, "Somewhere");
    assert.equal(cleared.plan.location, null);
    assert.equal(cleared.plan.time, null);

    const social = await api(port, "POST", "/api/socials", {
      token: alex.token,
      body: { note: "Coffee", place: "Cafe", lat: 48.7674, lng: 9.1708, precise: true },
      status: 201,
    });
    assert.ok(social.social.location);
    const moved = await api(port, "PATCH", `/api/socials/${social.social.id}`, {
      token: alex.token,
      body: { place: "Park", lat: null, lng: null },
      status: 200,
    });
    assert.equal(moved.social.place, "Park");
    assert.equal(moved.social.location, null);
  }, { sent: "envelope" });
});
