// Half-edge connectivity built from a MeshData.
//
// Every face edge is a half-edge owned by its face (CCW). Edges on an open boundary get an
// explicit boundary half-edge (face = -1) as their twin, and loose wire edges are a pair of
// boundary half-edges. Boundary half-edges are linked into cycles so `next`/`prev` are total.
//
// A half-edge mesh can't represent an edge shared by 3+ faces, or two faces that disagree on
// winding across an edge. Those are reported in `errors` (and refused by every edit op).

import { edgeKey } from './keys';
import type { MeshData } from './mesh';

export interface Topology {
  nV: number;
  nF: number;
  nE: number;
  nHe: number;
  heOrigin: Int32Array;
  heNext: Int32Array;
  hePrev: Int32Array;
  heTwin: Int32Array;
  /** Owning face, or -1 for boundary / wire half-edges. */
  heFace: Int32Array;
  heEdge: Int32Array;
  /** One outgoing half-edge per vertex (a boundary one if the vertex is on a boundary), or -1. */
  vHe: Int32Array;
  fHe: Int32Array;
  /** Edge endpoints, 2 per edge. */
  edgeV: Int32Array;
  edgeHe: Int32Array;
  /** Undirected edge key -> edge index (built on first use). */
  readonly edgeIndex: Map<number, number>;
  /** CSR adjacency: vertex → incident edges, vertex → incident faces. */
  vEdgeStart: Int32Array;
  vEdges: Int32Array;
  vFaceStart: Int32Array;
  vFaces: Int32Array;
  /** Problems found while building (non-manifold edges, flipped winding, bad faces). */
  errors: string[];
}

export function buildTopology(mesh: MeshData): Topology {
  return buildTopologyRaw(mesh.positions.length / 3, mesh.faces, mesh.looseEdges);
}

/**
 * Builds connectivity from a vertex count and face/edge lists (no positions needed).
 * Hash-map free: twins are found through per-vertex lists of outgoing half-edges (CSR), which
 * keeps this fast enough to run on every topology change for 100k+ faces.
 */
export function buildTopologyRaw(nV: number, faces: number[][], looseEdges: [number, number][]): Topology {
  const nF = faces.length;
  const errors: string[] = [];

  let faceHe = 0;
  for (const f of faces) faceHe += f.length;

  // Upper bound: every face half-edge may need a boundary twin, plus 2 per loose edge.
  const cap = faceHe * 2 + looseEdges.length * 2;
  const heOrigin = new Int32Array(cap);
  const heNext = new Int32Array(cap).fill(-1);
  const hePrev = new Int32Array(cap).fill(-1);
  const heTwin = new Int32Array(cap).fill(-1);
  const heFace = new Int32Array(cap).fill(-1);
  const heEdge = new Int32Array(cap).fill(-1);
  const fHe = new Int32Array(nF).fill(-1);
  const valid = (v: number) => Number.isInteger(v) && v >= 0 && v < nV;

  let nHe = 0;
  for (let f = 0; f < nF; f++) {
    const face = faces[f];
    const k = face.length;
    if (k < 3) errors.push(`face ${f} has ${k} vertices`);
    const first = nHe;
    for (let i = 0; i < k; i++) {
      const a = face[i];
      if (!valid(a)) errors.push(`face ${f} references missing vertex ${a}`);
      if (a === face[(i + 1) % k]) errors.push(`face ${f} has a repeated vertex ${a}`);
      else for (let j = i + 2; j < k; j++) if (face[j] === a && !(i === 0 && j === k - 1)) errors.push(`face ${f} visits a vertex twice`);
      const h = nHe++;
      heOrigin[h] = valid(a) ? a : 0;
      heFace[h] = f;
      heNext[h] = i === k - 1 ? first : h + 1;
      hePrev[h] = i === 0 ? first + k - 1 : h - 1;
    }
    fHe[f] = k ? first : -1;
  }
  const dest = (h: number) => heOrigin[heNext[h]];

  // Outgoing face half-edges per vertex (CSR).
  const outStart = new Int32Array(nV + 1);
  for (let h = 0; h < faceHe; h++) outStart[heOrigin[h] + 1]++;
  for (let v = 0; v < nV; v++) outStart[v + 1] += outStart[v];
  const outList = new Int32Array(faceHe);
  const fill = outStart.slice(0, nV);
  for (let h = 0; h < faceHe; h++) outList[fill[heOrigin[h]]++] = h;
  const findOut = (a: number, b: number, skip = -1): number => {
    for (let i = outStart[a], e = outStart[a + 1]; i < e; i++) {
      const h = outList[i];
      if (h !== skip && dest(h) === b) return h;
    }
    return -1;
  };

  // The same directed edge twice means flipped winding or an edge shared by 3+ faces.
  for (let h = 0; h < faceHe; h++) {
    const d = findOut(heOrigin[h], dest(h), h);
    if (d !== -1 && d < h) {
      errors.push(`edge ${heOrigin[h]}-${dest(h)} is used twice in the same direction (non-manifold or flipped face)`);
    }
  }

  // Twins for face half-edges; create boundary half-edges where there is no opposite face.
  const boundaryStart = faceHe;
  for (let h = 0; h < faceHe; h++) {
    if (heTwin[h] !== -1) continue;
    const a = heOrigin[h], b = dest(h);
    let t = -1;
    for (let i = outStart[b], e = outStart[b + 1]; i < e; i++) {
      const g = outList[i];
      if (heTwin[g] === -1 && dest(g) === a && g !== h) {
        t = g;
        break;
      }
    }
    if (t !== -1) {
      heTwin[h] = t;
      heTwin[t] = h;
    } else {
      const bh = nHe++;
      heOrigin[bh] = b;
      heTwin[h] = bh;
      heTwin[bh] = h;
    }
  }

  // Loose wire edges: a pair of boundary half-edges (skipping ones that duplicate face edges).
  const seenLoose = new Set<number>();
  for (const [a, b] of looseEdges) {
    if (a === b || !valid(a) || !valid(b)) {
      errors.push(`loose edge ${a}-${b} is invalid`);
      continue;
    }
    const k = edgeKey(a, b);
    if (seenLoose.has(k) || findOut(a, b) !== -1 || findOut(b, a) !== -1) continue;
    seenLoose.add(k);
    const h1 = nHe++, h2 = nHe++;
    heOrigin[h1] = a;
    heOrigin[h2] = b;
    heTwin[h1] = h2;
    heTwin[h2] = h1;
  }

  // Link boundary half-edges into cycles: at each vertex, pair incoming with outgoing ones.
  const nB = nHe - boundaryStart;
  if (nB > 0) {
    const bOutStart = new Int32Array(nV + 1), bInStart = new Int32Array(nV + 1);
    for (let h = boundaryStart; h < nHe; h++) {
      bOutStart[heOrigin[h] + 1]++;
      bInStart[heOrigin[heTwin[h]] + 1]++;
    }
    for (let v = 0; v < nV; v++) {
      bOutStart[v + 1] += bOutStart[v];
      bInStart[v + 1] += bInStart[v];
    }
    const bOut = new Int32Array(nB), bIn = new Int32Array(nB);
    const fo = bOutStart.slice(0, nV), fi = bInStart.slice(0, nV);
    for (let h = boundaryStart; h < nHe; h++) {
      bOut[fo[heOrigin[h]]++] = h;
      bIn[fi[heOrigin[heTwin[h]]]++] = h;
    }
    const used = new Uint8Array(nB);
    for (let v = 0; v < nV; v++) {
      const i0 = bInStart[v], i1 = bInStart[v + 1], o0 = bOutStart[v], o1 = bOutStart[v + 1];
      if (i1 - i0 !== o1 - o0) errors.push(`vertex ${v} has an inconsistent boundary`);
      // Prefer pairing an incoming boundary half-edge with an outgoing one that is not its own
      // twin, so a loop continues around the fan instead of bouncing back along a wire edge.
      for (let i = i0; i < i1; i++) {
        const hin = bIn[i];
        let pick = -1;
        for (let j = o0; j < o1; j++) {
          if (!used[j] && bOut[j] !== heTwin[hin]) {
            pick = j;
            break;
          }
        }
        if (pick === -1) {
          for (let j = o0; j < o1; j++) {
            if (!used[j]) {
              pick = j;
              break;
            }
          }
        }
        if (pick === -1) break;
        used[pick] = 1;
        heNext[hin] = bOut[pick];
        hePrev[bOut[pick]] = hin;
      }
    }
  }

  // Edges: one per twin pair.
  const edgeV = new Int32Array(nHe);
  const edgeHe = new Int32Array(nHe >> 1);
  let nE = 0;
  for (let h = 0; h < nHe; h++) {
    if (heEdge[h] !== -1) continue;
    const e = nE++;
    heEdge[h] = e;
    heEdge[heTwin[h]] = e;
    edgeV[e * 2] = heOrigin[h];
    edgeV[e * 2 + 1] = heOrigin[heTwin[h]];
    edgeHe[e] = h;
  }

  // Vertex → one outgoing half-edge (boundary preferred).
  const vHe = new Int32Array(nV).fill(-1);
  for (let h = 0; h < nHe; h++) {
    const v = heOrigin[h];
    if (vHe[v] === -1 || (heFace[h] === -1 && heFace[vHe[v]] !== -1)) vHe[v] = h;
  }

  // CSR adjacency.
  const vEdgeCount = new Int32Array(nV + 1);
  for (let e = 0; e < nE; e++) {
    vEdgeCount[edgeV[e * 2]]++;
    vEdgeCount[edgeV[e * 2 + 1]]++;
  }
  const vEdgeStart = prefix(vEdgeCount, nV);
  const vEdges = new Int32Array(vEdgeStart[nV]);
  const fillE = vEdgeStart.slice(0, nV);
  for (let e = 0; e < nE; e++) {
    vEdges[fillE[edgeV[e * 2]]++] = e;
    vEdges[fillE[edgeV[e * 2 + 1]]++] = e;
  }
  const vFaceCount = new Int32Array(nV + 1);
  for (const f of faces) for (const v of f) if (valid(v)) vFaceCount[v]++;
  const vFaceStart = prefix(vFaceCount, nV);
  const vFaces = new Int32Array(vFaceStart[nV]);
  const fillF = vFaceStart.slice(0, nV);
  for (let f = 0; f < nF; f++) for (const v of faces[f]) if (valid(v)) vFaces[fillF[v]++] = f;

  let edgeIndexCache: Map<number, number> | null = null;
  const edgeVOut = edgeV.slice(0, nE * 2);
  return {
    nV,
    nF,
    nE,
    nHe,
    heOrigin: heOrigin.subarray(0, nHe),
    heNext: heNext.subarray(0, nHe),
    hePrev: hePrev.subarray(0, nHe),
    heTwin: heTwin.subarray(0, nHe),
    heFace: heFace.subarray(0, nHe),
    heEdge: heEdge.subarray(0, nHe),
    vHe,
    fHe,
    edgeV: edgeVOut,
    edgeHe: edgeHe.slice(0, nE),
    get edgeIndex() {
      if (!edgeIndexCache) {
        edgeIndexCache = new Map();
        for (let e = 0; e < nE; e++) edgeIndexCache.set(edgeKey(edgeVOut[e * 2], edgeVOut[e * 2 + 1]), e);
      }
      return edgeIndexCache;
    },
    vEdgeStart,
    vEdges,
    vFaceStart,
    vFaces,
    errors,
  };
}

function prefix(counts: Int32Array, n: number): Int32Array {
  const start = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) start[i + 1] = start[i] + counts[i];
  return start;
}

/** Faces on each side of an edge (-1 where there is none). */
export function edgeFaces(t: Topology, e: number): [number, number] {
  const h = t.edgeHe[e];
  return [t.heFace[h], t.heFace[t.heTwin[h]]];
}

export const isBoundaryEdge = (t: Topology, e: number): boolean => {
  const [a, b] = edgeFaces(t, e);
  return (a === -1) !== (b === -1);
};

export const isWireEdge = (t: Topology, e: number): boolean => {
  const [a, b] = edgeFaces(t, e);
  return a === -1 && b === -1;
};

/** The other endpoint of edge `e` seen from vertex `v`. */
export const otherVert = (t: Topology, e: number, v: number): number =>
  t.edgeV[e * 2] === v ? t.edgeV[e * 2 + 1] : t.edgeV[e * 2];
