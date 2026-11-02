import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const root = path.resolve(import.meta.dirname, "..", "public");

function crcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}

const CRC = crcTable();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const name = Buffer.from(type);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}

function encodePng(width, height, pixels, channels) {
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function kernel(sigma) {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const values = [];
  let sum = 0;
  for (let i = -radius; i <= radius; i += 1) {
    const weight = Math.exp(-(i * i) / (2 * sigma * sigma));
    values.push(weight);
    sum += weight;
  }
  return { radius, weights: values.map((weight) => weight / sum) };
}

function blur(src, width, height, channels, sigma) {
  if (sigma <= 0) return src;
  const { radius, weights } = kernel(sigma);
  const tmp = new Float32Array(width * height * channels);
  const out = Buffer.alloc(src.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const base = (y * width + x) * channels;
      for (let c = 0; c < channels; c += 1) {
        let acc = 0;
        for (let i = -radius; i <= radius; i += 1) {
          const xx = Math.min(width - 1, Math.max(0, x + i));
          acc += src[(y * width + xx) * channels + c] * weights[i + radius];
        }
        tmp[base + c] = acc;
      }
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const base = (y * width + x) * channels;
      for (let c = 0; c < channels; c += 1) {
        let acc = 0;
        for (let i = -radius; i <= radius; i += 1) {
          const yy = Math.min(height - 1, Math.max(0, y + i));
          acc += tmp[(yy * width + x) * channels + c] * weights[i + radius];
        }
        out[base + c] = Math.max(0, Math.min(255, Math.round(acc)));
      }
    }
  }
  return out;
}

function mix(a, b, t) {
  const clamped = Math.max(0, Math.min(1, t));
  return a.map((channel, index) => Math.round(channel + (b[index] - channel) * clamped));
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PINK = [255, 70, 190];
const HOT = [255, 40, 96];
const ORANGE = [255, 96, 32];
const WHITE = [255, 228, 236];

function glowIcon(size, { radiusFrac, sigmaFrac, maskable = false }) {
  const pixels = Buffer.alloc(size * size * 3);
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const radius = size * radiusFrac;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (x - cx) / radius;
      const dy = (y - cy) / radius;
      const dist = Math.hypot(dx, dy);
      const index = (y * size + x) * 3;
      if (dist > 1) continue;
      const angle = (dx * 0.55 + dy * 0.85 + 1.4) / 2.8;
      let color = mix(mix(PINK, HOT, angle), ORANGE, Math.max(0, angle - 0.35));
      const core = Math.max(0, 1 - dist * 1.7);
      color = mix(color, WHITE, core * 0.62);
      const edge = Math.max(0, dist - 0.72) / 0.28;
      color = mix(color, [0, 0, 0], edge * 0.35);
      pixels[index] = color[0];
      pixels[index + 1] = color[1];
      pixels[index + 2] = color[2];
    }
  }
  const blurred = blur(pixels, size, size, 3, size * sigmaFrac);
  if (!maskable) return blurred;
  return blurred;
}

function badge(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const radius = size * 0.22;
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dist = Math.hypot(x - cx, y - cy);
      const index = (y * size + x) * 4;
      if (dist > radius) continue;
      const fade = Math.max(0, 1 - dist / radius);
      pixels[index] = 255;
      pixels[index + 1] = 255;
      pixels[index + 2] = 255;
      pixels[index + 3] = Math.round(255 * fade * fade);
    }
  }
  return blur(pixels, size, size, 4, size * 0.04);
}

function background(width, height, seed, stops) {
  const rand = mulberry32(seed);
  const pixels = Buffer.alloc(width * height * 3);
  const blobs = Array.from({ length: 7 }, () => ({
    x: rand() * width,
    y: rand() * height,
    r: width * (0.18 + rand() * 0.35),
    color: stops[Math.floor(rand() * stops.length)],
  }));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const t = y / (height - 1);
      let color = mix(stops[0], stops[stops.length - 1], t);
      for (const blob of blobs) {
        const d = Math.hypot(x - blob.x, y - blob.y) / blob.r;
        if (d < 1) color = mix(color, blob.color, (1 - d) * 0.55);
      }
      const n = (rand() - 0.5) * 18;
      const index = (y * width + x) * 3;
      pixels[index] = Math.max(0, Math.min(255, color[0] + n));
      pixels[index + 1] = Math.max(0, Math.min(255, color[1] + n));
      pixels[index + 2] = Math.max(0, Math.min(255, color[2] + n));
    }
  }
  return blur(pixels, width, height, 3, 8);
}

fs.mkdirSync(path.join(root, "icons"), { recursive: true });
fs.mkdirSync(path.join(root, "backgrounds"), { recursive: true });

const icons = [
  ["icon-32.png", 32, 0.34, 0.07],
  ["icon-180.png", 180, 0.3, 0.075],
  ["icon-192.png", 192, 0.3, 0.075],
  ["icon-512.png", 512, 0.28, 0.08],
];

for (const [name, size, radius, sigma] of icons) {
  const png = encodePng(size, size, glowIcon(size, { radiusFrac: radius, sigmaFrac: sigma }), 3);
  fs.writeFileSync(path.join(root, "icons", name), png);
}

fs.writeFileSync(
  path.join(root, "icons", "icon-maskable-512.png"),
  encodePng(512, 512, glowIcon(512, { radiusFrac: 0.2, sigmaFrac: 0.055, maskable: true }), 3),
);
fs.writeFileSync(path.join(root, "icons", "badge-96.png"), encodePng(96, 96, badge(96), 4));

const scenes = [
  ["dusk.png", 11, [[18, 28, 56], [92, 48, 78], [196, 92, 64], [40, 24, 32]]],
  ["dinner.png", 29, [[42, 18, 16], [120, 48, 28], [210, 120, 64], [24, 12, 14]]],
  ["walk.png", 47, [[10, 16, 32], [28, 36, 64], [180, 140, 80], [12, 14, 20]]],
  ["roof.png", 71, [[16, 24, 48], [88, 40, 72], [220, 96, 72], [20, 16, 28]]],
];

for (const [name, seed, stops] of scenes) {
  const png = encodePng(720, 480, background(720, 480, seed, stops), 3);
  fs.writeFileSync(path.join(root, "backgrounds", name), png);
}

console.log("wrote icons and backgrounds");
