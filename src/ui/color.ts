// Color pickers work in sRGB hex; materials and color attributes store linear values (like
// Blender's base color and Color attributes).

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const toSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

export function linearToHex(rgb: ArrayLike<number>): string {
  const h = (c: number) =>
    Math.round(Math.min(1, Math.max(0, toSrgb(c))) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${h(rgb[0])}${h(rgb[1])}${h(rgb[2])}`;
}

export function hexToLinear(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [toLinear(((n >> 16) & 255) / 255), toLinear(((n >> 8) & 255) / 255), toLinear((n & 255) / 255)];
}

/** Quick colors for skin, hair, clothes and accents. */
export const SWATCHES = ['#f2c9a8', '#c68642', '#8d5524', '#2b1d16', '#f5f5f5', '#1f1f1f', '#d64541', '#3a7bd5', '#4caf50', '#f2b632', '#8e44ad', '#ff8c42'];
