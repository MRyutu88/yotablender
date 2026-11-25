// The sample scene used by the export tests and by the Blender checks (blender/samples/*).
// Built through the real core ops.
import { Mesh, type MeshData } from '../mesh/mesh';
import { buildPrimitive } from '../primitives/primitives';
import { newObject, newProject, type Project } from '../scene/scene';
import { newMirror, newSubsurf } from '../modifiers/types';
import { extrude } from '../mesh/ops';
import { selectionFromFaces } from '../mesh/selection';
import { assertValid } from '../mesh/validate';
import { unwrap } from '../uv/unwrap';
import { encodePng } from './png';

export const SAMPLE_TEXTURE_SIZE = 256;

/**
 * The sample paint layer: 32 px blocks, every other one painted orange (opaque), the rest
 * transparent, plus a half-transparent blue band. Row 0 is the bottom row (v = 0), like GL and
 * Blender; the PNG is written top row first.
 */
export function samplePaintPixel(x: number, y: number): [number, number, number, number] {
  if (y >= 96 && y < 128) return [40, 90, 220, 128];
  return ((x >> 5) + (y >> 5)) % 2 === 0 ? [240, 140, 30, 255] : [0, 0, 0, 0];
}

function samplePng(): Uint8Array {
  const n = SAMPLE_TEXTURE_SIZE;
  const rgba = new Uint8Array(n * n * 4);
  for (let row = 0; row < n; row++) for (let x = 0; x < n; x++) rgba.set(samplePaintPixel(x, n - 1 - row), (row * n + x) * 4);
  return encodePng(rgba, n, n);
}

function characterWithArm(): MeshData {
  const positions: number[] = [];
  for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) for (let z = 0; z < 2; z++) positions.push(x * 0.5, y ? 0.35 : -0.35, z ? 1.6 : 0.6);
  const half: MeshData = {
    positions,
    faces: [
      [2, 3, 7, 6],
      [6, 7, 5, 4],
      [4, 5, 1, 0],
      [2, 6, 4, 0],
      [7, 3, 1, 5],
    ],
    looseEdges: [],
  };
  // Extrude the +X side face outwards (the arm) and move it.
  const side = half.faces.findIndex((f) => f.every((v) => half.positions[v * 3] > 0.25));
  const r = extrude(half, selectionFromFaces(half, [side]));
  for (const v of r.selection.verts) r.data.positions[v * 3] += 0.6;
  assertValid(r.data);
  return r.data;
}

export function sampleProject(): Project {
  const p = newProject('YotaBlender sample');
  // A second material ("Shirt") on the character's lower faces, and painted colors on the cone.
  const shirt = { id: 'mat-shirt', name: 'Shirt', base_color: [0.1, 0.3, 0.8, 1] as [number, number, number, number], roughness: 0.3, metallic: 0.2 };
  p.materials.push(shirt);
  const body = characterWithArm();
  // Unwrapped and painted (the paint layer covers both mirrored halves through shared UVs).
  body.uvs = unwrap(body).uvs;
  p.images.push({ id: 'img-body', name: 'Character Body Paint', width: SAMPLE_TEXTURE_SIZE, height: SAMPLE_TEXTURE_SIZE, png: samplePng() });
  body.faceMats = body.faces.map((f) => (f.every((v) => body.positions[v * 3 + 2] < 1.1) ? 1 : 0));
  const cone = buildPrimitive('cone', { vertices: 6 });
  // Red at the bottom, white at the tip (linear RGBA per vertex).
  cone.colors = Array.from({ length: cone.positions.length / 3 }, (_, v) => (cone.positions[v * 3 + 2] > 0 ? [1, 1, 1, 1] : [0.8, 0.05, 0.05, 1])).flat();
  p.objects.push(
    newObject('Character Body', new Mesh(body), {
      modifiers: [newMirror(), newSubsurf()],
      shade_smooth: true,
      materialSlots: [p.materials[0].id, shirt.id],
      texture: 'img-body',
    }),
    newObject('Cylinder 8', new Mesh(buildPrimitive('cylinder', { vertices: 8 })), { location: [2.5, 0, 1] }),
    newObject('Cone', new Mesh(cone), { location: [-2.5, 0, 1] }),
    newObject('Torus', new Mesh(buildPrimitive('torus', { majorSegments: 12, minorSegments: 6 })), {
      location: [0, 3, 1],
      rotation_euler: [Math.PI / 4, 0, Math.PI / 6],
      scale: [1, 1.5, 1],
    }),
  );
  return p;
}

