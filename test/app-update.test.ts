import assert from "node:assert/strict";
import test from "node:test";
import {
  UPDATE_CHECK_MS,
  canReloadNow,
  createReloadOnce,
  createUpdater,
  hasUnsentInput,
  isTypingTarget,
  readGuard,
  shouldCheckNow,
} from "../public/js/app-update.js";

test("typing in a text field, a textarea or an editable element blocks a reload", () => {
  assert.equal(isTypingTarget({ tagName: "TEXTAREA" }), true);
  assert.equal(isTypingTarget({ tagName: "INPUT", type: "text" }), true);
  assert.equal(isTypingTarget({ tagName: "INPUT" }), true);
  assert.equal(isTypingTarget({ tagName: "DIV", isContentEditable: true }), true);
  assert.equal(isTypingTarget({ tagName: "INPUT", type: "checkbox" }), false);
  assert.equal(isTypingTarget({ tagName: "BUTTON" }), false);
  assert.equal(isTypingTarget({ tagName: "BODY" }), false);
  assert.equal(isTypingTarget(null), false);
});

test("unsent input is any non-blank draft or a queued chat message", () => {
  assert.equal(hasUnsentInput({ drafts: ["", "  ", undefined, null] }), false);
  assert.equal(hasUnsentInput({ drafts: ["", "pizza?"] }), true);
  assert.equal(hasUnsentInput({ drafts: [], queued: true }), true);
  assert.equal(hasUnsentInput(), false);
});

test("a reload is allowed only when nobody is typing and nothing is unsent", () => {
  assert.equal(canReloadNow({ typing: false, unsent: false }), true);
  assert.equal(canReloadNow({ typing: true, unsent: false }), false);
  assert.equal(canReloadNow({ typing: false, unsent: true }), false);
  assert.equal(canReloadNow({ typing: true, unsent: true }), false);
  assert.equal(canReloadNow(), true);
});

function fakeDoc({ active = { tagName: "BODY" }, chatInput = null as string | null, sheetFields = [] as Array<Record<string, unknown>> } = {}) {
  return {
    activeElement: active,
    getElementById: (id: string) => (id === "chat-input" && chatInput !== null ? { value: chatInput } : null),
    querySelectorAll: () => sheetFields,
  } as unknown as Document;
}

test("readGuard sees a focused field, an unsent composer, an unsent sheet field and a queued message", () => {
  assert.deepEqual(readGuard({ chatDraft: "" }, fakeDoc()), { typing: false, unsent: false });
  assert.deepEqual(readGuard({ chatDraft: "" }, fakeDoc({ active: { tagName: "TEXTAREA" } })), { typing: true, unsent: false });
  assert.deepEqual(readGuard({ chatDraft: "hi" }, fakeDoc()), { typing: false, unsent: true });
  assert.deepEqual(readGuard({ chatDraft: "" }, fakeDoc({ chatInput: "half a thought" })), { typing: false, unsent: true });
  const note = { tagName: "INPUT", type: "text", value: "Rooftop coffee" };
  assert.deepEqual(readGuard({ chatDraft: "" }, fakeDoc({ sheetFields: [note] })), { typing: false, unsent: true });
  const empty = { tagName: "INPUT", type: "text", value: "" };
  assert.deepEqual(readGuard({ chatDraft: "" }, fakeDoc({ sheetFields: [empty] })), { typing: false, unsent: false });
  const readOnly = { tagName: "INPUT", type: "text", value: "https://example.test/feed", readOnly: true };
  assert.deepEqual(readGuard({ chatDraft: "" }, fakeDoc({ sheetFields: [readOnly] })), { typing: false, unsent: false });
  assert.deepEqual(readGuard({ chatDraft: "", chatQueue: { text: "x" } }, fakeDoc()), { typing: false, unsent: true });
});

test("the visibility check is throttled: a second one inside the window is skipped, a later one is not", () => {
  assert.equal(UPDATE_CHECK_MS, 60_000);
  assert.equal(shouldCheckNow(null, 1_000), true);
  assert.equal(shouldCheckNow(undefined, 1_000), true);
  assert.equal(shouldCheckNow(1_000, 1_000 + UPDATE_CHECK_MS - 1), false);
  assert.equal(shouldCheckNow(1_000, 1_000 + UPDATE_CHECK_MS), true);
  assert.equal(shouldCheckNow(1_000, 1_000 + 10 * UPDATE_CHECK_MS), true);
  assert.equal(shouldCheckNow(5_000, 1_000), true, "a clock that went back does not block checks");
});

test("the reload flag is one shot", () => {
  const once = createReloadOnce();
  assert.equal(once.used, false);
  assert.equal(once.take(), true);
  assert.equal(once.used, true);
  assert.equal(once.take(), false);
  assert.equal(once.take(), false);
});

type Worker = { state: string; addEventListener: (type: string, fn: () => void) => void };

/** A service worker container, a registration and a clock, all fake. */
function rig(options: { controller?: boolean; guard?: { typing: boolean; unsent: boolean }; found?: "none" | "activates" | "redundant" | "hangs" } = {}) {
  const listeners: Record<string, Array<() => void>> = {};
  const sw = {
    controller: options.controller === false ? null : {},
    addEventListener: (type: string, fn: () => void) => { (listeners[type] ||= []).push(fn); },
    getRegistration: async () => registration,
  };
  const worker: Worker & { fire: () => void } = {
    state: "installing",
    addEventListener: (type, fn) => { if (type === "statechange") (listeners.statechange ||= []).push(fn); },
    fire: () => (listeners.statechange || []).forEach((fn) => fn()),
  };
  const calls = { update: 0, reload: 0 };
  const registration: { installing: Worker | null; waiting: null; update: () => Promise<void> } = {
    installing: null,
    waiting: null,
    update: async () => {
      calls.update += 1;
      if (options.found && options.found !== "none") {
        registration.installing = worker;
        if (options.found === "activates") queueMicrotask(() => { worker.state = "activated"; worker.fire(); });
        if (options.found === "redundant") queueMicrotask(() => { worker.state = "redundant"; worker.fire(); });
      }
    },
  };
  let clock = 1_000_000;
  const timers: Array<{ at: number; fn: () => void }> = [];
  const guard = { typing: options.guard?.typing ?? false, unsent: options.guard?.unsent ?? false };
  const updater = createUpdater({
    sw,
    register: async () => registration,
    guard: () => guard,
    reload: () => { calls.reload += 1; },
    now: () => clock,
    later: (fn, ms) => { timers.push({ at: clock + ms, fn }); return 0; },
  });
  return {
    updater,
    calls,
    guard,
    controllerChange: () => (listeners.controllerchange || []).forEach((fn) => fn()),
    advance(ms: number) {
      clock += ms;
      for (const timer of timers.splice(0)) {
        if (timer.at <= clock) timer.fn();
        else timers.push(timer);
      }
    },
    settle: () => new Promise((resolve) => setTimeout(resolve, 5)),
  };
}

test("a new build that takes over reloads once, and a second controllerchange does not reload again", async () => {
  const t = rig();
  await t.updater.register();
  t.controllerChange();
  assert.equal(t.calls.reload, 1);
  t.controllerChange();
  t.updater.retry();
  t.advance(10_000);
  assert.equal(t.calls.reload, 1, "no reload loop");
});

test("the first worker claiming a page that had none is an install, not an update, and does not reload", async () => {
  const t = rig({ controller: false });
  await t.updater.register();
  t.controllerChange();
  assert.equal(t.calls.reload, 0);
  t.controllerChange();
  assert.equal(t.calls.reload, 1, "a later takeover is an update");
});

test("while the person is typing the reload waits, and applies once the field is left", async () => {
  const t = rig({ guard: { typing: true, unsent: false } });
  await t.updater.register();
  t.controllerChange();
  assert.equal(t.calls.reload, 0);
  t.advance(1_000);
  assert.equal(t.calls.reload, 0, "still typing");
  t.guard.typing = false;
  t.updater.retry();
  assert.equal(t.calls.reload, 1);
  t.advance(5_000);
  assert.equal(t.calls.reload, 1);
});

test("unsent composer or sheet text holds the reload until it is gone, found by the retry timer too", async () => {
  const t = rig({ guard: { typing: false, unsent: true } });
  await t.updater.register();
  t.controllerChange();
  assert.equal(t.calls.reload, 0);
  t.advance(1_000);
  assert.equal(t.calls.reload, 0);
  t.guard.unsent = false;
  t.advance(1_000);
  assert.equal(t.calls.reload, 1, "the retry timer applies it on the next safe moment");
  t.advance(5_000);
  assert.equal(t.calls.reload, 1);
});

test("a held reload also applies on the next pull", async () => {
  const t = rig({ guard: { typing: false, unsent: true }, found: "none" });
  await t.updater.register();
  t.controllerChange();
  assert.equal(t.calls.reload, 0);
  t.guard.unsent = false;
  const release = t.updater.holdReload();
  assert.equal(t.calls.reload, 0, "a pull in flight keeps the spinner first");
  release();
  assert.equal(t.calls.reload, 1);
});

test("a pull checks for a new worker every time, and reloads after the hold is released, not before", async () => {
  const t = rig({ found: "activates" });
  await t.updater.register();
  const release = t.updater.holdReload();
  const found = t.updater.checkNow({ force: true });
  await t.settle();
  t.controllerChange();
  assert.equal(await found, true);
  assert.equal(t.calls.update, 1);
  assert.equal(t.calls.reload, 0, "held while the spinner is up");
  release();
  assert.equal(t.calls.reload, 1);
  release();
  assert.equal(t.calls.reload, 1, "releasing twice does nothing");
  await t.updater.checkNow({ force: true });
  assert.equal(t.calls.update, 2, "a pull always asks");
  t.controllerChange();
  assert.equal(t.calls.reload, 1, "a second pull on the new build does not reload");
});

test("coming back to the app checks at most once a minute", async () => {
  const t = rig();
  await t.updater.register();
  await t.updater.checkNow();
  assert.equal(t.calls.update, 0, "register just looked, so the first visible is inside the window");
  t.advance(UPDATE_CHECK_MS - 1);
  await t.updater.checkNow();
  assert.equal(t.calls.update, 0);
  t.advance(1);
  await t.updater.checkNow();
  assert.equal(t.calls.update, 1);
  await t.updater.checkNow();
  assert.equal(t.calls.update, 1, "the check just made starts a new window");
  t.advance(UPDATE_CHECK_MS);
  await t.updater.checkNow();
  assert.equal(t.calls.update, 2);
  await t.updater.checkNow({ force: true });
  assert.equal(t.calls.update, 3, "a pull ignores the window");
});

test("a failed or redundant worker does not reload, and a missing registration is quiet", async () => {
  const redundant = rig({ found: "redundant" });
  await redundant.updater.register();
  assert.equal(await redundant.updater.checkNow({ force: true }), false);
  assert.equal(redundant.calls.reload, 0);

  const hangs = rig({ found: "hangs" });
  await hangs.updater.register();
  const waiting = hangs.updater.checkNow({ force: true });
  await hangs.settle();
  hangs.advance(10_000);
  assert.equal(await waiting, false, "a worker that never activates does not hold the pull");

  const bare = createUpdater({
    sw: { controller: {}, addEventListener: () => {}, getRegistration: async () => undefined },
    register: async () => { throw new Error("no worker"); },
    guard: () => ({ typing: false, unsent: false }),
    reload: () => assert.fail("no reload"),
  });
  assert.equal(await bare.register(), null);
  assert.equal(await bare.checkNow({ force: true }), false);
});
