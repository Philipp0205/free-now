import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDb } from "../../src/db.js";
import { HttpError } from "../../src/lib/http.js";
import { formatCents, paypalAmountUrl, readPriceCents } from "../../src/lib/payment-url.js";
import { canBeCollector, canSetPaid, effectiveCollectorId } from "../../src/social/payments.js";
import { api, withApp, testEmail } from "../http.js";

function badPrice(value: unknown) {
  assert.throws(() => readPriceCents(value), (error) => error instanceof HttpError && error.status === 400, String(value));
}

test("readPriceCents accepts euros with up to 2 decimals and clears on empty", () => {
  assert.equal(readPriceCents(12.5), 1250);
  assert.equal(readPriceCents("12.50"), 1250);
  assert.equal(readPriceCents("12,5"), 1250);
  assert.equal(readPriceCents(" 7 "), 700);
  assert.equal(readPriceCents("0.01"), 1);
  assert.equal(readPriceCents("9999.99"), 999999);
  assert.equal(readPriceCents(null), null);
  assert.equal(readPriceCents(undefined), null);
  assert.equal(readPriceCents(""), null);
  assert.equal(readPriceCents("  "), null);
});

test("readPriceCents rejects zero, negatives, odd decimals, huge and non-numbers", () => {
  for (const value of [0, "0", "0.00", -1, "-5", "12.505", "1e3", "abc", "12.", ".5", "10000", "9999.995", true, {}, [], NaN]) {
    badPrice(value);
  }
});

test("formatCents always has 2 decimals", () => {
  assert.equal(formatCents(1250), "12.50");
  assert.equal(formatCents(1000), "10.00");
  assert.equal(formatCents(5), "0.05");
  assert.equal(formatCents(999999), "9999.99");
});

test("paypalAmountUrl builds the amount link from all three stored forms", () => {
  assert.equal(paypalAmountUrl("https://paypal.me/HangryAlex", 1250), "https://www.paypal.me/HangryAlex/12.50EUR");
  assert.equal(paypalAmountUrl("https://www.paypal.me/HangryAlex", 1000), "https://www.paypal.me/HangryAlex/10.00EUR");
  assert.equal(paypalAmountUrl("https://www.paypal.com/paypalme/HangryAlex", 5), "https://www.paypal.me/HangryAlex/0.05EUR");
});

test("paypalAmountUrl only uses the handle and rejects anything odd", () => {
  assert.equal(paypalAmountUrl("https://paypal.me/Alex/99.00EUR?x=1#y", 1250), "https://www.paypal.me/Alex/12.50EUR");
  for (const stored of [
    null,
    "",
    "not a url",
    "http://paypal.me/Alex",
    "https://user:pw@paypal.me/Alex",
    "https://paypal.me:8443/Alex",
    "https://paypal.me/",
    "https://paypal.me/Alex-Smith",
    "https://paypal.me/" + "a".repeat(21),
    "https://paypal.me.evil.com/Alex",
    "https://example.com/Alex",
    "https://www.paypal.com/Alex",
    "https://www.paypal.com/paypalme/",
  ]) {
    assert.equal(paypalAmountUrl(stored, 1250), null, String(stored));
  }
  assert.equal(paypalAmountUrl("https://paypal.me/Alex", 0), null);
});

test("permission rules for paid ticks and collectors", () => {
  assert.equal(canSetPaid("org", "org", "col", "bea"), true);
  assert.equal(canSetPaid("col", "org", "col", "bea"), true);
  assert.equal(canSetPaid("bea", "org", "col", "bea"), true);
  assert.equal(canSetPaid("sam", "org", "col", "bea"), false);

  const going = [{ id: "org", name: "Alex" }, { id: "bea", name: "Bea" }, { id: "sam", name: "Sam" }];
  assert.equal(canBeCollector("org", "org", going, new Set()), true);
  assert.equal(canBeCollector("bea", "org", going, new Set(["bea"])), true);
  assert.equal(canBeCollector("bea", "org", going, new Set()), false);
  assert.equal(canBeCollector("zed", "org", going, new Set(["zed"])), false);

  assert.equal(effectiveCollectorId({ creator_id: "org", collector_id: null }, going), "org");
  assert.equal(effectiveCollectorId({ creator_id: "org", collector_id: "bea" }, going), "bea");
  assert.equal(effectiveCollectorId({ creator_id: "org", collector_id: "gone" }, going), "org");
});

test("migration adds the columns and table to an old database and leaves users alone", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hangry-pay-"));
  const file = path.join(dir, "old.db");
  try {
    // A real current schema with the new pieces taken away is what an old database looks like.
    const old = openDb(file);
    for (const table of ["plans", "socials"]) {
      old.exec(`ALTER TABLE ${table} DROP COLUMN price_cents; ALTER TABLE ${table} DROP COLUMN collector_id;`);
    }
    old.exec("DROP TABLE event_payments");
    const usersBefore = (old.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>).map((column) => column.name);
    old.close();
    const db = openDb(file);
    const columns = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string; notnull: number }>);
    for (const table of ["plans", "socials"]) {
      const price = columns(table).find((column) => column.name === "price_cents");
      const collector = columns(table).find((column) => column.name === "collector_id");
      assert.deepEqual([price?.type, price?.notnull], ["INTEGER", 0], table);
      assert.deepEqual([collector?.type, collector?.notnull], ["TEXT", 0], table);
    }
    assert.deepEqual(
      columns("event_payments").map((column) => column.name),
      ["kind", "event_id", "user_id", "set_by", "set_at"],
    );
    assert.deepEqual(columns("users").map((column) => column.name), usersBefore);
    for (const added of ["price_cents", "collector_id", "paid", "price"]) {
      assert.equal(columns("users").some((column) => column.name === added), false, `users.${added}`);
    }
    db.close();
    openDb(file).close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function circle(port: number) {
  const alex = await api(port, "POST", "/api/auth/start", { body: { email: testEmail(), name: "Alex" }, status: 201 });
  const created = await api(port, "POST", "/api/circles", { token: alex.token, body: { name: "friends" }, status: 201 });
  const join = (name: string) =>
    api(port, "POST", "/api/auth/start", { body: { email: testEmail(), name, code: created.circle.inviteCode }, status: 201 });
  const bea = await join("Bea");
  const sam = await join("Sam");
  const kim = await join("Kim");
  // Kim is a circle admin but not the organizer.
  await api(port, "POST", `/api/circles/members/${kim.user.id}`, { token: alex.token, body: { admin: true }, status: 200 });
  return { alex, bea, sam, kim };
}

for (const kind of ["plans", "socials"] as const) {
  const one = kind === "plans" ? "plan" : "social";

  test(`${kind}: price, collector and paid ticks over the API`, async () => {
    await withApp(async ({ port }) => {
      const { alex, bea, sam, kim } = await circle(port);
      await api(port, "PATCH", "/api/me", {
        token: bea.token,
        body: { paymentUrl: "https://paypal.me/HangryBea", weroEmail: "bea@example.com" },
        status: 200,
      });
      const made = await api(port, "POST", `/api/${kind}`, { token: alex.token, body: { note: "Pizza" }, status: 201 });
      const id = made[one].id;
      assert.equal(made[one].payment, null);
      const patch = (token: string, body: Record<string, unknown>, status = 200) =>
        api(port, "PATCH", `/api/${kind}/${id}`, { token, body, status });
      const paid = (token: string, body: Record<string, unknown>, status = 200) =>
        api(port, "POST", `/api/${kind}/${id}/paid`, { token, body, status });
      for (const person of [bea, sam]) await api(port, "POST", `/api/${kind}/${id}/join`, { token: person.token, status: 200 });

      // No price yet: nothing to tick.
      await paid(alex.token, { userId: bea.user.id, paid: true }, 400);

      // Validation, organizer only.
      await patch(alex.token, { price: "12.505" }, 400);
      await patch(alex.token, { price: 0 }, 400);
      await patch(alex.token, { price: "10000" }, 400);
      await patch(kim.token, { price: 5 }, 403);
      await patch(bea.token, { collectorId: bea.user.id }, 403);
      await patch(alex.token, { collectorId: bea.user.id }, 400);

      // A rejected price leaves the rest of the edit unsaved.
      await patch(alex.token, { note: "Nope", price: "-1" }, 400);
      const same = await api(port, "GET", `/api/${kind}`, { token: alex.token, status: 200 });
      assert.equal(same[kind].find((item: { id: string }) => item.id === id).note, "Pizza");

      const set = await patch(alex.token, { price: "12,50" });
      assert.equal(set[one].payment.priceCents, 1250);
      assert.equal(set[one].payment.amount, "12.50");
      assert.equal(set[one].payment.currency, "EUR");
      assert.equal(set[one].payment.collector.id, alex.user.id);
      assert.equal(set[one].payment.members[0].name, "Alex");
      assert.deepEqual(set[one].payment.members.map((member: { name: string }) => member.name).sort(), ["Alex", "Bea", "Sam"]);

      // Admin Kim is not the organizer and cannot change it, but can still read it.
      const seen = await api(port, "GET", `/api/${kind}`, { token: kim.token, status: 200 });
      assert.equal(seen[kind].find((item: { id: string }) => item.id === id).payment.amount, "12.50");

      // Ticks: organizer, self, and not a stranger to the row.
      await paid(sam.token, { userId: bea.user.id, paid: true }, 403);
      await paid(kim.token, { userId: bea.user.id, paid: true }, 403);
      await paid(alex.token, { userId: alex.user.id, paid: true }, 400);
      await paid(alex.token, { userId: kim.user.id, paid: true }, 400);
      await paid(alex.token, { userId: bea.user.id }, 400);
      const ticked = await paid(alex.token, { userId: bea.user.id, paid: true });
      const beaRow = ticked[one].payment.members.find((member: { id: string }) => member.id === bea.user.id);
      assert.equal(beaRow.paid, true);
      assert.equal(beaRow.setByName, "Alex");
      const own = await paid(sam.token, { paid: true });
      assert.equal(own[one].payment.members.find((member: { id: string }) => member.id === sam.user.id).setByName, "Sam");

      // Collector rules: Bea has paid, Kim is not going.
      const moved = await patch(alex.token, { collectorId: bea.user.id });
      assert.equal(moved[one].payment.collector.id, bea.user.id);
      assert.equal(moved[one].payment.collector.weroEmail, "bea@example.com");
      assert.equal(moved[one].payment.collector.paypalUrl, "https://www.paypal.me/HangryBea/12.50EUR");
      await patch(alex.token, { collectorId: kim.user.id }, 400);
      await paid(alex.token, { userId: bea.user.id, paid: false }, 400);
      // The new collector can tick others.
      const byCollector = await paid(bea.token, { userId: sam.user.id, paid: false });
      assert.equal(byCollector[one].payment.members.find((member: { id: string }) => member.id === sam.user.id).paid, false);
      // The organizer pays too now.
      const org = await paid(alex.token, { paid: true });
      assert.equal(org[one].payment.members.find((member: { id: string }) => member.id === alex.user.id).paid, true);

      // Back to the organizer.
      const back = await patch(alex.token, { collectorId: null });
      assert.equal(back[one].payment.collector.id, alex.user.id);

      // Clearing the price drops the collector and the paid marks.
      await patch(alex.token, { collectorId: bea.user.id });
      const cleared = await patch(alex.token, { price: null });
      assert.equal(cleared[one].payment, null);
      await patch(alex.token, { price: 9 });
      const fresh = await api(port, "GET", `/api/${kind}`, { token: alex.token, status: 200 });
      const payment = fresh[kind].find((item: { id: string }) => item.id === id).payment;
      assert.equal(payment.collector.id, alex.user.id);
      assert.equal(payment.members.some((member: { paid: boolean }) => member.paid), false);
    });
  });

  test(`${kind}: a collector who leaves falls back to the organizer, and links stay in the circle`, async () => {
    await withApp(async ({ port }) => {
      const { alex, bea } = await circle(port);
      await api(port, "PATCH", "/api/me", { token: bea.token, body: { paymentUrl: "https://paypal.me/HangryBea" }, status: 200 });
      const made = await api(port, "POST", `/api/${kind}`, { token: alex.token, body: { note: "Pizza" }, status: 201 });
      const id = made[one].id;
      await api(port, "POST", `/api/${kind}/${id}/join`, { token: bea.token, status: 200 });
      await api(port, "PATCH", `/api/${kind}/${id}`, { token: alex.token, body: { price: 8 }, status: 200 });
      await api(port, "POST", `/api/${kind}/${id}/paid`, { token: bea.token, body: { paid: true }, status: 200 });
      await api(port, "PATCH", `/api/${kind}/${id}`, { token: alex.token, body: { collectorId: bea.user.id }, status: 200 });
      const left = await api(port, "POST", `/api/${kind}/${id}/leave`, { token: bea.token, status: 200 });
      assert.equal(left[one].payment.collector.id, alex.user.id);
      assert.equal(left[one].payment.collector.paypalUrl, null);
    });
  });
}
