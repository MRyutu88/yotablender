// OBJ + MTL export of the cage (not the subdivided result), keeping quads and n-gons.
//
// - One `o` block per object, named like the object. Object transforms are baked into the
//   vertices (OBJ has no transforms).
// - Coordinates are converted from Blender's Z-up to OBJ's Y-up as (x, z, -y), which is exactly
//   what Blender's own OBJ exporter writes, so Blender's default import (forward -Z, up Y)
//   restores them.
// - Loose edges are written as `l` lines; faces keep their vertex count and winding.
// - Objects with UVs get `vt` lines and `f v/vt` faces. A painted object gets its own copies of
//   its materials ("Skin (Body)") whose `map_Kd` is its flattened texture (paint over colors).

import { buildMirrorPlan, evaluateMirror } from '../modifiers/mirror';
import { mirrorCornerUVs } from '../uv/stackUV';
import type { Project, SceneObject, Material } from '../scene/scene';
import { objectMatrix, slotMaterial } from '../scene/scene';
import { transformPoint } from '../math/mat4';

export interface ObjExportOptions {
  /** Bake the Mirror modifier into the cage (off: just the half you modeled). */
  applyMirror?: boolean;
  /** Export only these objects (default: all visible). */
  objectIds?: string[];
  /** File name used for the `mtllib` line. */
  mtlName?: string;
  /** Texture file (`map_Kd`) per object id, for painted objects. */
  textureFiles?: Record<string, string>;
}

const fmt = (n: number) => {
  const s = n.toFixed(6);
  return s === '-0.000000' ? '0.000000' : s;
};

export function exportObj(project: Project, opts: ObjExportOptions = {}): { obj: string; mtl: string } {
  const mtlName = opts.mtlName ?? 'model.mtl';
  const objects = project.objects.filter((o) => (opts.objectIds ? opts.objectIds.includes(o.id) : o.visible));
  const usedMats = new Map<string, { mat: Material; name: string; map?: string }>();
  const lines: string[] = ['# YotaBlender OBJ export (cage)', `mtllib ${mtlName}`];
  let base = 1;
  let uvBase = 1;

  for (const o of objects) {
    const { positions, faces, faceSrc, loose, colors, uvs } = cageFor(o, !!opts.applyMirror);
    const texFile = uvs ? opts.textureFiles?.[o.id] : undefined;
    const m = objectMatrix(o);
    const det =
      m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
    lines.push(`o ${safeName(o.name)}`);
    const n = positions.length / 3;
    for (let i = 0; i < n; i++) {
      const [x, y, z] = transformPoint(m, [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]]);
      // Vertex colors use the common "v x y z r g b" extension. Blender reads (and writes) these
      // as sRGB, so convert from our linear colors to round-trip exactly.
      const c = colors ? ` ${fmt(linToSrgb(colors[i * 4]))} ${fmt(linToSrgb(colors[i * 4 + 1]))} ${fmt(linToSrgb(colors[i * 4 + 2]))}` : '';
      lines.push(`v ${fmt(x)} ${fmt(z)} ${fmt(-y)}${c}`);
    }
    // UVs: one `vt` per distinct value, faces reference them per corner.
    let cornerVt: number[][] | null = null;
    let nVt = 0;
    if (uvs) {
      const index = new Map<string, number>();
      cornerVt = uvs.map((u) => {
        const out: number[] = [];
        for (let i = 0; i < u.length; i += 2) {
          const key = `${fmt(u[i])} ${fmt(u[i + 1])}`;
          let k = index.get(key);
          if (k === undefined) {
            index.set(key, (k = nVt++));
            lines.push(`vt ${key}`);
          }
          out.push(k + uvBase);
        }
        return out;
      });
    }
    lines.push(o.shade_smooth ? 's 1' : 's 0');
    let current = -1;
    faces.forEach((f, fi) => {
      // Switch material whenever the face's slot changes (faces keep their original order).
      const slot = o.mesh.faceMats?.[faceSrc ? faceSrc[fi] : fi] ?? 0;
      if (slot !== current) {
        current = slot;
        const mat = slotMaterial(project, o, slot);
        if (mat) {
          const name = safeName(texFile ? `${mat.name} (${o.name})` : mat.name);
          usedMats.set(texFile ? `${mat.id}|${o.id}` : mat.id, { mat, name, map: texFile });
          lines.push(`usemtl ${name}`);
        }
      }
      // A negative scale mirrors the object: flip winding so normals still point outwards.
      const corners = f.map((v, i) => (cornerVt ? `${v + base}/${cornerVt[fi][i]}` : `${v + base}`));
      lines.push('f ' + (det < 0 ? corners.reverse() : corners).join(' '));
    });
    for (const [a, b] of loose) lines.push(`l ${a + base} ${b + base}`);
    base += n;
    uvBase += nVt;
  }

  const mtl: string[] = ['# YotaBlender MTL export'];
  for (const { mat, name, map } of usedMats.values()) {
    const [r, g, b, a] = mat.base_color;
    mtl.push(
      '',
      `newmtl ${name}`,
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
      ...(map ? [`map_Kd ${map}`] : []),
    );
  }
  return { obj: lines.join('\n') + '\n', mtl: mtl.join('\n') + '\n' };
}

function cageFor(o: SceneObject, applyMirror: boolean) {
  const mesh = o.mesh;
  const mirror = applyMirror ? o.modifiers.find((m) => m.type === 'MIRROR' && m.show_viewport) : undefined;
  if (!mirror || mirror.type !== 'MIRROR') {
    return { positions: mesh.positions, faces: mesh.faces, faceSrc: null, loose: mesh.looseEdges, colors: mesh.colors, uvs: mesh.uvs };
  }
  const plan = buildMirrorPlan(mesh.positions, mesh.vertCount, mesh.faces, mesh.looseEdges, mirror);
  const pos = new Float64Array(plan.nOut * 3);
  evaluateMirror(plan, mesh.positions, pos);
  let colors: number[] | undefined;
  if (mesh.colors) {
    colors = [];
    for (let i = 0; i < plan.nOut; i++) {
      const s = plan.src[i] * 4;
      colors.push(mesh.colors[s], mesh.colors[s + 1], mesh.colors[s + 2], mesh.colors[s + 3]);
    }
  }
  const uvs = mesh.uvs ? mirrorCornerUVs(mesh.uvs, plan.faceSrc, plan.faceRev) : undefined;
  return { positions: Array.from(pos), faces: plan.faces, faceSrc: plan.faceSrc, loose: plan.looseEdges, colors, uvs };
}

const linToSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(0, c), 1 / 2.4) - 0.055);
const srgbToLin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/** OBJ names end at the line break; keep them on one line and without leading/trailing spaces. */
const safeName = (s: string) => s.replace(/[\r\n]+/g, ' ').trim() || 'Object';

// --- Reader (round-trip tests and import) -----------------------------------------------

export interface ObjObject {
  name: string;
  /** Positions converted back to Z-up. */
  positions: number[];
  /** Vertex colors (linear RGB) if the file had them. */
  colors?: number[];
  /** Material name per face ('' = none). */
  faceMaterials: string[];
  /** Corner UVs per face (u,v flat), when the file has `vt` and faces use them. */
  uvs?: number[][];
  faces: number[][];
  lines: [number, number][];
  material?: string;
  /** Shade smooth (an `s` line other than `s 0`/`s off`). */
  smooth?: boolean;
}

/**
 * Parses OBJ text. Objects start at `o` lines; files without any `o` split at `g` instead
 * (what most exporters use). Faces with bad indices are skipped, vertices are only taken when
 * something uses them, and objects with nothing in them are left out.
 */
export function parseObj(text: string): ObjObject[] {
  const all: number[] = [];
  const allColors: (number[] | null)[] = [];
  const allUV: number[] = [];
  const objects: ObjObject[] = [];
  const splitOnGroups = !/^[ \t]*o[ \t]/m.test(text);
  let cur: ObjObject | null = null;
  let material: string | undefined;
  let smooth = false;
  let faceUVs: (number[] | null)[] = [];
  const finish = () => {
    if (cur && faceUVs.some((u) => u)) cur.uvs = cur.faces.map((f, i) => faceUVs[i] ?? new Array(f.length * 2).fill(0));
  };
  const start = (name: string) => {
    finish();
    cur = { name: name || 'Object', positions: [], faces: [], lines: [], faceMaterials: [], material };
    objects.push(cur);
    localMap = new Map();
    faceUVs = [];
  };
  // Indices in OBJ are global; collect per-object local indices.
  let localMap = new Map<number, number>();
  const local = (o: ObjObject, gi: number) => {
    let li = localMap.get(gi);
    if (li === undefined) {
      li = o.positions.length / 3;
      localMap.set(gi, li);
      o.positions.push(all[gi * 3], all[gi * 3 + 1], all[gi * 3 + 2]);
      const c = allColors[gi];
      if (c) {
        // Fill earlier vertices (white) when colors start part-way through.
        if (!o.colors) o.colors = new Array(li * 3).fill(1);
        o.colors.push(...c);
      } else if (o.colors) o.colors.push(1, 1, 1);
    }
    return li;
  };
  const resolve = (s: string | undefined, count: number) => {
    if (!s) return -1;
    const i = parseInt(s, 10);
    const k = i < 0 ? count + i : i - 1;
    return Number.isInteger(k) && k >= 0 && k < count ? k : -1;
  };
  const rawLines = text.split(/\r?\n/);
  for (let ln = 0; ln < rawLines.length; ln++) {
    let line = rawLines[ln].trim();
    while (line.endsWith('\\') && ln + 1 < rawLines.length) line = line.slice(0, -1) + ' ' + rawLines[++ln].trim();
    if (!line || line.startsWith('#')) continue;
    const [tag, ...rest] = line.split(/\s+/);
    const arg = line.slice(tag.length).trim();
    if (tag === 'o' || (tag === 'g' && splitOnGroups)) {
      start(arg);
    } else if (tag === 'v') {
      const [x, y, z, r, g, b] = rest.map(Number);
      all.push(x, -z, y); // Y-up back to Z-up
      const hasColor = rest.length >= 6 && [r, g, b].every(Number.isFinite);
      const c01 = (c: number) => srgbToLin(Math.min(1, Math.max(0, c)));
      allColors.push(hasColor ? [c01(r), c01(g), c01(b)] : null);
    } else if (tag === 'vt') {
      const u = Number(rest[0]), v = Number(rest[1] ?? 0);
      allUV.push(Number.isFinite(u) ? u : 0, Number.isFinite(v) ? v : 0);
    } else if (tag === 'f' || tag === 'l') {
      const parts = rest.map((t) => t.split('/'));
      const idx = parts.map((p) => resolve(p[0], all.length / 3));
      if (idx.some((i) => i < 0) || idx.length < (tag === 'f' ? 3 : 2)) continue;
      if (!cur) start('Object');
      const o = cur!;
      const loc = idx.map((gi) => local(o, gi));
      if (tag === 'f') {
        const uvIdx = parts.map((p) => resolve(p[1], allUV.length / 2));
        faceUVs[o.faces.length] = uvIdx.every((k) => k >= 0) ? uvIdx.flatMap((k) => [allUV[k * 2], allUV[k * 2 + 1]]) : null;
        o.faces.push(loc);
        o.faceMaterials.push(o.material ?? '');
        if (smooth) o.smooth = true;
      } else for (let i = 0; i + 1 < loc.length; i++) o.lines.push([loc[i], loc[i + 1]]);
    } else if (tag === 'usemtl') {
      material = arg;
      if (cur) (cur as ObjObject).material = arg;
    } else if (tag === 's') {
      smooth = arg !== '0' && arg.toLowerCase() !== 'off';
    }
  }
  finish();
  return objects.filter((o) => o.faces.length || o.lines.length);
}

/** File names from the `mtllib` lines. */
export function objMtlLibs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/^[ \t]*mtllib[ \t]+(.+?)[ \t]*$/gm)) out.push(m[1]);
  return out;
}

export interface MtlMaterial {
  name: string;
  /** `Kd`, used as the linear base color (like Blender's importer). */
  color: [number, number, number];
  alpha: number;
  roughness: number;
  metallic: number;
  /** `map_Kd` file name, if any. */
  map?: string;
}

/** Reads the materials of an MTL file (base color, alpha, roughness, metallic, color map). */
export function parseMtl(text: string): MtlMaterial[] {
  const out: MtlMaterial[] = [];
  let m: MtlMaterial | null = null;
  let hasPr = false;
  const num = (s: string | undefined, d: number) => {
    const n = Number(s);
    return Number.isFinite(n) ? n : d;
  };
  const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [tag, ...rest] = line.split(/\s+/);
    const key = tag.toLowerCase();
    if (key === 'newmtl') {
      m = { name: line.slice(tag.length).trim(), color: [0.8, 0.8, 0.8], alpha: 1, roughness: 0.5, metallic: 0 };
      hasPr = false;
      out.push(m);
    } else if (!m) continue;
    else if (key === 'kd') m.color = [clamp01(num(rest[0], 0.8)), clamp01(num(rest[1], num(rest[0], 0.8))), clamp01(num(rest[2], num(rest[0], 0.8)))];
    else if (key === 'd') m.alpha = clamp01(num(rest[0], 1));
    else if (key === 'tr') m.alpha = clamp01(1 - num(rest[0], 0));
    else if (key === 'pr') {
      m.roughness = clamp01(num(rest[0], 0.5));
      hasPr = true;
    } else if (key === 'pm') m.metallic = clamp01(num(rest[0], 0));
    else if (key === 'ns' && !hasPr) m.roughness = clamp01(1 - Math.sqrt(clamp01(num(rest[0], 250) / 1000)));
    else if (key === 'map_kd') {
      // Skip options like "-s 1 1 1" / "-bm 0.5"; the file name is what's left (may hold spaces).
      const toks = rest.slice();
      while (toks.length > 1 && toks[0].startsWith('-')) {
        const opt = toks.shift()!;
        const n = { '-s': 3, '-o': 3, '-t': 3, '-mm': 2 }[opt] ?? 1;
        toks.splice(0, Math.min(n, toks.length - 1));
      }
      if (toks.length) m.map = toks.join(' ');
    }
  }
  return out;
}
