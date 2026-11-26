import { describe, expect, it } from 'vitest';
import { exportObj, parseMtl, parseObj } from './obj';
import { importObj, ImportError } from './objImport';
import { cleanMesh, IMPORT_LIMITS } from './importMesh';
import { newObject, newProject } from '../scene/scene';
import { Mesh } from '../mesh/mesh';
import { validateMesh } from '../mesh/validate';
import { buildPrimitive } from '../primitives/primitives';
import { sampleProject } from './sample';

const cubeObj = `# cube
mtllib cube.mtl
o Box
v -1 -1 1
v 1 -1 1
v 1 1 1
v -1 1 1
v -1 -1 -1
v 1 -1 -1
v 1 1 -1
v -1 1 -1
usemtl Red
f 1 2 3 4
f 6 5 8 7
usemtl Blue
f 5 1 4 8
f 2 6 7 3
f 4 3 7 8
f 5 6 2 1
`;
const cubeMtl = `newmtl Red
Kd 1 0 0
Pr 0.2
newmtl Blue
Kd 0 0 1
Ns 250
d 0.5
`;

describe('OBJ import', () => {
  it('imports a cube with materials from the MTL', () => {
    const p = newProject();
    const r = importObj(p, cubeObj, [cubeMtl]);
    expect(r.objects).toHaveLength(1);
    const o = r.objects[0];
    expect(o.name).toBe('Box');
    expect(o.mesh.faces).toHaveLength(6);
    expect(o.mesh.vertCount).toBe(8);
    expect(validateMesh(o.mesh).ok).toBe(true);
    expect(r.materials.map((m) => m.name)).toEqual(['Red', 'Blue']);
    expect(r.materials[0].roughness).toBeCloseTo(0.2);
    expect(r.materials[1].base_color).toEqual([0, 0, 1, 0.5]);
    expect(r.materials[1].roughness).toBeCloseTo(0.5);
    expect(o.materialSlots).toEqual(r.materials.map((m) => m.id));
    expect(o.mesh.faceMats).toEqual([0, 0, 1, 1, 1, 1]);
    expect(r.warnings).toEqual([]);
  });

  it('round-trips our own export (sample scene) with UVs, colors and materials', () => {
    const src = sampleProject();
    const { obj, mtl } = exportObj(src);
    const r = importObj(newProject(), obj, [mtl]);
    const visible = src.objects.filter((o) => o.visible);
    expect(r.objects.map((o) => o.name)).toEqual(visible.map((o) => o.name));
    r.objects.forEach((o, i) => {
      expect(validateMesh(o.mesh).ok).toBe(true);
      expect(o.mesh.faces.map((f) => f.length)).toEqual(visible[i].mesh.faces.map((f) => f.length));
      expect(!!o.mesh.colors).toBe(!!visible[i].mesh.colors);
      expect(!!o.mesh.uvs).toBe(!!visible[i].mesh.uvs);
      expect(o.shade_smooth).toBe(visible[i].shade_smooth);
    });
    expect(r.report.nonManifold + r.report.degenerate + r.report.duplicate).toBe(0);
  });

  it('reuses identical materials already in the project', () => {
    const p = newProject();
    const first = importObj(p, cubeObj, [cubeMtl]);
    p.materials.push(...first.materials);
    const again = importObj(p, cubeObj, [cubeMtl]);
    expect(again.materials).toEqual([]);
    expect(again.objects[0].materialSlots).toEqual(first.objects[0].materialSlots);
  });

  it('splits on g when there are no o lines and skips empty groups', () => {
    const txt = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nv 0 0 1\ng empty\ng A\nf 1 2 3\ng B\nf 1 2 4\n';
    expect(parseObj(txt).map((o) => o.name)).toEqual(['A', 'B']);
    expect(parseObj('o X\n' + txt).map((o) => o.name)).toEqual(['X']);
  });

  it('welds split vertices and fixes flipped faces', () => {
    // Two quads sharing an edge, but with their own copies of the shared vertices and the
    // second one wound the wrong way.
    const txt =
      'v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nv 1 0 0\nv 2 0 0\nv 2 1 0\nv 1 1 0\nf 1 2 3 4\nf 5 8 7 6\n';
    const r = importObj(newProject(), txt);
    const m = r.objects[0].mesh;
    expect(m.vertCount).toBe(6);
    expect(r.report.welded).toBe(2);
    expect(r.report.flipped).toBe(1);
    expect(validateMesh(m).ok).toBe(true);
  });

  it('removes degenerate, duplicate and non-manifold faces instead of failing', () => {
    const res = cleanMesh({
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 2, 0, 0],
      faces: [
        [0, 1, 2],
        [1, 0, 3],
        [0, 1, 4], // third face on edge 0-1
        [2, 1, 0], // duplicate of the first
        [0, 0, 1], // repeated corner
        [0, 1, 5], // zero area
        [0, 1, 9], // missing vertex
      ],
    });
    expect(res.data.faces).toHaveLength(2);
    expect(res.report).toMatchObject({ nonManifold: 1, duplicate: 1, degenerate: 3 });
    expect(validateMesh(res.data).ok).toBe(true);
  });

  it('keeps UVs in step when it flips faces or drops corners', () => {
    const res = cleanMesh({
      positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 2, 0, 0, 2, 1, 0],
      faces: [
        [0, 1, 2, 3],
        [1, 2, 5, 4, 4],
      ],
      uvs: [
        [0, 0, 1, 0, 1, 1, 0, 1],
        [0.1, 0.1, 0.2, 0.2, 0.3, 0.3, 0.4, 0.4, 0.4, 0.4],
      ],
    });
    expect(res.data.uvs).toEqual([
      [0, 0, 1, 0, 1, 1, 0, 1],
      [0.4, 0.4, 0.3, 0.3, 0.2, 0.2, 0.1, 0.1],
    ]);
    expect(validateMesh(res.data).ok).toBe(true);
  });

  it('handles negative indices, v//vn faces, missing vertices and mixed UVs', () => {
    const txt =
      'v 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 0 1\nvn 0 0 1\nf -3//1 -2//1 -1//1\nf 1 2 7\nv 1 1 0\nf 2/2 4/3 3/1\n';
    const [o] = parseObj(txt);
    expect(o.faces).toEqual([
      [0, 1, 2],
      [1, 3, 2],
    ]);
    expect(o.uvs).toEqual([
      [0, 0, 0, 0, 0, 0],
      [1, 0, 0, 1, 0, 0],
    ]);
  });

  it('enforces the limits', () => {
    const p = newProject();
    expect(() => importObj(p, '# nothing\n')).toThrow(ImportError);
    const many = Array.from(
      { length: IMPORT_LIMITS.maxObjects + 1 },
      (_, i) => `o O${i}\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf -3 -2 -1`,
    ).join('\n');
    expect(() => importObj(p, many)).toThrow(/limit is 32/);
    const lines = ['o Big'];
    const n = Math.ceil(Math.sqrt(IMPORT_LIMITS.maxFaces)) + 1;
    for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) lines.push(`v ${x} 0 ${y}`);
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const a = y * (n + 1) + x + 1;
        lines.push(`f ${a} ${a + 1} ${a + n + 2} ${a + n + 1}`);
      }
    expect(() => importObj(p, lines.join('\n'))).toThrow(/Decimate/);
  });

  it('rescales huge models and keeps normal ones as they are', () => {
    const p = newProject();
    const big = cubeObj.replace(
      /^v (.*)$/gm,
      (_, s: string) =>
        'v ' +
        s
          .split(' ')
          .map((x) => Number(x) * 500)
          .join(' '),
    );
    const r = importObj(p, big, [cubeMtl]);
    expect(r.scale).toBeCloseTo(2 / 1000);
    expect(Math.max(...r.objects[0].mesh.positions)).toBeCloseTo(1);
    expect(importObj(p, cubeObj).scale).toBe(1);
  });

  it('names imported objects uniquely and points painted objects at their texture', () => {
    const p = newProject();
    p.objects.push(newObject('Box', new Mesh(buildPrimitive('cube'))));
    const txt = cubeObj.replace('usemtl Red', 'vt 0 0\nvt 1 0\nvt 1 1\nvt 0 1\nusemtl Red');
    const withUV = txt.replace(/^f (\d+) (\d+) (\d+) (\d+)$/gm, 'f $1/1 $2/2 $3/3 $4/4');
    const r = importObj(p, withUV, [cubeMtl.replace('Pr 0.2', 'Pr 0.2\nmap_Kd -s 1 1 1 my tex.png')]);
    expect(r.objects[0].name).toBe('Box.001');
    expect(r.textureFiles[r.objects[0].id]).toBe('my tex.png');
  });

  it('reads MTL options', () => {
    const [m] = parseMtl('newmtl A\nKd 0.5\nTr 0.25\nPm 1\nmap_Kd -bm 0.5 -o 0 0 0 tex.png\n');
    expect(m).toMatchObject({ color: [0.5, 0.5, 0.5], alpha: 0.75, metallic: 1, map: 'tex.png' });
  });
});
