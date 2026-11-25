import { el } from "../lib.js";
import { render } from "../render.js";
import { refresh } from "../session.js";
import { PHOTO_COPY } from "./event-photo-copy.js";
import { beginPick, draftHasPhoto, finishPick, unstagePhoto } from "./event-photo-draft.js";
import { compressPhoto } from "./event-photo-image.js";
import { loadEventPhoto, photoKey, photoUrls, uploadPhotoNow } from "./event-photo.js";

let inputNode = null;
let target = null;

/** One hidden picker outside #app, so a re-render while it is open does not lose the change event. */
function picker() {
  if (inputNode) return inputNode;
  inputNode = el("input", { type: "file", accept: "image/*", id: "event-photo-file", class: "visually-hidden", tabindex: "-1", "aria-hidden": "true" });
  inputNode.addEventListener("change", () => {
    const file = inputNode.files?.[0];
    inputNode.value = "";
    if (file && target) void target(file);
  });
  document.body.append(inputNode);
  return inputNode;
}

/** Opens the picker and hands the chosen file to `onFile`. */
function pickFile(onFile) {
  target = onFile;
  picker().click();
}

function errorText(error) {
  return error?.message || PHOTO_COPY.unreadable;
}

/**
 * Compresses the pick and stages it on the draft. Shows "Preparing" meanwhile and any error under the slot.
 * The draft keeps the job in `pending`, so Save can wait for it. A pick finishing after a reset is dropped.
 */
async function onPicked(draft, file) {
  const token = beginPick(draft);
  render();
  const job = compressPhoto(file).then((blob) => ({ blob }), (error) => ({ error: errorText(error) }));
  draft.pending = job.then((result) => { finishPick(draft, token, result); });
  await draft.pending;
  render();
}

function pick(draft) {
  if (draft.busy) return;
  pickFile((file) => onPicked(draft, file));
}

/** What the Details button is doing: "" idle, else the label of the step. Survives re-renders. */
let quick = { id: "", step: "", error: "" };

/** Compresses, uploads straight away, then refreshes so the new photo shows on the sheet and the card. */
async function onQuickPicked(kind, item, file) {
  const job = { id: item.id, step: PHOTO_COPY.busy, error: "" };
  quick = job;
  render();
  try {
    const blob = await compressPhoto(file);
    job.step = PHOTO_COPY.uploading;
    render();
    job.error = await uploadPhotoNow(kind, item.id, blob);
  } catch (error) {
    job.error = errorText(error);
  }
  job.step = "";
  if (!job.error) await refresh().catch(() => {});
  render();
}

/** The host row of the Details sheet: Add or Change photo, which uploads at once, plus any `extra` buttons. */
export function hostPhotoRow(kind, item, extra = []) {
  const mine = quick.id === item.id ? quick : { step: "", error: "" };
  const label = mine.step || (item.photoRev ? PHOTO_COPY.change : PHOTO_COPY.add);
  return el("div", { class: "sheet-group event-photo-field detail-photo-row" }, [
    el("div", { class: "event-photo-actions" }, [
      el("button", {
        class: "text-btn", type: "button", id: "detail-photo-pick", text: label, disabled: Boolean(mine.step),
        onclick: () => pickFile((file) => onQuickPicked(kind, item, file)),
      }),
      ...extra,
    ]),
    mine.error ? el("p", { class: "time-error", role: "alert", text: mine.error }) : null,
  ]);
}

/** An <img> for an event's photo. A cached blob URL is set at once; otherwise it loads and `onFail` runs if there is none. */
function loadedImage(kind, item, className, alt, onFail) {
  const img = el("img", { class: className, alt, decoding: "async", draggable: "false" });
  const cached = photoUrls.get(photoKey(kind, item));
  if (typeof cached === "string") {
    img.src = cached;
    return img;
  }
  void Promise.resolve(loadEventPhoto(kind, item)).then((url) => {
    if (url) img.src = url;
    else if (img.isConnected) onFail();
  });
  return img;
}

function slotPreview(draft, item, kind) {
  const box = el("div", { class: "event-photo-preview" });
  if (draft.blob) {
    box.append(el("img", { src: draft.url, alt: PHOTO_COPY.previewAlt }));
    return box;
  }
  box.append(loadedImage(kind, item, "", PHOTO_COPY.previewAlt, () => box.remove()));
  return box;
}

/**
 * The photo row of the composer and the edit sheet: a preview, then Add photo or Replace and Remove.
 * It only edits `draft` (see event-photo-draft.js). The upload happens when the sheet saves.
 */
export function photoField(draft, item, kind) {
  const has = draftHasPhoto(draft, item);
  const label = draft.busy ? PHOTO_COPY.busy : has ? PHOTO_COPY.replace : PHOTO_COPY.add;
  return el("div", { class: "sheet-group event-photo-field" }, [
    el("span", { class: "sheet-label", text: PHOTO_COPY.label }),
    has ? slotPreview(draft, item, kind) : null,
    el("div", { class: "event-photo-actions" }, [
      el("button", { class: "text-btn", type: "button", id: "event-photo-pick", text: label, disabled: draft.busy, onclick: () => pick(draft) }),
      has && !draft.busy
        ? el("button", { class: "text-btn", type: "button", id: "event-photo-remove", text: PHOTO_COPY.remove, onclick: () => { unstagePhoto(draft, item); render(); } })
        : null,
    ]),
    draft.error ? el("p", { class: "time-error", role: "alert", text: draft.error }) : el("p", { class: "help", text: PHOTO_COPY.help }),
  ]);
}

/** The photo on a card or in the details sheet. Tap opens it larger. Null when the event has no photo. */
export function eventPhoto(kind, item, className = "event-photo") {
  if (!item?.photoRev) return null;
  const alt = PHOTO_COPY.alt(item.creator?.name);
  const button = el("button", { class: className, type: "button", "aria-label": PHOTO_COPY.open, "data-photo": item.id });
  const img = loadedImage(kind, item, "", alt, () => button.remove());
  button.append(img);
  button.addEventListener("click", () => { if (img.src) openLightbox(img.src, alt); });
  return button;
}

/** The small square on a compact row. A span, because the row is already a button. */
export function photoThumb(kind, item) {
  if (!item?.photoRev) return null;
  const alt = PHOTO_COPY.alt(item.creator?.name);
  const box = el("span", { class: "compact-photo", "data-photo": item.id });
  const img = loadedImage(kind, item, "", "", () => box.remove());
  box.append(img);
  box.addEventListener("click", (event) => {
    if (!img.src) return;
    event.stopPropagation();
    openLightbox(img.src, alt);
  });
  return box;
}

/** The photo large over everything. Tap, Close or Escape puts it away. Lives outside #app, so a render keeps it. */
export function openLightbox(src, alt) {
  document.querySelector(".photo-lightbox")?.remove();
  const before = document.activeElement;
  const close = () => {
    box.remove();
    document.removeEventListener("keydown", onKey, true);
    if (before instanceof HTMLElement) before.focus({ preventScroll: true });
  };
  const onKey = (event) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    close();
  };
  const button = el("button", { class: "photo-lightbox-close", type: "button", "aria-label": PHOTO_COPY.close, text: "×", onclick: close });
  const box = el("div", { class: "photo-lightbox", role: "dialog", "aria-modal": "true", "aria-label": alt, onclick: close }, [
    el("img", { src, alt }),
    button,
  ]);
  document.addEventListener("keydown", onKey, true);
  document.body.append(box);
  button.focus({ preventScroll: true });
}
