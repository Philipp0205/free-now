import { state } from "../state.js";
import { api } from "../session.js";
import { render } from "../render.js";
import { chatTargetUrl, syncChatAlerts } from "../alerts.js";
import { tick } from "../replies.js";
import { noteRainThread } from "../emoji-rain.js";
import { scheduleErrorClear } from "../lib.js";
import { setChat } from "../chat-store.js";
import { compressPhoto } from "../plans/event-photo-image.js";
import { PHOTO_FAILED, PHOTO_OFFLINE, PHOTO_PREPARING } from "./chat-copy.js";
import { forgetChatPhotos } from "./photo-cache.js";

/** Writes the staged photo to `state` and its signal. */
function setPhoto(photo) {
  state.chatPhoto = photo;
  setChat({ chatPhoto: photo });
}

/** Gives the staged preview's blob URL back and clears the stage. No render: callers decide. */
export function discardPhoto() {
  if (state.chatPhoto?.url) URL.revokeObjectURL(state.chatPhoto.url);
  setPhoto(null);
}

/** Opens the picker. The input is hidden, so a button click stands in for it. */
export function pickPhoto() {
  if (!state.chat || state.chatPhoto?.sending) return;
  document.getElementById("chat-photo-file")?.click();
}

/** A file was chosen: shrink it and stage it in the composer. Nothing is sent until Send. */
export async function onPhotoPicked(event) {
  const input = event.target;
  const file = input.files?.[0];
  input.value = "";
  if (!file || !state.chat) return;
  discardPhoto();
  setPhoto({ blob: null, url: "", busy: true, sending: false, message: PHOTO_PREPARING });
  render();
  try {
    const blob = await compressPhoto(file);
    if (!state.chatPhoto?.busy) return;
    setPhoto({ blob, url: URL.createObjectURL(blob), busy: false, sending: false, message: "" });
  } catch (error) {
    setPhoto(null);
    state.error = error.message || PHOTO_FAILED;
    scheduleErrorClear();
  }
  render();
}

/** The X on the preview: the photo goes, the draft and the reply stay. */
export function cancelPhoto() {
  if (!state.chatPhoto || state.chatPhoto.sending) return;
  discardPhoto();
  render();
}

function sendFailureText(error) {
  if (error.status === 0) return PHOTO_OFFLINE;
  return error.status === 413 || error.status === 415 ? error.message : PHOTO_FAILED;
}

/** The send went through: the thread is the answer, the preview and a replied-to target go. */
function sent(target, chat, replyTo) {
  const here = state.chat?.kind === target.kind && state.chat.id === target.id;
  if (here) {
    state.chatThread = chat;
    noteRainThread(chat);
  }
  discardPhoto();
  if (replyTo && state.chatReplyTo?.id === replyTo) {
    state.chatReplyTo = null;
    setChat({ chatReplyTo: null });
  }
  state.statusMessage = "";
  state.chatStick = true;
  void syncChatAlerts(target);
}

/** Posts the staged photo as its own message, as a reply when the composer has a target. A failure keeps it staged. */
export async function sendStagedPhoto() {
  const photo = state.chatPhoto;
  if (!photo?.blob || photo.sending || !state.chat) return;
  tick();
  const target = { kind: state.chat.kind, id: state.chat.id };
  const replyTo = state.chatReplyTo?.id || null;
  const path = `${chatTargetUrl(target)}/photo${replyTo ? `?replyTo=${encodeURIComponent(replyTo)}` : ""}`;
  setPhoto({ ...photo, sending: true, message: "" });
  try {
    const chat = (await api(path, { method: "POST", raw: photo.blob })).chat;
    sent(target, chat, replyTo);
  } catch (error) {
    if (error.status === 401) return;
    if (state.chatPhoto) setPhoto({ ...state.chatPhoto, sending: false, message: sendFailureText(error) });
  }
  render();
}

/** Leaving the chat: the staged preview and every loaded picture give their blob URLs back. */
export function dropPhotos() {
  discardPhoto();
  forgetChatPhotos();
}
