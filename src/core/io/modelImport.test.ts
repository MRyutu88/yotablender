import { describe, expect, it } from 'vitest';
import { exportObj, parseMtl, parseObj } from './obj';
import { importObj, importStl, ImportError } from './modelImport';
import { cleanMesh, IMPORT_LIMITS, joinTriangles } from './importMesh';
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

// --- STL ------------------------------------------------------------------------------

/** A mesh as STL triangles (quads split along their first diagonal). */
function stlTriangles(positions: number[], faces: number[][]): number[][][] {
  const tris: number[][][] = [];
  const p = (v: number) => [positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]];
  for (const f of faces) for (let i = 1; i + 1 < f.length; i++) tris.push([p(f[0]), p(f[i]), p(f[i + 1])]);
  return tris;
}

function binaryStl(tris: number[][][]): Uint8Array {
  const b = new Uint8Array(84 + tris.length * 50);
  const dv = new DataView(b.buffer);
  dv.setUint32(80, tris.length, true);
  tris.forEach((t, i) =>
    t.forEach((v, k) => v.forEach((x, j) => dv.setFloat32(84 + i * 50 + 12 + k * 12 + j * 4, x, true))),
  );
  return b;
}

function asciiStl(name: string, tris: number[][][]): string {
  const facets = tris.map(
    (t) =>
      `  facet normal 0 0 0\n    outer loop\n${t.map((v) => `      vertex ${v.join(' ')}`).join('\n')}\n    endloop\n  endfacet`,
  );
  return `solid ${name}\n${facets.join('\n')}\nendsolid ${name}\n`;
}

describe('STL import', () => {
  const cube = buildPrimitive('cube');
  const cubeTris = stlTriangles(cube.positions, cube.faces);

  it('reads binary STL, welds it and joins the triangles back into 6 quads', () => {
    const r = importStl(newProject(), binaryStl(cubeTris), 'part.stl');
    expect(r.objects).toHaveLength(1);
    const o = r.objects[0];
    expect(o.name).toBe('part');
    expect(o.mesh.vertCount).toBe(8);
    expect(o.mesh.faces.map((f) => f.length)).toEqual([4, 4, 4, 4, 4, 4]);
    expect(validateMesh(o.mesh).ok).toBe(true);
    expect(r.report.welded).toBe(36 - 8);
    expect(r.warnings).toContain('6 triangle pairs joined into quads');
  });

  it('keeps triangles when joining is off, and keeps outward winding', () => {
    const o = importStl(newProject(), binaryStl(cubeTris), 'x.stl', { joinTris: false }).objects[0];
    expect(o.mesh.faces).toHaveLength(12);
    // Every face normal points away from the cube's center.
    for (const f of o.mesh.faces) {
      const [a, b, c] = f.map((v) => o.mesh.getVert(v));
      const n = [
        (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
        (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
        (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
      ];
      const ctr = [0, 1, 2].map((k) => (a[k] + b[k] + c[k]) / 3);
      expect(n[0] * ctr[0] + n[1] * ctr[1] + n[2] * ctr[2]).toBeGreaterThan(0);
    }
  });

  it('reads ASCII STL with several solids (also ones starting with "solid" that are binary)', () => {
    const txt =
      asciiStl('Left', cubeTris) +
      asciiStl(
        'Right',
        cubeTris.map((t) => t.map(([x, y, z]) => [x + 5, y, z])),
      );
    const r = importStl(newProject(), new TextEncoder().encode(txt), 'pair.stl');
    expect(r.objects.map((o) => o.name)).toEqual(['Left', 'Right']);
    expect(r.objects.every((o) => o.mesh.faces.length === 6)).toBe(true);
    // A binary file whose 80-byte header says "solid": the size check wins.
    const bin = binaryStl(cubeTris);
    bin.set(new TextEncoder().encode('solid fake header'), 0);
    expect(importStl(newProject(), bin).objects[0].mesh.faces).toHaveLength(6);
  });

  it('only joins triangles that make a flat, convex quad', () => {
    // A sphere's triangles are not coplanar enough to all join; whatever joins must still be valid.
    const s = buildPrimitive('uvSphere', { segments: 16, rings: 8 });
    const o = importStl(newProject(), binaryStl(stlTriangles(s.positions, s.faces)), 's.stl').objects[0];
    expect(validateMesh(o.mesh).ok).toBe(true);
    // Every quad comes back (and some near-flat pole triangles pair up too).
    expect(o.mesh.faces.length).toBeLessThanOrEqual(s.faces.length);
    expect(o.mesh.faces.filter((f) => f.length === 4).length).toBeGreaterThanOrEqual(
      s.faces.filter((f) => f.length === 4).length,
    );
    // Two triangles folded at 90° stay triangles.
    const fold = binaryStl([
      [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
      ],
      [
        [1, 0, 0],
        [0, 0, 0],
        [0, 0, -1],
      ],
    ]);
    expect(importStl(newProject(), fold).objects[0].mesh.faces).toHaveLength(2);
  });

  it('keeps UVs when joining, and not across UV seams', () => {
    const data = {
      positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
      faces: [
        [0, 1, 2],
        [0, 2, 3],
      ],
      looseEdges: [] as [number, number][],
    };
    const ok = joinTriangles(
      {
        ...data,
        uvs: [
          [0, 0, 1, 0, 1, 1],
          [0, 0, 1, 1, 0, 1],
        ],
      },
      [0, 1],
    );
    expect(ok.joined).toBe(1);
    expect(ok.data.faces).toEqual([[0, 1, 2, 3]]);
    expect(ok.data.uvs).toEqual([[0, 0, 1, 0, 1, 1, 0, 1]]);
    const seam = joinTriangles(
      {
        ...data,
        uvs: [
          [0, 0, 1, 0, 1, 1],
          [0.5, 0, 1, 1, 0, 1],
        ],
      },
      [0, 1],
    );
    expect(seam.joined).toBe(0);
    expect(joinTriangles(data, [0, 1], (f) => (f === 0 ? 'A' : 'B')).joined).toBe(0);
  });

  it('enforces the limits after joining, and refuses non-STL data', () => {
    const n = Math.ceil(Math.sqrt(IMPORT_LIMITS.maxFaces)) + 1; // > maxFaces quads = 2× triangles
    const tris: number[][][] = [];
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        tris.push(
          [
            [x, y, 0],
            [x + 1, y, 0],
            [x + 1, y + 1, 0],
          ],
          [
            [x, y, 0],
            [x + 1, y + 1, 0],
            [x, y + 1, 0],
          ],
        );
      }
    expect(() => importStl(newProject(), binaryStl(tris))).toThrow(/Decimate/);
    expect(() => importStl(newProject(), new TextEncoder().encode('hello'))).toThrow(ImportError);
  });
});
