import assert from "node:assert/strict";
import test from "node:test";
import { nextPushDetail, pushTitle } from "../public/push-sheet.js";

const person = (status: string) => ({ id: "bea", name: "Bea", status, httpStatus: null });
const push = (delivered: number, status: string) => ({ delivered, total: 1, people: [person(status)] });

test("a plan sheet follows the plan list, not the socials", () => {
  const detail = { kind: "plan", id: "p1", title: "Picnic", push: push(0, "sent") };
  const plans = [{ id: "p1", note: "Picnic", forDate: "2026-11-05", push: push(1, "delivered") }];
  const socials = [{ id: "p1", note: "Other", push: push(0, "sent") }];
  const next = nextPushDetail(detail, socials, plans);
  assert.deepEqual(next, { kind: "plan", id: "p1", title: "Picnic", push: push(1, "delivered") });
  assert.equal(nextPushDetail(next, socials, plans), null);
});

test("a social sheet picks up a new note and delivery count", () => {
  const detail = { kind: "social", id: "s1", title: "Coffee", push: push(0, "sent") };
  const next = nextPushDetail(detail, [{ id: "s1", note: "", push: push(1, "delivered") }], []);
  assert.equal(next?.title, "Free now");
  assert.equal(next?.push.delivered, 1);
});

test("an ended or deleted event leaves the sheet as it was and never throws", () => {
  const detail = { kind: "plan", id: "p1", title: "Picnic", push: push(1, "delivered") };
  assert.equal(nextPushDetail(detail, [], []), null);
  assert.equal(nextPushDetail(detail, [], [{ id: "other", push: push(0, "sent") }]), null);
  assert.equal(nextPushDetail(detail, [], [{ id: "p1", note: "Picnic" }]), null);
  assert.equal(nextPushDetail(detail, [], [null, { id: "p1", push: {} }]), null);
  assert.equal(nextPushDetail(detail, undefined, undefined), null);
  assert.equal(nextPushDetail(null, [], []), null);
  assert.equal(nextPushDetail({ kind: "plan" }, [], []), null);
});

test("titles fall back by kind", () => {
  assert.equal(pushTitle("plan", { note: "" }), "Plan");
  assert.equal(pushTitle("social", { note: "" }), "Free now");
  assert.equal(pushTitle("social", { note: "Coffee" }), "Coffee");
});
