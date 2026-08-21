/**
 * Colour maths shared by the seeder, the relighting stage, and the drift check.
 *
 * Everything photometric happens in LINEAR light. Averaging, blurring, or
 * multiplying gamma-encoded sRGB values crushes shadows and is the second
 * biggest cause of the "pasted on" look in composited renders — right behind
 * getting the shading transfer wrong.
 */

/** sRGB 0..255 -> linear 0..1. */
export function srgbToLinear(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** Linear 0..1 -> sRGB 0..255. */
export function linearToSrgb(v: number): number {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
}

/** Rec.709 relative luminance from LINEAR rgb. */
export function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** D65 white point, the sRGB reference illuminant. */
const WHITE: [number, number, number] = [0.95047, 1.0, 1.08883];

/** sRGB 0..255 -> CIELAB. Used for the post-render colour retarget. */
export function srgbToLab(r8: number, g8: number, b8: number): [number, number, number] {
  const r = srgbToLinear(r8);
  const g = srgbToLinear(g8);
  const b = srgbToLinear(b8);

  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / WHITE[0];
  const y = (0.2126729 * r + 0.7151522 * g + 0.072175 * b) / WHITE[1];
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / WHITE[2];

  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);

  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIELAB -> sRGB 0..255, clipped to gamut. */
export function labToSrgb(L: number, a: number, bb: number): [number, number, number] {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - bb / 200;

  const finv = (t: number) => (t ** 3 > 216 / 24389 ? t ** 3 : (108 / 841) * (t - 4 / 29));
  const x = finv(fx) * WHITE[0];
  const y = finv(fy) * WHITE[1];
  const z = finv(fz) * WHITE[2];

  const r = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
  const g = -0.969266 * x + 1.8760108 * y + 0.041556 * z;
  const b = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;

  return [linearToSrgb(r), linearToSrgb(g), linearToSrgb(b)];
}

/** Perceptual distance, good enough for "is this swatch close to that one". */
export function deltaE76(
  a: [number, number, number],
  b: [number, number, number],
): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
