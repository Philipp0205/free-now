import assert from "node:assert/strict";
import test from "node:test";
import { HttpError } from "../src/lib/http.js";
import { cleanPaymentUrl, cleanWeroEmail, visiblePaymentUrls, visibleWeroEmails } from "../src/lib/payment-url.js";
import { openDb } from "../src/db.js";

const BAD = "Use a paypal.me link, for example https://paypal.me/yourname";

function rejects(value: unknown, message = BAD) {
  assert.throws(
    () => cleanPaymentUrl(value),
    (error) => error instanceof HttpError && error.status === 400 && error.message === message,
    String(value),
  );
}

test("accepts paypal.me, www.paypal.me and www.paypal.com/paypalme links", () => {
  assert.equal(cleanPaymentUrl("https://paypal.me/name"), "https://paypal.me/name");
  assert.equal(cleanPaymentUrl("https://www.paypal.me/name"), "https://www.paypal.me/name");
  assert.equal(cleanPaymentUrl("https://www.paypal.com/paypalme/name"), "https://www.paypal.com/paypalme/name");
  assert.equal(cleanPaymentUrl("https://paypal.me/name/12.50EUR"), "https://paypal.me/name/12.50EUR");
});

test("trims, lowercases the host, and an empty value clears", () => {
  assert.equal(cleanPaymentUrl("  https://PayPal.me/Name  "), "https://paypal.me/Name");
  assert.equal(cleanPaymentUrl(""), null);
  assert.equal(cleanPaymentUrl("   "), null);
});

test("rejects other schemes, hosts and lookalikes", () => {
  rejects("http://paypal.me/name", "Links must start with https://");
  rejects("javascript:alert(1)", "Links must start with https://");
  rejects("data:text/html,hi", "Links must start with https://");
  rejects("paypal.me/name", "Links must start with https://");
  for (const url of [
    "https://example.com/name",
    "https://paypal.me.evil.com/name",
    "https://evilpaypal.me/name",
    "https://paypal.com/paypalme/name",
    "https://www.paypal.com/name",
    "https://www.paypal.com/paypalme/",
    "https://wero-wallet.eu/name",
    "https://pay.wero-wallet.eu/collect/abc",
    "https://wero.example/name",
  ]) rejects(url);
});

test("rejects credentials, ports and a bare host", () => {
  for (const url of [
    "https://user:pass@paypal.me/name",
    "https://user@paypal.me/name",
    "https://paypal.me:8443/name",
    "https://paypal.me:443/name",
    "https://paypal.me",
    "https://paypal.me/",
    "https://www.paypal.me//",
    "https://",
  ]) rejects(url);
});

test("rejects a link over 200 characters and anything that is not a string", () => {
  rejects(`https://paypal.me/${"a".repeat(200)}`, "Link is too long");
  assert.equal(cleanPaymentUrl(`https://paypal.me/${"a".repeat(182)}`)?.length, 200);
  for (const value of [undefined, null, 5, true, {}, ["https://paypal.me/name"]]) rejects(value);
});

test("visiblePaymentUrls: own and circle mates only, nobody without a viewer", () => {
  const db = openDb(":memory:");
  const user = (id: string, url: string | null) =>
    db.prepare("INSERT INTO users (id, name, token_hash, buzz_token, created_at, payment_url) VALUES (?, ?, ?, ?, 1, ?)").run(id, id, `h${id}`, `b${id}`, url);
  user("a", "https://paypal.me/a");
  user("b", "https://paypal.me/b");
  user("c", "https://paypal.me/c");
  user("d", null);
  db.prepare("INSERT INTO circles (id, name, invite_code, created_by, created_at) VALUES ('x', 'X', 'CODEX', 'a', 1), ('y', 'Y', 'CODEY', 'c', 1)").run();
  for (const [circle, who] of [["x", "a"], ["x", "b"], ["x", "d"], ["y", "c"]]) {
    db.prepare("INSERT INTO memberships (circle_id, user_id, joined_at) VALUES (?, ?, 1)").run(circle, who);
  }
  assert.deepEqual([...visiblePaymentUrls(db, "a")].sort(), [["a", "https://paypal.me/a"], ["b", "https://paypal.me/b"]]);
  assert.deepEqual([...visiblePaymentUrls(db, "d")], [["a", "https://paypal.me/a"], ["b", "https://paypal.me/b"]]);
  assert.deepEqual([...visiblePaymentUrls(db, "c")], [["c", "https://paypal.me/c"]]);
  assert.equal(visiblePaymentUrls(db, null).size, 0);
  db.close();
});

function badEmail(value: unknown) {
  assert.throws(
    () => cleanWeroEmail(value),
    (error) => error instanceof HttpError && error.status === 400 && error.message === "Enter a valid email",
    String(value),
  );
}

test("cleanWeroEmail trims and lowercases, and an empty value clears", () => {
  assert.equal(cleanWeroEmail("  Bea.Friend@Example.COM "), "bea.friend@example.com");
  assert.equal(cleanWeroEmail(""), null);
  assert.equal(cleanWeroEmail("   "), null);
});

test("cleanWeroEmail rejects bad addresses and anything that is not a string", () => {
  for (const value of ["bea.example.com", "bea @example.com", "bea@example", "a@@example.com", `${"a".repeat(250)}@x.co`]) badEmail(value);
  for (const value of [undefined, null, 5, true, {}, ["bea@example.com"]]) badEmail(value);
});

test("visibleWeroEmails: own and circle mates only, nobody without a viewer", () => {
  const db = openDb(":memory:");
  const user = (id: string, email: string | null) =>
    db.prepare("INSERT INTO users (id, name, token_hash, buzz_token, created_at, wero_email) VALUES (?, ?, ?, ?, 1, ?)").run(id, id, `h${id}`, `b${id}`, email);
  user("a", "a@example.com");
  user("b", "b@example.com");
  user("c", "c@example.com");
  user("d", null);
  db.prepare("INSERT INTO circles (id, name, invite_code, created_by, created_at) VALUES ('x', 'X', 'CODEX', 'a', 1), ('y', 'Y', 'CODEY', 'c', 1)").run();
  for (const [circle, who] of [["x", "a"], ["x", "b"], ["x", "d"], ["y", "c"]]) {
    db.prepare("INSERT INTO memberships (circle_id, user_id, joined_at) VALUES (?, ?, 1)").run(circle, who);
  }
  assert.deepEqual([...visibleWeroEmails(db, "a")].sort(), [["a", "a@example.com"], ["b", "b@example.com"]]);
  assert.deepEqual([...visibleWeroEmails(db, "d")], [["a", "a@example.com"], ["b", "b@example.com"]]);
  assert.deepEqual([...visibleWeroEmails(db, "c")], [["c", "c@example.com"]]);
  assert.equal(visibleWeroEmails(db, null).size, 0);
  db.close();
});
