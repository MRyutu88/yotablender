// OBJ (+ MTL) import: parse, clean up each object, apply the import limits and turn the
// result into scene objects and materials. Pure: images are resolved by the caller (the app
// decodes them), this only says which file each object's texture comes from.

import { Mesh } from '../mesh/mesh';
import {
  newObject,
  uid,
  uniqueName,
  DEFAULT_MATERIAL_ID,
  type Material,
  type Project,
  type SceneObject,
} from '../scene/scene';
import { parseMtl, parseObj, type MtlMaterial } from './obj';
import {
  addReports,
  bboxDiagonal,
  cleanMesh,
  emptyReport,
  IMPORT_LIMITS,
  type CleanReport,
} from './importMesh';

export interface ObjImportResult {
  objects: SceneObject[];
  /** Materials to add to the project (existing identical ones are reused, not listed). */
  materials: Material[];
  /** Texture file (`map_Kd`) per new object id, for objects with UVs. */
  textureFiles: Record<string, string>;
  report: CleanReport;
  /** Scale baked into the vertices to bring a huge or tiny model to a workable size (1 = none). */
  scale: number;
  warnings: string[];
}

export class ImportError extends Error {}

/** Models bigger than this or smaller than `MIN_SIZE` (largest bounding-box side) get rescaled. */
const MAX_SIZE = 100;
const MIN_SIZE = 0.01;
const FIT_SIZE = 2;

export function importObj(
  project: Project,
  objText: string,
  mtlTexts: string[] = [],
  opts: { weld?: boolean } = {},
): ObjImportResult {
  const warnings: string[] = [];
  const parsed = parseObj(objText);
  if (!parsed.length) throw new ImportError('No faces or edges found in that OBJ file');
  if (parsed.length > IMPORT_LIMITS.maxObjects)
    throw new ImportError(
      `That file has ${parsed.length} objects; the limit is ${IMPORT_LIMITS.maxObjects}. Join them in Blender first.`,
    );
  const rawFaces = parsed.reduce((n, o) => n + o.faces.length, 0);
  if (rawFaces > IMPORT_LIMITS.maxFaces)
    throw new ImportError(
      `That model has ${rawFaces.toLocaleString('en-US')} faces; the limit is ${IMPORT_LIMITS.maxFaces.toLocaleString('en-US')}. Decimate it in Blender first.`,
    );

  const mtl = new Map<string, MtlMaterial>();
  for (const t of mtlTexts) for (const m of parseMtl(t)) if (!mtl.has(m.name)) mtl.set(m.name, m);

  // Rescale models that are far too big (millimetre CAD) or too small to edit comfortably.
  const allPos = parsed.flatMap((o) => o.positions);
  const size = maxSide(allPos);
  const scale = size > MAX_SIZE || (size > 0 && size < MIN_SIZE) ? FIT_SIZE / size : 1;
  if (scale !== 1) warnings.push(`Scaled ×${formatScale(scale)} to fit`);
  if (bboxDiagonal(allPos) === 0) throw new ImportError('That OBJ file has no usable geometry');

  // Materials: one project material per MTL/usemtl name; reuse an identical existing one.
  const materials: Material[] = [];
  const matIds = new Map<string, string>();
  const missing = new Set<string>();
  const materialFor = (name: string): string => {
    if (!name) return DEFAULT_MATERIAL_ID;
    let id = matIds.get(name);
    if (id) return id;
    const m = mtl.get(name);
    if (!m) missing.add(name);
    const base_color: Material['base_color'] = m ? [...m.color, m.alpha] : [0.8, 0.8, 0.8, 1];
    const roughness = m?.roughness ?? 0.5,
      metallic = m?.metallic ?? 0;
    const same = project.materials.find(
      (x) =>
        x.name === name &&
        x.roughness === roughness &&
        x.metallic === metallic &&
        x.base_color.every((c, i) => Math.abs(c - base_color[i]) < 1e-6),
    );
    if (same) id = same.id;
    else {
      const mat: Material = {
        id: uid(),
        name: uniqueName(
          name,
          [...project.materials, ...materials].map((x) => x.name),
        ),
        base_color,
        roughness,
        metallic,
      };
      materials.push(mat);
      id = mat.id;
    }
    matIds.set(name, id);
    return id;
  };

  const taken = project.objects.map((o) => o.name);
  const objects: SceneObject[] = [];
  const textureFiles: Record<string, string> = {};
  let report = emptyReport();
  let failed = 0;
  let uvOutside = false;
  for (const o of parsed) {
    const positions = scale === 1 ? o.positions : o.positions.map((x) => x * scale);
    let cleaned;
    try {
      cleaned = cleanMesh(
        {
          positions,
          faces: o.faces,
          lines: o.lines,
          colors: o.colors ? rgbToRgba(o.colors) : undefined,
          uvs: o.uvs,
        },
        opts,
      );
    } catch {
      failed++;
      continue;
    }
    const { data, faceSrc } = cleaned;
    report = addReports(report, cleaned.report);
    if (!data.faces.length && !data.looseEdges.length) {
      failed++;
      continue;
    }
    // Material slots in order of first use; faces point at their slot.
    const slotOf = new Map<string, number>();
    const slots: string[] = [];
    const faceMats = faceSrc.map((fi) => {
      const id = materialFor(o.faceMaterials[fi] ?? '');
      let s = slotOf.get(id);
      if (s === undefined) {
        slotOf.set(id, (s = slots.length));
        slots.push(id);
      }
      return s;
    });
    if (slots.length > 1) data.faceMats = faceMats;
    const name = uniqueName(o.name.trim() || 'Object', taken);
    taken.push(name);
    const obj = newObject(name, new Mesh(data), {
      materialSlots: slots.length ? slots : [DEFAULT_MATERIAL_ID],
      shade_smooth: !!o.smooth,
    });
    // One texture per object: the first material (in face order) with a color map.
    if (data.uvs) {
      const maps = [
        ...new Set(
          faceSrc.map((fi) => mtl.get(o.faceMaterials[fi] ?? '')?.map).filter((m): m is string => !!m),
        ),
      ];
      if (maps.length) {
        textureFiles[obj.id] = maps[0];
        if (maps.length > 1) warnings.push(`${name}: only the first of ${maps.length} textures is used`);
        if (data.uvs.some((u) => u.some((x) => x < -0.001 || x > 1.001))) uvOutside = true;
      }
    }
    objects.push(obj);
  }
  if (!objects.length) throw new ImportError('Nothing in that OBJ file could be imported');
  if (failed) warnings.push(`${failed} object${failed > 1 ? 's' : ''} skipped (broken geometry)`);
  if (missing.size && mtlTexts.length)
    warnings.push(`Material${missing.size > 1 ? 's' : ''} not in the MTL: ${[...missing].join(', ')}`);
  if (uvOutside) warnings.push('Some UVs are outside 0–1 (tiling), so the texture may look different');
  const dropped = report.degenerate + report.duplicate + report.nonManifold;
  if (dropped) warnings.push(`${dropped} broken face${dropped > 1 ? 's' : ''} removed`);
  return { objects, materials, textureFiles, report, scale, warnings };
}

function rgbToRgba(c: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < c.length; i += 3) out.push(c[i], c[i + 1], c[i + 2], 1);
  return out;
}

function maxSide(p: number[]): number {
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3)
    for (let k = 0; k < 3; k++)
      if (Number.isFinite(p[i + k])) {
        min[k] = Math.min(min[k], p[i + k]);
        max[k] = Math.max(max[k], p[i + k]);
      }
  return min[0] === Infinity ? 0 : Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
}

const formatScale = (s: number) =>
  s >= 1 ? String(Number(s.toPrecision(3))) : Number(s.toPrecision(2)).toString();
