import { state } from "./state.js";
import { isNetworkFailure, noteConnectionProblem, scheduleOfflineRetry } from "./session.js";
import { render } from "./render.js";

export const ICONS = {
  home: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4.2 10.6 12 4l7.8 6.6V20a1 1 0 0 1-1 1h-4.6v-6.2H9.8V21H5.2a1 1 0 0 1-1-1z"/></svg>',
  compass: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="8.25" stroke="currentColor" stroke-width="1.8"/><path d="m14.8 9.2-1.3 4.3-4.3 1.3 1.3-4.3z" fill="currentColor"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="5" stroke="currentColor" stroke-width="1.8"/><path d="M12 8.2v7.6M8.2 12h7.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6.2 16.5h11.6l-1.1-1.6a6.8 6.8 0 0 1-1-3.5V9.6a3.7 3.7 0 0 0-7.4 0v1.8c0 1.3-.3 2.5-1 3.5z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M10 17.2a2 2 0 0 0 4 0" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  person: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="8.2" r="3.1" stroke="currentColor" stroke-width="1.8"/><path d="M5.6 19.2c.8-2.8 3.2-4.2 6.4-4.2s5.6 1.4 6.4 4.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  add: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  map: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 21s6-5.2 6-10a6 6 0 1 0-12 0c0 4.8 6 10 6 10z" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="11" r="2.1" fill="currentColor"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="4" y="5.5" width="16" height="14.5" rx="3" stroke="currentColor" stroke-width="1.8"/><path d="M8.5 3.5v4M15.5 3.5v4M4 10.5h16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M8.5 14.2h.01M12 14.2h.01M15.5 14.2h.01M8.5 17h.01M12 17h.01" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  people: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="9" cy="8.5" r="2.8" stroke="currentColor" stroke-width="1.8"/><path d="M3.8 18.5c.6-2.6 2.6-4 5.2-4s4.6 1.4 5.2 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M15.2 6.2a2.6 2.6 0 0 1 0 5M17 14.7c1.6.5 2.7 1.8 3.2 3.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 6.5 15 12l-6 5.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7.2 16.2 5 19.2c-.3.4.1 1 .6.8l3.2-.9A7.2 7.2 0 1 0 7.2 16.2Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 14.5V4.5M8.2 8 12 4.2 15.8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 11H6.5a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-7a1 1 0 0 0-1-1H16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  more: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><circle cx="19" cy="12" r="1.8" fill="currentColor"/></svg>',
  reply: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9.5 7 5 11.5 9.5 16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M5.5 11.5h8a5 5 0 0 1 5 5v1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
};

export function isTyping() {
  const tag = document.activeElement?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA";
}

/** The person's own zone: the one saved with their status or hours, else this device's, else the app's. */
export function userTz() {
  return state.me?.user?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || appTz();
}

export function isLiveSocial(social) {
  return !social?.startsAt || social.startsAt <= Date.now();
}

export function clock(ms) {
  const tz = state.meta?.tz || "Europe/Berlin";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(ms));
}

export function appTz() {
  return state.meta?.tz || "Europe/Berlin";
}

/** This device's zone. Busy-until and availability clocks are shown in it, whatever zone the setter used. */
export function viewerTz() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || appTz();
}

export function mapsHref(lat, lng, label) {
  const name = encodeURIComponent(label || "Spontaco");
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (ios) return `https://maps.apple.com/?ll=${lat},${lng}&q=${name}`;
  if (/android/i.test(navigator.userAgent)) return `geo:${lat},${lng}?q=${lat},${lng}(${name})`;
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}

export function field(label, id, value, onValue, attrs = {}) {
  return el("label", { class: "field" }, [
    el("span", { text: label }),
    el("input", {
      id,
      type: "text",
      value,
      autocomplete: "off",
      ...attrs,
      oninput: (event) => onValue(event.target.value),
    }),
  ]);
}

export function icon(name) {
  const node = el("span", { class: "icon" });
  node.innerHTML = ICONS[name];
  return node;
}

/** Placeholder rows (avatar circle and two lines) for a list that waits on a fetch. The container announces "Loading". */
export function skeletonList(count = 3, cls = "") {
  const rows = Array.from({ length: count }, () => el("div", { class: "skel-row", "aria-hidden": "true" }, [
    el("span", { class: "ak-skeleton ak-skeleton-circle", "aria-hidden": "true" }),
    el("div", { class: "skel-lines", "aria-hidden": "true" }, [
      el("span", { class: "ak-skeleton ak-skeleton-line", "aria-hidden": "true" }),
      el("span", { class: "ak-skeleton ak-skeleton-line ak-skeleton-short", "aria-hidden": "true" }),
    ]),
  ]));
  return el("div", { class: `skel-list ${cls}`.trim(), "aria-busy": "true" }, [
    el("span", { class: "visually-hidden", text: "Loading" }),
    ...rows,
  ]);
}

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = String(value);
    else if (key === "style") node.setAttribute("style", value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (key === "disabled") node.disabled = Boolean(value);
    else if (key === "checked") node.checked = Boolean(value);
    else node.setAttribute(key, String(value));
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** Same rules as the server's cleanPaymentUrl. Returns the error text, or "" when the link is fine or empty. */
export function paymentUrlError(value) {
  const text = String(value).trim();
  if (!text) return "";
  if (text.length > 200) return "Link is too long";
  if (!/^https:\/\//i.test(text)) return "Links must start with https://";
  const bad = "Use a paypal.me link, for example https://paypal.me/yourname";
  let url;
  try {
    url = new URL(text);
  } catch {
    return bad;
  }
  const hasPort = /^https:\/\/[^/\\?#]*:\d*(?:[/\\?#]|$)/i.test(text);
  const path = url.hostname === "www.paypal.com" ? /^\/paypalme\/[^/]/ : /^\/[^/]/;
  const host = ["paypal.me", "www.paypal.me", "www.paypal.com"].includes(url.hostname);
  return url.username || url.password || url.port || hasPort || !host || !path.test(url.pathname) ? bad : "";
}

/** A "Pay" link to another member's payment link. Nothing for yourself or without an https link. */
export function payLink(person, cls = "text-btn pay-link") {
  const url = person?.paymentUrl;
  if (!person || person.id === state.me?.user?.id || typeof url !== "string" || !url.startsWith("https://")) return null;
  return el("a", { class: cls, href: url, target: "_blank", rel: "noopener noreferrer", text: "Pay", "aria-label": `Pay ${person.name}` });
}

/** Same rules as the server's cleanWeroEmail. Returns the error text, or "" when the address is fine or empty. */
export function weroEmailError(value) {
  const text = String(value).trim();
  return !text || (text.length <= 254 && /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(text)) ? "" : "Enter a valid email";
}

/** Another member's Wero email with a copy button. Nothing for yourself or without an address. */
export function weroEntry(person, cls = "wero-entry") {
  const email = person?.weroEmail;
  if (!person || person.id === state.me?.user?.id || typeof email !== "string" || !email) return null;
  return el("div", { class: cls }, [
    el("span", { class: "wero-tag", text: "Wero" }),
    el("span", { class: "wero-email", text: email }),
    el("button", {
      class: "text-btn",
      type: "button",
      text: "Copy",
      "aria-label": `Copy Wero email for ${person.name}`,
      onclick: () => { void copyText(email, "Copied"); },
    }),
  ]);
}

export async function run(fn, keepError = "") {
  state.error = keepError;
  try {
    await fn();
  } catch (error) {
    if (isNetworkFailure(error) || error.status >= 500) {
      noteConnectionProblem(error);
      scheduleOfflineRetry(1000);
      state.error = isNetworkFailure(error) ? "You're offline. Try again." : "Something went wrong. Try again.";
    } else {
      state.error = error.message || "Something went wrong. Try again.";
    }
  }
  render();
  scheduleErrorClear();
}

export function scheduleErrorClear() {
  const message = state.error;
  if (!message) return;
  clearTimeout(state.errorTimer);
  state.errorTimer = setTimeout(() => {
    if (state.error === message) {
      state.error = "";
      render();
    }
  }, 3200);
}

let copyTimer = 0;

export async function copyText(value, message) {
  try {
    await navigator.clipboard.writeText(value);
    state.error = message;
  } catch {
    state.error = value;
  }
  render();
  // A second copy right after the first keeps its own full toast time.
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => {
    if (state.error === message) {
      state.error = "";
      render();
    }
  }, 2200);
}

export function mySocial() {
  return state.socials.find((social) => social.creator.id === state.me?.user.id) ?? null;
}

export function remaining(expiresAt) {
  const minutes = Math.max(0, Math.round((expiresAt - Date.now()) / 60000));
  if (minutes < 1) return "ending";
  if (minutes < 60) return `${minutes}m left`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m left`;
}

export function ago(ts) {
  const seconds = Math.max(0, (Date.now() - Number(ts || 0)) / 1000);
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} d ago`;
}

export function ttlLabel(ms) {
  const hours = ms / 3600000;
  if (Math.abs(hours - 2) < 0.05) return "about 2 hours";
  if (hours >= 1) return `about ${Math.round(hours)} hours`;
  return `about ${Math.round(ms / 60000)} minutes`;
}

/** The server picks one color per person and sends it with every user it lists. */
export function colorFor(person) {
  return person?.color || "#636366";
}

export function initial(name) {
  const char = Array.from(name || "?")[0] || "?";
  return char.toUpperCase();
}

export function base64UrlToUint8(base64Url) {
  const padded = `${base64Url}${"=".repeat((4 - (base64Url.length % 4)) % 4)}`.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
