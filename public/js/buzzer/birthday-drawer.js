/**
 * The birthday buzzer drawer: a cake with candles, balloons and confetti, then "Happy birthday <name>".
 * Same contract as the four rotating drawers in buzzer.js: setup(s) -> state, draw(s, st, t) for
 * t in 0..BUZZ_SECONDS (3.2, fade out at the end). Everything is finite and driven by t, nothing loops.
 * The name only ever reaches the canvas as text.
 */
import { buzzLines } from "./birthday-copy.js";

const FONT = '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif';
const COLORS = ["#ff5ec8", "#ffd23f", "#3ddc97", "#4cc9f0", "#ff6a24", "#b388ff"];
const END = 3.2;

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const seg = (t, a, b) => clamp((t - a) / (b - a));
const easeOut = (t) => 1 - Math.pow(1 - clamp(t), 3);
const easeOutBack = (t) => {
  t = clamp(t);
  return 1 + 2.9 * Math.pow(t - 1, 3) + 1.9 * Math.pow(t - 1, 2);
};

/** Shrinks the font to fit `maxW` (down to `min`), then cuts with an ellipsis. Leaves ctx.font set. */
function fitLine(ctx, text, size, maxW, min) {
  let px = size;
  const width = (str) => {
    ctx.font = "800 " + px + "px " + FONT;
    return ctx.measureText(str).width;
  };
  while (px > min && width(text) > maxW) px -= 2;
  const chars = [...text];
  let out = text;
  while (chars.length > 1 && width(out) > maxW) {
    chars.pop();
    out = chars.join("").trimEnd() + "\u2026";
  }
  return { text: out, size: px };
}

/** Pieces that fall from the top, each with its own delay, speed and spin. */
function makeConfetti(rng, W) {
  return Array.from({ length: 70 }, () => ({
    x: rng() * W,
    delay: rng() * 1.4,
    vy: 120 + rng() * 150,
    wob: rng() * 6,
    rot: rng() * 6,
    vr: (rng() - 0.5) * 12,
    w: 6 + rng() * 6,
    h: 10 + rng() * 8,
    c: COLORS[Math.floor(rng() * COLORS.length)],
    round: rng() < 0.3,
  }));
}

/** Balloons that rise from below the screen and leave through the top. */
function makeBalloons(rng, W) {
  return Array.from({ length: 7 }, (_, i) => ({
    x: W * (0.08 + (0.84 * i) / 6) + (rng() - 0.5) * 24,
    delay: 0.1 + i * 0.13,
    r: 24 + rng() * 10,
    phase: rng() * 6,
    c: COLORS[i % COLORS.length],
  }));
}

function drawBackdrop(s, t, fade) {
  const { ctx, W, H } = s;
  ctx.globalAlpha = fade;
  ctx.fillStyle = "rgba(24,4,40," + 0.86 * easeOut(seg(t, 0, 0.25)) + ")";
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W / 2, H * 0.4, 0, W / 2, H * 0.4, W * 0.9);
  glow.addColorStop(0, "rgba(255,94,200," + 0.4 * easeOut(seg(t, 0, 0.5)) + ")");
  glow.addColorStop(1, "rgba(255,94,200,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
}

function drawBalloons(s, st, t) {
  const { ctx, H } = s;
  for (const b of st.balloons) {
    const p = seg(t, b.delay, b.delay + 2.6);
    if (p <= 0 || p >= 1) continue;
    const x = b.x + Math.sin(t * 2 + b.phase) * 10;
    const y = H + 90 - p * (H + 240);
    ctx.strokeStyle = "rgba(255,255,255,.55)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, y + b.r * 1.25);
    ctx.quadraticCurveTo(x + 8 * Math.sin(t * 3 + b.phase), y + b.r * 2.4, x, y + b.r * 3.4);
    ctx.stroke();
    ctx.fillStyle = b.c;
    ctx.beginPath();
    ctx.ellipse(x, y, b.r, b.r * 1.25, 0, 0, 7);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,.35)";
    ctx.beginPath();
    ctx.ellipse(x - b.r * 0.35, y - b.r * 0.4, b.r * 0.22, b.r * 0.38, 0.5, 0, 7);
    ctx.fill();
  }
}

function drawConfetti(s, st, t) {
  const { ctx, H } = s;
  for (const p of st.confetti) {
    const q = t - p.delay;
    if (q < 0) continue;
    const y = -20 + p.vy * q + 120 * q * q;
    if (y > H + 20) continue;
    ctx.save();
    ctx.translate(p.x + Math.sin(q * 4 + p.wob) * 14, y);
    ctx.rotate(p.rot + p.vr * q);
    ctx.scale(1, Math.cos(q * 8 + p.wob));
    ctx.fillStyle = p.c;
    if (p.round) {
      ctx.beginPath();
      ctx.arc(0, 0, p.w / 2, 0, 7);
      ctx.fill();
    } else {
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
    }
    ctx.restore();
  }
}

/** One rounded block of the cake. */
function block(ctx, x, y, w, h, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x + 10, y);
  ctx.arcTo(x + w, y, x + w, y + h, 10);
  ctx.arcTo(x + w, y + h, x, y + h, 10);
  ctx.arcTo(x, y + h, x, y, 10);
  ctx.arcTo(x, y, x + w, y, 10);
  ctx.closePath();
  ctx.fill();
}

function drawCandles(ctx, t) {
  const flame = easeOut(seg(t, 0.55, 0.9));
  for (const [i, x] of [-34, 0, 34].entries()) {
    ctx.fillStyle = COLORS[(i * 2 + 1) % COLORS.length];
    ctx.fillRect(x - 5, -86, 10, 40);
    const flick = 1 + 0.18 * Math.sin(t * 22 + i * 2);
    ctx.fillStyle = "rgba(255,196,60," + flame + ")";
    ctx.shadowColor = "rgba(255,170,40,.9)";
    ctx.shadowBlur = 16 * flame;
    ctx.beginPath();
    ctx.ellipse(x, -98, 6 * flame, 12 * flame * flick, 0, 0, 7);
    ctx.fill();
    ctx.shadowBlur = 0;
  }
}

function drawCake(s, t) {
  const { ctx, W, H } = s;
  const sc = easeOutBack(seg(t, 0.1, 0.6));
  ctx.save();
  ctx.translate(W / 2, H * 0.4);
  ctx.scale(sc, sc);
  ctx.fillStyle = "#e8e8f0";
  ctx.beginPath();
  ctx.ellipse(0, 62, 118, 14, 0, 0, 7);
  ctx.fill();
  block(ctx, -95, 0, 190, 60, "#ff7aa8");
  block(ctx, -66, -46, 132, 48, "#ffc14d");
  ctx.fillStyle = "#fff4f8";
  ctx.fillRect(-95, 0, 190, 12);
  ctx.fillRect(-66, -46, 132, 10);
  drawCandles(ctx, t);
  ctx.restore();
}

function drawText(s, st, t) {
  const { ctx, W, H } = s;
  const tp = easeOutBack(seg(t, 0.5, 0.95));
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.save();
  ctx.translate(W / 2, H * 0.67);
  ctx.scale(tp, tp);
  ctx.font = "600 28px " + FONT;
  ctx.fillStyle = "#ffe9a8";
  ctx.fillText(st.lead, 0, 0);
  ctx.font = "800 " + st.size + "px " + FONT;
  ctx.fillStyle = "#fff";
  ctx.shadowColor = "rgba(255,94,200,.85)";
  ctx.shadowBlur = 24;
  ctx.fillText(st.name, 0, 52);
  ctx.shadowBlur = 0;
  ctx.font = "500 22px " + FONT;
  ctx.fillStyle = "#d1d1d6";
  ctx.fillText(st.sub, 0, 104);
  ctx.restore();
}

export const birthday = {
  setup(s) {
    const lines = buzzLines("birthday", s.name);
    const fit = fitLine(s.ctx, lines.who, 54, s.W * 0.86, 20);
    return {
      lead: lines.lead,
      sub: lines.sub,
      name: fit.text,
      size: fit.size,
      confetti: makeConfetti(s.rng, s.W),
      balloons: makeBalloons(s.rng, s.W),
    };
  },
  draw(s, st, t) {
    const fade = 1 - seg(t, 2.7, END);
    drawBackdrop(s, t, fade);
    drawBalloons(s, st, t);
    drawCake(s, t);
    drawConfetti(s, st, t);
    drawText(s, st, t);
    s.ctx.globalAlpha = 1;
  },
};
