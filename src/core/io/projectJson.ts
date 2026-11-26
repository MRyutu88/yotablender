// Native project file (.yblend.json). Versioned, with migrations. Field names deliberately match
// Blender's Python API (location, rotation_euler, use_axis, levels…) so the Blender add-on can
// rebuild objects, the exact cage, the modifier stack, materials and color attributes directly.
//
// v1 → v2: one material per object became material slots + a slot per face, and meshes can
// carry a color attribute.
// v2 → v3: UVs (a Face Corner float2 attribute "UVMap"), a paint texture per object and the
// project's images (PNG, embedded as base64 so one file carries everything).

import { Mesh, type Edge } from '../mesh/mesh';
import { emptySelection } from '../mesh/selection';
import type { Modifier } from '../modifiers/types';
import { defaultMaterial, uid, type Material, type Project, type ProjectImage, type SceneObject } from '../scene/scene';
import { base64ToBytes, bytesToBase64 } from './png';
import type { Vec3 } from '../math/vec3';

export const FORMAT = 'yotablender';
export const VERSION = 3;

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
  /** Edit Mode live symmetry (Blender's mesh.use_mirror_x/y/z). */
  use_mirror?: [boolean, boolean, boolean];
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

export interface UVLayerV3 {
  name: string;
  domain: 'CORNER';
  data_type: 'FLOAT2';
  /** One [u, v] per face corner, faces in order, corners in face order (Blender's loops). */
  data: number[][];
}

interface ObjectV3 extends Omit<ObjectV2, 'mesh'> {
  mesh: ObjectV2['mesh'] & { uv_layers: UVLayerV3[] };
  /** Paint layer: image (by name) mapped through a UV layer, mixed over the base color by its alpha. */
  texture: { image: string; uv_map: string; blend: 'MIX_ALPHA' } | null;
}

export interface ImageV3 {
  name: string;
  width: number;
  height: number;
  colorspace: 'sRGB';
  alpha_mode: 'STRAIGHT';
  file_format: 'PNG';
  /** PNG file, base64. Absent in autosaves, which store image bytes separately. */
  data?: string;
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
export interface ProjectFileV3 extends Header {
  version: 3;
  objects: ObjectV3[];
  images: ImageV3[];
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

export interface SerializeOptions {
  /** Embed image PNGs (default true). Autosave stores them separately. */
  embedImages?: boolean;
}

export function serializeProject(p: Project, opts: SerializeOptions = {}): ProjectFileV3 {
  const nameOf = (id: string) => p.materials.find((m) => m.id === id)?.name;
  const embed = opts.embedImages ?? true;
  const imageName = (id: string | undefined) => (id ? p.images.find((i) => i.id === id)?.name : undefined);
  return {
    format: FORMAT,
    version: VERSION,
    generator: 'YotaBlender 0.3',
    unit: 'm',
    up_axis: 'Z',
    project: { id: p.id, name: p.name, created: p.created, modified: p.modified },
    materials: p.materials.map((m) => ({ ...m, base_color: [...m.base_color] })),
    // Only images some object still paints with (undo can leave unused ones in memory).
    images: p.images.filter((im) => p.objects.some((o) => o.texture === im.id && o.mesh.uvs)).map((im) => ({
      name: im.name,
      width: im.width,
      height: im.height,
      colorspace: 'sRGB',
      alpha_mode: 'STRAIGHT',
      file_format: 'PNG',
      ...(embed ? { data: bytesToBase64(im.png) } : {}),
    })),
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
      const uvLayers: UVLayerV3[] = [];
      if (o.mesh.uvs) {
        const data: number[][] = [];
        for (const f of o.mesh.uvs) for (let i = 0; i < f.length; i += 2) data.push([round(f[i]), round(f[i + 1])]);
        uvLayers.push({ name: 'UVMap', domain: 'CORNER', data_type: 'FLOAT2', data });
      }
      const tex = o.mesh.uvs ? imageName(o.texture) : undefined;
      return {
        id: o.id,
        name: o.name,
        location: [...o.location],
        rotation_mode: 'XYZ',
        rotation_euler: [...o.rotation_euler],
        scale: [...o.scale],
        visible: o.visible,
        shade_smooth: o.shade_smooth,
        ...(o.use_mirror?.some(Boolean) ? { use_mirror: [...o.use_mirror] as [boolean, boolean, boolean] } : {}),
        materials: o.materialSlots.map((id) => nameOf(id)).filter((n): n is string => !!n),
        mesh: {
          vertices: verts,
          faces: o.mesh.faces.map((f) => [...f]),
          loose_edges: o.mesh.looseEdges.map((e) => [e[0], e[1]]),
          face_materials: o.mesh.faces.map((_, i) => o.mesh.faceMats?.[i] ?? 0),
          color_attributes: colors,
          uv_layers: uvLayers,
        },
        texture: tex ? { image: tex, uv_map: 'UVMap', blend: 'MIX_ALPHA' } : null,
        modifiers: o.modifiers.map((m) => structuredClone(m)),
        primitive: o.primitive ? structuredClone(o.primitive) : undefined,
      };
    }),
  };
}

export class ProjectFileError extends Error {}

/**
 * Parses and migrates a project file of any supported version. `imageBytes` supplies PNGs that
 * are not embedded (autosave), by image name.
 */
export function deserializeProject(input: unknown, imageBytes?: (name: string) => Uint8Array | undefined): Project {
  const file = migrate(input);
  const materials = file.materials.length ? file.materials : [defaultMaterial()];
  const images: ProjectImage[] = [];
  for (const im of file.images) {
    const png = im.data ? base64ToBytes(im.data) : imageBytes?.(im.name);
    if (png) images.push({ id: uid(), name: im.name, width: im.width, height: im.height, png });
  }
  return {
    id: file.project.id,
    name: file.project.name,
    created: file.project.created,
    modified: file.project.modified,
    materials,
    images,
    objects: file.objects.map((o) => {
      const positions: number[] = [];
      for (const v of o.mesh.vertices) positions.push(v[0], v[1], v[2]);
      const slots = o.materials.map((n) => materials.find((m) => m.name === n)?.id).filter((id): id is string => !!id);
      const fm = o.mesh.face_materials;
      const color = o.mesh.color_attributes.find((c) => c.domain === 'POINT');
      const uvl = o.mesh.uv_layers.find((l) => l.domain === 'CORNER');
      let uvs: number[][] | undefined;
      if (uvl) {
        let k = 0;
        uvs = o.mesh.faces.map((f) => f.flatMap(() => uvl.data[k++] ?? [0, 0]));
      }
      const texture = uvs && o.texture ? images.find((im) => im.name === o.texture!.image)?.id : undefined;
      return {
        id: o.id,
        name: o.name,
        location: [...o.location] as Vec3,
        rotation_euler: [...o.rotation_euler] as Vec3,
        scale: [...o.scale] as Vec3,
        visible: o.visible,
        shade_smooth: o.shade_smooth,
        use_mirror: Array.isArray(o.use_mirror) && o.use_mirror.some(Boolean) ? ([0, 1, 2].map((i) => !!o.use_mirror![i]) as [boolean, boolean, boolean]) : undefined,
        materialSlots: slots,
        mesh: new Mesh({
          positions,
          faces: o.mesh.faces.map((f) => [...f]),
          looseEdges: o.mesh.loose_edges.map((e) => [e[0], e[1]] as Edge),
          faceMats: fm && fm.some((x) => x !== 0) ? [...fm] : undefined,
          colors: color ? color.data.flat() : undefined,
          uvs,
        }),
        texture,
        modifiers: o.modifiers.map((m) => withModifierDefaults(m)),
        editSelection: emptySelection(),
        primitive: o.primitive,
      };
    }),
  };
}

function migrate(input: unknown): ProjectFileV3 {
  if (!input || typeof input !== 'object') throw new ProjectFileError('Not a YotaBlender project file');
  const f = input as { format?: string; version?: number };
  if (f.format !== FORMAT) throw new ProjectFileError('Not a YotaBlender project file');
  if (typeof f.version !== 'number') throw new ProjectFileError('Project file has no version');
  if (f.version > VERSION) throw new ProjectFileError('This project was saved by a newer version of the app. Update the app first.');
  let file = input as ProjectFileV1 | ProjectFileV2 | ProjectFileV3;
  if (file.version === 1) file = v1ToV2(file);
  if (file.version === 2) file = v2ToV3(file);
  return file;
}

function v2ToV3(f: ProjectFileV2): ProjectFileV3 {
  return {
    ...f,
    version: 3,
    images: [],
    objects: f.objects.map((o) => ({ ...o, mesh: { ...o.mesh, uv_layers: [] }, texture: null })),
  };
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
