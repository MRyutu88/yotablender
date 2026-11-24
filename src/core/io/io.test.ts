import { describe, expect, it } from 'vitest';
import { exportObj, parseObj } from './obj';
import { deserializeProject, serializeProject, ProjectFileError } from './projectJson';
import { newObject, newProject } from '../scene/scene';
import { Mesh, faceCenter, faceNormal } from '../mesh/mesh';
import { buildPrimitive } from '../primitives/primitives';
import { newMirror, newSubsurf } from '../modifiers/types';
import { History } from '../history/history';

function sampleProject() {
  const p = newProject('Test');
  const body = newObject('Body', new Mesh(buildPrimitive('cylinder', { vertices: 8 })), {
    location: [1, 2, 3],
    modifiers: [newMirror(), newSubsurf()],
  });
  const head = newObject('Head Ball', new Mesh(buildPrimitive('uvSphere', { segments: 8, rings: 4 })));
  p.objects.push(body, head);
  return p;
}

describe('OBJ export', () => {
  it('keeps quads, n-gons, triangles and object names', () => {
    const { obj, mtl } = exportObj(sampleProject());
    const objs = parseObj(obj);
    expect(objs.map((o) => o.name)).toEqual(['Body', 'Head Ball']);
    const arity = (fs: number[][]) => fs.map((f) => f.length).sort((a, b) => a - b);
    expect(arity(objs[0].faces)).toEqual(arity(buildPrimitive('cylinder', { vertices: 8 }).faces));
    expect(objs[0].faces.filter((f) => f.length === 8).length).toBe(2);
    expect(arity(objs[1].faces)).toEqual(arity(buildPrimitive('uvSphere', { segments: 8, rings: 4 }).faces));
    expect(objs[0].material).toBe('Material');
    expect(mtl).toMatch(/newmtl Material/);
    expect(mtl).toMatch(/Kd 0\.800000 0\.800000 0\.800000/);
  });

  it('bakes transforms and converts Z-up to Y-up the way Blender does', () => {
    const { obj } = exportObj(sampleProject());
    // Cylinder(8) vertex 0 is (0, 1, -1); moved by (1, 2, 3) it is (1, 3, 2) → OBJ (x, z, -y) = (1, 2, -3).
    expect(obj).toMatch(/^v 1\.000000 2\.000000 -3\.000000$/m);
    const back = parseObj(obj)[0].positions.slice(0, 3);
    expect(back).toEqual([1, 3, 2]);
  });

  it('exports the cage only by default, or with the mirror applied', () => {
    const p = newProject();
    const half = buildPrimitive('cube');
    for (let i = 0; i < half.positions.length; i += 3) half.positions[i] = half.positions[i] < 0 ? 0 : 1;
    half.faces = half.faces.filter((f) => !f.every((v) => half.positions[v * 3] === 0));
    p.objects.push(newObject('Half', new Mesh(half), { modifiers: [newMirror()] }));
    expect(parseObj(exportObj(p).obj)[0].faces.length).toBe(5);
    expect(parseObj(exportObj(p, { applyMirror: true }).obj)[0].faces.length).toBe(10);
  });

  it('flips winding for negatively scaled objects', () => {
    const p = newProject();
    p.objects.push(newObject('Neg', new Mesh(buildPrimitive('cube')), { scale: [-1, 1, 1] }));
    const o = parseObj(exportObj(p).obj)[0];
    for (const f of o.faces) {
      const c = faceCenter(o.positions, f);
      const n = faceNormal(o.positions, f);
      expect(n[0] * c[0] + n[1] * c[1] + n[2] * c[2]).toBeGreaterThan(0); // still outward
    }
  });
});

describe('project JSON', () => {
  it('round-trips topology, transforms and modifiers', () => {
    const p = sampleProject();
    const back = deserializeProject(JSON.parse(JSON.stringify(serializeProject(p))));
    expect(back.objects.length).toBe(2);
    expect(back.objects[0].mesh.faces).toEqual(p.objects[0].mesh.faces);
    expect(back.objects[0].location).toEqual([1, 2, 3]);
    expect(back.objects[0].modifiers).toEqual(p.objects[0].modifiers);
    expect(back.objects[0].materialSlots).toEqual(p.objects[0].materialSlots);
    const file = serializeProject(p);
    expect(file.objects[0].modifiers[0]).toMatchObject({ type: 'MIRROR', use_axis: [true, false, false], use_clip: true });
  });

  it('round-trips material slots, face materials and colors (v2)', () => {
    const p = sampleProject();
    const o = p.objects[0];
    p.materials.push({ id: 'm2', name: 'Skin', base_color: [0.9, 0.6, 0.5, 1], roughness: 0.6, metallic: 0 });
    o.materialSlots = [...o.materialSlots, 'm2'];
    o.mesh.setData({ ...o.mesh.snapshot(), faceMats: o.mesh.faces.map((_, i) => i % 2), colors: new Array(o.mesh.vertCount * 4).fill(0.25) });
    const back = deserializeProject(JSON.parse(JSON.stringify(serializeProject(p))));
    const b = back.objects[0];
    expect(b.materialSlots.map((id) => back.materials.find((m) => m.id === id)!.name)).toEqual(['Material', 'Skin']);
    expect(b.mesh.faceMats).toEqual(o.mesh.faceMats);
    expect(b.mesh.colors).toEqual(o.mesh.colors);
  });

  it('migrates version 1 files (one material per object)', () => {
    const v1 = {
      format: 'yotablender',
      version: 1,
      generator: 'YotaBlender 0.1',
      unit: 'm',
      up_axis: 'Z',
      project: { id: 'p1', name: 'Old', created: 0, modified: 0 },
      materials: [{ id: 'mat-default', name: 'Material', base_color: [0.8, 0.8, 0.8, 1], roughness: 0.5, metallic: 0 }],
      objects: [
        {
          id: 'o1',
          name: 'Cube',
          location: [0, 0, 0],
          rotation_mode: 'XYZ',
          rotation_euler: [0, 0, 0],
          scale: [1, 1, 1],
          visible: true,
          shade_smooth: false,
          material: 'Material',
          mesh: { vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], faces: [[0, 1, 2]], loose_edges: [] },
          modifiers: [],
        },
      ],
    };
    const p = deserializeProject(v1);
    expect(p.objects[0].materialSlots).toEqual(['mat-default']);
    expect(p.objects[0].mesh.faceMats).toBeUndefined();
    expect(p.objects[0].mesh.colors).toBeUndefined();
    expect(serializeProject(p).version).toBe(2);
  });

  it('rejects files from other apps and newer versions', () => {
    expect(() => deserializeProject({ hello: 1 })).toThrow(ProjectFileError);
    expect(() => deserializeProject({ format: 'yotablender', version: 99 })).toThrow(/newer version/);
  });
});

describe('history', () => {
  it('undoes and redoes, and drops redo on new commands', () => {
    const h = new History();
    let v = 0;
    const set = (to: number) => {
      const from = v;
      v = to;
      h.push({ label: 'set', bytes: 8, undo: () => (v = from), redo: () => (v = to) });
    };
    set(1);
    set(2);
    h.undo();
    expect(v).toBe(1);
    h.redo();
    expect(v).toBe(2);
    h.undo();
    set(5);
    expect(h.canRedo()).toBe(false);
    h.undo();
    expect(v).toBe(1);
  });

  it('respects the step limit', () => {
    const h = new History(3);
    for (let i = 0; i < 10; i++) h.push({ label: String(i), bytes: 1, undo() {}, redo() {} });
    expect(h.size).toBe(3);
  });
});
