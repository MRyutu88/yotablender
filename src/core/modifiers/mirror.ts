// Mirror modifier, like Blender's: mirrors across the object's local X/Y/Z planes in that
// order, reversing face winding on the copies. With merge on, a vertex closer to its mirror
// image than `merge_threshold` (|coord| < threshold / 2) is shared instead of copied, which
// stitches the seam so subdivision is smooth across it.
//
// Like subdivision, topology lives in a plan and positions are a cheap per-frame map:
// each output vertex = an input vertex with some axes negated.

import type { MirrorModifier } from './types';

export interface MirrorPlan {
  /** Output vertex → input vertex. */
  src: Int32Array;
  /** Output vertex → bitmask of negated axes (1 = X, 2 = Y, 4 = Z). */
  flip: Uint8Array;
  nIn: number;
  nOut: number;
  faces: number[][];
  /** Output face → input face it came from (for materials). */
  faceSrc: Int32Array;
  /** Output face → 1 when its corners run in reverse order of its source face's (for UVs). */
  faceRev: Uint8Array;
  looseEdges: [number, number][];
  /** Per input vertex, bitmask of axes it is merged on. Plan is stale when this changes. */
  mergeMask: Uint8Array;
}

export function mirrorMergeMask(pos: ArrayLike<number>, nV: number, mod: MirrorModifier): Uint8Array {
  const mask = new Uint8Array(nV);
  if (!mod.use_mirror_merge) return mask;
  const half = mod.merge_threshold / 2;
  for (let v = 0; v < nV; v++) {
    for (let a = 0; a < 3; a++) {
      if (mod.use_axis[a] && Math.abs(pos[v * 3 + a]) <= half) mask[v] |= 1 << a;
    }
  }
  return mask;
}

export function buildMirrorPlan(
  pos: ArrayLike<number>,
  nV: number,
  faces: number[][],
  looseEdges: [number, number][],
  mod: MirrorModifier,
): MirrorPlan {
  const mergeMask = mirrorMergeMask(pos, nV, mod);
  let src: number[] = [];
  let flip: number[] = [];
  for (let v = 0; v < nV; v++) {
    src.push(v);
    flip.push(0);
  }
  let curFaces = faces;
  let curSrc = faces.map((_, i) => i);
  let curRev = faces.map(() => 0);
  let curLoose = looseEdges;
  for (let a = 0; a < 3; a++) {
    if (!mod.use_axis[a]) continue;
    const bit = 1 << a;
    const n = src.length;
    const map = new Int32Array(n);
    const nextSrc = src.slice(), nextFlip = flip.slice();
    for (let v = 0; v < n; v++) {
      if (mergeMask[src[v]] & bit) map[v] = v;
      else {
        map[v] = nextSrc.length;
        nextSrc.push(src[v]);
        nextFlip.push(flip[v] ^ bit);
      }
    }
    const mirroredFaces: number[][] = [];
    const mirroredSrc: number[] = [];
    const mirroredRev: number[] = [];
    curFaces.forEach((f, fi) => {
      // A face lying entirely on the plane would be duplicated onto itself: skip its copy.
      if (f.every((v) => map[v] === v)) return;
      mirroredFaces.push(f.map((v) => map[v]).reverse());
      mirroredSrc.push(curSrc[fi]);
      mirroredRev.push(curRev[fi] ^ 1);
    });
    const mirroredLoose: [number, number][] = [];
    for (const [x, y] of curLoose) {
      if (map[x] === x && map[y] === y) continue;
      mirroredLoose.push([map[x], map[y]]);
    }
    curFaces = curFaces.concat(mirroredFaces);
    curSrc = curSrc.concat(mirroredSrc);
    curRev = curRev.concat(mirroredRev);
    curLoose = curLoose.concat(mirroredLoose);
    src = nextSrc;
    flip = nextFlip;
  }
  return {
    src: Int32Array.from(src),
    flip: Uint8Array.from(flip),
    nIn: nV,
    nOut: src.length,
    faces: curFaces,
    faceSrc: Int32Array.from(curSrc),
    faceRev: Uint8Array.from(curRev),
    looseEdges: curLoose,
    mergeMask,
  };
}

export function evaluateMirror(plan: MirrorPlan, pos: ArrayLike<number>, out: { [i: number]: number }): void {
  const { src, flip } = plan;
  for (let i = 0; i < plan.nOut; i++) {
    const s = src[i] * 3, f = flip[i], o = i * 3;
    out[o] = f & 1 ? -pos[s] : pos[s];
    out[o + 1] = f & 2 ? -pos[s + 1] : pos[s + 1];
    out[o + 2] = f & 4 ? -pos[s + 2] : pos[s + 2];
  }
}

/** True when the merge decisions changed (a vertex moved on/off the plane): rebuild the plan. */
export function mirrorPlanStale(plan: MirrorPlan, pos: ArrayLike<number>, mod: MirrorModifier): boolean {
  if (!mod.use_mirror_merge) return false;
  const half = mod.merge_threshold / 2;
  for (let v = 0; v < plan.nIn; v++) {
    let m = 0;
    for (let a = 0; a < 3; a++) if (mod.use_axis[a] && Math.abs(pos[v * 3 + a]) <= half) m |= 1 << a;
    if (m !== plan.mergeMask[v]) return true;
  }
  return false;
}

/**
 * Clipping for edit-mode transforms: vertices that started on a mirror plane stay on it, and
 * no vertex may cross to the other side. `start` holds positions before the transform.
 */
export function applyMirrorClip(
  mod: MirrorModifier,
  verts: Iterable<number>,
  start: ArrayLike<number>,
  pos: { [i: number]: number },
): void {
  if (!mod.use_clip) return;
  const half = Math.max(mod.merge_threshold / 2, 1e-6);
  for (const v of verts) {
    for (let a = 0; a < 3; a++) {
      if (!mod.use_axis[a]) continue;
      const s = start[v * 3 + a], i = v * 3 + a;
      if (Math.abs(s) <= half) pos[i] = 0;
      else if (Math.sign(pos[i]) !== Math.sign(s)) pos[i] = 0;
    }
  }
}
