import assert from "node:assert/strict";
import test from "node:test";
import { getPlan, getSocial } from "../src/db.js";
import { planPayload, socialPayload } from "../src/social/payload.js";
import { api, START, withApp, testEmail } from "./http.js";

type Person = { token: string; user: { id: string; name: string } };
type Entry = { id: string; weroEmail?: string | null };

const WERO = "alex.wero@example.com";
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
const patch = (port: number, token: string, body: object, status = 200) => api(port, "PATCH", "/api/me", { token, body, status });

test("PATCH /api/me sets, reads back, rejects bad values and clears the Wero email", async () => {
  await withApp(async ({ port, db }) => {
    const { alex } = await seed(port);
    assert.equal((await api(port, "GET", "/api/me", { token: alex.token, status: 200 })).user.weroEmail, null);

    const set = await patch(port, alex.token, { weroEmail: `  Alex.Wero@Example.com ` });
    assert.equal(set.user.weroEmail, WERO);
    assert.equal((await api(port, "GET", "/api/me", { token: alex.token, status: 200 })).user.weroEmail, WERO);

    for (const weroEmail of ["not-an-email", "a b@example.com", "a@example", 42, null, `${"a".repeat(250)}@x.co`]) {
      const bad = await patch(port, alex.token, { name: "Changed", paymentUrl: LINK, weroEmail }, 400);
      assert.equal(bad.error, "Enter a valid email");
    }
    const after = await api(port, "GET", "/api/me", { token: alex.token, status: 200 });
    assert.equal(after.user.weroEmail, WERO, "unchanged");
    assert.equal(after.user.name, "Alex", "a bad Wero email does not write the name");
    assert.equal(after.user.paymentUrl, null, "a bad Wero email does not write the payment link");

    const cleared = await patch(port, alex.token, { weroEmail: "" });
    assert.equal(cleared.user.weroEmail, null);
    const row = db.prepare("SELECT wero_email AS email FROM users WHERE id = ?").get(alex.user.id) as { email: string | null };
    assert.equal(row.email, null);
  });
});

test("Wero email and payment link are independent, and renaming keeps both", async () => {
  await withApp(async ({ port }) => {
    const { alex } = await seed(port);
    const wero = await patch(port, alex.token, { weroEmail: WERO });
    assert.equal(wero.user.name, "Alex", "sending only the Wero email keeps the name");
    assert.equal(wero.user.paymentUrl, null);

    const link = await patch(port, alex.token, { paymentUrl: LINK });
    assert.equal(link.user.paymentUrl, LINK);
    assert.equal(link.user.weroEmail, WERO, "setting the link keeps the Wero email");

    const renamed = await patch(port, alex.token, { name: "Alexa" });
    assert.equal(renamed.user.weroEmail, WERO, "renaming keeps the Wero email");
    assert.equal(renamed.user.paymentUrl, LINK);

    const both = await patch(port, alex.token, { paymentUrl: "", weroEmail: "other@example.com" });
    assert.equal(both.user.paymentUrl, null);
    assert.equal(both.user.weroEmail, "other@example.com");

    const noWero = await patch(port, alex.token, { paymentUrl: LINK });
    assert.equal(noWero.user.weroEmail, "other@example.com", "clearing the link elsewhere never clears it");
    await patch(port, alex.token, {}, 400);
  });
});

test("the Wero email may equal the login email and is never copied from it", async () => {
  await withApp(async ({ port }) => {
    const email = testEmail();
    const dan = await api(port, "POST", "/api/auth/start", { body: { email, name: "Dan" }, status: 201 });
    assert.equal((await api(port, "GET", "/api/me", { token: dan.token, status: 200 })).user.weroEmail, null);
    const same = await patch(port, dan.token, { weroEmail: email });
    assert.equal(same.user.weroEmail, email.toLowerCase());
  });
});

test("circle mates see the Wero email on members and events; others never do", async () => {
  await withApp(async ({ port, db }) => {
    const { alex, bea, cam, sam } = await seed(port);
    await patch(port, alex.token, { weroEmail: WERO });

    const beaMe = await api(port, "GET", "/api/me", { token: bea.token, status: 200 });
    assert.equal(find(beaMe.circle.members, alex.user.id)?.weroEmail, WERO);
    assert.equal(find(beaMe.circle.members, bea.user.id)?.weroEmail, null);

    const plan = (await api(port, "POST", "/api/plans", { token: alex.token, body: { note: "Dinner" }, status: 201 })).plan;
    await api(port, "POST", `/api/plans/${plan.id}/join`, { token: bea.token, status: 200 });
    const social = (await api(port, "POST", "/api/socials", { token: bea.token, body: { note: "Coffee" }, status: 201 })).social;
    await api(port, "POST", `/api/socials/${social.id}/join`, { token: alex.token, status: 200 });

    const plans = (await api(port, "GET", "/api/plans", { token: bea.token, status: 200 })).plans;
    assert.equal(plans[0].creator.weroEmail, WERO);
    const socials = (await api(port, "GET", "/api/socials", { token: bea.token, status: 200 })).socials;
    assert.equal(socials[0].creator.weroEmail, null);
    assert.equal(find(socials[0].joined, alex.user.id)?.weroEmail, WERO, "joined entry on a social");
    const joinedPlan = (await api(port, "GET", "/api/plans", { token: alex.token, status: 200 })).plans[0];
    assert.equal(find(joinedPlan.joined, bea.user.id)?.weroEmail, null);
    await patch(port, bea.token, { weroEmail: "bea@example.com" });
    const seen = (await api(port, "GET", "/api/plans", { token: alex.token, status: 200 })).plans[0];
    assert.equal(find(seen.joined, bea.user.id)?.weroEmail, "bea@example.com");

    // Cam is in another circle and Sam in none: never, on any payload.
    for (const person of [cam, sam]) {
      for (const path of ["/api/me", "/api/plans", "/api/socials"]) {
        const text = JSON.stringify((await api(port, "GET", path, { token: person.token })) ?? {});
        assert.equal(text.includes(WERO) || text.includes("bea@example.com"), false, `${person.user.name} ${path}`);
      }
    }
    // Even asking the payload builders for an event as an outsider, or with no viewer, gives null.
    for (const viewer of [cam.user.id, sam.user.id, null]) {
      const direct = socialPayload(db, getSocial(db, social.id)!, viewer, START);
      assert.equal(find(direct.joined, alex.user.id)?.weroEmail, null, String(viewer));
      const directPlan = planPayload(db, getPlan(db, plan.id)!, "2026-06-01", viewer, START);
      assert.equal(directPlan.creator.weroEmail, null, String(viewer));
      assert.equal(JSON.stringify(directPlan).includes(WERO), false);
    }
    await api(port, "GET", "/api/me", { status: 401 });
  });
});
