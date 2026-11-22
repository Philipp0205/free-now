import assert from "node:assert/strict";
import test from "node:test";
import { cardCrowd } from "../public/js/map-pin.js";

const person = (id: string, reply?: string) => ({ id, name: id, color: "#336699", avatarRev: null, reply });
const ids = (list: Array<{ id: string }>) => list.map((p) => p.id);

test("the card shows the host and who's in; maybe and can't go to the details", () => {
  const host = person("host");
  const joined = [person("alex", "coming"), person("bea", "declined"), person("cy", "maybe"), person("dee", "in")];
  const crowd = cardCrowd(host, joined);
  assert.deepEqual(ids(crowd.stack), ["host", "alex", "dee"]);
  assert.deepEqual(ids(crowd.people), ["host", "alex", "dee"], "maybe is not counted as in");
  assert.deepEqual(ids(crowd.listed), ["alex", "dee"], "the who-row lists in, never maybe or can't");
  assert.deepEqual(ids(crowd.maybe), ["cy"]);
  assert.deepEqual(ids(crowd.cant), ["bea"]);
  assert.equal(crowd.more, 0);
});

test("a host's own maybe-looking row never makes the host maybe", () => {
  const host = person("host");
  const crowd = cardCrowd(host, [person("host", "maybe"), person("cy", "maybe")]);
  assert.deepEqual(ids(crowd.maybe), ["cy"]);
  assert.deepEqual(ids(crowd.people), ["host"]);
});

test("only a decline leaves the host alone on the card and an empty who-row", () => {
  const crowd = cardCrowd(person("host"), [person("bea", "declined")]);
  assert.deepEqual(ids(crowd.stack), ["host"]);
  assert.deepEqual(crowd.listed, []);
  assert.deepEqual(ids(crowd.cant), ["bea"]);
});

test("the stack overflows into +N and lists everyone once", () => {
  const host = person("host");
  const joined = [person("host", "coming"), ...["a", "b", "c", "d", "e", "f", "g"].map((id) => person(id, "coming"))];
  const crowd = cardCrowd(host, joined, 6);
  assert.deepEqual(ids(crowd.stack), ["host", "a", "b", "c", "d", "e"]);
  assert.equal(crowd.more, 2);
  assert.equal(crowd.people.length, 8, "the host is counted once");
  assert.deepEqual(cardCrowd(host, null as never).people.length, 1);
});
