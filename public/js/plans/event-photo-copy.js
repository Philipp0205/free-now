/** Words for the event cover photo. Logic and UI modules import these, so the wording lives in one place. */
export const PHOTO_COPY = {
  label: "Photo",
  add: "Add photo",
  replace: "Replace",
  remove: "Remove",
  busy: "Preparing…",
  help: "Optional. Only people who can see this event can see the photo.",
  previewAlt: "Your photo",
  open: "View photo",
  close: "Close photo",
  alt: (name) => (name ? `Photo from ${name}` : "Event photo"),
  unreadable: "That photo could not be read. Try a JPEG or PNG.",
  heic: "This photo format can't be read on this device. Try a JPEG or PNG.",
  tooBig: "That photo is too big. Try a smaller one.",
  uploadFailed: "Saved, but the photo did not upload. Edit to try again.",
  removeFailed: "Saved, but the photo was not removed. Edit to try again.",
};
