import assert from "node:assert/strict";
import test from "node:test";
import { JOINING_ONLY_KEY, filterJoining, isJoining, readJoiningOnly, writeJoiningOnly } from "../public/js/plans/joining-filter.js";

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => (data.has(key) ? data.get(key)! : null),
    setItem: (key: string, value: string) => { data.set(key, String(value)); },
  };
}

const ME = "me";
const host = (id: string) => ({ id, name: id });
const item = (creator: string, replies: [string, string][] = []) => ({
  creator: host(creator),
  joined: replies.map(([id, reply]) => ({ id, reply })),
});

test("the key is named for what it does and the default is off", () => {
  assert.equal(JOINING_ONLY_KEY, "fn_joining_only");
  assert.equal(readJoiningOnly(fakeStorage()), false);
  assert.equal(readJoiningOnly(null), false);
});

test("the choice is written as 1 or 0 and read back, also by a reload of the same store", () => {
  const store = fakeStorage();
  writeJoiningOnly(true, store);
  assert.equal(store.data.get(JOINING_ONLY_KEY), "1");
  assert.equal(readJoiningOnly(store), true);
  assert.equal(readJoiningOnly(fakeStorage(Object.fromEntries(store.data))), true);
  writeJoiningOnly(false, store);
  assert.equal(store.data.get(JOINING_ONLY_KEY), "0");
  assert.equal(readJoiningOnly(store), false);
});

test("broken storage never throws", () => {
  const broken = {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("full"); },
  };
  assert.equal(readJoiningOnly(broken), false);
  assert.doesNotThrow(() => writeJoiningOnly(true, broken));
  assert.doesNotThrow(() => writeJoiningOnly(true, null));
});

test("host, In and Maybe are kept; Can't join and no reply are hidden", () => {
  assert.equal(isJoining(item(ME), ME), true, "hosted plan");
  assert.equal(isJoining({ creator: host(ME) }, ME), true, "a Free now post they host");
  for (const reply of ["coming", "join", "in", "maybe"]) {
    assert.equal(isJoining(item("other", [[ME, reply]]), ME), true, reply);
  }
  assert.equal(isJoining(item("other", [[ME, "declined"]]), ME), false, "declined");
  assert.equal(isJoining(item("other", [["third", "in"]]), ME), false, "someone else's reply");
  assert.equal(isJoining(item("other"), ME), false, "no reply");
});

test("filterJoining leaves the list alone while off", () => {
  const list = [item(ME), item("other")];
  assert.equal(filterJoining(list, false, ME), list);
  assert.deepEqual(filterJoining(list, true, ME), [list[0]]);
});
