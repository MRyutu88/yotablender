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
  /** Material slot per face (index into the object's material slots). Absent = all slot 0. */
  faceMats?: number[];
  /** Color attribute, RGBA per vertex (Blender's default "Color", Vertex domain). Linear 0..1. */
  colors?: number[];
}

export class Mesh implements MeshData {
  positions: number[];
  faces: Face[];
  looseEdges: Edge[];
  faceMats?: number[];
  colors?: number[];
  /** Bumped whenever faces/edges/vertex count change. Caches (topology, subdivision plans) key on it. */
  topoVersion = 0;
  /** Bumped whenever any vertex position changes. */
  posVersion = 0;
  /** Bumped whenever the color attribute changes (painting). */
  colorVersion = 0;
  private _topo: Topology | null = null;
  private _topoFor = -1;

  constructor(data: MeshData = { positions: [], faces: [], looseEdges: [] }) {
    this.positions = data.positions;
    this.faces = data.faces;
    this.looseEdges = data.looseEdges;
    this.faceMats = data.faceMats;
    this.colors = data.colors;
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
    this.faceMats = data.faceMats;
    this.colors = data.colors;
    this.topoVersion++;
    this.posVersion++;
    this.colorVersion++;
  }

  /** Call after editing `colors` in place. */
  touchColors(): void {
    this.colorVersion++;
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
  const out: MeshData = {
    positions: d.positions.slice(),
    faces: d.faces.map((f) => f.slice()),
    looseEdges: d.looseEdges.map((e) => [e[0], e[1]] as Edge),
  };
  if (d.faceMats) out.faceMats = d.faceMats.slice();
  if (d.colors) out.colors = d.colors.slice();
  return out;
}

// --- Attribute helpers (keep faceMats/colors in step with faces/vertices) ----------------

export const faceMat = (d: MeshData, f: number): number => d.faceMats?.[f] ?? 0;

/** Appends a vertex; its color is copied from `colorOf` (a vertex) or given directly. */
export function addVertex(d: MeshData, x: number, y: number, z: number, color?: number | number[]): number {
  const i = d.positions.length / 3;
  d.positions.push(x, y, z);
  if (d.colors) {
    if (typeof color === 'number') d.colors.push(d.colors[color * 4], d.colors[color * 4 + 1], d.colors[color * 4 + 2], d.colors[color * 4 + 3]);
    else d.colors.push(...(color ?? [1, 1, 1, 1]));
  }
  return i;
}

/** Color between two vertices (for new vertices on an edge). */
export function lerpColor(d: MeshData, a: number, b: number, t: number): number[] | undefined {
  if (!d.colors) return undefined;
  const c = d.colors;
  return [0, 1, 2, 3].map((k) => c[a * 4 + k] + (c[b * 4 + k] - c[a * 4 + k]) * t);
}

/** Appends a face with the material of face `like` (or slot `like` when `isSlot`). */
export function addFace(d: MeshData, face: Face, like: number, isSlot = false): void {
  if (d.faceMats) d.faceMats.push(isSlot ? like : (d.faceMats[like] ?? 0));
  d.faces.push(face);
}

/** Keeps only the faces for which keep(i) is true, with their materials. */
export function filterFaces(d: MeshData, keep: (i: number) => boolean): void {
  const faces: Face[] = [];
  const mats: number[] = [];
  d.faces.forEach((f, i) => {
    if (!keep(i)) return;
    faces.push(f);
    if (d.faceMats) mats.push(d.faceMats[i] ?? 0);
  });
  d.faces = faces;
  if (d.faceMats) d.faceMats = mats;
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
  const out: MeshData = {
    positions,
    faces: data.faces.map((f) => f.map((v) => remap[v])),
    looseEdges: data.looseEdges.map(([a, b]) => [remap[a], remap[b]] as Edge),
  };
  if (data.faceMats) out.faceMats = data.faceMats.slice();
  if (data.colors) {
    const colors: number[] = [];
    for (let i = 0; i < n; i++) if (remap[i] >= 0) colors.push(data.colors[i * 4], data.colors[i * 4 + 1], data.colors[i * 4 + 2], data.colors[i * 4 + 3]);
    out.colors = colors;
  }
  return { data: out, remap };
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
