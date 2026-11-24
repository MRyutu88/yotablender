// OBJ + MTL export of the cage (not the subdivided result), keeping quads and n-gons.
//
// - One `o` block per object, named like the object. Object transforms are baked into the
//   vertices (OBJ has no transforms).
// - Coordinates are converted from Blender's Z-up to OBJ's Y-up as (x, z, -y), which is exactly
//   what Blender's own OBJ exporter writes, so Blender's default import (forward -Z, up Y)
//   restores them.
// - Loose edges are written as `l` lines; faces keep their vertex count and winding.

import { buildMirrorPlan, evaluateMirror } from '../modifiers/mirror';
import type { Project, SceneObject, Material } from '../scene/scene';
import { objectMatrix } from '../scene/scene';
import { transformPoint } from '../math/mat4';

export interface ObjExportOptions {
  /** Bake the Mirror modifier into the cage (off: just the half you modeled). */
  applyMirror?: boolean;
  /** Export only these objects (default: all visible). */
  objectIds?: string[];
  /** File name used for the `mtllib` line. */
  mtlName?: string;
}

const fmt = (n: number) => {
  const s = n.toFixed(6);
  return s === '-0.000000' ? '0.000000' : s;
};

export function exportObj(project: Project, opts: ObjExportOptions = {}): { obj: string; mtl: string } {
  const mtlName = opts.mtlName ?? 'model.mtl';
  const objects = project.objects.filter((o) => (opts.objectIds ? opts.objectIds.includes(o.id) : o.visible));
  const usedMats = new Map<string, Material>();
  const lines: string[] = ['# YotaBlender OBJ export (cage)', `mtllib ${mtlName}`];
  let base = 1;

  for (const o of objects) {
    const { positions, faces, loose } = cageFor(o, !!opts.applyMirror);
    const m = objectMatrix(o);
    const det =
      m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
    lines.push(`o ${safeName(o.name)}`);
    const n = positions.length / 3;
    for (let i = 0; i < n; i++) {
      const [x, y, z] = transformPoint(m, [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]]);
      lines.push(`v ${fmt(x)} ${fmt(z)} ${fmt(-y)}`);
    }
    const mat = project.materials.find((mm) => mm.id === o.materialId);
    if (mat) {
      usedMats.set(mat.id, mat);
      lines.push(`usemtl ${safeName(mat.name)}`);
    }
    lines.push(o.shade_smooth ? 's 1' : 's 0');
    for (const f of faces) {
      // A negative scale mirrors the object: flip winding so normals still point outwards.
      const loop = det < 0 ? f.slice().reverse() : f;
      lines.push('f ' + loop.map((v) => v + base).join(' '));
    }
    for (const [a, b] of loose) lines.push(`l ${a + base} ${b + base}`);
    base += n;
  }

  const mtl: string[] = ['# YotaBlender MTL export'];
  for (const mat of usedMats.values()) {
    const [r, g, b, a] = mat.base_color;
    mtl.push(
      '',
      `newmtl ${safeName(mat.name)}`,
      `Ns ${fmt((1 - mat.roughness) ** 2 * 1000)}`,
      'Ka 1.000000 1.000000 1.000000',
      `Kd ${fmt(r)} ${fmt(g)} ${fmt(b)}`,
      'Ks 0.500000 0.500000 0.500000',
      'Ke 0.000000 0.000000 0.000000',
      'Ni 1.500000',
      `d ${fmt(a)}`,
      'illum 2',
      `Pr ${fmt(mat.roughness)}`,
      `Pm ${fmt(mat.metallic)}`,
    );
  }
  return { obj: lines.join('\n') + '\n', mtl: mtl.join('\n') + '\n' };
}

function cageFor(o: SceneObject, applyMirror: boolean) {
  const mesh = o.mesh;
  const mirror = applyMirror ? o.modifiers.find((m) => m.type === 'MIRROR' && m.show_viewport) : undefined;
  if (!mirror || mirror.type !== 'MIRROR') {
    return { positions: mesh.positions, faces: mesh.faces, loose: mesh.looseEdges };
  }
  const plan = buildMirrorPlan(mesh.positions, mesh.vertCount, mesh.faces, mesh.looseEdges, mirror);
  const pos = new Float64Array(plan.nOut * 3);
  evaluateMirror(plan, mesh.positions, pos);
  return { positions: Array.from(pos), faces: plan.faces, loose: plan.looseEdges };
}

/** OBJ names end at the line break; keep them on one line and without leading/trailing spaces. */
const safeName = (s: string) => s.replace(/[\r\n]+/g, ' ').trim() || 'Object';

// --- Minimal reader (round-trip tests and future import) ---------------------------------

export interface ObjObject {
  name: string;
  /** Positions converted back to Z-up. */
  positions: number[];
  faces: number[][];
  lines: [number, number][];
  material?: string;
}

export function parseObj(text: string): ObjObject[] {
  const all: number[] = [];
  const objects: ObjObject[] = [];
  let cur: ObjObject | null = null;
  const ensure = () => {
    if (!cur) {
      cur = { name: 'Object', positions: [], faces: [], lines: [] };
      objects.push(cur);
    }
    return cur;
  };
  // Indices in OBJ are global; collect per-object local indices.
  let localMap = new Map<number, number>();
  const local = (o: ObjObject, gi: number) => {
    let li = localMap.get(gi);
    if (li === undefined) {
      li = o.positions.length / 3;
      localMap.set(gi, li);
      o.positions.push(all[gi * 3], all[gi * 3 + 1], all[gi * 3 + 2]);
    }
    return li;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [tag, ...rest] = line.split(/\s+/);
    if (tag === 'o' || tag === 'g') {
      cur = { name: line.slice(2).trim(), positions: [], faces: [], lines: [] };
      objects.push(cur);
      localMap = new Map();
    } else if (tag === 'v') {
      const [x, y, z] = rest.map(Number);
      all.push(x, -z, y); // Y-up back to Z-up
    } else if (tag === 'f' || tag === 'l') {
      const o = ensure();
      const idx = rest.map((t) => {
        const i = parseInt(t.split('/')[0], 10);
        return i < 0 ? all.length / 3 + i : i - 1;
      });
      const loc = idx.map((gi) => local(o, gi));
      if (tag === 'f') o.faces.push(loc);
      else for (let i = 0; i + 1 < loc.length; i++) o.lines.push([loc[i], loc[i + 1]]);
    } else if (tag === 'usemtl') {
      ensure().material = line.slice(7).trim();
    }
  }
  return objects;
}
