// Selection walkers: Select Linked (whole connected piece), Select Loop (edge loop, like
// Blender's Alt+click) and Select Ring (the edges a loop cut would cross).

import type { MeshData } from '../mesh';
import { edgeKey } from '../keys';
import { buildTopology, type Topology } from '../topology';
import { flushSelection, emptySelection, type Selection, type SelectMode } from '../selection';

/** Everything connected (through edges) to the current selection. */
export function selectLinked(mesh: MeshData, sel: Selection, mode: SelectMode): Selection {
  const t = buildTopology(mesh);
  const seen = new Uint8Array(t.nV);
  const stack = [...sel.verts];
  for (const v of stack) seen[v] = 1;
  while (stack.length) {
    const v = stack.pop()!;
    for (let k = t.vEdgeStart[v]; k < t.vEdgeStart[v + 1]; k++) {
      const e = t.vEdges[k];
      const o = t.edgeV[e * 2] === v ? t.edgeV[e * 2 + 1] : t.edgeV[e * 2];
      if (!seen[o]) {
        seen[o] = 1;
        stack.push(o);
      }
    }
  }
  const s = emptySelection();
  for (let v = 0; v < t.nV; v++) if (seen[v]) s.verts.add(v);
  return flushSelection(mesh, flushSelection(mesh, s, 'vert'), mode);
}

/** Half-edge of edge (a, b) that belongs to a face, preferring a → b. */
function faceHalfEdge(t: Topology, a: number, b: number): number {
  const e = t.edgeIndex.get(edgeKey(a, b));
  if (e === undefined) return -1;
  const h = t.edgeHe[e];
  const tw = t.heTwin[h];
  if (t.heFace[h] >= 0) return t.heOrigin[h] === a || t.heFace[tw] < 0 ? h : tw;
  return t.heFace[tw] >= 0 ? tw : h;
}

const valence = (t: Topology, v: number) => t.vEdgeStart[v + 1] - t.vEdgeStart[v];
const isBoundaryHe = (t: Topology, h: number) => t.heFace[h] < 0 || t.heFace[t.heTwin[h]] < 0;

/**
 * Edge loop through edge (a, b): continues straight across every 4-valent vertex (the edge
 * "opposite" the incoming one), stopping at poles, n-gon corners or the mesh border.
 * On an open border it follows the border instead, like Blender.
 */
export function edgeLoop(mesh: MeshData, a: number, b: number): number[] {
  const t = buildTopology(mesh);
  const start = faceHalfEdge(t, a, b);
  if (start < 0) return [];
  const loop = new Set<number>([t.heEdge[start]]);

  if (isBoundaryHe(t, start)) {
    // Border loop: walk the boundary half-edge cycle.
    const bh = t.heFace[start] < 0 ? start : t.heTwin[start];
    for (let h = t.heNext[bh]; h !== bh && h >= 0; h = t.heNext[h]) {
      if (loop.has(t.heEdge[h])) break;
      loop.add(t.heEdge[h]);
    }
    return [...loop].map((e) => edgeKey(t.edgeV[e * 2], t.edgeV[e * 2 + 1]));
  }

  // Walk forward from the head of each direction.
  const walk = (h0: number) => {
    let h = h0;
    for (let guard = 0; guard < t.nE; guard++) {
      const v = t.heOrigin[t.heNext[h]]; // head vertex
      if (valence(t, v) !== 4) return;
      const n = t.heNext[h];
      if (t.heFace[n] < 0) return;
      const across = t.heTwin[n];
      if (t.heFace[across] < 0) return;
      const next = t.heNext[across];
      // All faces around a loop vertex must be quads for "straight across" to mean anything.
      if (faceLen(t, t.heFace[h]) !== 4 || faceLen(t, t.heFace[across]) !== 4) return;
      const e = t.heEdge[next];
      if (loop.has(e)) return; // closed loop
      loop.add(e);
      h = next;
    }
  };
  walk(start);
  walk(t.heTwin[start]);
  return [...loop].map((e) => edgeKey(t.edgeV[e * 2], t.edgeV[e * 2 + 1]));
}

function faceLen(t: Topology, f: number): number {
  if (f < 0) return 0;
  let n = 0;
  let h = t.fHe[f];
  do {
    n++;
    h = t.heNext[h];
  } while (h !== t.fHe[f] && n < 1000);
  return n;
}

/**
 * Edge ring through edge (a, b): steps to the opposite edge of each quad. Returns the ring as
 * a list of steps { face, entry half-edge } plus the ring's edge keys. Stops at non-quads and
 * borders; `closed` tells whether it went all the way around.
 */
export function edgeRing(
  mesh: MeshData,
  a: number,
  b: number,
): { edges: number[]; steps: { face: number; he: number }[]; closed: boolean; topo: Topology } {
  const t = buildTopology(mesh);
  const start = faceHalfEdge(t, a, b);
  const edges = new Set<number>();
  const steps: { face: number; he: number }[] = [];
  if (start < 0) return { edges: [], steps, closed: false, topo: t };
  edges.add(t.heEdge[start]);
  let closed = false;
  // Forward: from the face of `start` across to the opposite edges.
  const forward = (h0: number, push: (s: { face: number; he: number }) => void) => {
    let h = h0;
    for (let guard = 0; guard <= t.nF; guard++) {
      const f = t.heFace[h];
      if (f < 0 || faceLen(t, f) !== 4) return;
      const opp = t.heNext[t.heNext[h]];
      push({ face: f, he: h });
      const e = t.heEdge[opp];
      if (edges.has(e)) {
        closed = true;
        return;
      }
      edges.add(e);
      h = t.heTwin[opp];
    }
  };
  forward(start, (s) => steps.push(s));
  if (!closed) {
    // Backward from the other side of the start edge; these steps go before the forward ones.
    const back: { face: number; he: number }[] = [];
    forward(t.heTwin[start], (s) => back.push(s));
    // A backward step entered through he; flip it to the ring's direction (enter through the
    // opposite edge's twin side) so all steps run the same way.
    const flipped = back.map(({ face, he }) => ({ face, he: t.heNext[t.heNext[he]] }));
    steps.unshift(...flipped.reverse());
  }
  return { edges: [...edges].map((e) => edgeKey(t.edgeV[e * 2], t.edgeV[e * 2 + 1])), steps, closed, topo: t };
}

export function selectLoop(mesh: MeshData, sel: Selection, a: number, b: number, add: boolean): Selection {
  const s = add ? { ...sel, edges: new Set(sel.edges) } : emptySelection();
  for (const k of edgeLoop(mesh, a, b)) s.edges.add(k);
  return flushSelection(mesh, s, 'edge');
}

export function selectRing(mesh: MeshData, sel: Selection, a: number, b: number, add: boolean): Selection {
  const s = add ? { ...sel, edges: new Set(sel.edges) } : emptySelection();
  for (const k of edgeRing(mesh, a, b).edges) s.edges.add(k);
  return flushSelection(mesh, s, 'edge');
}
