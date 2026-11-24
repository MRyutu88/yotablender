// Edit-mode selection with Blender's flushing rules.
//
// The selection keeps vertices, edges (by undirected edge key) and faces. The active select
// mode decides which set is the "source" and how the others are derived:
// - vertex mode: an edge is selected when both its vertices are, a face when all its vertices are
// - edge mode:   vertices of selected edges; a face when all its edges are
// - face mode:   vertices and edges of selected faces

import { allEdgeKeys, edgeFromKey, edgeKey, type MeshData } from './mesh';

export type SelectMode = 'vert' | 'edge' | 'face';

export interface Selection {
  verts: Set<number>;
  edges: Set<number>;
  faces: Set<number>;
}

export const emptySelection = (): Selection => ({ verts: new Set(), edges: new Set(), faces: new Set() });

export const cloneSelection = (s: Selection): Selection => ({
  verts: new Set(s.verts),
  edges: new Set(s.edges),
  faces: new Set(s.faces),
});

export const selectionIsEmpty = (s: Selection): boolean => s.verts.size === 0 && s.edges.size === 0 && s.faces.size === 0;

/** Recomputes the derived sets from the set that belongs to `mode`. */
export function flushSelection(mesh: MeshData, sel: Selection, mode: SelectMode): Selection {
  const out = emptySelection();
  if (mode === 'vert') {
    for (const v of sel.verts) out.verts.add(v);
    for (const k of allEdgeKeys(mesh)) {
      const [a, b] = edgeFromKey(k);
      if (out.verts.has(a) && out.verts.has(b)) out.edges.add(k);
    }
    mesh.faces.forEach((f, i) => {
      if (f.every((v) => out.verts.has(v))) out.faces.add(i);
    });
  } else if (mode === 'edge') {
    for (const k of sel.edges) {
      out.edges.add(k);
      const [a, b] = edgeFromKey(k);
      out.verts.add(a);
      out.verts.add(b);
    }
    mesh.faces.forEach((f, i) => {
      if (f.every((v, j) => out.edges.has(edgeKey(v, f[(j + 1) % f.length])))) out.faces.add(i);
    });
  } else {
    for (const fi of sel.faces) {
      const f = mesh.faces[fi];
      if (!f) continue;
      out.faces.add(fi);
      for (let j = 0; j < f.length; j++) {
        out.verts.add(f[j]);
        out.edges.add(edgeKey(f[j], f[(j + 1) % f.length]));
      }
    }
  }
  return out;
}

/** Applies a pick (replace / add / subtract) of elements of the current mode, then flushes. */
export function applyPick(
  mesh: MeshData,
  sel: Selection,
  mode: SelectMode,
  items: Iterable<number>,
  op: 'replace' | 'add' | 'sub' | 'toggle',
): Selection {
  const key = mode === 'vert' ? 'verts' : mode === 'edge' ? 'edges' : 'faces';
  let next: Selection = op === 'replace' ? emptySelection() : cloneSelection(sel);
  const target = next[key];
  if (op === 'sub') {
    for (const i of items) target.delete(i);
    // Subtracting in vertex mode must also deselect the derived edges/faces.
  } else if (op === 'toggle') {
    for (const i of items) {
      if (target.has(i)) target.delete(i);
      else target.add(i);
    }
  } else {
    for (const i of items) target.add(i);
  }
  next = flushSelection(mesh, next, mode);
  return next;
}

/** Everything selected; valid in every select mode. */
export function selectAll(mesh: MeshData): Selection {
  const s = emptySelection();
  for (let i = 0; i < mesh.positions.length / 3; i++) s.verts.add(i);
  return flushSelection(mesh, s, 'vert');
}

export function invertSelection(mesh: MeshData, sel: Selection, mode: SelectMode): Selection {
  const s = emptySelection();
  if (mode === 'vert') {
    for (let i = 0; i < mesh.positions.length / 3; i++) if (!sel.verts.has(i)) s.verts.add(i);
  } else if (mode === 'edge') {
    for (const k of allEdgeKeys(mesh)) if (!sel.edges.has(k)) s.edges.add(k);
  } else {
    for (let i = 0; i < mesh.faces.length; i++) if (!sel.faces.has(i)) s.faces.add(i);
  }
  return flushSelection(mesh, s, mode);
}

/** Vertices affected by a transform of this selection. */
export const selectedVerts = (sel: Selection): number[] => [...sel.verts].sort((a, b) => a - b);

/** Selection made of the given vertices (and whatever edges/faces they fully cover). */
export function selectionFromVerts(mesh: MeshData, verts: Iterable<number>): Selection {
  const s = emptySelection();
  for (const v of verts) s.verts.add(v);
  return flushSelection(mesh, s, 'vert');
}

/** Selection made of the given faces (and their vertices and edges). */
export function selectionFromFaces(mesh: MeshData, faces: Iterable<number>): Selection {
  const s = emptySelection();
  for (const f of faces) s.faces.add(f);
  return flushSelection(mesh, s, 'face');
}

/** Selection made of the given edge keys (and their vertices). */
export function selectionFromEdges(mesh: MeshData, edges: Iterable<number>): Selection {
  const s = emptySelection();
  for (const e of edges) s.edges.add(e);
  return flushSelection(mesh, s, 'edge');
}

/** Converts a selection when the user switches select mode (Blender keeps what is fully covered). */
export function convertSelectMode(mesh: MeshData, sel: Selection, to: SelectMode): Selection {
  return flushSelection(mesh, sel, to);
}
