// Subdivide (Blender's Edge → Subdivide): splits real geometry, unlike the Subdivision modifier.
//
// Every edge of the target faces gets `cuts` evenly spaced vertices. Quads with all four edges
// cut become an (n+1)×(n+1) grid, triangles a triangle grid. With `axis` set (0/1/2 = local
// X/Y/Z), only edges that run along that axis are cut, so a cube with axis Z gets horizontal
// slices around its sides and untouched caps; quads cut on one pair of opposite edges become
// strips. Faces with other patterns (n-gons, uneven cuts) and neighbours outside the target set
// that share a cut edge get the new vertices inserted into their outline, so there is no crack.
// Shape, colors and UVs are interpolated linearly, so the surface does not move.

import { addVertex, cloneData, edgeKey, type MeshData } from '../mesh';
import { emptySelection, flushSelection } from '../selection';
import { checkResult, OpError, type OpResult } from './opResult';

export type SubdivideAxis = -1 | 0 | 1 | 2;

/** An edge counts as "along" an axis within about 53° of it. */
const ALONG = 0.6;

export function subdivide(mesh: MeshData, targetFaces: Iterable<number> | null, cuts = 1, axis: SubdivideAxis = -1): OpResult {
  const n = Math.max(1, Math.min(32, Math.round(cuts)));
  const M = n + 1;
  const data = cloneData(mesh);
  const pos = data.positions;
  const targets = new Set<number>(targetFaces ?? mesh.faces.map((_, i) => i));
  if (!targets.size) throw new OpError('Nothing to subdivide');

  // Which edges get cut.
  const cutEdge = new Set<number>();
  for (const f of targets) {
    const face = mesh.faces[f];
    if (!face) continue;
    for (let i = 0; i < face.length; i++) {
      const a = face[i], b = face[(i + 1) % face.length];
      if (axis >= 0) {
        const d = [0, 1, 2].map((k) => pos[b * 3 + k] - pos[a * 3 + k]);
        const len = Math.hypot(d[0], d[1], d[2]);
        if (len < 1e-12 || Math.abs(d[axis]) / len < ALONG) continue;
      }
      cutEdge.add(edgeKey(a, b));
    }
  }
  if (!cutEdge.size) throw new OpError(`No edges run along ${'XYZ'[axis]} here`);

  // Cut vertices per edge, stored from the lower vertex index to the higher one.
  const cutsOn = new Map<number, number[]>();
  const pointsOn = (from: number, to: number): number[] | null => {
    const k = edgeKey(from, to);
    if (!cutEdge.has(k)) return null;
    let pts = cutsOn.get(k);
    if (!pts) {
      const lo = Math.min(from, to), hi = Math.max(from, to);
      pts = [];
      for (let i = 1; i <= n; i++) {
        const t = i / M;
        const at = (c: number) => pos[lo * 3 + c] + (pos[hi * 3 + c] - pos[lo * 3 + c]) * t;
        pts.push(addVertex(data, at(0), at(1), at(2), mix(data.colors, [lo, hi], [1 - t, t])));
      }
      cutsOn.set(k, pts);
    }
    return from < to ? pts : pts.slice().reverse();
  };

  const faces: number[][] = [];
  const mats: number[] = [];
  const uvs: number[][] = [];
  const newFaces: number[] = [];
  const emit = (face: number[], src: number, uv: number[] | null) => {
    faces.push(face);
    mats.push(mesh.faceMats?.[src] ?? 0);
    if (mesh.uvs) uvs.push(uv ?? new Array(face.length * 2).fill(0));
    if (targets.has(src)) newFaces.push(faces.length - 1);
  };

  mesh.faces.forEach((face, fi) => {
    const fuv = mesh.uvs?.[fi];
    const L = face.length;
    const edgeCut = face.map((v, i) => cutEdge.has(edgeKey(v, face[(i + 1) % L])));
    const nCut = edgeCut.filter(Boolean).length;
    const cornerUV = (i: number): [number, number] => (fuv ? [fuv[i * 2], fuv[i * 2 + 1]] : [0, 0]);

    if (targets.has(fi) && L === 4 && nCut === 4) {
      // Grid: (i, j) with i along corner 0 → 1 and j along corner 0 → 3.
      const [p0, p1, p2, p3] = face;
      const bottom = pointsOn(p0, p1)!, right = pointsOn(p1, p2)!, top = pointsOn(p3, p2)!, left = pointsOn(p0, p3)!;
      const grid: number[][] = [];
      for (let j = 0; j <= M; j++) {
        const row: number[] = [];
        for (let i = 0; i <= M; i++) {
          let v: number;
          if (j === 0) v = i === 0 ? p0 : i === M ? p1 : bottom[i - 1];
          else if (j === M) v = i === 0 ? p3 : i === M ? p2 : top[i - 1];
          else if (i === 0) v = left[j - 1];
          else if (i === M) v = right[j - 1];
          else {
            const w = bilinear(i / M, j / M);
            const p = [0, 1, 2].map((c) => w.reduce((s, wk, k) => s + wk * pos[face[k] * 3 + c], 0));
            v = addVertex(data, p[0], p[1], p[2], mix(data.colors, face, w));
          }
          row.push(v);
        }
        grid.push(row);
      }
      const uvAt = (i: number, j: number) => {
        const w = bilinear(i / M, j / M);
        return [0, 1].map((c) => w.reduce((s, wk, k) => s + wk * cornerUV(k)[c], 0));
      };
      for (let j = 0; j < M; j++) {
        for (let i = 0; i < M; i++) {
          const cell: [number, number][] = [
            [i, j],
            [i + 1, j],
            [i + 1, j + 1],
            [i, j + 1],
          ];
          emit(
            cell.map(([a, b]) => grid[b][a]),
            fi,
            fuv ? cell.flatMap(([a, b]) => uvAt(a, b)) : null,
          );
        }
      }
      return;
    }

    if (targets.has(fi) && L === 4 && nCut === 2 && edgeCut[0] === edgeCut[2]) {
      // Strips across the two cut (opposite) edges. Rotate so the cut pair is 0→1 and 3→2.
      const r = edgeCut[0] ? 0 : 1;
      const idx = [0, 1, 2, 3].map((k) => (k + r) % 4);
      const [q0, q1, q2, q3] = idx.map((k) => face[k]);
      const a = [q0, ...pointsOn(q0, q1)!, q1];
      const b = [q3, ...pointsOn(q3, q2)!, q2];
      const uvAt = (s: number, t: number) => {
        const w = bilinear(s, t);
        return [0, 1].map((c) => w.reduce((sum, wk, k) => sum + wk * cornerUV(idx[k])[c], 0));
      };
      for (let i = 0; i < M; i++) {
        emit(
          [a[i], a[i + 1], b[i + 1], b[i]],
          fi,
          fuv ? [...uvAt(i / M, 0), ...uvAt((i + 1) / M, 0), ...uvAt((i + 1) / M, 1), ...uvAt(i / M, 1)] : null,
        );
      }
      return;
    }

    if (targets.has(fi) && L === 3 && nCut === 3) {
      // Triangle grid: P(i, j) = A + (B − A)·i/M + (C − A)·j/M, i + j ≤ M.
      const [A, B, C] = face;
      const ab = pointsOn(A, B)!, ac = pointsOn(A, C)!, bc = pointsOn(B, C)!;
      const key = (i: number, j: number) => i * (M + 1) + j;
      const vert = new Map<number, number>();
      for (let i = 0; i <= M; i++) {
        for (let j = 0; i + j <= M; j++) {
          let v: number;
          if (i === 0 && j === 0) v = A;
          else if (i === M) v = B;
          else if (j === M) v = C;
          else if (j === 0) v = ab[i - 1];
          else if (i === 0) v = ac[j - 1];
          else if (i + j === M) v = bc[j - 1];
          else {
            const w = [1 - (i + j) / M, i / M, j / M];
            const p = [0, 1, 2].map((c) => w.reduce((s, wk, k) => s + wk * pos[face[k] * 3 + c], 0));
            v = addVertex(data, p[0], p[1], p[2], mix(data.colors, face, w));
          }
          vert.set(key(i, j), v);
        }
      }
      const uvAt = (i: number, j: number) => {
        const w = [1 - (i + j) / M, i / M, j / M];
        return [0, 1].map((c) => w.reduce((s, wk, k) => s + wk * cornerUV(k)[c], 0));
      };
      const tri = (pts: [number, number][]) =>
        emit(
          pts.map(([i, j]) => vert.get(key(i, j))!),
          fi,
          fuv ? pts.flatMap(([i, j]) => uvAt(i, j)) : null,
        );
      for (let i = 0; i < M; i++) {
        for (let j = 0; i + j < M; j++) {
          tri([
            [i, j],
            [i + 1, j],
            [i, j + 1],
          ]);
          if (i + j < M - 1)
            tri([
              [i + 1, j],
              [i + 1, j + 1],
              [i, j + 1],
            ]);
        }
      }
      return;
    }

    // Anything else: keep the face, with cut points spliced into its outline.
    const out: number[] = [];
    const outUV: number[] = [];
    for (let i = 0; i < L; i++) {
      const u = face[i], w = face[(i + 1) % L];
      out.push(u);
      const cu = cornerUV(i);
      outUV.push(cu[0], cu[1]);
      const pts = edgeCut[i] ? pointsOn(u, w) : null;
      if (!pts) continue;
      const cw = cornerUV((i + 1) % L);
      pts.forEach((p, k) => {
        out.push(p);
        const t = (k + 1) / M;
        outUV.push(cu[0] + (cw[0] - cu[0]) * t, cu[1] + (cw[1] - cu[1]) * t);
      });
    }
    emit(out, fi, fuv ? outUV : null);
  });

  data.faces = faces;
  if (data.faceMats) data.faceMats = mats;
  if (data.uvs) data.uvs = uvs;
  checkResult(data, 'Subdivide');
  const s = emptySelection();
  for (const f of newFaces) s.faces.add(f);
  return { data, selection: flushSelection(data, s, 'face') };
}

/** Bilinear weights of the 4 quad corners at (s along 0→1, t along 0→3). */
function bilinear(s: number, t: number): number[] {
  return [(1 - s) * (1 - t), s * (1 - t), s * t, (1 - s) * t];
}

/** Weighted mix of vertex colors (undefined when the mesh has none). */
function mix(colors: number[] | undefined, verts: number[], w: number[]): number[] | undefined {
  if (!colors) return undefined;
  return [0, 1, 2, 3].map((c) => verts.reduce((s, v, k) => s + (w[k] ?? 0) * colors[v * 4 + c], 0));
}
