// The linear map from a face's 3D plane to its UVs (least squares over the face's corners).
// Used to move UVs along with vertices that slide inside a face (inset).

import { faceCenter, faceNormal, type Face } from '../mesh/mesh';
import type { Vec3 } from '../math/vec3';

export interface FaceUVMap {
  /** UV change for a 3D offset (object space) inside the face's plane. */
  delta(offset: Vec3): [number, number];
}

export function faceUVMap(pos: ArrayLike<number>, face: Face, uv: number[]): FaceUVMap {
  const n = faceNormal(pos, face);
  const c = faceCenter(pos, face);
  // Plane basis: t1 along the first edge, t2 = n × t1.
  let t1: Vec3 = [pos[face[1] * 3] - pos[face[0] * 3], pos[face[1] * 3 + 1] - pos[face[0] * 3 + 1], pos[face[1] * 3 + 2] - pos[face[0] * 3 + 2]];
  const l = Math.hypot(...t1) || 1;
  t1 = [t1[0] / l, t1[1] / l, t1[2] / l];
  const t2: Vec3 = [n[1] * t1[2] - n[2] * t1[1], n[2] * t1[0] - n[0] * t1[2], n[0] * t1[1] - n[1] * t1[0]];
  let uc = 0, vc = 0;
  for (let i = 0; i < face.length; i++) {
    uc += uv[i * 2];
    vc += uv[i * 2 + 1];
  }
  uc /= face.length;
  vc /= face.length;
  // M = (Σ d qᵀ)(Σ q qᵀ)⁻¹ with q = local 2D position, d = uv - mean.
  let a = 0, b = 0, d = 0; // Σ q qᵀ = [a b; b d]
  let e00 = 0, e01 = 0, e10 = 0, e11 = 0; // Σ d qᵀ
  for (let i = 0; i < face.length; i++) {
    const p: Vec3 = [pos[face[i] * 3] - c[0], pos[face[i] * 3 + 1] - c[1], pos[face[i] * 3 + 2] - c[2]];
    const x = p[0] * t1[0] + p[1] * t1[1] + p[2] * t1[2];
    const y = p[0] * t2[0] + p[1] * t2[1] + p[2] * t2[2];
    const du = uv[i * 2] - uc, dv = uv[i * 2 + 1] - vc;
    a += x * x;
    b += x * y;
    d += y * y;
    e00 += du * x;
    e01 += du * y;
    e10 += dv * x;
    e11 += dv * y;
  }
  const det = a * d - b * b;
  if (Math.abs(det) < 1e-20) return { delta: () => [0, 0] };
  const i00 = d / det, i01 = -b / det, i11 = a / det;
  const m00 = e00 * i00 + e01 * i01, m01 = e00 * i01 + e01 * i11;
  const m10 = e10 * i00 + e11 * i01, m11 = e10 * i01 + e11 * i11;
  return {
    delta(o) {
      const x = o[0] * t1[0] + o[1] * t1[1] + o[2] * t1[2];
      const y = o[0] * t2[0] + o[1] * t2[1] + o[2] * t2[2];
      return [m00 * x + m01 * y, m10 * x + m11 * y];
    },
  };
}
