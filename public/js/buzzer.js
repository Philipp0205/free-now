/**
 * Full-screen "buzzer" overlay: "<Name> is free now", shown when a friend presses their Flic
 * button. The pick/consume/cycle rules are pure and testable; playBuzzer is the only DOM part.
 * Four canvas animations rotate in order. Names are only ever drawn as canvas text (or set with
 * textContent in the reduced-motion variant), never as HTML.
 */

import { birthday } from "./buzzer/birthday-drawer.js";
import { buzzLines } from "./buzzer/birthday-copy.js";
import { BIRTHDAY, payloadAnimation } from "./buzzer/birthday-rules.js";
import { playLizard } from "./buzzer/lizard-sound.js";

export const BUZZ_ANIMATIONS = ["shockwave", "slam", "flood", "bell"];
export const BUZZ_INDEX_KEY = "fn_buzz_index";
export const BUZZ_TEST_INDEX_KEY = "fn_buzz_test_index";
/** The Test button's cycle: the rotation plus birthday once. Kept apart so real buzzes never get birthday. */
const BUZZ_TEST_ANIMATIONS = [...BUZZ_ANIMATIONS, BIRTHDAY];
export const BUZZ_SEEN_KEY = "fn_buzz_seen";
/** A buzz older than this is stale: the app was closed or offline, so it plays nothing. */
export const BUZZ_FRESH_MS = 120000;
/** Clock skew allowed between the server and this phone. */
const BUZZ_FUTURE_MS = 60000;
/** Seconds of canvas animation, including the fade out at the end. */
export const BUZZ_SECONDS = 3.2;
export const BUZZ_NAME_MAX = 24;
const REDUCED_MS = 1800;
const REDUCED_FADE_OUT_AT = 1300;
const DISMISS_MS = 180;

/* ---------- pure rules ---------- */

/** The animation for this press. Remembers the next one in storage, and never throws. */
export function nextBuzzIndex(storage) {
  let index = 0;
  try {
    const raw = storage.getItem(BUZZ_INDEX_KEY);
    if (typeof raw === "string" && /^\d{1,9}$/.test(raw)) index = Number(raw) % BUZZ_ANIMATIONS.length;
  } catch {
    return BUZZ_ANIMATIONS[0];
  }
  try {
    storage.setItem(BUZZ_INDEX_KEY, String((index + 1) % BUZZ_ANIMATIONS.length));
  } catch {
    // The name is still right; the next press may repeat it.
  }
  return BUZZ_ANIMATIONS[index];
}

/** The animation for one Test press, from its own cycle in storage. Never reads or writes fn_buzz_index. */
export function nextTestBuzzAnimation(storage) {
  let index = 0;
  try {
    const raw = storage.getItem(BUZZ_TEST_INDEX_KEY);
    if (typeof raw === "string" && /^\d{1,9}$/.test(raw)) index = Number(raw) % BUZZ_TEST_ANIMATIONS.length;
  } catch {
    return BUZZ_TEST_ANIMATIONS[0];
  }
  try {
    storage.setItem(BUZZ_TEST_INDEX_KEY, String((index + 1) % BUZZ_TEST_ANIMATIONS.length));
  } catch {
    // The name is still right; the next press may repeat it.
  }
  return BUZZ_TEST_ANIMATIONS[index];
}

function isTime(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/** The social with the newest fresh, unseen buzz, or null. */
export function pickBuzz(socials, seenAt, now) {
  const seen = isTime(seenAt) ? seenAt : 0;
  if (!Array.isArray(socials) || !isTime(now)) return null;
  let best = null;
  for (const social of socials) {
    const at = social && social.buzzedAt;
    if (!isTime(at) || at <= seen) continue;
    if (now - at > BUZZ_FRESH_MS || at - now > BUZZ_FUTURE_MS) continue;
    if (!best || at > best.buzzedAt) best = social;
  }
  return best;
}

/**
 * The buzz to play for this list of socials, once. The seen marker always moves up to the newest
 * buzz in the list, so an old one is never replayed and a stale one is skipped silently.
 */
export function consumeBuzz(socials, storage, now = Date.now()) {
  let seen = 0;
  try {
    const raw = Number(storage.getItem(BUZZ_SEEN_KEY));
    if (Number.isFinite(raw) && raw > 0) seen = raw;
  } catch {
    seen = 0;
  }
  const social = pickBuzz(socials, seen, now);
  let newest = seen;
  if (Array.isArray(socials)) {
    for (const item of socials) if (item && isTime(item.buzzedAt) && item.buzzedAt > newest) newest = item.buzzedAt;
  }
  if (newest > seen) {
    try {
      storage.setItem(BUZZ_SEEN_KEY, String(newest));
    } catch {
      // Without storage a buzz can replay on the next load; the freshness window bounds that.
    }
  }
  if (!social) return null;
  const creator = social.creator && social.creator.name;
  const animation = payloadAnimation(social);
  return { social, name: String(creator ?? social.creatorName ?? "").trim() || "Someone", ...(animation ? { animation } : {}) };
}

/** A name that is safe to draw: one line, at most BUZZ_NAME_MAX characters, never empty. */
export function cleanBuzzName(name) {
  const flat = String(name ?? "").replace(/\s+/g, " ").trim();
  const chars = [...flat].slice(0, BUZZ_NAME_MAX).join("").trim();
  return chars || "Someone";
}

/**
 * Fits `text` (plus a fixed `suffix`) into `maxW`. Shrinks the font first, down to `minSize`,
 * then cuts the text with an ellipsis. `measure(str, size)` returns a width.
 */
export function fitText(measure, text, size, maxW, minSize, suffix = "") {
  const width = (str, px) => measure(str + suffix, px);
  let px = size;
  const full = width(text, px);
  if (full > maxW) px = Math.max(minSize, Math.floor((size * maxW) / full));
  let out = text;
  if (width(out, px) > maxW) {
    const chars = [...text];
    while (chars.length > 1 && width(chars.join("").trimEnd() + "\u2026", px) > maxW) chars.pop();
    out = chars.join("").trimEnd() + "\u2026";
  }
  return { text: out, size: px };
}

/**
 * One frame of the shake. The canvas content moves by (dx, dy) and the dim background is drawn
 * oversized (x, y, w, h) so the moved picture never shows a gap. The page behind never shifts.
 */
export function buzzerStage(width, height, amp, rand = Math.random) {
  const on = amp > 0.05;
  const pad = on ? Math.ceil(amp) + 1 : 0;
  return {
    dx: on ? (rand() - 0.5) * 2 * amp : 0,
    dy: on ? (rand() - 0.5) * 2 * amp : 0,
    x: 0 - pad || 0,
    y: 0 - pad || 0,
    w: width + pad * 2,
    h: height + pad * 2,
  };
}

/* ---------- animation helpers ---------- */

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const easeOut = (t) => 1 - Math.pow(1 - clamp(t), 3);
const easeOutBack = (t) => {
  t = clamp(t);
  const c = 1.9;
  return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
};
const easeInOut = (t) => {
  t = clamp(t);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};
const seg = (t, a, b) => clamp((t - a) / (b - a));

/** Deterministic random so every take looks the same. */
function makeRandom(seed = 1234567) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const FONT = '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif';

/** The Spontaco orb. */
function orb(ctx, x, y, r, glow = 1) {
  ctx.save();
  ctx.shadowColor = "rgba(255,50,120," + 0.75 * glow + ")";
  ctx.shadowBlur = r * 0.9 * glow;
  const g = ctx.createLinearGradient(x - r * 0.7, y - r * 0.7, x + r * 0.7, y + r * 0.7);
  g.addColorStop(0, "#ff5ec8");
  g.addColorStop(0.42, "#ff2d78");
  g.addColorStop(0.7, "#ff3a3a");
  g.addColorStop(1, "#ff6a24");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, 7);
  ctx.fill();
  ctx.shadowBlur = 0;
  const h = ctx.createRadialGradient(x - r * 0.32, y - r * 0.38, 0, x - r * 0.32, y - r * 0.38, r * 0.62);
  h.addColorStop(0, "rgba(255,255,255,.92)");
  h.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = h;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, 7);
  ctx.fill();
  ctx.restore();
}

/** Rounded rectangle path without relying on ctx.roundRect (older Safari lacks it). */
function pillPath(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Fits the name for a given font; sets ctx.font to the fitted size. */
function fitName(ctx, name, weight, size, maxW, suffix = "", style = "") {
  const font = (px) => style + weight + " " + px + "px " + FONT;
  const measure = (str, px) => {
    ctx.font = font(px);
    return ctx.measureText(str).width;
  };
  const fit = fitText(measure, name, size, maxW, Math.round(size * 0.4), suffix);
  ctx.font = font(fit.size);
  return fit;
}

/* ---------- the four animations ---------- */
/* Each has setup(s) -> state and draw(s, st, t). `s` holds ctx, W, H, name and the random streams. */

const shockwave = {
  setup(s) {
    const fit = fitName(s.ctx, s.name, 700, 54, s.W * 0.78);
    return { rings: [0, 0.12, 0.26, 0.42, 0.6, 0.8].map((d, i) => ({ d, w: 10 - i })), name: fit.text, size: fit.size };
  },
  draw(s, st, t) {
    const { ctx, W, H } = s;
    const fade = 1 - seg(t, 2.7, 3.2);
    const inT = seg(t, 0, 0.35);
    const stage = buzzerStage(W, H, Math.max(0, 1 - t / 1.1) * 14 * fade, s.rand);
    ctx.translate(stage.dx, stage.dy);
    ctx.globalAlpha = fade;
    // dim
    ctx.fillStyle = "rgba(0,0,0," + 0.72 * easeOut(inT) + ")";
    ctx.fillRect(stage.x, stage.y, stage.w, stage.h);
    const cx = W / 2;
    const cy = H * 0.42;
    const maxR = Math.hypot(W, H) * 0.75;
    // pink bloom
    const bl = ctx.createRadialGradient(cx, cy, 0, cx, cy, W * (0.6 + 0.5 * Math.sin(t * 5) * 0.1));
    bl.addColorStop(0, "rgba(255,45,120," + 0.55 * easeOut(inT) + ")");
    bl.addColorStop(1, "rgba(255,45,120,0)");
    ctx.fillStyle = bl;
    ctx.fillRect(stage.x, stage.y, stage.w, stage.h);
    // shock rings
    for (const r of st.rings) {
      const p = seg(t, 0.1 + r.d, 1.7 + r.d);
      if (p <= 0 || p >= 1) continue;
      const rad = easeOut(p) * maxR;
      ctx.beginPath();
      ctx.arc(cx, cy, rad, 0, 7);
      ctx.lineWidth = r.w * (1 - p) + 1.5;
      const g = ctx.createLinearGradient(cx - rad, cy - rad, cx + rad, cy + rad);
      g.addColorStop(0, "rgba(255,94,200," + (1 - p) + ")");
      g.addColorStop(0.5, "rgba(255,58,58," + (1 - p) + ")");
      g.addColorStop(1, "rgba(255,106,36," + (1 - p) + ")");
      ctx.strokeStyle = g;
      ctx.shadowColor = "rgba(255,50,120,.9)";
      ctx.shadowBlur = 24;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
    // white flash
    if (t < 0.25) {
      ctx.fillStyle = "rgba(255,255,255," + 0.85 * (1 - t / 0.25) + ")";
      ctx.fillRect(stage.x, stage.y, stage.w, stage.h);
    }
    // orb: slam in, then heartbeat
    const sc = t < 0.45 ? easeOutBack(seg(t, 0, 0.45)) : 1 + 0.07 * Math.sin((t - 0.45) * 9) * Math.exp(-(t - 0.45) * 1.1);
    orb(ctx, cx, cy, 78 * sc, 1.3);
    // text
    const tp = easeOutBack(seg(t, 0.45, 0.9));
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.save();
    ctx.translate(cx, H * 0.66);
    ctx.scale(tp, tp);
    ctx.fillStyle = "#fff";
    ctx.font = "700 " + st.size + "px " + FONT;
    ctx.shadowColor = "rgba(255,45,120,.8)";
    ctx.shadowBlur = 22;
    ctx.fillText(st.name, 0, 0);
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#d1d1d6";
    ctx.font = "500 24px " + FONT;
    ctx.fillText("is free now", 0, 46);
    ctx.restore();
    ctx.globalAlpha = 1;
  },
};

const slam = {
  setup(s) {
    const { ctx, W } = s;
    // The pill is name + " is free now" at weight 800; the 56px is its horizontal padding.
    const fit = fitName(ctx, s.name, 800, 30, W - 24 - 56, " is free now");
    // The headline is 118px wide-set; shrink it only when a narrow phone would clip it.
    ctx.font = "900 italic 118px " + FONT;
    // Strokes and extrusion add about 40px around the letters.
    const headline = Math.max(48, Math.min(118, Math.floor((118 * (W - 24)) / (ctx.measureText("BUZZ!").width + 40))));
    return { label: fit.text + " is free now", size: fit.size, headline };
  },
  draw(s, st, t) {
    const { ctx, W, H } = s;
    const fade = 1 - seg(t, 2.75, 3.2);
    const cx = W / 2;
    const cy = H * 0.42;
    const slamP = seg(t, 0.05, 0.3);
    const imp = Math.exp(-Math.max(0, t - 0.3) * 2.2);
    const stage = buzzerStage(W, H, (t > 0.3 ? 18 * imp : 0) * fade, s.rand);
    ctx.translate(stage.dx, stage.dy);
    ctx.globalAlpha = fade;
    ctx.fillStyle = "rgba(10,0,20," + 0.85 * easeOut(seg(t, 0, 0.2)) + ")";
    ctx.fillRect(stage.x, stage.y, stage.w, stage.h);
    // sunburst rays, rotating
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(t * 0.35);
    const n = 18;
    const R = Math.hypot(W, H);
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2;
      const a1 = a0 + Math.PI / n;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(a0) * R, Math.sin(a0) * R);
      ctx.lineTo(Math.cos(a1) * R, Math.sin(a1) * R);
      ctx.closePath();
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 0.6);
      g.addColorStop(0, "rgba(255,90,60," + 0.75 * easeOut(slamP) + ")");
      g.addColorStop(1, "rgba(255,45,120,0)");
      ctx.fillStyle = g;
      ctx.fill();
    }
    ctx.restore();
    // halftone dots
    ctx.fillStyle = "rgba(255,255,255," + 0.08 * easeOut(slamP) + ")";
    for (let y = 0; y < H; y += 16) {
      for (let x = (y / 16 % 2) * 8; x < W; x += 16) {
        ctx.beginPath();
        ctx.arc(x, y, 3 * (1 - y / H) + 1, 0, 7);
        ctx.fill();
      }
    }
    // BUZZ!
    const sc = t < 0.3 ? lerp(5, 1, easeOut(slamP)) : 1 + 0.06 * Math.sin((t - 0.3) * 22) * imp;
    const jx = t > 0.3 ? (s.rand() - 0.5) * 8 * imp * 2 : 0;
    const jy = t > 0.3 ? (s.rand() - 0.5) * 8 * imp * 2 : 0;
    ctx.save();
    ctx.translate(cx + jx, cy + jy);
    ctx.rotate(-0.13);
    ctx.scale(sc, sc);
    ctx.globalAlpha = fade * easeOut(seg(t, 0.05, 0.15));
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.font = "900 italic " + st.headline + "px " + FONT;
    // layered extrusion
    for (let i = 14; i > 0; i--) {
      ctx.fillStyle = i % 2 ? "#2a0a3a" : "#1a0526";
      ctx.fillText("BUZZ!", i * 0.9, i * 1.1);
    }
    ctx.lineWidth = 22;
    ctx.strokeStyle = "#fff";
    ctx.strokeText("BUZZ!", 0, 0);
    ctx.lineWidth = 10;
    ctx.strokeStyle = "#12031c";
    ctx.strokeText("BUZZ!", 0, 0);
    const g = ctx.createLinearGradient(0, -60, 0, 60);
    g.addColorStop(0, "#ffe14a");
    g.addColorStop(0.45, "#ff6a24");
    g.addColorStop(1, "#ff2d78");
    ctx.fillStyle = g;
    ctx.fillText("BUZZ!", 0, 0);
    ctx.restore();
    ctx.globalAlpha = fade;
    // impact flash
    if (t < 0.3 && t > 0.25) {
      ctx.fillStyle = "rgba(255,255,255,.9)";
      ctx.fillRect(stage.x, stage.y, stage.w, stage.h);
    }
    if (t >= 0.3 && t < 0.6) {
      ctx.fillStyle = "rgba(255,255,255," + 0.7 * (1 - (t - 0.3) / 0.3) + ")";
      ctx.fillRect(stage.x, stage.y, stage.w, stage.h);
    }
    // name pill slides up
    const p = easeOutBack(seg(t, 0.7, 1.15));
    const py = lerp(H + 60, H * 0.68, p);
    ctx.save();
    ctx.translate(cx, py);
    ctx.rotate(0.03 * (1 - p));
    ctx.font = "800 " + st.size + "px " + FONT;
    const w = ctx.measureText(st.label).width + 56;
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    pillPath(ctx, -w / 2 - 4, -34, w + 8, 76, 38);
    ctx.fill();
    const pg = ctx.createLinearGradient(-w / 2, 0, w / 2, 0);
    pg.addColorStop(0, "#ff2d78");
    pg.addColorStop(1, "#ff6a24");
    ctx.fillStyle = pg;
    ctx.beginPath();
    pillPath(ctx, -w / 2, -30, w, 68, 34);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(st.label, 0, 4);
    ctx.restore();
    ctx.globalAlpha = 1;
  },
};

const flood = {
  setup(s) {
    const { ctx, W, rng } = s;
    const fit = fitName(ctx, s.name, 800, 76, W * 0.88);
    const drops = Array.from({ length: 26 }, () => ({ x: rng() * W || rng() * 390, v: 260 + rng() * 380, s: 3 + rng() * 6, d: 0.25 + rng() * 0.6 }));
    return { drops, name: fit.text, size: fit.size };
  },
  draw(s, st, t) {
    const { ctx, W, H } = s;
    const surfaceY = (x, tt, level) => level + Math.sin(x / 38 + tt * 7) * 14 * (1 - seg(tt, 1.2, 1.6) * 0.7) + Math.sin(x / 17 - tt * 5) * 6;
    const fade = 1 - seg(t, 2.75, 3.2);
    const rise = easeInOut(seg(t, 0, 1.05));
    const level = lerp(H + 30, -40, rise);
    ctx.globalAlpha = fade;
    // two waves back to front
    for (const [off, col0, col1] of [[22, "#ff6a24", "#ff3a3a"], [0, "#ff5ec8", "#ff2d78"]]) {
      const g = ctx.createLinearGradient(0, 0, W * 0.4, H);
      g.addColorStop(0, col0);
      g.addColorStop(1, col1);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(0, H + 5);
      for (let x = 0; x <= W; x += 6) ctx.lineTo(x, surfaceY(x + (off ? 90 : 0), t + (off ? 0.13 : 0), level + off));
      ctx.lineTo(W, H + 5);
      ctx.closePath();
      ctx.fill();
    }
    // bubbles / droplets thrown up
    ctx.fillStyle = "rgba(255,255,255,.85)";
    for (const d of st.drops) {
      const p = t - d.d;
      if (p < 0 || p > 1.4) continue;
      const y = H * 0.55 - d.v * p + 700 * p * p;
      const a = 1 - p / 1.4;
      ctx.globalAlpha = fade * a;
      ctx.beginPath();
      ctx.arc(d.x, y, d.s, 0, 7);
      ctx.fill();
    }
    ctx.globalAlpha = fade;
    // ripples from bottom centre
    for (let i = 0; i < 3; i++) {
      const p = seg(t, 0.15 + i * 0.28, 1.5 + i * 0.28);
      if (p <= 0 || p >= 1) continue;
      ctx.beginPath();
      ctx.ellipse(W / 2, H * 0.9, easeOut(p) * W * 0.9, easeOut(p) * W * 0.35, 0, 0, 7);
      ctx.strokeStyle = "rgba(255,255,255," + 0.55 * (1 - p) + ")";
      ctx.lineWidth = 4 * (1 - p) + 1;
      ctx.stroke();
    }
    // bouncing letters
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const drawLine = (str, y, size, weight, t0, col) => {
      ctx.font = weight + " " + size + "px " + FONT;
      const chars = [...str];
      const widths = chars.map((ch) => ctx.measureText(ch).width);
      const total = widths.reduce((a, b) => a + b, 0);
      let x = W / 2 - total / 2;
      chars.forEach((ch, i) => {
        const p = seg(t, t0 + i * 0.045, t0 + i * 0.045 + 0.55);
        const bounce = p <= 0 ? 0 : 1 - Math.abs(Math.cos(p * Math.PI * 2.5)) * Math.pow(1 - p, 1.2);
        const y0 = y - (1 - bounce) * H * 0.5;
        const sq = p > 0 && p < 0.4 ? 1 + 0.15 * Math.sin((p / 0.4) * Math.PI) : 1;
        ctx.save();
        ctx.translate(x + widths[i] / 2, y0);
        ctx.scale(1 / sq, sq);
        ctx.rotate((1 - p) * (i % 2 ? 0.3 : -0.3));
        ctx.globalAlpha = fade * (p > 0 ? 1 : 0);
        ctx.fillStyle = col;
        ctx.shadowColor = "rgba(120,0,40,.45)";
        ctx.shadowBlur = 16;
        ctx.shadowOffsetY = 5;
        ctx.fillText(ch, 0, 0);
        ctx.restore();
        x += widths[i];
      });
    };
    drawLine(st.name, H * 0.42, st.size, 800, 0.5, "#fff");
    drawLine("is free now", H * 0.42 + Math.round(st.size * 0.87), 30, 600, 0.85, "#fff");
    ctx.globalAlpha = 1;
  },
};

const BELL_COLORS = ["#ff5ec8", "#ff2d78", "#ff6a24", "#ffd23f", "#ffffff", "#7be0ff"];

function bell(ctx, x, y, s, swing) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(swing);
  ctx.scale(s, s);
  const g = ctx.createLinearGradient(-50, -60, 50, 60);
  g.addColorStop(0, "#ffd23f");
  g.addColorStop(0.5, "#ff9a3a");
  g.addColorStop(1, "#ff3a3a");
  ctx.shadowColor = "rgba(255,150,60,.8)";
  ctx.shadowBlur = 40;
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(0, -62);
  ctx.bezierCurveTo(-8, -62, -12, -56, -12, -50);
  ctx.bezierCurveTo(-48, -40, -52, 0, -58, 30);
  ctx.lineTo(-68, 44);
  ctx.lineTo(68, 44);
  ctx.lineTo(58, 30);
  ctx.bezierCurveTo(52, 0, 48, -40, 12, -50);
  ctx.bezierCurveTo(12, -56, 8, -62, 0, -62);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.beginPath();
  ctx.arc(0, -66, 8, 0, 7);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,.55)";
  ctx.beginPath();
  ctx.ellipse(-24, -6, 7, 26, 0.25, 0, 7);
  ctx.fill();
  // clapper
  const cl = -swing * 1.8;
  ctx.fillStyle = "#ff3a3a";
  ctx.beginPath();
  ctx.arc(Math.sin(cl) * 14, 58 + Math.abs(Math.cos(cl)) * 4, 13, 0, 7);
  ctx.fill();
  ctx.restore();
}

const bellConfetti = {
  setup(s) {
    const { rng } = s;
    const fit = fitName(s.ctx, s.name, 800, 60, s.W * 0.78);
    const parts = Array.from({ length: 110 }, () => {
      const a = -Math.PI / 2 + (rng() - 0.5) * 2.6;
      const v = 300 + rng() * 620;
      return {
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v,
        w: 5 + rng() * 8,
        h: 3 + rng() * 7,
        c: BELL_COLORS[(rng() * BELL_COLORS.length) | 0],
        rot: rng() * 6,
        vr: (rng() - 0.5) * 16,
        round: rng() < 0.3,
        wob: rng() * 6,
      };
    });
    return { parts, name: fit.text, size: fit.size };
  },
  draw(s, st, t) {
    const { ctx, W, H } = s;
    const fade = 1 - seg(t, 2.7, 3.2);
    const inT = easeOut(seg(t, 0, 0.3));
    const cx = W / 2;
    const cy = H * 0.34;
    ctx.globalAlpha = fade;
    ctx.fillStyle = "rgba(8,4,18," + 0.8 * inT + ")";
    ctx.fillRect(0, 0, W, H);
    const bl = ctx.createRadialGradient(cx, cy, 0, cx, cy, W * 0.9);
    bl.addColorStop(0, "rgba(255,90,60," + 0.4 * inT + ")");
    bl.addColorStop(1, "rgba(255,45,120,0)");
    ctx.fillStyle = bl;
    ctx.fillRect(0, 0, W, H);
    // sound waves: arcs left and right, repeated pulses synced to bell swings
    for (let k = 0; k < 8; k++) {
      const p = seg(t, 0.2 + k * 0.22, 1.3 + k * 0.22);
      if (p <= 0 || p >= 1) continue;
      const r = 60 + easeOut(p) * Math.max(W, H) * 0.9;
      ctx.lineWidth = 7 * (1 - p) + 1;
      ctx.strokeStyle = "rgba(255," + (120 + k * 10) + ",120," + 0.8 * (1 - p) + ")";
      ctx.shadowColor = "rgba(255,90,90,.8)";
      ctx.shadowBlur = 14;
      for (const dir of [0, Math.PI]) {
        ctx.beginPath();
        ctx.arc(cx, cy, r, dir - 0.75, dir + 0.75);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(cx, cy, r, -Math.PI / 2 - 0.4, -Math.PI / 2 + 0.4);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, r, Math.PI / 2 - 0.4, Math.PI / 2 + 0.4);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
    // bell
    const drop = easeOutBack(seg(t, 0, 0.4));
    const swing = Math.sin(t * 16) * 0.5 * Math.exp(-Math.max(0, t - 0.3) * 1.1);
    bell(ctx, cx, cy, 1.25 * drop, swing);
    // confetti burst from the bell
    for (const p of st.parts) {
      const q = t - 0.25;
      if (q < 0) continue;
      const drag = Math.exp(-q * 1.4);
      const x = cx + (p.vx * (1 - drag)) / 1.4 + Math.sin(q * 4 + p.wob) * 10;
      const y = cy + (p.vy * (1 - drag)) / 1.4 + 520 * q * q * 0.5;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(p.rot + p.vr * q);
      ctx.fillStyle = p.c;
      ctx.scale(1, Math.cos(q * 9 + p.wob));
      if (p.round) {
        ctx.beginPath();
        ctx.arc(0, 0, p.w / 2, 0, 7);
        ctx.fill();
      } else {
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      }
      ctx.restore();
    }
    // text
    const tp = easeOutBack(seg(t, 0.55, 1.0));
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.save();
    ctx.translate(cx, H * 0.64);
    ctx.scale(tp, tp);
    ctx.font = "800 " + st.size + "px " + FONT;
    ctx.fillStyle = "#fff";
    ctx.shadowColor = "rgba(255,150,60,.85)";
    ctx.shadowBlur = 26;
    ctx.fillText(st.name, 0, 0);
    ctx.shadowBlur = 0;
    ctx.font = "500 26px " + FONT;
    ctx.fillStyle = "#d1d1d6";
    ctx.fillText("is free now", 0, 50);
    ctx.restore();
    ctx.globalAlpha = 1;
  },
};

const DRAWERS = { shockwave, slam, flood, bell: bellConfetti, birthday };

/* ---------- DOM ---------- */

/** True when the phone asks for less motion. */
export function prefersReducedMotion() {
  try {
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches === true;
  } catch {
    return false;
  }
}

let active = null;

/** True while an overlay is on screen. */
export function buzzerPlaying() {
  return active !== null;
}

/**
 * Plays the overlay. Returns false (and does nothing) while another one is on screen, true when
 * it started. Tap or a key press dismisses it. Nothing stays in the DOM or running afterwards.
 * `sound: true` also plays the short lizard clip, whatever the motion setting.
 */
export function playBuzzer({ name, animation, onEnd, sound } = {}) {
  if (active || typeof document === "undefined") return false;
  const who = cleanBuzzName(name);
  const lines = buzzLines(animation, who);
  const drawer = DRAWERS[animation] || DRAWERS[BUZZ_ANIMATIONS[0]];

  const overlay = document.createElement("div");
  overlay.className = "buzzer";
  overlay.dataset.animation = DRAWERS[animation] ? animation : BUZZ_ANIMATIONS[0];
  overlay.setAttribute("role", "status");
  overlay.setAttribute("aria-live", "assertive");

  let canvas = null;
  let ctx = null;
  const reduced = prefersReducedMotion();
  if (!reduced) {
    canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    try {
      ctx = canvas.getContext("2d");
    } catch {
      ctx = null;
    }
  }
  const still = reduced || !ctx;

  let raf = 0;
  let ended = false;
  const timers = new Set();
  const later = (fn, ms) => {
    const id = setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms);
    timers.add(id);
  };

  const listeners = [];
  const listen = (target, type, fn, options) => {
    target.addEventListener(type, fn, options);
    listeners.push(() => target.removeEventListener(type, fn, options));
  };

  const cleanup = () => {
    if (ended) return;
    ended = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    for (const id of timers) clearTimeout(id);
    timers.clear();
    for (const off of listeners) off();
    overlay.remove();
    active = null;
    if (typeof onEnd === "function") {
      try {
        onEnd();
      } catch {
        // A failing callback must not leave the overlay behind.
      }
    }
  };

  const dismiss = () => {
    if (ended || overlay.dataset.leaving) return;
    overlay.dataset.leaving = "1";
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    for (const id of timers) clearTimeout(id);
    timers.clear();
    overlay.style.transition = "opacity " + DISMISS_MS + "ms ease";
    overlay.style.opacity = "0";
    later(cleanup, DISMISS_MS + 20);
  };

  // The overlay swallows taps: a tap dismisses it and never reaches the page below.
  listen(overlay, "click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    dismiss();
  });
  listen(document, "keydown", () => dismiss());

  active = overlay;
  if (sound) playLizard();
  if (still) {
    overlay.classList.add("reduced");
    const nameEl = document.createElement("div");
    nameEl.className = "buzzer-name";
    nameEl.setAttribute("aria-hidden", "true");
    nameEl.textContent = lines.name;
    const subEl = document.createElement("div");
    subEl.className = "buzzer-sub";
    subEl.setAttribute("aria-hidden", "true");
    subEl.textContent = lines.sub;
    overlay.append(nameEl, subEl);
  } else {
    overlay.append(canvas);
  }
  document.body.append(overlay);
  // Added after the live region is in the page so screen readers announce it.
  const sr = document.createElement("span");
  sr.className = "buzzer-sr";
  sr.textContent = lines.sr;
  overlay.append(sr);

  if (still) {
    void overlay.offsetWidth;
    later(() => overlay.classList.add("show"), 30);
    later(() => overlay.classList.remove("show"), REDUCED_FADE_OUT_AT);
    later(cleanup, REDUCED_MS);
    return true;
  }

  const state = { ctx, W: 0, H: 0, DPR: 1, name: who, rng: makeRandom(), rand: makeRandom(7654321) };
  let drawState = null;
  const layout = () => {
    state.DPR = window.devicePixelRatio || 1;
    state.W = overlay.clientWidth || window.innerWidth;
    state.H = overlay.clientHeight || window.innerHeight;
    canvas.width = Math.round(state.W * state.DPR);
    canvas.height = Math.round(state.H * state.DPR);
    state.rng = makeRandom();
    drawState = drawer.setup(state);
  };
  layout();
  listen(window, "resize", layout);

  let t0 = null;
  const frame = (now) => {
    raf = 0;
    if (ended || overlay.dataset.leaving) return;
    if (t0 === null) t0 = now;
    const t = (now - t0) / 1000;
    if (t >= BUZZ_SECONDS) {
      cleanup();
      return;
    }
    ctx.setTransform(state.DPR, 0, 0, state.DPR, 0, 0);
    ctx.clearRect(0, 0, state.W, state.H);
    ctx.save();
    try {
      drawer.draw(state, drawState, Math.max(0, t));
    } finally {
      ctx.restore();
    }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return true;
}
