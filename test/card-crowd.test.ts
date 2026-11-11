import assert from "node:assert/strict";
import test from "node:test";
import { cardCrowd } from "../public/map-pin.js";

const person = (id: string, reply?: string) => ({ id, name: id, color: "#336699", avatarRev: null, reply });
const ids = (list: Array<{ id: string }>) => list.map((p) => p.id);

test("the card shows the host and who's in or maybe; can't goes to the details", () => {
  const host = person("host");
  const joined = [person("alex", "coming"), person("bea", "declined"), person("cy", "maybe"), person("dee", "in")];
  const crowd = cardCrowd(host, joined);
  assert.deepEqual(ids(crowd.stack), ["host", "alex", "cy", "dee"]);
  assert.deepEqual(ids(crowd.listed), ["alex", "cy", "dee"], "the who-row lists in and maybe, never can't");
  assert.deepEqual(ids(crowd.cant), ["bea"]);
  assert.equal(crowd.more, 0);
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
