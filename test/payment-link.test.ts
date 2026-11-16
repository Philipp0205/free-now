import assert from "node:assert/strict";
import test from "node:test";
import { getPlan, getSocial } from "../src/db.js";
import { planPayload, socialPayload } from "../src/social/payload.js";
import { api, START, withApp, testEmail } from "./http.js";

type Person = { token: string; user: { id: string; name: string } };
type Entry = { id: string; paymentUrl?: string | null };

const LINK = "https://paypal.me/hangryfriend";

/** Friends: Alex, Bea. Climbing: Cam. Sam is in no circle. */
async function seed(port: number) {
  const start = (name: string, code?: string): Promise<Person> =>
    api(port, "POST", "/api/auth/start", { body: code ? { email: testEmail(), name, code } : { email: testEmail(), name }, status: 201 });
  const alex = await start("Alex");
  const friends = (await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Friends" }, status: 201 })).circle;
  const bea = await start("Bea", friends.inviteCode);
  const cam = await start("Cam");
  await api(port, "POST", "/api/circles", { token: cam.token, body: { name: "Climbing" }, status: 201 });
  const sam = await start("Sam");
  return { alex, bea, cam, sam, friends };
}

const find = (list: Entry[], id: string) => list.find((entry) => entry.id === id);

test("PATCH /api/me sets, reads back, rejects bad values and clears the payment link", async () => {
  await withApp(async ({ port, db }) => {
    const { alex } = await seed(port);
    assert.equal((await api(port, "GET", "/api/me", { token: alex.token, status: 200 })).user.paymentUrl, null);

    const set = await api(port, "PATCH", "/api/me", { token: alex.token, body: { name: "Alex", paymentUrl: `  ${LINK}  ` }, status: 200 });
    assert.equal(set.user.paymentUrl, LINK);
    assert.equal((await api(port, "GET", "/api/me", { token: alex.token, status: 200 })).user.paymentUrl, LINK);

    for (const [paymentUrl, error] of [
      ["https://example.com/alex", "Use a paypal.me link, for example https://paypal.me/yourname"],
      ["http://paypal.me/alex", "Links must start with https://"],
      [`https://paypal.me/${"a".repeat(200)}`, "Link is too long"],
      [42, "Use a paypal.me link, for example https://paypal.me/yourname"],
    ] as const) {
      const bad = await api(port, "PATCH", "/api/me", { token: alex.token, body: { name: "Changed", paymentUrl }, status: 400 });
      assert.equal(bad.error, error);
    }
    const after = await api(port, "GET", "/api/me", { token: alex.token, status: 200 });
    assert.equal(after.user.paymentUrl, LINK, "unchanged");
    assert.equal(after.user.name, "Alex", "a rejected request changes nothing");

    const cleared = await api(port, "PATCH", "/api/me", { token: alex.token, body: { paymentUrl: "" }, status: 200 });
    assert.equal(cleared.user.paymentUrl, null);
    const row = db.prepare("SELECT payment_url AS url FROM users WHERE id = ?").get(alex.user.id) as { url: string | null };
    assert.equal(row.url, null);
  });
});

test("renaming does not clear the payment link", async () => {
  await withApp(async ({ port }) => {
    const { alex } = await seed(port);
    await api(port, "PATCH", "/api/me", { token: alex.token, body: { name: "Alex", paymentUrl: LINK }, status: 200 });
    const renamed = await api(port, "PATCH", "/api/me", { token: alex.token, body: { name: "Alexa" }, status: 200 });
    assert.equal(renamed.user.name, "Alexa");
    assert.equal(renamed.user.paymentUrl, LINK);
    const only = await api(port, "PATCH", "/api/me", { token: alex.token, body: { paymentUrl: "https://www.paypal.me/alexa" }, status: 200 });
    assert.equal(only.user.name, "Alexa", "sending only the link keeps the name");
    assert.equal(only.user.paymentUrl, "https://www.paypal.me/alexa");
    await api(port, "PATCH", "/api/me", { token: alex.token, body: {}, status: 400 });
  });
});

test("circle mates see the link on members and events; others never do", async () => {
  await withApp(async ({ port, db }) => {
    const { alex, bea, cam, sam } = await seed(port);
    await api(port, "PATCH", "/api/me", { token: alex.token, body: { paymentUrl: LINK }, status: 200 });

    const beaMe = await api(port, "GET", "/api/me", { token: bea.token, status: 200 });
    assert.equal(find(beaMe.circle.members, alex.user.id)?.paymentUrl, LINK);
    assert.equal(find(beaMe.circle.members, bea.user.id)?.paymentUrl, null);

    const plan = (await api(port, "POST", "/api/plans", { token: alex.token, body: { note: "Dinner" }, status: 201 })).plan;
    await api(port, "POST", `/api/plans/${plan.id}/join`, { token: bea.token, status: 200 });
    const social = (await api(port, "POST", "/api/socials", { token: bea.token, body: { note: "Coffee" }, status: 201 })).social;
    await api(port, "POST", `/api/socials/${social.id}/join`, { token: alex.token, status: 200 });

    const plans = (await api(port, "GET", "/api/plans", { token: bea.token, status: 200 })).plans;
    assert.equal(plans[0].creator.paymentUrl, LINK);
    const socials = (await api(port, "GET", "/api/socials", { token: bea.token, status: 200 })).socials;
    assert.equal(socials[0].creator.paymentUrl, null);
    assert.equal(find(socials[0].joined, alex.user.id)?.paymentUrl, LINK, "joined entry on a social");
    const joinedPlan = (await api(port, "GET", "/api/plans", { token: alex.token, status: 200 })).plans[0];
    assert.equal(find(joinedPlan.joined, bea.user.id)?.paymentUrl, null);
    // The host sees Bea's link once she sets it.
    await api(port, "PATCH", "/api/me", { token: bea.token, body: { paymentUrl: "https://www.paypal.com/paypalme/bea" }, status: 200 });
    const seen = (await api(port, "GET", "/api/plans", { token: alex.token, status: 200 })).plans[0];
    assert.equal(find(seen.joined, bea.user.id)?.paymentUrl, "https://www.paypal.com/paypalme/bea");

    // Cam is in another circle and Sam in none: never, on any payload.
    const camMe = await api(port, "GET", "/api/me", { token: cam.token, status: 200 });
    assert.equal(find(camMe.circle.members, alex.user.id), undefined);
    assert.equal(JSON.stringify(camMe).includes("paypal"), false);
    for (const person of [cam, sam]) {
      for (const path of ["/api/me", "/api/plans", "/api/socials"]) {
        const body = await api(port, "GET", path, { token: person.token });
        assert.equal(JSON.stringify(body ?? {}).includes("paypal"), false, `${person.user.name} ${path}`);
      }
    }
    // Even asking the payload builders for an event as an outsider, or with no viewer, gives null.
    for (const viewer of [cam.user.id, sam.user.id, null]) {
      const direct = socialPayload(db, getSocial(db, social.id)!, viewer, START);
      assert.equal(find(direct.joined, alex.user.id)?.paymentUrl, null, String(viewer));
      const directPlan = planPayload(db, getPlan(db, plan.id)!, "2026-06-01", viewer, START);
      assert.equal(directPlan.creator.paymentUrl, null, String(viewer));
    }
    await api(port, "GET", "/api/me", { status: 401 });
  });
});
