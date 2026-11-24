// Catmull-Clark subdivision tuned to match Blender's Subdivision Surface modifier with its
// defaults (verified against Blender 5.3 output in catmullClark.test.ts):
// - boundary_smooth = 'ALL': open boundaries are smooth B-spline curves, corners included
// - n-gons become n quads on the first level
// - use_limit_surface = True: final vertices are projected onto the limit surface
//
// Speed comes from splitting topology from positions. `buildSubdivPlan` runs only when the
// topology (or level) changes and produces sparse stencil tables. `evaluateSubdiv` runs every
// frame while dragging: a few linear passes over typed arrays, with no allocation.
//
// Vertex ordering at every level: [vertex points | edge points | face points]. So cage vertex
// i stays vertex i at every level.

import { buildTopologyRaw, type Topology } from '../mesh/topology';
import { edgeKey } from '../mesh/keys';

export interface Stencils {
  start: Int32Array; // CSR offsets, length nOut + 1
  idx: Int32Array;
  w: Float64Array;
}

interface PlanLevel {
  nIn: number;
  nFaces: number;
  /** Face points, written into work[nIn + f]. Sources are input vertices. */
  facePts: Stencils;
  /** Next-level vertices; sources index the work buffer (inputs, then face points). */
  out: Stencils;
  nOut: number;
}

export interface SubdivPlan {
  levels: PlanLevel[];
  /** Limit-surface projection applied to the last level, or null. */
  limit: Stencils | null;
  nCage: number;
  nFinal: number;
  /** Final polygons (all quads when levels ≥ 1). */
  faces: number[][];
  looseEdges: [number, number][];
  /** Preallocated work buffers, one per level (inputs + face points), xyz interleaved. */
  work: Float64Array[];
  scratch: Float64Array;
}

export interface SubdivOptions {
  levels: number;
  useLimitSurface: boolean;
}

export function buildSubdivPlan(
  nV: number,
  faces: number[][],
  looseEdges: [number, number][],
  opts: SubdivOptions,
): SubdivPlan {
  const levels: PlanLevel[] = [];
  let curV = nV, curFaces = faces, curLoose = looseEdges;
  let topo: Topology | null = null;
  for (let l = 0; l < opts.levels; l++) {
    topo = buildTopologyRaw(curV, curFaces, curLoose);
    const { level, faces: nf, loose: nl, nOut } = refineLevel(topo, curFaces, curLoose);
    levels.push(level);
    curV = nOut;
    curFaces = nf;
    curLoose = nl;
  }
  let limit: Stencils | null = null;
  if (opts.useLimitSurface && opts.levels > 0) {
    limit = limitStencils(buildTopologyRaw(curV, curFaces, curLoose), curFaces);
  }
  return {
    levels,
    limit,
    nCage: nV,
    nFinal: curV,
    faces: curFaces,
    looseEdges: curLoose,
    work: levels.map((lv) => new Float64Array((lv.nIn + lv.nFaces) * 3)),
    scratch: new Float64Array(curV * 3),
  };
}

/** Evaluates final positions from cage positions. `out` must hold nFinal * 3 floats. */
export function evaluateSubdiv(plan: SubdivPlan, cage: ArrayLike<number>, out: Float32Array | Float64Array): void {
  if (plan.levels.length === 0) {
    for (let i = 0; i < plan.nCage * 3; i++) out[i] = cage[i];
    return;
  }
  // Level 0 input = cage.
  const w0 = plan.work[0];
  for (let i = 0; i < plan.nCage * 3; i++) w0[i] = cage[i];
  for (let l = 0; l < plan.levels.length; l++) {
    const lv = plan.levels[l];
    const work = plan.work[l];
    applyStencils(lv.facePts, work, work, lv.nIn);
    const last = l === plan.levels.length - 1;
    const dst = last ? (plan.limit ? plan.scratch : out) : plan.work[l + 1];
    applyStencils(lv.out, work, dst, 0);
  }
  if (plan.limit) applyStencils(plan.limit, plan.scratch, out, 0);
}

function applyStencils(s: Stencils, src: ArrayLike<number>, dst: { [i: number]: number }, dstOffset: number): void {
  const { start, idx, w } = s;
  const n = start.length - 1;
  for (let i = 0; i < n; i++) {
    let x = 0, y = 0, z = 0;
    for (let k = start[i], e = start[i + 1]; k < e; k++) {
      const j = idx[k] * 3, wk = w[k];
      x += src[j] * wk;
      y += src[j + 1] * wk;
      z += src[j + 2] * wk;
    }
    const o = (dstOffset + i) * 3;
    dst[o] = x;
    dst[o + 1] = y;
    dst[o + 2] = z;
  }
}

class StencilBuilder {
  private start: number[] = [0];
  private idx: number[] = [];
  private w: number[] = [];
  private rowStart = 0;
  /** Adds a weight to the current row, merging duplicate sources (rows are tiny: linear scan). */
  add(i: number, wt: number): void {
    for (let k = this.rowStart; k < this.idx.length; k++) {
      if (this.idx[k] === i) {
        this.w[k] += wt;
        return;
      }
    }
    this.idx.push(i);
    this.w.push(wt);
  }
  end(): void {
    this.start.push(this.idx.length);
    this.rowStart = this.idx.length;
  }
  /** Convenience: one whole row. */
  row(entries: [number, number][]): void {
    for (const [i, wt] of entries) this.add(i, wt);
    this.end();
  }
  build(): Stencils {
    return { start: Int32Array.from(this.start), idx: Int32Array.from(this.idx), w: Float64Array.from(this.w) };
  }
}

/** How a vertex behaves under subdivision. */
const enum VKind {
  Isolated,
  Smooth, // interior manifold vertex
  Crease, // exactly two boundary/wire edges: smooth B-spline curve rule
  Sharp, // everything else (non-manifold, dangling wire end): stays put
}

// Scratch buffers reused by classify() (it runs once per vertex per level).
const RING: number[] = [];
const CREASE: number[] = [];

/** Classifies vertex v and fills RING (all neighbours) and CREASE (neighbours across open edges). */
function classify(t: Topology, v: number): VKind {
  RING.length = 0;
  CREASE.length = 0;
  const s = t.vEdgeStart[v], e = t.vEdgeStart[v + 1];
  if (s === e) return VKind.Isolated;
  let faceSides = 0;
  for (let k = s; k < e; k++) {
    const edge = t.vEdges[k];
    const other = t.edgeV[edge * 2] === v ? t.edgeV[edge * 2 + 1] : t.edgeV[edge * 2];
    RING.push(other);
    const h = t.edgeHe[edge];
    const nFaces = (t.heFace[h] >= 0 ? 1 : 0) + (t.heFace[t.heTwin[h]] >= 0 ? 1 : 0);
    if (nFaces < 2) CREASE.push(other);
    faceSides += nFaces;
  }
  const nFaces = t.vFaceStart[v + 1] - t.vFaceStart[v];
  if (CREASE.length === 0) {
    // Interior: a single closed fan has as many faces as edges.
    return nFaces === RING.length && faceSides === 2 * RING.length ? VKind.Smooth : VKind.Sharp;
  }
  return CREASE.length === 2 ? VKind.Crease : VKind.Sharp;
}

function refineLevel(
  t: Topology,
  faces: number[][],
  loose: [number, number][],
): { level: PlanLevel; faces: number[][]; loose: [number, number][]; nOut: number } {
  const nV = t.nV, nE = t.nE, nF = faces.length;
  const fp = (f: number) => nV + f; // face point index inside the work buffer

  const facePts = new StencilBuilder();
  for (const f of faces) {
    const k = 1 / f.length;
    for (const v of f) facePts.add(v, k);
    facePts.end();
  }

  const out = new StencilBuilder();
  // Vertex points.
  for (let v = 0; v < nV; v++) {
    const kind = classify(t, v);
    if (kind === VKind.Smooth) {
      const n = RING.length, k = 1 / (n * n);
      out.add(v, (n - 2) / n);
      for (const r of RING) out.add(r, k);
      for (let j = t.vFaceStart[v]; j < t.vFaceStart[v + 1]; j++) out.add(fp(t.vFaces[j]), k);
    } else if (kind === VKind.Crease) {
      out.add(v, 0.75);
      out.add(CREASE[0], 0.125);
      out.add(CREASE[1], 0.125);
    } else {
      out.add(v, 1);
    }
    out.end();
  }
  // Edge points.
  for (let e = 0; e < nE; e++) {
    const a = t.edgeV[e * 2], b = t.edgeV[e * 2 + 1];
    const h = t.edgeHe[e];
    const f0 = t.heFace[h], f1 = t.heFace[t.heTwin[h]];
    if (f0 >= 0 && f1 >= 0) {
      out.add(a, 0.25);
      out.add(b, 0.25);
      out.add(fp(f0), 0.25);
      out.add(fp(f1), 0.25);
    } else {
      out.add(a, 0.5);
      out.add(b, 0.5);
    }
    out.end();
  }
  // Face points carry over unchanged.
  for (let f = 0; f < nF; f++) {
    out.add(fp(f), 1);
    out.end();
  }

  // Refined topology: walk each face's half-edges to find its edges (no hashing).
  const nextFaces: number[][] = new Array(t.nHe);
  let nf = 0;
  for (let fi = 0; fi < nF; fi++) {
    const f = faces[fi];
    const c = nV + nE + fi;
    let h = t.fHe[fi];
    for (let i = 0; i < f.length; i++) {
      nextFaces[nf++] = [f[i], nV + t.heEdge[h], c, nV + t.heEdge[t.hePrev[h]]];
      h = t.heNext[h];
    }
  }
  nextFaces.length = nf;
  const nextLoose: [number, number][] = [];
  for (const [a, b] of loose) {
    const e = t.edgeIndex.get(edgeKey(a, b));
    if (e === undefined) continue;
    const m = nV + e;
    nextLoose.push([a, m], [m, b]);
  }
  const nOut = nV + nE + nF;
  return {
    level: { nIn: nV, nFaces: nF, facePts: facePts.build(), out: out.build(), nOut },
    faces: nextFaces,
    loose: nextLoose,
    nOut,
  };
}

/**
 * Limit positions for every vertex of a refined (all-quad) mesh.
 * Interior valence n: (n²·v + 4·Σ edge neighbours + Σ diagonal neighbours) / (n(n+5)).
 * Boundary curve: (a + 4v + b) / 6. Sharp vertices stay put.
 */
function limitStencils(t: Topology, faces: number[][]): Stencils {
  const sb = new StencilBuilder();
  for (let v = 0; v < t.nV; v++) {
    const kind = classify(t, v);
    if (kind === VKind.Smooth) {
      const n = RING.length;
      const den = n * (n + 5);
      let allQuads = true;
      for (let k = t.vFaceStart[v]; k < t.vFaceStart[v + 1]; k++) if (faces[t.vFaces[k]].length !== 4) allQuads = false;
      if (allQuads) {
        sb.add(v, (n * n) / den);
        for (const r of RING) sb.add(r, 4 / den);
        for (let k = t.vFaceStart[v]; k < t.vFaceStart[v + 1]; k++) {
          const f = faces[t.vFaces[k]];
          sb.add(f[(f.indexOf(v) + 2) % 4], 1 / den);
        }
      } else sb.add(v, 1);
    } else if (kind === VKind.Crease) {
      sb.add(v, 4 / 6);
      sb.add(CREASE[0], 1 / 6);
      sb.add(CREASE[1], 1 / 6);
    } else {
      sb.add(v, 1);
    }
    sb.end();
  }
  return sb.build();
}

/** Fan triangulation of polygons (index buffer for rendering). */
export function triangulate(faces: number[][]): Uint32Array {
  let n = 0;
  for (const f of faces) n += Math.max(0, f.length - 2);
  const out = new Uint32Array(n * 3);
  let o = 0;
  for (const f of faces) {
    if (f.length === 4) {
      out[o++] = f[0];
      out[o++] = f[1];
      out[o++] = f[2];
      out[o++] = f[0];
      out[o++] = f[2];
      out[o++] = f[3];
      continue;
    }
    for (let i = 1; i < f.length - 1; i++) {
      out[o++] = f[0];
      out[o++] = f[i];
      out[o++] = f[i + 1];
    }
  }
  return out;
}

/** Area-weighted smooth vertex normals from triangles. */
export function computeNormals(pos: ArrayLike<number>, tris: Uint32Array, out: Float32Array): void {
  out.fill(0);
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t] * 3, b = tris[t + 1] * 3, c = tris[t + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    out[a] += nx; out[a + 1] += ny; out[a + 2] += nz;
    out[b] += nx; out[b + 1] += ny; out[b + 2] += nz;
    out[c] += nx; out[c + 1] += ny; out[c + 2] += nz;
  }
  for (let i = 0; i < out.length; i += 3) {
    const l = Math.hypot(out[i], out[i + 1], out[i + 2]);
    if (l > 1e-20) {
      out[i] /= l;
      out[i + 1] /= l;
      out[i + 2] /= l;
    } else out[i + 2] = 1;
  }
}
