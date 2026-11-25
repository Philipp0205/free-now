/**
 * The photo a host has picked in a sheet but not saved yet. Pure state: no network, no DOM.
 * blob is a compressed image to upload, remove asks for the current photo to go, url previews the blob.
 */
export function emptyPhotoDraft() {
  return { blob: null, url: "", remove: false, busy: false, error: "", pending: null, pick: 0 };
}

function freeBlob(draft) {
  if (draft.url) URL.revokeObjectURL(draft.url);
  draft.blob = null;
  draft.url = "";
}

/** Frees the preview URL, drops the staged blob and invalidates a pick still being compressed. */
export function releaseDraft(draft) {
  freeBlob(draft);
  draft.pick += 1;
  draft.pending = null;
  draft.busy = false;
}

/** Starts a pick: marks the draft busy and returns the token that only this pick may finish with. */
export function beginPick(draft) {
  draft.pick += 1;
  draft.busy = true;
  draft.error = "";
  return draft.pick;
}

/** Whether a pick is still the latest one, that is the draft was not released or re-picked meanwhile. */
function isCurrentPick(draft, token) {
  return draft.pick === token;
}

/** Ends the pick `token`: stages its blob or records its error. A stale pick changes nothing. Returns whether it applied. */
export function finishPick(draft, token, result) {
  if (!isCurrentPick(draft, token)) return false;
  if (result.blob) stagePhoto(draft, result.blob);
  else draft.error = result.error;
  draft.busy = false;
  draft.pending = null;
  return true;
}

/** A fresh draft for a sheet that just opened. The old one gives its preview URL back. */
export function resetPhotoDraft(old) {
  if (old) releaseDraft(old);
  return emptyPhotoDraft();
}

/** Whether the slot shows a photo: a staged one, or the saved one unless the host asked to remove it. */
export function draftHasPhoto(draft, item) {
  return Boolean(draft.blob) || (!draft.remove && Boolean(item?.photoRev));
}

/** Stages a compressed photo, replacing any earlier pick. */
export function stagePhoto(draft, blob) {
  freeBlob(draft);
  draft.blob = blob;
  draft.url = URL.createObjectURL(blob);
  draft.remove = false;
  draft.error = "";
}

/** Remove: drops a staged pick, and marks the saved photo (if the event has one) for removal. */
export function unstagePhoto(draft, item) {
  freeBlob(draft);
  draft.remove = Boolean(item?.photoRev);
  draft.error = "";
}

/** Whether saving has anything to do for the photo. */
export function draftHasChange(draft) {
  return Boolean(draft.blob) || draft.remove;
}
