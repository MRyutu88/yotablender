// Mesh symmetry, like Blender's Edit Mode "Mesh Symmetry" (live mirror editing) and
// Mesh → Symmetrize. Both work in the object's local space, across the X/Y/Z planes through
// the origin.

import { compactVertices, type Edge, type MeshData } from './mesh';
import { selectionFromVerts, type Selection } from './selection';
import { checkResult, OpError, type OpResult } from './ops/opResult';

export type Axes = readonly [boolean, boolean, boolean];

/** How close two vertices must be to count as mirror images (scaled to the mesh size). */
export function symmetryTolerance(pos: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < pos.length; i++) m = Math.max(m, Math.abs(pos[i]));
  return Math.max(1e-5, m * 1e-4);
}

/**
 * Finds mirror partners by position. `partner(v, mask)` is the vertex at v's position with the
 * axes in `mask` (1 = X, 2 = Y, 4 = Z) negated, -1 when there is none, or -2 when several
 * vertices sit there (ambiguous, e.g. right after an extrude). A vertex on the plane is its own
 * partner.
 */
export function mirrorLookup(pos: ArrayLike<number>, tol = symmetryTolerance(pos)): (v: number, mask: number) => number {
  const n = pos.length / 3;
  const grid = new Map<string, number[]>();
  const cell = tol * 2;
  const key = (x: number, y: number, z: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  for (let v = 0; v < n; v++) {
    const k = key(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
    let l = grid.get(k);
    if (!l) grid.set(k, (l = []));
    l.push(v);
  }
  const t2 = tol * tol;
  return (v, mask) => {
    const x = mask & 1 ? -pos[v * 3] : pos[v * 3];
    const y = mask & 2 ? -pos[v * 3 + 1] : pos[v * 3 + 1];
    const z = mask & 4 ? -pos[v * 3 + 2] : pos[v * 3 + 2];
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
    let best = -1;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          for (const u of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
            const d = (pos[u * 3] - x) ** 2 + (pos[u * 3 + 1] - y) ** 2 + (pos[u * 3 + 2] - z) ** 2;
            if (d > t2) continue;
            if (best >= 0) return -2;
            best = u;
          }
        }
    return best;
  };
}

/** The non-empty combinations of the enabled axes, as flip masks (X, Y, Z, XY, …). */
export function axisMasks(axes: Axes): number[] {
  const all = (axes[0] ? 1 : 0) | (axes[1] ? 2 : 0) | (axes[2] ? 4 : 0);
  const out: number[] = [];
  for (let m = 1; m < 8; m++) if ((m & all) === m) out.push(m);
  return out;
}

export interface SymmetryPlan {
  /** Vertices that are transformed normally (the selection and proportional neighbours). */
  drivers: number[];
  driverWeights: number[];
  /** Per driver: axes to keep at 0 (it started on that mirror plane). */
  pin: number[];
  /** Vertices that copy a driver's position with some axes negated. */
  mirrors: { v: number; driver: number; mask: number }[];
}

/**
 * Splits the vertices a transform touches into drivers and their mirror images. Selected
 * vertices drive first, then proportional neighbours by influence; a vertex whose image is
 * selected too keeps moving on its own (both sides selected = both transformed as they are).
 */
export function planSymmetry(pos: ArrayLike<number>, verts: number[], weights: number[], selected: Set<number>, axes: Axes): SymmetryPlan {
  const masks = axisMasks(axes);
  const tol = symmetryTolerance(pos);
  const find = mirrorLookup(pos, tol);
  const order = verts.map((_, i) => i).sort((a, b) => {
    const sa = selected.has(verts[a]) ? 1 : 0, sb = selected.has(verts[b]) ? 1 : 0;
    return sb - sa || weights[b] - weights[a];
  });
  const role = new Map<number, 'driver' | 'mirror'>();
  const plan: SymmetryPlan = { drivers: [], driverWeights: [], pin: [], mirrors: [] };
  const allMask = masks.reduce((a, m) => a | m, 0);
  for (const i of order) {
    const v = verts[i];
    if (role.has(v)) continue;
    role.set(v, 'driver');
    let pin = 0;
    for (let a = 0; a < 3; a++) if (allMask & (1 << a) && Math.abs(pos[v * 3 + a]) <= tol) pin |= 1 << a;
    plan.drivers.push(v);
    plan.driverWeights.push(weights[i]);
    plan.pin.push(pin);
    if (find(v, 0) === -2) continue; // stacked on another vertex: its image is ambiguous
    for (const m of masks) {
      if (m & pin) continue; // the image across a plane it sits on is itself
      const p = find(v, m);
      if (p < 0 || p === v || role.has(p)) continue;
      if (selected.has(v) && selected.has(p)) continue;
      role.set(p, 'mirror');
      plan.mirrors.push({ v: p, driver: v, mask: m });
    }
  }
  return plan;
}

/**
 * Symmetrize: throws away the `axis` half that `fromPositive` doesn't keep, cuts faces that
 * cross the plane, mirrors the kept half over and stitches the two at the plane (vertices on
 * the plane are shared). Colors, materials and UVs come along.
 */
export function symmetrize(mesh: MeshData, axis: 0 | 1 | 2, fromPositive: boolean, sel?: Selection): OpResult {
  const pos = mesh.positions;
  const n = pos.length / 3;
  if (!mesh.faces.length && !mesh.looseEdges.length) throw new OpError('Nothing to symmetrize');
  const tol = symmetryTolerance(pos);
  const sgn = fromPositive ? 1 : -1;
  // side: 1 = keep, 0 = on the plane, -1 = drop
  const side = new Int8Array(n);
  for (let v = 0; v < n; v++) {
    const c = pos[v * 3 + axis] * sgn;
    side[v] = Math.abs(c) <= tol ? 0 : c > 0 ? 1 : -1;
  }
  const positions = pos.slice();
  for (let v = 0; v < n; v++) if (side[v] === 0) positions[v * 3 + axis] = 0;
  const colors = mesh.colors?.slice();
  const sideOf: number[] = Array.from(side);

  // New vertices where edges cross the plane, shared between the faces on both sides of the edge.
  const cut = new Map<string, number>();
  const cutVert = (a: number, b: number): { v: number; t: number } => {
    const ca = pos[a * 3 + axis], cb = pos[b * 3 + axis];
    const t = ca / (ca - cb);
    const k = a < b ? `${a},${b}` : `${b},${a}`;
    let v = cut.get(k);
    if (v === undefined) {
      v = positions.length / 3;
      for (let i = 0; i < 3; i++) positions.push(pos[a * 3 + i] + (pos[b * 3 + i] - pos[a * 3 + i]) * t);
      positions[v * 3 + axis] = 0;
      if (colors) for (let i = 0; i < 4; i++) colors.push(colors[a * 4 + i] + (colors[b * 4 + i] - colors[a * 4 + i]) * t);
      sideOf.push(0);
      cut.set(k, v);
    }
    return { v, t };
  };

  const faces: number[][] = [];
  const faceMats: number[] = [];
  const uvs: number[][] = [];
  const onPlane: boolean[] = [];
  mesh.faces.forEach((f, fi) => {
    const uv = mesh.uvs?.[fi];
    if (f.every((v) => side[v] >= 0)) {
      faces.push(f.slice());
      if (uv) uvs.push(uv.slice());
    } else if (f.some((v) => side[v] > 0)) {
      // Clip the face against the plane (Sutherland–Hodgman), keeping the "keep" side.
      const out: number[] = [];
      const outUv: number[] = [];
      for (let i = 0; i < f.length; i++) {
        const a = f[i], b = f[(i + 1) % f.length];
        if (side[a] >= 0) {
          out.push(a);
          if (uv) outUv.push(uv[i * 2], uv[i * 2 + 1]);
        }
        if ((side[a] > 0 && side[b] < 0) || (side[a] < 0 && side[b] > 0)) {
          const { v, t } = cutVert(a, b);
          out.push(v);
          if (uv) {
            const j = (i + 1) % f.length;
            outUv.push(uv[i * 2] + (uv[j * 2] - uv[i * 2]) * t, uv[i * 2 + 1] + (uv[j * 2 + 1] - uv[i * 2 + 1]) * t);
          }
        }
      }
      if (out.length < 3) return;
      faces.push(out);
      if (uv) uvs.push(outUv);
    } else return;
    faceMats.push(mesh.faceMats?.[fi] ?? 0);
    onPlane.push(faces[faces.length - 1].every((v) => sideOf[v] === 0));
  });

  const loose: Edge[] = [];
  for (const [a, b] of mesh.looseEdges) {
    if (side[a] >= 0 && side[b] >= 0) loose.push([a, b]);
    else if (side[a] > 0 && side[b] < 0) loose.push([a, cutVert(a, b).v]);
    else if (side[a] < 0 && side[b] > 0) loose.push([cutVert(a, b).v, b]);
  }

  // Mirror every kept vertex that isn't on the plane.
  const total = positions.length / 3;
  const twin = new Int32Array(total).fill(-1);
  const keepLoose = new Set<number>();
  const referenced = new Uint8Array(total);
  for (const f of mesh.faces) for (const v of f) referenced[v] = 1;
  for (const [a, b] of mesh.looseEdges) referenced[a] = referenced[b] = 1;
  for (let v = 0; v < total; v++) {
    if (sideOf[v] < 0) continue;
    if (v < n && !referenced[v]) keepLoose.add(v); // stray points on the kept side stay
    if (sideOf[v] === 0) {
      twin[v] = v;
      continue;
    }
    twin[v] = positions.length / 3;
    positions.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
    positions[twin[v] * 3 + axis] *= -1;
    if (colors) colors.push(colors[v * 4], colors[v * 4 + 1], colors[v * 4 + 2], colors[v * 4 + 3]);
    if (keepLoose.has(v)) keepLoose.add(twin[v]);
  }
  const nKept = faces.length;
  for (let i = 0; i < nKept; i++) {
    if (onPlane[i]) continue; // would land on itself
    const f = faces[i];
    faces.push(f.map((v) => twin[v]).reverse());
    faceMats.push(faceMats[i]);
    if (mesh.uvs) {
      const u = uvs[i], r: number[] = [];
      for (let c = f.length - 1; c >= 0; c--) r.push(u[c * 2], u[c * 2 + 1]);
      uvs.push(r);
    }
  }
  for (const [a, b] of loose.slice()) if (sideOf[a] !== 0 || sideOf[b] !== 0) loose.push([twin[a], twin[b]]);

  const raw: MeshData = { positions, faces, looseEdges: loose };
  if (mesh.faceMats) raw.faceMats = faceMats;
  if (colors) raw.colors = colors;
  if (mesh.uvs) raw.uvs = uvs;
  const { data, remap } = compactVertices(raw, keepLoose);
  checkResult(data, 'Symmetrize');

  // Keep the selection on the kept side and select its mirror images too.
  const selVerts: number[] = [];
  for (const v of sel?.verts ?? []) {
    if (v >= n || side[v] < 0) continue;
    if (remap[v] >= 0) selVerts.push(remap[v]);
    const t = twin[v];
    if (t >= 0 && t !== v && remap[t] >= 0) selVerts.push(remap[t]);
  }
  return { data, selection: selectionFromVerts(data, selVerts) };
}
