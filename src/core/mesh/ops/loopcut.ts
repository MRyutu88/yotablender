// Loop Cut (Blender's Ctrl+R): inserts `cuts` edge loops across the quad ring that passes
// through edge (a, b). With one cut, `factor` (0..1) slides it along the ring.
// The ring stops at triangles/n-gons and borders; faces outside the ring that share a cut edge
// (e.g. an n-gon cap) get the new vertices inserted into their outline, so there is no crack.

import { addVertex, cloneData, cornerUV, edgeKey, lerpColor, type MeshData } from '../mesh';
import { edgeRing } from './select';
import { emptySelection, flushSelection } from '../selection';
import { checkResult, OpError, type OpResult } from './opResult';

export function loopCut(mesh: MeshData, a: number, b: number, cuts = 1, factor = 0.5): OpResult {
  const n = Math.max(1, Math.min(64, Math.round(cuts)));
  const ring = edgeRing(mesh, a, b);
  if (!ring.steps.length) throw new OpError('Loop Cut needs an edge between quads');
  const t = ring.topo;
  const data = cloneData(mesh);
  const pos = data.positions;

  // Cut points per undirected edge, stored from the lower vertex index to the higher one.
  const cutsOn = new Map<number, number[]>();
  /** Every cut vertex: the edge it sits on (lo < hi) and its parameter measured from lo. */
  const cutAt = new Map<number, { lo: number; hi: number; t: number }>();
  const params = n === 1 ? [Math.min(0.98, Math.max(0.02, factor))] : Array.from({ length: n }, (_, i) => (i + 1) / (n + 1));
  /** Cut vertices on edge from→to, ordered from `from`. `tFrom` = params measured from `from`. */
  const pointsOn = (from: number, to: number): number[] => {
    const k = edgeKey(from, to);
    let pts = cutsOn.get(k);
    if (!pts) {
      // Parameters are defined from `from` the first time an edge is met (that is the ring's
      // consistent side), then stored low → high.
      pts = params.map((p) => {
        const at = (c: number) => pos[from * 3 + c] + (pos[to * 3 + c] - pos[from * 3 + c]) * p;
        const v = addVertex(data, at(0), at(1), at(2), lerpColor(data, from, to, p));
        cutAt.set(v, from < to ? { lo: from, hi: to, t: p } : { lo: to, hi: from, t: 1 - p });
        return v;
      });
      cutsOn.set(k, from < to ? pts : pts.slice().reverse());
      return pts;
    }
    return from < to ? pts : pts.slice().reverse();
  };

  /** UV of vertex x (original or cut) inside input face f: cut points interpolate their edge. */
  const uvIn = (f: number, x: number): number[] => {
    const c = cutAt.get(x);
    if (!c) return cornerUV(mesh, f, x) ?? [0, 0];
    const a = cornerUV(mesh, f, c.lo) ?? [0, 0], b = cornerUV(mesh, f, c.hi) ?? [0, 0];
    return [a[0] + (b[0] - a[0]) * c.t, a[1] + (b[1] - a[1]) * c.t];
  };
  const uvsOf = (f: number, face: number[]) => face.flatMap((x) => uvIn(f, x));

  const ringFaces = new Set<number>();
  const newFaces: number[][] = [];
  const newMats: number[] = [];
  const newUVs: number[][] = [];
  for (const { face, he } of ring.steps) {
    ringFaces.add(face);
    // Quad p0 p1 p2 p3 with entry edge p0→p1 and exit edge p2→p3.
    const p0 = t.heOrigin[he];
    const p1 = t.heOrigin[t.heNext[he]];
    const p2 = t.heOrigin[t.heNext[t.heNext[he]]];
    const p3 = t.heOrigin[t.hePrev[he]];
    const c = pointsOn(p0, p1); // from p0 towards p1
    const d = pointsOn(p3, p2); // from p3 towards p2 (same side as p0)
    const left = [p0, ...c], right = [p3, ...d];
    left.push(p1);
    right.push(p2);
    for (let i = 0; i < left.length - 1; i++) {
      const nf = [left[i], left[i + 1], right[i + 1], right[i]];
      newFaces.push(nf);
      newMats.push(data.faceMats?.[face] ?? 0);
      if (mesh.uvs) newUVs.push(uvsOf(face, nf));
    }
  }

  // Rebuild the face list: ring faces are replaced; other faces get cut points spliced in.
  const faces: number[][] = [];
  const mats: number[] = [];
  const uvs: number[][] = [];
  data.faces.forEach((f, fi) => {
    if (ringFaces.has(fi)) return;
    mats.push(data.faceMats?.[fi] ?? 0);
    const out: number[] = [];
    for (let i = 0; i < f.length; i++) {
      const u = f[i], w = f[(i + 1) % f.length];
      out.push(u);
      const k = edgeKey(u, w);
      const pts = cutsOn.get(k);
      if (pts) out.push(...(u < w ? pts : pts.slice().reverse()));
    }
    faces.push(out);
    if (mesh.uvs) uvs.push(uvsOf(fi, out));
  });
  data.faces = [...faces, ...newFaces];
  if (data.faceMats) data.faceMats = [...mats, ...newMats];
  if (data.uvs) data.uvs = [...uvs, ...newUVs];
  // Loose edges that were cut (not possible for ring edges, which always have faces) stay as is.
  checkResult(data, 'Loop Cut');

  // Select the new loop(s), like Blender.
  const s = emptySelection();
  for (const pts of cutsOn.values()) for (const v of pts) s.verts.add(v);
  return { data, selection: flushSelection(data, s, 'vert') };
}
