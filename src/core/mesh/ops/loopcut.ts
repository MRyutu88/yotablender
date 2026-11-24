// Loop Cut (Blender's Ctrl+R): inserts `cuts` edge loops across the quad ring that passes
// through edge (a, b). With one cut, `factor` (0..1) slides it along the ring.
// The ring stops at triangles/n-gons and borders; faces outside the ring that share a cut edge
// (e.g. an n-gon cap) get the new vertices inserted into their outline, so there is no crack.

import { cloneData, edgeKey, type MeshData } from '../mesh';
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
  const params = n === 1 ? [Math.min(0.98, Math.max(0.02, factor))] : Array.from({ length: n }, (_, i) => (i + 1) / (n + 1));
  /** Cut vertices on edge from→to, ordered from `from`. `tFrom` = params measured from `from`. */
  const pointsOn = (from: number, to: number): number[] => {
    const k = edgeKey(from, to);
    let pts = cutsOn.get(k);
    if (!pts) {
      // Parameters are defined from `from` the first time an edge is met (that is the ring's
      // consistent side), then stored low → high.
      pts = params.map((p) => {
        const i = pos.length / 3;
        for (let c = 0; c < 3; c++) pos.push(pos[from * 3 + c] + (pos[to * 3 + c] - pos[from * 3 + c]) * p);
        return i;
      });
      cutsOn.set(k, from < to ? pts : pts.slice().reverse());
      return pts;
    }
    return from < to ? pts : pts.slice().reverse();
  };

  const ringFaces = new Set<number>();
  const newFaces: number[][] = [];
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
    for (let i = 0; i < left.length - 1; i++) newFaces.push([left[i], left[i + 1], right[i + 1], right[i]]);
  }

  // Rebuild the face list: ring faces are replaced; other faces get cut points spliced in.
  const faces: number[][] = [];
  data.faces.forEach((f, fi) => {
    if (ringFaces.has(fi)) return;
    const out: number[] = [];
    for (let i = 0; i < f.length; i++) {
      const u = f[i], w = f[(i + 1) % f.length];
      out.push(u);
      const k = edgeKey(u, w);
      const pts = cutsOn.get(k);
      if (pts) out.push(...(u < w ? pts : pts.slice().reverse()));
    }
    faces.push(out);
  });
  data.faces = [...faces, ...newFaces];
  // Loose edges that were cut (not possible for ring edges, which always have faces) stay as is.
  checkResult(data, 'Loop Cut');

  // Select the new loop(s), like Blender.
  const s = emptySelection();
  for (const pts of cutsOn.values()) for (const v of pts) s.verts.add(v);
  return { data, selection: flushSelection(data, s, 'vert') };
}
