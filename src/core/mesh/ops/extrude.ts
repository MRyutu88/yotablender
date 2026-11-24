// Extrude, like Blender's E key:
// - selected faces: region extrude. Connected faces move together; side walls are built along
//   the region's outline (including open mesh borders, so extruding a plane makes a box).
// - selected edges not part of a selected face: each becomes a new quad (a strip for chains).
// - selected vertices not part of a selected edge: each gets a new wire edge.
// The new geometry starts at the same place; the caller then moves it (along `normal` for faces).

import { cloneData, edgeFromKey, edgeKey, faceNormalRaw, unreferencedVertices, compactVertices, type Edge, type MeshData } from '../mesh';
import { emptySelection, flushSelection, type Selection } from '../selection';
import { checkResult, OpError, type OpResult } from './opResult';

export function extrude(mesh: MeshData, sel: Selection): OpResult {
  if (sel.verts.size === 0) throw new OpError('Nothing selected');
  const keepLoose = unreferencedVertices(mesh);
  const data = cloneData(mesh);
  const pos = data.positions;
  let normal: [number, number, number] | undefined;

  const dup = new Map<number, number>();
  const duplicate = (v: number): number => {
    let d = dup.get(v);
    if (d === undefined) {
      d = pos.length / 3;
      pos.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
      dup.set(v, d);
    }
    return d;
  };

  // --- Faces: region extrude -----------------------------------------------------------------
  const regionFaces = [...sel.faces].filter((f) => f < mesh.faces.length);
  const coveredEdges = new Set<number>();
  if (regionFaces.length) {
    // Directed edges of the region; an edge is on the outline when its reverse isn't in the region.
    const directed = new Set<string>();
    for (const f of regionFaces) {
      const face = mesh.faces[f];
      for (let i = 0; i < face.length; i++) directed.add(`${face[i]},${face[(i + 1) % face.length]}`);
    }
    // Average normal of the region (area weighted) for the follow-up move.
    let nx = 0, ny = 0, nz = 0;
    for (const f of regionFaces) {
      const n = faceNormalRaw(mesh.positions, mesh.faces[f]);
      nx += n[0];
      ny += n[1];
      nz += n[2];
    }
    const nl = Math.hypot(nx, ny, nz);
    normal = nl > 1e-12 ? [nx / nl, ny / nl, nz / nl] : [0, 0, 1];

    for (const f of regionFaces) {
      const face = mesh.faces[f];
      for (let i = 0; i < face.length; i++) {
        const a = face[i], b = face[(i + 1) % face.length];
        coveredEdges.add(edgeKey(a, b));
        if (!directed.has(`${b},${a}`)) {
          // Outline edge a→b: side wall a, b, b', a' (keeps winding consistent with the neighbours).
          data.faces.push([a, b, duplicate(b), duplicate(a)]);
        }
      }
    }
    // Move the region onto the duplicated vertices. Interior vertices of the region are
    // duplicated too and their originals dropped by compaction below.
    for (const f of regionFaces) {
      data.faces[f] = mesh.faces[f].map((v) => duplicate(v));
    }
  }

  // --- Edges ----------------------------------------------------------------------------------
  const faceDirected = new Map<string, number>();
  mesh.faces.forEach((f, fi) => {
    for (let i = 0; i < f.length; i++) faceDirected.set(`${f[i]},${f[(i + 1) % f.length]}`, fi);
  });
  const lonelyEdges = [...sel.edges].filter((k) => !coveredEdges.has(k));
  if (lonelyEdges.length) {
    // Orient each edge: opposite to the face that already uses it, so the new quad continues
    // the surface. Wire edges are oriented along their chain so neighbouring quads agree.
    const oriented: Edge[] = [];
    const wire: Edge[] = [];
    for (const k of lonelyEdges) {
      const [a, b] = edgeFromKey(k);
      const fab = faceDirected.has(`${a},${b}`), fba = faceDirected.has(`${b},${a}`);
      if (fab && fba) throw new OpError('Can only extrude edges on a border (or loose edges)');
      if (fab) oriented.push([b, a]);
      else if (fba) oriented.push([a, b]);
      else wire.push([a, b]);
    }
    oriented.push(...orientChains(wire));
    for (const [a, b] of oriented) {
      // [a, b, b', a'] runs a→b, opposite to the existing face's b→a.
      data.faces.push([a, b, duplicate(b), duplicate(a)]);
    }
    // A loose edge that now has a face is no longer loose.
    const used = new Set(lonelyEdges);
    data.looseEdges = data.looseEdges.filter(([a, b]) => !used.has(edgeKey(a, b)));
  }

  // --- Vertices -------------------------------------------------------------------------------
  const edgeVerts = new Set<number>();
  for (const k of sel.edges) {
    const [a, b] = edgeFromKey(k);
    edgeVerts.add(a);
    edgeVerts.add(b);
  }
  for (const v of sel.verts) {
    if (edgeVerts.has(v)) continue;
    const d = duplicate(v);
    data.looseEdges.push([v, d]);
  }

  const { data: out, remap } = compactVertices(data, keepLoose);
  checkResult(out, 'Extrude');

  // New selection: the copies that will be moved, like Blender.
  const s = emptySelection();
  for (const d of dup.values()) if (remap[d] >= 0) s.verts.add(remap[d]);
  const selection: Selection = flushSelection(out, s, 'vert');
  return { data: out, selection, normal };
}

/** Orients wire edges so consecutive edges in a chain run head-to-tail. */
function orientChains(edges: Edge[]): Edge[] {
  if (edges.length === 0) return [];
  const adj = new Map<number, number[]>();
  edges.forEach(([a, b], i) => {
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(i);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(i);
  });
  const out: Edge[] = new Array(edges.length);
  const done = new Uint8Array(edges.length);
  // Start walks at chain ends (degree 1) first, then whatever is left (closed loops).
  const starts = [...adj.keys()].sort((x, y) => adj.get(x)!.length - adj.get(y)!.length);
  for (const s of starts) {
    let v = s;
    for (;;) {
      const next = adj.get(v)!.find((i) => !done[i]);
      if (next === undefined) break;
      done[next] = 1;
      const [a, b] = edges[next];
      const to = a === v ? b : a;
      out[next] = [v, to];
      v = to;
    }
  }
  return out;
}
