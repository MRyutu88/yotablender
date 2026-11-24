// Native project file (.yblend.json). Versioned, with migrations. Field names deliberately match
// Blender's Python API (location, rotation_euler, use_axis, levels…) so the Blender add-on can
// rebuild objects, the exact cage and the modifier stack directly.

import { Mesh, type Edge } from '../mesh/mesh';
import { emptySelection } from '../mesh/selection';
import type { Modifier } from '../modifiers/types';
import { defaultMaterial, type Material, type Project, type SceneObject } from '../scene/scene';
import type { Vec3 } from '../math/vec3';

export const FORMAT = 'yotablender';
export const VERSION = 1;

export interface ProjectFileV1 {
  format: typeof FORMAT;
  version: 1;
  generator: string;
  unit: 'm';
  up_axis: 'Z';
  project: { id: string; name: string; created: number; modified: number };
  materials: Material[];
  objects: {
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
  }[];
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

export function serializeProject(p: Project): ProjectFileV1 {
  return {
    format: FORMAT,
    version: VERSION,
    generator: 'YotaBlender 0.1',
    unit: 'm',
    up_axis: 'Z',
    project: { id: p.id, name: p.name, created: p.created, modified: p.modified },
    materials: p.materials.map((m) => ({ ...m, base_color: [...m.base_color] })),
    objects: p.objects.map((o) => {
      const verts: number[][] = [];
      const pos = o.mesh.positions;
      for (let i = 0; i < pos.length; i += 3) verts.push([round(pos[i]), round(pos[i + 1]), round(pos[i + 2])]);
      const mat = p.materials.find((m) => m.id === o.materialId);
      return {
        id: o.id,
        name: o.name,
        location: [...o.location],
        rotation_mode: 'XYZ',
        rotation_euler: [...o.rotation_euler],
        scale: [...o.scale],
        visible: o.visible,
        shade_smooth: o.shade_smooth,
        material: mat ? mat.name : null,
        mesh: { vertices: verts, faces: o.mesh.faces.map((f) => [...f]), loose_edges: o.mesh.looseEdges.map((e) => [e[0], e[1]]) },
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
      return {
        id: o.id,
        name: o.name,
        location: [...o.location] as Vec3,
        rotation_euler: [...o.rotation_euler] as Vec3,
        scale: [...o.scale] as Vec3,
        visible: o.visible,
        shade_smooth: o.shade_smooth,
        materialId: materials.find((m) => m.name === o.material)?.id ?? null,
        mesh: new Mesh({ positions, faces: o.mesh.faces.map((f) => [...f]), looseEdges: o.mesh.loose_edges.map((e) => [e[0], e[1]] as Edge) }),
        modifiers: o.modifiers.map((m) => withModifierDefaults(m)),
        editSelection: emptySelection(),
        primitive: o.primitive,
      };
    }),
  };
}

function migrate(input: unknown): ProjectFileV1 {
  if (!input || typeof input !== 'object') throw new ProjectFileError('Not a YotaBlender project file');
  const f = input as { format?: string; version?: number };
  if (f.format !== FORMAT) throw new ProjectFileError('Not a YotaBlender project file');
  if (typeof f.version !== 'number') throw new ProjectFileError('Project file has no version');
  if (f.version > VERSION) throw new ProjectFileError('This project was saved by a newer version of the app. Update the app first.');
  // Future: if (f.version === 1) input = v1ToV2(input) …
  return input as ProjectFileV1;
}

/** Fills in modifier fields added after a file was written. */
function withModifierDefaults(m: Modifier): Modifier {
  if (m.type === 'SUBSURF') return { ...m, drag_levels: m.drag_levels ?? m.levels };
  return { ...m };
}
