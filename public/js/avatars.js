import { activeStatus, statusLabel, statusBadge } from "./status.js";
import { state } from "./state.js";
import { api, friendlyMessage, refresh } from "./session.js";
import { render } from "./render.js";
import { colorFor, el, initial, run } from "./lib.js";

/** Blob URLs for photos, by `${id}:${rev}`. A string is ready, a Promise is loading, null failed. */
export const avatarUrls = new Map();

export function avatarKey(person) {
  return person?.id && person.avatarRev ? `${person.id}:${person.avatarRev}` : "";
}

/** Photos need the Bearer token, so <img src> cannot fetch them. Fetch once, keep a blob URL. */
export function loadAvatar(person) {
  const key = avatarKey(person);
  if (avatarUrls.has(key)) return avatarUrls.get(key);
  const token = state.token;
  const job = fetch(`/api/users/${encodeURIComponent(person.id)}/avatar?v=${encodeURIComponent(person.avatarRev)}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
    .then((response) => (response.ok ? response.blob() : null))
    .then((blob) => {
      const url = blob && blob.size ? URL.createObjectURL(blob) : null;
      avatarUrls.set(key, url);
      return url;
    })
    .catch(() => {
      // Offline: forget the failure so the next render tries again.
      avatarUrls.delete(key);
      return null;
    });
  avatarUrls.set(key, job);
  return job;
}

export function forgetAvatars() {
  for (const value of avatarUrls.values()) if (typeof value === "string") URL.revokeObjectURL(value);
  avatarUrls.clear();
}

function avatarImg(url, person, size, extra) {
  const node = el("img", {
    class: `avatar photo ${extra}`.trim(),
    src: url,
    alt: "",
    "data-person": person.id,
    style: `background:${colorFor(person)}`,
  });
  if (size !== 28) {
    node.style.width = `${size}px`;
    node.style.height = `${size}px`;
  }
  return node;
}

/** The face, with a small Away / Busy badge on it while that status is on. */
export function avatar(person, size = 28, extra = "") {
  const face = avatarFace(person, size, extra);
  const status = activeStatus(person?.status);
  if (!status) return face;
  const badge = el("span", {
    class: "status-badge",
    role: "img",
    "aria-label": statusLabel(status.type),
    "data-status": status.type,
    text: statusBadge(status.type),
  });
  const mark = Math.max(14, Math.round(size * 0.4));
  badge.style.width = `${mark}px`;
  badge.style.height = `${mark}px`;
  badge.style.fontSize = `${Math.round(mark * 0.62)}px`;
  return el("span", { class: "avatar-wrap" }, [face, badge]);
}

function avatarFace(person, size = 28, extra = "") {
  const key = avatarKey(person);
  const cached = key ? avatarUrls.get(key) : undefined;
  if (typeof cached === "string") return avatarImg(cached, person, size, extra);
  const node = el("span", {
    class: `avatar ${extra}`.trim(),
    text: initial(person.name),
    "data-person": person?.id || null,
    style: `background:${colorFor(person)}`,
  });
  if (size !== 28) {
    node.style.width = `${size}px`;
    node.style.height = `${size}px`;
  }
  if (key && cached !== null) {
    // Initials while it loads. Swap in place when ready; a later render reads the cache.
    void Promise.resolve(loadAvatar(person)).then((url) => {
      if (url && node.isConnected) node.replaceWith(avatarImg(url, person, size, extra));
    });
  }
  return node;
}

const PHOTO_SIZE = 256;
const PHOTO_MAX_BYTES = 50 * 1024;
let photoInputNode = null;

/** One hidden picker outside #app, so a re-render while it is open does not lose the change event. */
function photoInput() {
  if (photoInputNode) return photoInputNode;
  photoInputNode = el("input", { type: "file", accept: "image/*", id: "avatar-file", class: "visually-hidden", tabindex: "-1", "aria-hidden": "true" });
  photoInputNode.addEventListener("change", () => {
    const file = photoInputNode.files?.[0];
    photoInputNode.value = "";
    if (file) void onPhotoChosen(file);
  });
  document.body.append(photoInputNode);
  return photoInputNode;
}

export function pickPhoto() {
  if (state.avatarBusy) return;
  photoInput().click();
}

async function decodePhoto(file) {
  if ("createImageBitmap" in window) {
    try {
      return await createImageBitmap(file);
    } catch {
      /* fall back to <img> */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function canvasBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** Centre square, 256×256, WebP (JPEG where WebP will not encode), at most 50 KB. */
async function squarePhoto(file) {
  const image = await decodePhoto(file);
  const width = image.width || image.naturalWidth;
  const height = image.height || image.naturalHeight;
  if (!width || !height) throw new Error("That photo could not be read.");
  const side = Math.min(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = PHOTO_SIZE;
  canvas.height = PHOTO_SIZE;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, (width - side) / 2, (height - side) / 2, side, side, 0, 0, PHOTO_SIZE, PHOTO_SIZE);
  image.close?.();
  let type = "image/webp";
  let quality = 0.8;
  let blob = await canvasBlob(canvas, type, quality);
  if (!blob || blob.type !== "image/webp") {
    type = "image/jpeg";
    quality = 0.85;
    blob = await canvasBlob(canvas, type, quality);
  }
  while (blob && blob.size > PHOTO_MAX_BYTES && quality > 0.3) {
    quality -= 0.1;
    blob = await canvasBlob(canvas, type, quality);
  }
  if (!blob || blob.size > PHOTO_MAX_BYTES) throw new Error("That photo is too big.");
  return blob;
}

async function onPhotoChosen(file) {
  state.avatarBusy = true;
  render();
  await run(async () => {
    try {
      let blob;
      try {
        blob = await squarePhoto(file);
      } catch (error) {
        throw new Error(error?.message === "That photo is too big." ? error.message : "That photo could not be read.");
      }
      let response;
      try {
        response = await fetch("/api/me/avatar", {
          method: "PUT",
          headers: { "content-type": blob.type, authorization: `Bearer ${state.token}` },
          body: blob,
        });
      } catch {
        const error = new Error("You're offline. Retrying…");
        error.status = 0;
        throw error;
      }
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        const error = new Error(friendlyMessage(data?.error, response.status));
        error.status = response.status;
        throw error;
      }
      // The bytes we just sent are the photo. No need to fetch them back.
      avatarUrls.set(`${data.user.id}:${data.user.avatarRev}`, URL.createObjectURL(blob));
      state.me = { ...state.me, user: data.user };
      state.error = "Photo saved";
    } finally {
      state.avatarBusy = false;
    }
    await refresh();
  });
}

export async function onRemovePhoto() {
  state.avatarBusy = true;
  render();
  await run(async () => {
    try {
      const data = await api("/api/me/avatar", { method: "DELETE" });
      state.me = { ...state.me, user: data.user };
      state.error = "Photo removed";
    } finally {
      state.avatarBusy = false;
    }
    await refresh();
  });
}
