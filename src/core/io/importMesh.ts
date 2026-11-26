// Turns geometry read from outside files into a mesh our half-edge core accepts.
//
// Outside files are often messy: split vertices, repeated corners, slivers, duplicate faces,
// edges shared by 3+ faces and faces that disagree on winding. Instead of refusing the file,
// this repairs what it can and drops what it can't, and reports how many faces it touched.

import { edgeKey, dirKey, type MeshData } from '../mesh/mesh';
import { validateMesh } from '../mesh/validate';

/** Limits for imported files (a phone has to stay responsive). */
export const IMPORT_LIMITS = {
  maxFileBytes: 25 * 1024 * 1024,
  maxFaces: 20_000,
  maxObjects: 32,
  maxTextureSize: 2048,
};

export interface RawMesh {
  positions: number[];
  faces: number[][];
  lines?: [number, number][];
  /** RGBA per vertex (linear). */
  colors?: number[];
  /** Corner UVs per face (parallel to faces), null for faces without UVs. */
  uvs?: (number[] | null)[];
}

export interface CleanReport {
  /** Vertices merged into another one at the same position. */
  welded: number;
  /** Faces dropped for having fewer than 3 distinct corners, bad vertices or no area. */
  degenerate: number;
  duplicate: number;
  /** Faces dropped because their edge was already shared by two faces or the winding could not agree. */
  nonManifold: number;
  /** Faces turned around so their winding matches their neighbors. */
  flipped: number;
}

export interface CleanResult {
  data: MeshData;
  /** Source face index of each output face. */
  faceSrc: number[];
  report: CleanReport;
}

export const emptyReport = (): CleanReport => ({
  welded: 0,
  degenerate: 0,
  duplicate: 0,
  nonManifold: 0,
  flipped: 0,
});

export function addReports(a: CleanReport, b: CleanReport): CleanReport {
  return {
    welded: a.welded + b.welded,
    degenerate: a.degenerate + b.degenerate,
    duplicate: a.duplicate + b.duplicate,
    nonManifold: a.nonManifold + b.nonManifold,
    flipped: a.flipped + b.flipped,
  };
}

/** Bounding-box diagonal of a position array (0 when empty). */
export function bboxDiagonal(positions: number[]): number {
  if (positions.length < 3) return 0;
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3)
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (!Number.isFinite(v)) continue;
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  if (min[0] === Infinity) return 0;
  return Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
}

export function cleanMesh(src: RawMesh, opts: { weld?: boolean } = {}): CleanResult {
  const report = emptyReport();
  const nV = src.positions.length / 3;
  const P = src.positions;
  const finite = (v: number) =>
    Number.isFinite(P[v * 3]) && Number.isFinite(P[v * 3 + 1]) && Number.isFinite(P[v * 3 + 2]);
  const diag = bboxDiagonal(P);

  // 1. Weld vertices at the same position (exporters often split them at UV seams).
  const remap = new Int32Array(nV);
  for (let v = 0; v < nV; v++) remap[v] = v;
  if (opts.weld !== false && nV) {
    const eps = Math.max(diag * 1e-6, 1e-12);
    const seen = new Map<string, number>();
    for (let v = 0; v < nV; v++) {
      if (!finite(v)) continue;
      const key = `${Math.round(P[v * 3] / eps)},${Math.round(P[v * 3 + 1] / eps)},${Math.round(P[v * 3 + 2] / eps)}`;
      const w = seen.get(key);
      if (w === undefined) seen.set(key, v);
      else {
        remap[v] = w;
        report.welded++;
      }
    }
  }

  // 2. Per face: remap, drop repeated corners, drop faces that are still degenerate.
  const minArea2 = (diag * 1e-7) ** 4; // (area)^2 threshold, scale-relative
  type F = { v: number[]; uv: number[] | null; src: number };
  let faces: F[] = [];
  src.faces.forEach((face, fi) => {
    const uvIn = src.uvs?.[fi] ?? null;
    const v: number[] = [];
    const uv: number[] = [];
    let bad = false;
    for (let i = 0; i < face.length; i++) {
      const a = face[i];
      if (!Number.isInteger(a) || a < 0 || a >= nV || !finite(a)) {
        bad = true;
        break;
      }
      const m = remap[a];
      if (v.length && v[v.length - 1] === m) continue;
      v.push(m);
      if (uvIn) uv.push(uvIn[i * 2] ?? 0, uvIn[i * 2 + 1] ?? 0);
    }
    while (v.length > 1 && v[0] === v[v.length - 1]) {
      v.pop();
      if (uvIn) uv.splice(-2, 2);
    }
    if (bad || v.length < 3 || new Set(v).size !== v.length || area2(P, v) <= minArea2) {
      report.degenerate++;
      return;
    }
    faces.push({ v, uv: uvIn ? uv : null, src: fi });
  });

  // 3. Duplicate faces (same vertex set, any winding).
  {
    const keys = new Set<string>();
    faces = faces.filter((f) => {
      const k = f.v
        .slice()
        .sort((a, b) => a - b)
        .join(',');
      if (keys.has(k)) {
        report.duplicate++;
        return false;
      }
      keys.add(k);
      return true;
    });
  }

  // 4. Non-manifold edges: keep a face only while each of its edges has fewer than 2 faces.
  const edgeFaces = new Map<number, number[]>();
  {
    const kept: F[] = [];
    for (const f of faces) {
      const ks = f.v.map((a, i) => edgeKey(a, f.v[(i + 1) % f.v.length]));
      if (ks.some((k) => (edgeFaces.get(k)?.length ?? 0) >= 2)) {
        report.nonManifold++;
        continue;
      }
      const fi = kept.length;
      kept.push(f);
      for (const k of ks) {
        const l = edgeFaces.get(k);
        if (l) l.push(fi);
        else edgeFaces.set(k, [fi]);
      }
    }
    faces = kept;
  }

  // 5. Consistent winding per connected piece: walk across shared edges, turning faces around
  //    so neighbors run each shared edge in opposite directions. A piece that can't agree
  //    (a Möbius strip) loses the faces where it conflicts.
  const nF = faces.length;
  const sign = new Int8Array(nF); // 0 = not reached, 1 = keep, -1 = flip
  const drop = new Uint8Array(nF);
  const runs = (f: F, a: number, b: number) => {
    const i = f.v.indexOf(a);
    return f.v[(i + 1) % f.v.length] === b ? 1 : -1;
  };
  for (let s = 0; s < nF; s++) {
    if (sign[s]) continue;
    sign[s] = 1;
    const piece = [s];
    for (let q = 0; q < piece.length; q++) {
      const fi = piece[q];
      if (drop[fi]) continue;
      const f = faces[fi];
      for (let i = 0; i < f.v.length; i++) {
        const a = f.v[i],
          b = f.v[(i + 1) % f.v.length];
        for (const gi of edgeFaces.get(edgeKey(a, b))!) {
          if (gi === fi || drop[gi]) continue;
          const want = -sign[fi] * runs(faces[gi], a, b);
          if (!sign[gi]) {
            sign[gi] = want;
            piece.push(gi);
          } else if (sign[gi] !== want) {
            drop[gi] = 1;
            report.nonManifold++;
          }
        }
      }
    }
    // Keep the winding most of the piece already had.
    const flips = piece.filter((f) => !drop[f] && sign[f] < 0).length;
    if (flips * 2 > piece.filter((f) => !drop[f]).length) for (const f of piece) sign[f] = -sign[f];
  }
  const out: F[] = [];
  for (let i = 0; i < nF; i++) {
    if (drop[i]) continue;
    const f = faces[i];
    if (sign[i] < 0) {
      report.flipped++;
      f.v.reverse();
      if (f.uv) {
        const pairs: number[] = [];
        for (let k = f.uv.length - 2; k >= 0; k -= 2) pairs.push(f.uv[k], f.uv[k + 1]);
        f.uv = pairs;
      }
    }
    out.push(f);
  }

  // 6. Safety net: any directed edge still used twice drops the later face.
  {
    const used = new Set<number>();
    for (let i = 0; i < out.length; i++) {
      const v = out[i].v;
      const ks = v.map((a, k) => dirKey(a, v[(k + 1) % v.length]));
      if (ks.some((k) => used.has(k))) {
        out.splice(i--, 1);
        report.nonManifold++;
        continue;
      }
      for (const k of ks) used.add(k);
    }
  }

  // 7. Loose edges, then keep only the vertices that something uses.
  const faceEdges = new Set<number>();
  for (const f of out) f.v.forEach((a, i) => faceEdges.add(edgeKey(a, f.v[(i + 1) % f.v.length])));
  const loose: [number, number][] = [];
  const looseSeen = new Set<number>();
  for (const [a0, b0] of src.lines ?? []) {
    if (![a0, b0].every((x) => Number.isInteger(x) && x >= 0 && x < nV && finite(x))) continue;
    const a = remap[a0],
      b = remap[b0];
    const k = edgeKey(a, b);
    if (a === b || faceEdges.has(k) || looseSeen.has(k)) continue;
    looseSeen.add(k);
    loose.push([a, b]);
  }
  const newIndex = new Int32Array(nV).fill(-1);
  const positions: number[] = [];
  const colors: number[] | undefined = src.colors ? [] : undefined;
  const take = (v: number) => {
    if (newIndex[v] < 0) {
      newIndex[v] = positions.length / 3;
      positions.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
      if (colors) colors.push(...[0, 1, 2, 3].map((k) => src.colors![v * 4 + k] ?? 1));
    }
    return newIndex[v];
  };
  const data: MeshData = {
    positions,
    faces: out.map((f) => f.v.map(take)),
    looseEdges: loose.map(([a, b]) => [take(a), take(b)]),
  };
  if (colors) data.colors = colors;
  if (out.some((f) => f.uv)) data.uvs = out.map((f) => f.uv ?? new Array(f.v.length * 2).fill(0));
  const res = validateMesh(data);
  if (!res.ok) throw new Error(`could not repair the mesh: ${res.errors[0]}`);
  return { data, faceSrc: out.map((f) => f.src), report };
}

/** Squared area of a polygon (Newell's method), times 4. */
function area2(P: number[], v: number[]): number {
  let x = 0,
    y = 0,
    z = 0;
  for (let i = 0; i < v.length; i++) {
    const a = v[i] * 3,
      b = v[(i + 1) % v.length] * 3;
    x += (P[a + 1] - P[b + 1]) * (P[a + 2] + P[b + 2]);
    y += (P[a + 2] - P[b + 2]) * (P[a] + P[b]);
    z += (P[a] - P[b]) * (P[a + 1] + P[b + 1]);
  }
  return x * x + y * y + z * z;
}
