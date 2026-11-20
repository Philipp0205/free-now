// WCAG contrast math shared by test/card-grad.test.ts and the compact colour UI spec. Not a test file.
export type Rgb = [number, number, number];

export function hex(value: string): Rgb {
  return [1, 3, 5].map((at) => parseInt(value.slice(at, at + 2), 16)) as Rgb;
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function luminance([r, g, b]: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrast(a: Rgb, b: Rgb): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** rgba(fg, alpha) painted over an opaque bg. */
export function over(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return fg.map((v, i) => v * alpha + bg[i] * (1 - alpha)) as Rgb;
}

/** A computed colour from Chrome: rgb(), rgba() or color(srgb ...), which is how it prints a color-mix(). */
export function parseCss(css: string): { rgb: Rgb; alpha: number } {
  const rgb = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/.exec(css);
  const srgb = /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)/.exec(css);
  const m = rgb ?? srgb;
  if (!m) throw new Error(`unreadable colour ${css}`);
  const scale = rgb ? 1 : 255;
  const alpha = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  return { rgb: [Number(m[1]) * scale, Number(m[2]) * scale, Number(m[3]) * scale], alpha };
}
