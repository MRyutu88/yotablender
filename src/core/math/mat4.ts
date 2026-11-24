// 4x4 matrices, column-major (same memory layout as WebGL / Three.js), so a core matrix
// can be copied straight into a Three.js Matrix4 without conversion.
//
// Rotations follow Blender: Euler mode 'XYZ' means the X rotation is applied first, then Y,
// then Z, i.e. R = Rz * Ry * Rx (for column vectors).

import type { Vec3 } from './vec3';

export type Mat4 = Float64Array;

export const identity = (): Mat4 => {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
};

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

/** 3x3 rotation (row-major nested) from Blender XYZ Euler angles in radians. */
export function eulerToRot(e: Vec3): number[][] {
  const [cx, cy, cz] = [Math.cos(e[0]), Math.cos(e[1]), Math.cos(e[2])];
  const [sx, sy, sz] = [Math.sin(e[0]), Math.sin(e[1]), Math.sin(e[2])];
  // Rz * Ry * Rx
  return [
    [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
    [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
    [-sy, cy * sx, cy * cx],
  ];
}

/** Blender XYZ Euler from a pure rotation matrix (row-major nested). */
export function rotToEuler(r: number[][]): Vec3 {
  const sy = -r[2][0];
  const cy = Math.hypot(r[0][0], r[1][0]);
  if (cy > 1e-6) {
    return [Math.atan2(r[2][1], r[2][2]), Math.atan2(sy, cy), Math.atan2(r[1][0], r[0][0])];
  }
  // Gimbal lock: Y = ±90°, fold Z into X.
  return [Math.atan2(-r[1][2], r[1][1]), Math.atan2(sy, cy), 0];
}

/** Picks the equivalent of `e` closest to `prev` (like Blender's compatible euler), avoiding jumps. */
export function compatibleEuler(e: Vec3, prev: Vec3): Vec3 {
  const fix = (a: number, p: number) => a + Math.round((p - a) / (2 * Math.PI)) * 2 * Math.PI;
  const direct: Vec3 = [fix(e[0], prev[0]), fix(e[1], prev[1]), fix(e[2], prev[2])];
  // The alternative solution of the same rotation: (x+π, π-y, z+π).
  const alt: Vec3 = [fix(e[0] + Math.PI, prev[0]), fix(Math.PI - e[1], prev[1]), fix(e[2] + Math.PI, prev[2])];
  const d = (a: Vec3) => Math.abs(a[0] - prev[0]) + Math.abs(a[1] - prev[1]) + Math.abs(a[2] - prev[2]);
  return d(alt) < d(direct) ? alt : direct;
}

/** Rotation matrix (row-major nested) for an angle around a unit axis (Rodrigues). */
export function axisAngleToRot(axis: Vec3, angle: number): number[][] {
  const [x, y, z] = axis;
  const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  return [
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
  ];
}

export function mulRot(a: number[][], b: number[][]): number[][] {
  const out = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) out[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
  return out;
}

export const rotApply = (r: number[][], v: Vec3): Vec3 => [
  r[0][0] * v[0] + r[0][1] * v[1] + r[0][2] * v[2],
  r[1][0] * v[0] + r[1][1] * v[1] + r[1][2] * v[2],
  r[2][0] * v[0] + r[2][1] * v[1] + r[2][2] * v[2],
];

/** T * R * S, like Blender's object matrix_basis. */
export function compose(loc: Vec3, rot: Vec3, scl: Vec3): Mat4 {
  const r = eulerToRot(rot);
  const m = new Float64Array(16);
  for (let c = 0; c < 3; c++) {
    m[c * 4] = r[0][c] * scl[c];
    m[c * 4 + 1] = r[1][c] * scl[c];
    m[c * 4 + 2] = r[2][c] * scl[c];
  }
  m[12] = loc[0];
  m[13] = loc[1];
  m[14] = loc[2];
  m[15] = 1;
  return m;
}

/** Splits an affine matrix (no shear) back into location, XYZ Euler and scale. */
export function decompose(m: Mat4, prevRot: Vec3 = [0, 0, 0]): { loc: Vec3; rot: Vec3; scale: Vec3 } {
  const col = (c: number): Vec3 => [m[c * 4], m[c * 4 + 1], m[c * 4 + 2]];
  const sx = Math.hypot(...col(0)), sy = Math.hypot(...col(1)), sz = Math.hypot(...col(2));
  const det =
    m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
  const s: Vec3 = [det < 0 ? -sx : sx, sy, sz];
  const r: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let c = 0; c < 3; c++) {
    const k = s[c] !== 0 ? 1 / s[c] : 0;
    r[0][c] = m[c * 4] * k;
    r[1][c] = m[c * 4 + 1] * k;
    r[2][c] = m[c * 4 + 2] * k;
  }
  return { loc: [m[12], m[13], m[14]], rot: compatibleEuler(rotToEuler(r), prevRot), scale: s };
}

export function invert(m: Mat4): Mat4 {
  const inv = new Float64Array(16);
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (Math.abs(det) < 1e-300) return identity();
  det = 1 / det;
  inv[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  inv[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  inv[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  inv[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  inv[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  inv[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  inv[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  inv[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  inv[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  inv[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  inv[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  inv[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  inv[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  inv[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  inv[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  inv[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return inv;
}

export const transformPoint = (m: Mat4, p: Vec3): Vec3 => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];

export const transformDir = (m: Mat4, d: Vec3): Vec3 => [
  m[0] * d[0] + m[4] * d[1] + m[8] * d[2],
  m[1] * d[0] + m[5] * d[1] + m[9] * d[2],
  m[2] * d[0] + m[6] * d[1] + m[10] * d[2],
];

export const translation = (t: Vec3): Mat4 => {
  const m = identity();
  m[12] = t[0];
  m[13] = t[1];
  m[14] = t[2];
  return m;
};

/** Embeds a 3x3 (row-major nested) linear map into a 4x4 matrix. */
export function fromRot3(r: number[][]): Mat4 {
  const m = identity();
  for (let c = 0; c < 3; c++) for (let rr = 0; rr < 3; rr++) m[c * 4 + rr] = r[rr][c];
  return m;
}
