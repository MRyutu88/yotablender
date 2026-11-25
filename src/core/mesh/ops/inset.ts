// Inset Faces (Blender's I), region mode: the selected faces shrink inward by `thickness`
// inside their own plane, with a ring of new quads around them. `depth` then pushes the inset
// faces along their normal (positive = out). Built on region extrude: the outline vertices are
// duplicated in place and the copies slid inward.

import { faceNormalRaw, type MeshData } from '../mesh';
import type { Selection } from '../selection';
import { extrude } from './extrude';
import { checkResult, OpError, type OpResult } from './opResult';
import { faceUVMap, type FaceUVMap } from '../../uv/faceMap';
import type { Vec3 } from '../../math/vec3';

export function inset(mesh: MeshData, sel: Selection, thickness = 0.1, depth = 0): OpResult {
  const region = [...sel.faces].filter((f) => f < mesh.faces.length);
  if (!region.length) throw new OpError('Select faces to inset');
  const pos = mesh.positions;

  // Outline edges (a→b as in their region face) and the inward direction of each.
  const directed = new Set<string>();
  for (const f of region) {
    const face = mesh.faces[f];
    for (let i = 0; i < face.length; i++) directed.add(`${face[i]},${face[(i + 1) % face.length]}`);
  }
  const inward = new Map<number, Vec3[]>(); // vertex → inward directions of its outline edges
  const normals = new Map<number, Vec3[]>();
  for (const f of region) {
    const face = mesh.faces[f];
    const n = norm(faceNormalRaw(pos, face));
    for (let i = 0; i < face.length; i++) {
      const a = face[i], b = face[(i + 1) % face.length];
      for (const v of [a, b]) (normals.get(v) ?? normals.set(v, []).get(v)!).push(n);
      if (directed.has(`${b},${a}`)) continue;
      const e: Vec3 = [pos[b * 3] - pos[a * 3], pos[b * 3 + 1] - pos[a * 3 + 1], pos[b * 3 + 2] - pos[a * 3 + 2]];
      const u = norm(cross(n, e)); // points into the face for a CCW face
      for (const v of [a, b]) (inward.get(v) ?? inward.set(v, []).get(v)!).push(u);
    }
  }

  // Offset of every outline/inner vertex copy (input index → object-space offset).
  const avg = (vs: Vec3[]): Vec3 => norm(vs.reduce<Vec3>((acc, v) => [acc[0] + v[0], acc[1] + v[1], acc[2] + v[2]], [0, 0, 0]));
  const slide = new Map<number, Vec3>(); // in-plane part (moves the UVs too)
  const lift = new Map<number, Vec3>(); // along the normal (depth)
  for (const v of normals.keys()) {
    const dirs = inward.get(v);
    if (dirs) {
      // Outline vertex: slide inward, keeping a constant distance from both outline edges.
      const d = avg(dirs);
      const minDot = Math.min(...dirs.map((u) => d[0] * u[0] + d[1] * u[1] + d[2] * u[2]));
      const len = thickness / Math.max(minDot, 0.25);
      slide.set(v, [d[0] * len, d[1] * len, d[2] * len]);
    }
    const nn = avg(normals.get(v)!);
    lift.set(v, [nn[0] * depth, nn[1] * depth, nn[2] * depth]);
  }

  const maps = new Map<number, FaceUVMap>();
  const r = extrude(mesh, sel, {
    dupUV: (f, v, uv) => {
      const o = slide.get(v);
      if (!o || !mesh.uvs) return uv;
      let m = maps.get(f);
      if (!m) maps.set(f, (m = faceUVMap(pos, mesh.faces[f], mesh.uvs[f])));
      const d = m.delta(o);
      return [uv[0] + d[0], uv[1] + d[1]];
    },
  });
  const out = r.data;
  const regionNormal = r.normal ?? [0, 0, 1];
  for (const { src, dup } of r.dupPairs ?? []) {
    const o = slide.get(src) ?? [0, 0, 0];
    const h = lift.get(src) ?? [regionNormal[0] * depth, regionNormal[1] * depth, regionNormal[2] * depth];
    for (let c = 0; c < 3; c++) out.positions[dup * 3 + c] += o[c] + h[c];
  }
  checkResult(out, 'Inset');
  return { data: out, selection: r.selection, normal: r.normal };
}

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 0];
};
