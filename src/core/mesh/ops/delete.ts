// Delete, like Blender's X menu for the current select mode:
// - vertices: removes them and every face/edge using them
// - edges: removes them and their faces; vertices left with nothing are removed too
// - faces: removes them; edges and vertices that no longer belong to anything go as well

import { cloneData, compactVertices, edgeFromKey, edgeKey, filterFaces, unreferencedVertices, type MeshData } from '../mesh';
import { emptySelection, type SelectMode, type Selection } from '../selection';
import { checkResult, OpError, type OpResult } from './opResult';

export function deleteSelected(mesh: MeshData, sel: Selection, mode: SelectMode): OpResult {
  const keepLoose = unreferencedVertices(mesh);
  const data = cloneData(mesh);

  if (mode === 'vert') {
    if (sel.verts.size === 0) throw new OpError('Nothing selected');
    filterFaces(data, (i) => !data.faces[i].some((v) => sel.verts.has(v)));
    data.looseEdges = data.looseEdges.filter(([a, b]) => !sel.verts.has(a) && !sel.verts.has(b));
    for (const v of sel.verts) keepLoose.delete(v);
    // Selected vertices must go even if something still referenced them: nothing does now.
  } else if (mode === 'edge') {
    if (sel.edges.size === 0) throw new OpError('Nothing selected');
    filterFaces(data, (fi) => {
      const f = data.faces[fi];
      return !f.some((v, i) => sel.edges.has(edgeKey(v, f[(i + 1) % f.length])));
    });
    data.looseEdges = data.looseEdges.filter(([a, b]) => !sel.edges.has(edgeKey(a, b)));
    for (const k of sel.edges) for (const v of edgeFromKey(k)) keepLoose.delete(v);
  } else {
    if (sel.faces.size === 0) throw new OpError('Nothing selected');
    filterFaces(data, (i) => !sel.faces.has(i));
  }

  const { data: out } = compactVertices(data, keepLoose);
  checkResult(out, 'Delete');
  return { data: out, selection: emptySelection() };
}
