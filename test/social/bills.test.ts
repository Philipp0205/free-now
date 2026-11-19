import assert from "node:assert/strict";
import test from "node:test";
import { type PaymentPayload } from "../../src/social/payments.js";
import { billShare } from "../../src/social/bills.js";
import { api, testEmail, withApp } from "../http.js";

// Fake people only.

type Member = PaymentPayload["members"][number];

function member(id: string, options: { collector?: boolean; paid?: boolean } = {}): Member {
  return { id, name: id.toUpperCase(), collector: Boolean(options.collector), paid: Boolean(options.paid), setBy: null, setByName: null, at: null };
}

function payment(members: Member[], priceCents = 1000): PaymentPayload {
  const collector = members.find((item) => item.collector) ?? members[0];
  return {
    priceCents,
    amount: (priceCents / 100).toFixed(2),
    currency: "EUR",
    collector: { id: collector.id, name: collector.name, paypalUrl: null, weroEmail: null },
    members,
  };
}

test("billShare: a going member who has not paid owes the price", () => {
  const pay = payment([member("alex", { collector: true }), member("bea"), member("sam", { paid: true })]);
  assert.deepEqual(billShare(pay, "bea"), { side: "owe", cents: 1000 });
  assert.equal(billShare(pay, "sam"), null, "paid is settled");
});

test("billShare: the collector is owed price times unpaid members", () => {
  const pay = payment([member("alex", { collector: true }), member("bea"), member("sam"), member("kim", { paid: true })], 750);
  assert.deepEqual(billShare(pay, "alex"), {
    side: "owed",
    cents: 1500,
    unpaid: [{ id: "bea", name: "BEA" }, { id: "sam", name: "SAM" }],
  });
});

test("billShare: nothing when everyone has paid, when there is no price, or when the viewer is not going", () => {
  const settled = payment([member("alex", { collector: true }), member("bea", { paid: true })]);
  assert.equal(billShare(settled, "alex"), null);
  assert.equal(billShare(settled, "bea"), null);
  assert.equal(billShare(null, "alex"), null);
  assert.equal(billShare(payment([member("alex", { collector: true }), member("bea")]), "zed"), null);
});

test("billShare: an organizer who is not the collector owes like anyone else", () => {
  const pay = payment([member("alex"), member("bea", { collector: true, paid: true }), member("sam")]);
  assert.deepEqual(billShare(pay, "alex"), { side: "owe", cents: 1000 });
  assert.deepEqual(billShare(pay, "bea"), { side: "owed", cents: 2000, unpaid: [{ id: "alex", name: "ALEX" }, { id: "sam", name: "SAM" }] });
});

type Person = { token: string; user: { id: string } };

async function start(port: number, name: string, code?: string): Promise<Person> {
  return api(port, "POST", "/api/auth/start", { body: { email: testEmail(), name, ...(code ? { code } : {}) }, status: 201 });
}

/** Alex, Bea and Sam in Friends. Cleo and Dan in Work. Alex is in both. */
async function twoCircles(port: number) {
  const alex = await start(port, "Alex");
  const friends = (await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "Friends" }, status: 201 })).circle;
  const bea = await start(port, "Bea", friends.inviteCode);
  const sam = await start(port, "Sam", friends.inviteCode);
  const cleo = await start(port, "Cleo");
  const work = (await api(port, "POST", "/api/circles", { token: cleo.token, body: { name: "Work" }, status: 201 })).circle;
  const dan = await start(port, "Dan", work.inviteCode);
  await api(port, "POST", "/api/circles/join", { token: alex.token, body: { code: work.inviteCode }, status: 200 });
  return { alex, bea, sam, cleo, dan, friends: friends as { id: string }, work: work as { id: string } };
}

const bills = (port: number, token: string) => api(port, "GET", "/api/bills", { token, status: 200 });

/** Alex hosts Ramen in Friends at 10.00 with Bea and Sam in. Cleo hosts Climbing in Work at 8.00 with Alex and Dan in. */
async function seedBills(port: number) {
  const people = await twoCircles(port);
  const { alex, bea, sam, cleo, dan, friends, work } = people;
  const ramen = (await api(port, "POST", `/api/socials?circle=${friends.id}`, { token: alex.token, body: { note: "Ramen" }, status: 201 })).social;
  await api(port, "PATCH", `/api/socials/${ramen.id}?circle=${friends.id}`, { token: alex.token, body: { price: "10" }, status: 200 });
  for (const person of [bea, sam]) await api(port, "POST", `/api/socials/${ramen.id}/join`, { token: person.token, status: 200 });
  const climbing = (await api(port, "POST", "/api/plans", { token: cleo.token, body: { note: "Climbing", date: "2026-06-02" }, status: 201 })).plan;
  await api(port, "PATCH", `/api/plans/${climbing.id}`, { token: cleo.token, body: { price: "8" }, status: 200 });
  await api(port, "POST", `/api/plans/${climbing.id}/join?circle=${work.id}`, { token: alex.token, status: 200 });
  await api(port, "POST", `/api/plans/${climbing.id}/join`, { token: dan.token, status: 200 });
  // Priced nothing: Alex's plain plan must stay out of the bills.
  const walk = (await api(port, "POST", `/api/plans?circle=${friends.id}`, { token: alex.token, body: { note: "Walk", date: "2026-06-02" }, status: 201 })).plan;
  await api(port, "POST", `/api/plans/${walk.id}/join`, { token: bea.token, status: 200 });
  return { ...people, ramen: ramen.id as string, climbing: climbing.id as string, walk: walk.id as string };
}

test("bills: one call adds up what I owe and what I am owed across two circles", async () => {
  await withApp(async ({ port }) => {
    const { alex, bea, sam, cleo, dan, friends, work, ramen, climbing, walk } = await seedBills(port);

    const mine = await bills(port, alex.token);
    assert.equal(mine.currency, "EUR");
    assert.deepEqual(mine.totals, { oweCents: 800, owedCents: 2000, owe: "8.00", owed: "20.00" });
    assert.deepEqual(mine.owe.map((bill: { id: string }) => bill.id), [climbing]);
    assert.deepEqual(mine.owed.map((bill: { id: string }) => bill.id), [ramen]);
    const owe = mine.owe[0];
    assert.equal(owe.kind, "plan");
    assert.equal(owe.title, "Climbing");
    assert.equal(owe.circleId, work.id);
    assert.equal(owe.circleName, "Work");
    assert.equal(owe.collector.name, "Cleo");
    assert.equal(owe.amount, "8.00");
    assert.equal(owe.event.payment.amount, "8.00", "the full event rides along for the detail sheet");
    const owed = mine.owed[0];
    assert.equal(owed.kind, "social");
    assert.equal(owed.circleId, friends.id);
    assert.equal(owed.amount, "20.00");
    assert.deepEqual(owed.unpaid.map((person: { name: string }) => person.name).sort(), ["Bea", "Sam"]);
    assert.ok(![...mine.owe, ...mine.owed].some((bill: { id: string }) => bill.id === walk), "an event without a price is not a bill");

    const beas = await bills(port, bea.token);
    assert.deepEqual(beas.totals, { oweCents: 1000, owedCents: 0, owe: "10.00", owed: "0.00" });
    assert.deepEqual(beas.owe.map((bill: { id: string }) => bill.id), [ramen]);
    assert.deepEqual((await bills(port, sam.token)).totals.oweCents, 1000);

    const cleos = await bills(port, cleo.token);
    assert.deepEqual(cleos.totals, { oweCents: 0, owedCents: 1600, owe: "0.00", owed: "16.00" });
    assert.deepEqual((await bills(port, dan.token)).owe.map((bill: { id: string }) => bill.id), [climbing]);
  });
});

test("bills: someone in no circle gets an empty list, and a missing token is a 401", async () => {
  await withApp(async ({ port }) => {
    const loner = await start(port, "Kim");
    const empty = await bills(port, loner.token);
    assert.deepEqual(empty, { currency: "EUR", owe: [], owed: [], totals: { oweCents: 0, owedCents: 0, owe: "0.00", owed: "0.00" } });
    await api(port, "GET", "/api/bills", { status: 401 });
  });
});

test("bills: marking paid goes through the paid endpoints and updates both lists", async () => {
  await withApp(async ({ port }) => {
    const { alex, bea, sam, dan, ramen, climbing } = await seedBills(port);
    const mine = await bills(port, alex.token);
    const climbingBill = mine.owe[0];
    const ramenBill = mine.owed[0];

    // Alex is in two circles, so the paid call must name one. The bill carries it.
    await api(port, "POST", `/api/plans/${climbing}/paid`, { token: alex.token, body: { paid: true }, status: 400 });
    await api(port, "POST", `/api/plans/${climbing}/paid?circle=${climbingBill.circleId}`, { token: alex.token, body: { paid: true }, status: 200 });
    await api(port, "POST", `/api/socials/${ramen}/paid?circle=${ramenBill.circleId}`, { token: alex.token, body: { userId: bea.user.id, paid: true }, status: 200 });

    const after = await bills(port, alex.token);
    assert.deepEqual(after.totals, { oweCents: 0, owedCents: 1000, owe: "0.00", owed: "10.00" });
    assert.deepEqual(after.owe, [], "a paid share leaves the list");
    assert.deepEqual(after.owed[0].unpaid.map((person: { name: string }) => person.name), ["Sam"]);
    assert.deepEqual((await bills(port, bea.token)).owe, []);

    // The paid state agrees with the circle's own list.
    const listed = await api(port, "GET", "/api/socials?all=1", { token: alex.token, status: 200 });
    const row = listed.socials.find((item: { id: string }) => item.id === ramen);
    const states = row.payment.members.map((item: { name: string; paid: boolean }) => [item.name, item.paid]).sort();
    assert.deepEqual(states, [["Alex", false], ["Bea", true], ["Sam", false]]);
    assert.equal(after.owed[0].event.payment.members.find((item: { id: string }) => item.id === bea.user.id).paid, true);

    // Sam pays himself, and the last share settles the event out of the list.
    await api(port, "POST", `/api/socials/${ramen}/paid`, { token: sam.token, body: { paid: true }, status: 200 });
    assert.deepEqual(await bills(port, alex.token), { currency: "EUR", owe: [], owed: [], totals: { oweCents: 0, owedCents: 0, owe: "0.00", owed: "0.00" } });

    // Ticks the person is not allowed to make still fail, and a stranger cannot reach the event.
    await api(port, "POST", `/api/socials/${ramen}/paid`, { token: sam.token, body: { userId: bea.user.id, paid: false }, status: 403 });
    await api(port, "POST", `/api/socials/${ramen}/paid`, { token: dan.token, body: { userId: bea.user.id, paid: false }, status: 404 });
    assert.equal((await bills(port, alex.token)).totals.owedCents, 0, "the refused ticks changed nothing");
  });
});

test("bills: a bystander tick is refused and leaves the bills alone", async () => {
  await withApp(async ({ port }) => {
    const { alex, bea, sam, ramen } = await seedBills(port);
    await api(port, "POST", `/api/socials/${ramen}/paid`, { token: sam.token, body: { userId: bea.user.id, paid: true }, status: 403 });
    assert.equal((await bills(port, alex.token)).totals.owedCents, 2000);
    assert.equal((await bills(port, bea.token)).totals.oweCents, 1000);
  });
});

test("bills: past and ended events stay listed until everyone has paid", async () => {
  await withApp(async ({ port, advance }) => {
    const { alex, bea, friends, ramen, climbing } = await seedBills(port);
    const day = 24 * 60 * 60 * 1000;
    advance(5 * day);

    const listed = await api(port, "GET", "/api/socials?all=1", { token: alex.token, status: 200 });
    assert.ok(!listed.socials.some((item: { id: string }) => item.id === ramen), "the social is over and out of the live list");
    const plans = await api(port, "GET", "/api/plans?all=1", { token: alex.token, status: 200 });
    assert.ok(!plans.plans.some((item: { id: string }) => item.id === climbing), "the plan is in the past and out of the live list");

    const mine = await bills(port, alex.token);
    assert.deepEqual(mine.totals, { oweCents: 800, owedCents: 2000, owe: "8.00", owed: "20.00" });
    assert.deepEqual(mine.owe.map((bill: { id: string }) => bill.id), [climbing]);
    assert.deepEqual(mine.owed.map((bill: { id: string }) => bill.id), [ramen]);

    // Paying after the event is still allowed.
    await api(port, "POST", `/api/socials/${ramen}/paid?circle=${friends.id}`, { token: alex.token, body: { userId: bea.user.id, paid: true }, status: 200 });
    assert.equal((await bills(port, alex.token)).totals.owedCents, 1000);
  });
});

test("bills: an ended plan keeps its open shares", async () => {
  await withApp(async ({ port }) => {
    const { cleo, dan, climbing } = await seedBills(port);
    await api(port, "DELETE", `/api/plans/${climbing}`, { token: cleo.token, status: 204 });
    assert.equal((await bills(port, cleo.token)).totals.owedCents, 1600);
    assert.equal((await bills(port, dan.token)).totals.oweCents, 800);
  });
});

test("bills: owed to me means the effective collector, and the organizer owes when someone else collects", async () => {
  await withApp(async ({ port }) => {
    const { alex, bea, sam, friends, ramen } = await seedBills(port);
    await api(port, "POST", `/api/socials/${ramen}/paid`, { token: bea.token, body: { paid: true }, status: 200 });
    await api(port, "PATCH", `/api/socials/${ramen}?circle=${friends.id}`, { token: alex.token, body: { collectorId: bea.user.id }, status: 200 });

    const organizer = await bills(port, alex.token);
    assert.deepEqual(organizer.owed, [], "Alex hosts it but no longer collects");
    assert.ok(organizer.owe.some((bill: { id: string }) => bill.id === ramen), "Alex owes the new collector");
    assert.equal(organizer.owe.find((bill: { id: string }) => bill.id === ramen).collector.name, "Bea");

    const collector = await bills(port, bea.token);
    assert.deepEqual(collector.owe, []);
    assert.equal(collector.totals.owedCents, 2000, "Bea is owed by Alex and Sam");
    assert.deepEqual(collector.owed[0].unpaid.map((person: { name: string }) => person.name).sort(), ["Alex", "Sam"]);
    assert.equal((await bills(port, sam.token)).owe[0].collector.name, "Bea");
  });
});
