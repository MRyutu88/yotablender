// Builds a sample scene through the real core ops and checks the exports. With WRITE_SAMPLES=1
// it also writes blender/samples/* (OBJ, MTL, JSON and the expected counts), which
// blender/verify_obj_import.py imports into Blender to confirm quads/n-gons survive.
import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Mesh, type MeshData } from '../mesh/mesh';
import { buildPrimitive } from '../primitives/primitives';
import { newObject, newProject, type Project } from '../scene/scene';
import { newMirror, newSubsurf } from '../modifiers/types';
import { extrude } from '../mesh/ops';
import { selectionFromFaces } from '../mesh/selection';
import { exportObj, parseObj } from './obj';
import { serializeProject } from './projectJson';
import { assertValid } from '../mesh/validate';

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
  body.faceMats = body.faces.map((f) => (f.every((v) => body.positions[v * 3 + 2] < 1.1) ? 1 : 0));
  const cone = buildPrimitive('cone', { vertices: 6 });
  // Red at the bottom, white at the tip (linear RGBA per vertex).
  cone.colors = Array.from({ length: cone.positions.length / 3 }, (_, v) => (cone.positions[v * 3 + 2] > 0 ? [1, 1, 1, 1] : [0.8, 0.05, 0.05, 1])).flat();
  p.objects.push(
    newObject('Character Body', new Mesh(body), { modifiers: [newMirror(), newSubsurf()], shade_smooth: true, materialSlots: [p.materials[0].id, shirt.id] }),
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

const matCounts = (names: string[]) => {
  const h: Record<string, number> = {};
  for (const n of names) h[n] = (h[n] ?? 0) + 1;
  return h;
};

const histogram = (faces: number[][]) => {
  const h: Record<string, number> = {};
  for (const f of faces) h[f.length] = (h[f.length] ?? 0) + 1;
  return h;
};

describe('sample scene exports', () => {
  it('keeps every face size through OBJ', () => {
    const p = sampleProject();
    const { obj, mtl } = exportObj(p, { mtlName: 'yotablender-sample.mtl' });
    const parsed = parseObj(obj);
    const expected = p.objects.map((o) => ({
      name: o.name,
      verts: o.mesh.vertCount,
      faces: o.mesh.faces.length,
      sizes: histogram(o.mesh.faces),
      materials: matCounts(o.mesh.faces.map((_, i) => p.materials.find((m) => m.id === o.materialSlots[o.mesh.faceMats?.[i] ?? 0])!.name)),
      hasColors: !!o.mesh.colors,
    }));
    expect(
      parsed.map((o) => ({
        name: o.name,
        verts: o.positions.length / 3,
        faces: o.faces.length,
        sizes: histogram(o.faces),
        materials: matCounts(o.faceMaterials),
        hasColors: !!o.colors,
      })),
    ).toEqual(expected);
    expect(mtl).toMatch(/newmtl Shirt/);
    // Cone vertex 0 (bottom ring) carries the red paint.
    parsed[2].colors!.slice(0, 3).forEach((c, i) => expect(c).toBeCloseTo([0.8, 0.05, 0.05][i], 4));
    const mirrored = exportObj(p, { applyMirror: true, mtlName: 'yotablender-sample.mtl' });
    if (process.env.WRITE_SAMPLES) {
      const dir = new URL('../../../blender/samples/', import.meta.url);
      mkdirSync(dir, { recursive: true });
      writeFileSync(new URL('yotablender-sample.obj', dir), obj);
      writeFileSync(new URL('yotablender-sample-mirrored.obj', dir), mirrored.obj);
      writeFileSync(new URL('yotablender-sample.mtl', dir), mtl);
      writeFileSync(new URL('yotablender-sample.yblend.json', dir), JSON.stringify(serializeProject(p), null, 1));
      const mirroredParsed = parseObj(mirrored.obj).map((o) => ({
        name: o.name,
        verts: o.positions.length / 3,
        faces: o.faces.length,
        sizes: histogram(o.faces),
        materials: matCounts(o.faceMaterials),
        hasColors: !!o.colors,
      }));
      writeFileSync(new URL('expected-counts.json', dir), JSON.stringify({ cage: expected, mirrored: mirroredParsed }, null, 1));
    }
  });
});
