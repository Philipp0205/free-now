/**
 * The photo a host has picked in a sheet but not saved yet. Pure state: no network, no DOM.
 * blob is a compressed image to upload, remove asks for the current photo to go, url previews the blob.
 */
export function emptyPhotoDraft() {
  return { blob: null, url: "", remove: false, busy: false, error: "" };
}

/** Frees the preview URL and drops the staged blob. */
export function releaseDraft(draft) {
  if (draft.url) URL.revokeObjectURL(draft.url);
  draft.blob = null;
  draft.url = "";
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
  releaseDraft(draft);
  draft.blob = blob;
  draft.url = URL.createObjectURL(blob);
  draft.remove = false;
  draft.error = "";
}

/** Remove: drops a staged pick, and marks the saved photo (if the event has one) for removal. */
export function unstagePhoto(draft, item) {
  releaseDraft(draft);
  draft.remove = Boolean(item?.photoRev);
  draft.error = "";
}

/** Whether saving has anything to do for the photo. */
export function draftHasChange(draft) {
  return Boolean(draft.blob) || draft.remove;
}
