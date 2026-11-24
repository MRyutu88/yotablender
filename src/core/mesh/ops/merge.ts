// Merge vertices: at center (Blender's M → At Center) and by distance (M → By Distance).
// Faces that collapse are removed, edges that collapse disappear, and the result must still be
// valid topology or the merge is refused.

import { cloneData, compactVertices, edgeKey, unreferencedVertices, type Edge, type MeshData } from '../mesh';
import { selectionFromVerts, type Selection } from '../selection';
import { checkResult, OpError, type OpResult } from './opResult';

export function mergeAtCenter(mesh: MeshData, sel: Selection): OpResult {
  const verts = [...sel.verts].sort((a, b) => a - b);
  if (verts.length < 2) throw new OpError('Select at least 2 vertices to merge');
  let x = 0, y = 0, z = 0;
  for (const v of verts) {
    x += mesh.positions[v * 3];
    y += mesh.positions[v * 3 + 1];
    z += mesh.positions[v * 3 + 2];
  }
  const target = verts[0];
  const map = new Map<number, number>();
  for (const v of verts) map.set(v, target);
  const data = cloneData(mesh);
  data.positions[target * 3] = x / verts.length;
  data.positions[target * 3 + 1] = y / verts.length;
  data.positions[target * 3 + 2] = z / verts.length;
  return applyMerge(mesh, data, map, 'Merge');
}

export function mergeByDistance(mesh: MeshData, sel: Selection, threshold = 0.0001): OpResult & { removed: number } {
  const verts = [...sel.verts].sort((a, b) => a - b);
  if (verts.length < 2) throw new OpError('Select at least 2 vertices to merge');
  const pos = mesh.positions;
  // Spatial hash + union-find.
  const cell = Math.max(threshold, 1e-9);
  const grid = new Map<string, number[]>();
  const parent = new Map<number, number>();
  const find = (v: number): number => {
    let r = v;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(v, r);
    return r;
  };
  const t2 = threshold * threshold;
  for (const v of verts) {
    parent.set(v, v);
    const cx = Math.floor(pos[v * 3] / cell), cy = Math.floor(pos[v * 3 + 1] / cell), cz = Math.floor(pos[v * 3 + 2] / cell);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          for (const u of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
            const d =
              (pos[u * 3] - pos[v * 3]) ** 2 + (pos[u * 3 + 1] - pos[v * 3 + 1]) ** 2 + (pos[u * 3 + 2] - pos[v * 3 + 2]) ** 2;
            if (d <= t2) {
              const ru = find(u), rv = find(v);
              if (ru !== rv) parent.set(Math.max(ru, rv), Math.min(ru, rv));
            }
          }
        }
    const key = `${cx},${cy},${cz}`;
    (grid.get(key) ?? grid.set(key, []).get(key)!).push(v);
  }
  const map = new Map<number, number>();
  let removed = 0;
  for (const v of verts) {
    const r = find(v);
    if (r !== v) {
      map.set(v, r);
      removed++;
    }
  }
  if (removed === 0) return { data: cloneData(mesh), selection: sel, removed: 0 };
  return { ...applyMerge(mesh, cloneData(mesh), map, 'Merge by distance'), removed };
}

/** Rewrites faces/edges through a vertex merge map and cleans up what collapsed. */
function applyMerge(orig: MeshData, data: MeshData, map: Map<number, number>, what: string): OpResult {
  const keepLoose = unreferencedVertices(orig);
  for (const v of map.keys()) if (map.get(v) !== v) keepLoose.delete(v);
  const m = (v: number) => map.get(v) ?? v;

  const faces: number[][] = [];
  for (const f of data.faces) {
    const g: number[] = [];
    for (const v of f.map(m)) if (g[g.length - 1] !== v) g.push(v);
    while (g.length > 1 && g[0] === g[g.length - 1]) g.pop();
    if (g.length < 3) continue; // collapsed to an edge or a point
    if (new Set(g).size !== g.length) continue; // pinched face: drop it
    faces.push(g);
  }
  // Faces that now share the same vertices: same winding → keep one; opposite → both go.
  const bySet = new Map<string, number[]>();
  faces.forEach((f, i) => {
    const k = f.slice().sort((a, b) => a - b).join(',');
    (bySet.get(k) ?? bySet.set(k, []).get(k)!).push(i);
  });
  const drop = new Set<number>();
  for (const idx of bySet.values()) {
    if (idx.length < 2) continue;
    const sameWinding = (a: number[], b: number[]) => {
      const i = b.indexOf(a[0]);
      return a.every((v, j) => b[(i + j) % b.length] === v);
    };
    const first = faces[idx[0]];
    if (idx.length === 2 && !sameWinding(first, faces[idx[1]])) idx.forEach((i) => drop.add(i));
    else idx.slice(1).forEach((i) => drop.add(i));
  }
  data.faces = faces.filter((_, i) => !drop.has(i));

  const faceEdges = new Set<number>();
  for (const f of data.faces) for (let i = 0; i < f.length; i++) faceEdges.add(edgeKey(f[i], f[(i + 1) % f.length]));
  const seen = new Set<number>();
  const loose: Edge[] = [];
  for (const [a0, b0] of data.looseEdges) {
    const a = m(a0), b = m(b0);
    const k = edgeKey(a, b);
    if (a === b || faceEdges.has(k) || seen.has(k)) continue;
    seen.add(k);
    loose.push([a, b]);
  }
  data.looseEdges = loose;

  const targets = new Set<number>(map.values());
  for (const t of targets) keepLoose.add(t); // a merge result may legitimately be a lone vertex
  const { data: out, remap } = compactVertices(data, keepLoose);
  checkResult(out, what);
  const sel = [...targets].map((t) => remap[t]).filter((v) => v >= 0);
  return { data: out, selection: selectionFromVerts(out, sel) };
}
