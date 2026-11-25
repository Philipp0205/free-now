import assert from "node:assert/strict";
import test from "node:test";
import { beginPick, emptyPhotoDraft, finishPick, releaseDraft, resetPhotoDraft } from "../../public/js/plans/event-photo-draft.js";

const blob = () => new Blob(["x"], { type: "image/jpeg" });

test("a pick marks the draft busy and its result stages the blob", () => {
  const draft = emptyPhotoDraft();
  const token = beginPick(draft);
  assert.equal(draft.busy, true);
  assert.equal(finishPick(draft, token, { blob: blob() }), true);
  assert.equal(draft.busy, false);
  assert.ok(draft.blob && draft.url);
  releaseDraft(draft);
});

test("a failed pick keeps the error and stages nothing", () => {
  const draft = emptyPhotoDraft();
  const token = beginPick(draft);
  finishPick(draft, token, { error: "unreadable" });
  assert.equal(draft.error, "unreadable");
  assert.equal(draft.blob, null);
  assert.equal(draft.busy, false);
});

test("a pick that finishes after a release or reset is dropped", () => {
  const draft = emptyPhotoDraft();
  const token = beginPick(draft);
  draft.pending = Promise.resolve();
  releaseDraft(draft);
  assert.equal(draft.pending, null);
  assert.equal(draft.busy, false);
  assert.equal(finishPick(draft, token, { blob: blob() }), false);
  assert.equal(draft.blob, null);
  const again = beginPick(draft);
  const fresh = resetPhotoDraft(draft);
  assert.equal(finishPick(draft, again, { blob: blob() }), false);
  assert.equal(draft.blob, null);
  assert.equal(fresh.blob, null);
});

test("a second pick replaces the first, and the first result is ignored", () => {
  const draft = emptyPhotoDraft();
  const first = beginPick(draft);
  const second = beginPick(draft);
  assert.equal(finishPick(draft, first, { blob: blob() }), false);
  assert.equal(draft.blob, null);
  assert.equal(finishPick(draft, second, { blob: blob() }), true);
  assert.ok(draft.blob);
  releaseDraft(draft);
});
