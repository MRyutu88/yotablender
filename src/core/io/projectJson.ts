// Native project file (.yblend.json). Versioned, with migrations. Field names deliberately match
// Blender's Python API (location, rotation_euler, use_axis, levels…) so the Blender add-on can
// rebuild objects, the exact cage, the modifier stack, materials and color attributes directly.
//
// v1 → v2: one material per object became material slots + a slot per face, and meshes can
// carry a color attribute.

import { Mesh, type Edge } from '../mesh/mesh';
import { emptySelection } from '../mesh/selection';
import type { Modifier } from '../modifiers/types';
import { defaultMaterial, type Material, type Project, type SceneObject } from '../scene/scene';
import type { Vec3 } from '../math/vec3';

export const FORMAT = 'yotablender';
export const VERSION = 2;

interface ObjectV1 {
  id: string;
  name: string;
  location: Vec3;
  rotation_mode: 'XYZ';
  rotation_euler: Vec3;
  scale: Vec3;
  visible: boolean;
  shade_smooth: boolean;
  material: string | null;
  mesh: { vertices: number[][]; faces: number[][]; loose_edges: Edge[] };
  modifiers: Modifier[];
  primitive?: SceneObject['primitive'];
}

export interface ColorAttributeV2 {
  name: string;
  /** Blender's attribute domain and type: per-vertex float color, like a new "Color" attribute. */
  domain: 'POINT';
  data_type: 'FLOAT_COLOR';
  /** Linear RGBA per vertex. */
  data: number[][];
}

interface ObjectV2 extends Omit<ObjectV1, 'material' | 'mesh'> {
  /** Material slot names, in slot order (Blender's object.material_slots). */
  materials: string[];
  mesh: {
    vertices: number[][];
    faces: number[][];
    loose_edges: Edge[];
    /** Slot index per face (Blender's polygon.material_index). */
    face_materials: number[];
    color_attributes: ColorAttributeV2[];
  };
}

interface Header {
  format: typeof FORMAT;
  generator: string;
  unit: 'm';
  up_axis: 'Z';
  project: { id: string; name: string; created: number; modified: number };
  materials: Material[];
}
export interface ProjectFileV1 extends Header {
  version: 1;
  objects: ObjectV1[];
}
export interface ProjectFileV2 extends Header {
  version: 2;
  objects: ObjectV2[];
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

export function serializeProject(p: Project): ProjectFileV2 {
  const nameOf = (id: string) => p.materials.find((m) => m.id === id)?.name;
  return {
    format: FORMAT,
    version: VERSION,
    generator: 'YotaBlender 0.2',
    unit: 'm',
    up_axis: 'Z',
    project: { id: p.id, name: p.name, created: p.created, modified: p.modified },
    materials: p.materials.map((m) => ({ ...m, base_color: [...m.base_color] })),
    objects: p.objects.map((o) => {
      const verts: number[][] = [];
      const pos = o.mesh.positions;
      for (let i = 0; i < pos.length; i += 3) verts.push([round(pos[i]), round(pos[i + 1]), round(pos[i + 2])]);
      const colors: ColorAttributeV2[] = [];
      if (o.mesh.colors) {
        const c = o.mesh.colors;
        const data: number[][] = [];
        for (let i = 0; i < c.length; i += 4) data.push([round(c[i]), round(c[i + 1]), round(c[i + 2]), round(c[i + 3])]);
        colors.push({ name: 'Color', domain: 'POINT', data_type: 'FLOAT_COLOR', data });
      }
      return {
        id: o.id,
        name: o.name,
        location: [...o.location],
        rotation_mode: 'XYZ',
        rotation_euler: [...o.rotation_euler],
        scale: [...o.scale],
        visible: o.visible,
        shade_smooth: o.shade_smooth,
        materials: o.materialSlots.map((id) => nameOf(id)).filter((n): n is string => !!n),
        mesh: {
          vertices: verts,
          faces: o.mesh.faces.map((f) => [...f]),
          loose_edges: o.mesh.looseEdges.map((e) => [e[0], e[1]]),
          face_materials: o.mesh.faces.map((_, i) => o.mesh.faceMats?.[i] ?? 0),
          color_attributes: colors,
        },
        modifiers: o.modifiers.map((m) => structuredClone(m)),
        primitive: o.primitive ? structuredClone(o.primitive) : undefined,
      };
    }),
  };
}

export class ProjectFileError extends Error {}

/** Parses and migrates a project file of any supported version. */
export function deserializeProject(input: unknown): Project {
  const file = migrate(input);
  const materials = file.materials.length ? file.materials : [defaultMaterial()];
  return {
    id: file.project.id,
    name: file.project.name,
    created: file.project.created,
    modified: file.project.modified,
    materials,
    objects: file.objects.map((o) => {
      const positions: number[] = [];
      for (const v of o.mesh.vertices) positions.push(v[0], v[1], v[2]);
      const slots = o.materials.map((n) => materials.find((m) => m.name === n)?.id).filter((id): id is string => !!id);
      const fm = o.mesh.face_materials;
      const color = o.mesh.color_attributes.find((c) => c.domain === 'POINT');
      return {
        id: o.id,
        name: o.name,
        location: [...o.location] as Vec3,
        rotation_euler: [...o.rotation_euler] as Vec3,
        scale: [...o.scale] as Vec3,
        visible: o.visible,
        shade_smooth: o.shade_smooth,
        materialSlots: slots,
        mesh: new Mesh({
          positions,
          faces: o.mesh.faces.map((f) => [...f]),
          looseEdges: o.mesh.loose_edges.map((e) => [e[0], e[1]] as Edge),
          faceMats: fm && fm.some((x) => x !== 0) ? [...fm] : undefined,
          colors: color ? color.data.flat() : undefined,
        }),
        modifiers: o.modifiers.map((m) => withModifierDefaults(m)),
        editSelection: emptySelection(),
        primitive: o.primitive,
      };
    }),
  };
}

function migrate(input: unknown): ProjectFileV2 {
  if (!input || typeof input !== 'object') throw new ProjectFileError('Not a YotaBlender project file');
  const f = input as { format?: string; version?: number };
  if (f.format !== FORMAT) throw new ProjectFileError('Not a YotaBlender project file');
  if (typeof f.version !== 'number') throw new ProjectFileError('Project file has no version');
  if (f.version > VERSION) throw new ProjectFileError('This project was saved by a newer version of the app. Update the app first.');
  let file = input as ProjectFileV1 | ProjectFileV2;
  if (file.version === 1) file = v1ToV2(file);
  return file;
}

function v1ToV2(f: ProjectFileV1): ProjectFileV2 {
  return {
    ...f,
    version: 2,
    objects: f.objects.map(({ material, mesh, ...rest }) => ({
      ...rest,
      materials: material ? [material] : [],
      mesh: { ...mesh, face_materials: mesh.faces.map(() => 0), color_attributes: [] },
    })),
  };
}

/** Fills in modifier fields added after a file was written. */
function withModifierDefaults(m: Modifier): Modifier {
  if (m.type === 'SUBSURF') return { ...m, drag_levels: m.drag_levels ?? m.levels };
  return { ...m };
}
