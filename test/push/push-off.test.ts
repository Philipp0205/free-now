import assert from "node:assert/strict";
import test from "node:test";
import { listPushSubs } from "../../src/db.js";
import { api, withApp, testEmail } from "../http.js";

test("after DELETE /api/push/subscribe the phone is gone and gets no more pushes", async () => {
  await withApp(async ({ port, db, sent }) => {
    const alex = await api(port, "POST", "/api/auth/start", { body: { email: testEmail(), name: "Alex" }, status: 201 });
    const created = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "friends" }, status: 201 });
    const bea = await api(port, "POST", "/api/auth/start", { body: { email: testEmail(), name: "Bea", code: created.circle.inviteCode }, status: 201 });
    const endpoint = "https://push.example/bea";
    await api(port, "POST", "/api/push/subscribe", {
      token: bea.token,
      body: { endpoint, keys: { p256dh: "p", auth: "a" } },
      status: 204,
    });

    await api(port, "POST", "/api/socials", { token: alex.token, body: { note: "Coffee" }, status: 201 });
    assert.ok(sent.some((item) => item.endpoint === endpoint), "on: Bea gets the social");

    await api(port, "DELETE", "/api/push/subscribe", { token: bea.token, body: { endpoint }, status: 204 });
    assert.deepEqual(listPushSubs(db, bea.user.id), []);
    const status = await api(port, "POST", "/api/push/status", { token: bea.token, body: { endpoint }, status: 200 });
    assert.equal(status.known, false);

    sent.length = 0;
    await api(port, "POST", "/api/plans", { token: alex.token, body: { note: "Dinner" }, status: 201 });
    await api(port, "POST", "/api/socials", { token: alex.token, body: { note: "Walk" } });
    assert.equal(sent.filter((item) => item.endpoint === endpoint).length, 0);

    await api(port, "POST", "/api/push/subscribe", {
      token: bea.token,
      body: { endpoint, keys: { p256dh: "p", auth: "a" } },
      status: 204,
    });
    sent.length = 0;
    await api(port, "POST", "/api/plans", { token: alex.token, body: { note: "Lunch" }, status: 201 });
    assert.ok(sent.some((item) => item.endpoint === endpoint), "back on: Bea gets pushes again");
  }, { sent: "envelope" });
});
