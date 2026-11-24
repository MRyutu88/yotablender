// The editable polygon mesh: the source of truth for every object.
//
// Storage is deliberately simple: flat vertex positions, faces as CCW vertex loops (quads,
// triangles and n-gons alike) and loose "wire" edges. This makes snapshots, undo and
// serialization trivial and keeps topology ops easy to reason about.
//
// Connectivity queries go through a half-edge structure (see topology.ts) that is built from
// this data on demand and cached until the topology changes.

import { buildTopology, type Topology } from './topology';
import type { Vec3 } from '../math/vec3';
import { edgeKey, type Edge } from './keys';

export { edgeKey, dirKey, edgeFromKey, type Edge } from './keys';

export type Face = number[];

export interface MeshData {
  positions: number[];
  faces: Face[];
  looseEdges: Edge[];
}

export class Mesh implements MeshData {
  positions: number[];
  faces: Face[];
  looseEdges: Edge[];
  /** Bumped whenever faces/edges/vertex count change. Caches (topology, subdivision plans) key on it. */
  topoVersion = 0;
  /** Bumped whenever any vertex position changes. */
  posVersion = 0;
  private _topo: Topology | null = null;
  private _topoFor = -1;

  constructor(data: MeshData = { positions: [], faces: [], looseEdges: [] }) {
    this.positions = data.positions;
    this.faces = data.faces;
    this.looseEdges = data.looseEdges;
  }

  get vertCount(): number {
    return this.positions.length / 3;
  }

  topology(): Topology {
    if (!this._topo || this._topoFor !== this.topoVersion) {
      this._topo = buildTopology(this);
      this._topoFor = this.topoVersion;
    }
    return this._topo;
  }

  /** Replaces the whole mesh (used by topology ops and undo). */
  setData(data: MeshData): void {
    this.positions = data.positions;
    this.faces = data.faces;
    this.looseEdges = data.looseEdges;
    this.topoVersion++;
    this.posVersion++;
  }

  /** Call after editing `positions` in place. */
  touchPositions(): void {
    this.posVersion++;
  }

  getVert(i: number): Vec3 {
    return [this.positions[i * 3], this.positions[i * 3 + 1], this.positions[i * 3 + 2]];
  }

  setVert(i: number, v: Vec3): void {
    this.positions[i * 3] = v[0];
    this.positions[i * 3 + 1] = v[1];
    this.positions[i * 3 + 2] = v[2];
  }

  snapshot(): MeshData {
    return cloneData(this);
  }

  clone(): Mesh {
    return new Mesh(cloneData(this));
  }
}

export function cloneData(d: MeshData): MeshData {
  return {
    positions: d.positions.slice(),
    faces: d.faces.map((f) => f.slice()),
    looseEdges: d.looseEdges.map((e) => [e[0], e[1]] as Edge),
  };
}

// --- Geometry helpers -------------------------------------------------------------------

/** Newell normal (robust for non-planar quads and n-gons), not normalized. */
export function faceNormalRaw(pos: ArrayLike<number>, face: Face): Vec3 {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < face.length; i++) {
    const a = face[i] * 3, b = face[(i + 1) % face.length] * 3;
    nx += (pos[a + 1] - pos[b + 1]) * (pos[a + 2] + pos[b + 2]);
    ny += (pos[a + 2] - pos[b + 2]) * (pos[a] + pos[b]);
    nz += (pos[a] - pos[b]) * (pos[a + 1] + pos[b + 1]);
  }
  return [nx, ny, nz];
}

export function faceNormal(pos: ArrayLike<number>, face: Face): Vec3 {
  const n = faceNormalRaw(pos, face);
  const l = Math.hypot(n[0], n[1], n[2]);
  return l > 1e-20 ? [n[0] / l, n[1] / l, n[2] / l] : [0, 0, 1];
}

export function faceCenter(pos: ArrayLike<number>, face: Face): Vec3 {
  let x = 0, y = 0, z = 0;
  for (const v of face) {
    x += pos[v * 3];
    y += pos[v * 3 + 1];
    z += pos[v * 3 + 2];
  }
  const k = 1 / face.length;
  return [x * k, y * k, z * k];
}

/** Every undirected edge of the mesh (face edges + loose edges), as keys, in a stable order. */
export function allEdgeKeys(mesh: MeshData): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const f of mesh.faces) {
    for (let i = 0; i < f.length; i++) {
      const k = edgeKey(f[i], f[(i + 1) % f.length]);
      if (!seen.has(k)) {
        seen.add(k);
        out.push(k);
      }
    }
  }
  for (const [a, b] of mesh.looseEdges) {
    const k = edgeKey(a, b);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}

export function bounds(pos: ArrayLike<number>): { min: Vec3; max: Vec3 } | null {
  if (pos.length < 3) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (pos[i + k] < min[k]) min[k] = pos[i + k];
      if (pos[i + k] > max[k]) max[k] = pos[i + k];
    }
  }
  return { min, max };
}

/**
 * Rebuilds a mesh after a topology op: drops vertices that are no longer used by any face or
 * loose edge (except ones in `keepLoose`), and remaps indices. Returns the new data plus the
 * old→new vertex index map (-1 for dropped vertices).
 */
export function compactVertices(
  data: MeshData,
  keepLoose: Set<number> = new Set(),
): { data: MeshData; remap: Int32Array } {
  const n = data.positions.length / 3;
  const used = new Uint8Array(n);
  for (const f of data.faces) for (const v of f) used[v] = 1;
  for (const [a, b] of data.looseEdges) used[a] = used[b] = 1;
  for (const v of keepLoose) if (v < n) used[v] = 1;
  const remap = new Int32Array(n).fill(-1);
  const positions: number[] = [];
  let next = 0;
  for (let i = 0; i < n; i++) {
    if (!used[i]) continue;
    remap[i] = next++;
    positions.push(data.positions[i * 3], data.positions[i * 3 + 1], data.positions[i * 3 + 2]);
  }
  return {
    data: {
      positions,
      faces: data.faces.map((f) => f.map((v) => remap[v])),
      looseEdges: data.looseEdges.map(([a, b]) => [remap[a], remap[b]] as Edge),
    },
    remap,
  };
}

/** Vertices that no face or loose edge references (stray points, kept on purpose). */
export function unreferencedVertices(data: MeshData): Set<number> {
  const n = data.positions.length / 3;
  const used = new Uint8Array(n);
  for (const f of data.faces) for (const v of f) used[v] = 1;
  for (const [a, b] of data.looseEdges) used[a] = used[b] = 1;
  const out = new Set<number>();
  for (let i = 0; i < n; i++) if (!used[i]) out.add(i);
  return out;
}
