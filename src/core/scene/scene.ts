// Project / scene model. Field names follow Blender where there is an equivalent.

import { Mesh } from '../mesh/mesh';
import { emptySelection, type Selection } from '../mesh/selection';
import type { Modifier } from '../modifiers/types';
import type { PrimitiveParams, PrimitiveType } from '../primitives/primitives';
import { compose, type Mat4 } from '../math/mat4';
import type { Vec3 } from '../math/vec3';

export interface Material {
  id: string;
  name: string;
  /** Linear RGBA, like Blender's Principled BSDF base color. */
  base_color: [number, number, number, number];
  roughness: number;
  metallic: number;
}

export interface SceneObject {
  id: string;
  name: string;
  location: Vec3;
  /** Euler XYZ in radians (Blender's default rotation mode). */
  rotation_euler: Vec3;
  scale: Vec3;
  mesh: Mesh;
  modifiers: Modifier[];
  materialId: string | null;
  visible: boolean;
  /** Blender's Shade Smooth / Flat. */
  shade_smooth: boolean;
  /** Edit-mode selection, kept per object like Blender keeps it in the mesh. */
  editSelection: Selection;
  /** How the object was created, for the Adjust Last Operation panel. */
  primitive?: { type: PrimitiveType; params: PrimitiveParams[PrimitiveType] };
}

export interface Project {
  id: string;
  name: string;
  objects: SceneObject[];
  materials: Material[];
  created: number;
  modified: number;
}

export const DEFAULT_MATERIAL_ID = 'mat-default';

export const defaultMaterial = (): Material => ({
  id: DEFAULT_MATERIAL_ID,
  name: 'Material',
  base_color: [0.8, 0.8, 0.8, 1],
  roughness: 0.5,
  metallic: 0,
});

export function newProject(name = 'Untitled'): Project {
  const t = Date.now();
  return { id: uid(), name, objects: [], materials: [defaultMaterial()], created: t, modified: t };
}

export function newObject(name: string, mesh: Mesh, init: Partial<SceneObject> = {}): SceneObject {
  return {
    id: uid(),
    name,
    location: [0, 0, 0],
    rotation_euler: [0, 0, 0],
    scale: [1, 1, 1],
    mesh,
    modifiers: [],
    materialId: DEFAULT_MATERIAL_ID,
    visible: true,
    shade_smooth: false,
    editSelection: emptySelection(),
    ...init,
  };
}

export const objectMatrix = (o: SceneObject): Mat4 => compose(o.location, o.rotation_euler, o.scale);

/** Blender-style unique names: "Cube", "Cube.001", "Cube.002"… */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const names = new Set(taken);
  const stem = base.replace(/\.\d{3}$/, '');
  if (!names.has(stem)) return stem;
  for (let i = 1; ; i++) {
    const n = `${stem}.${String(i).padStart(3, '0')}`;
    if (!names.has(n)) return n;
  }
}

export function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
