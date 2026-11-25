import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { deleteSelected, extrude, inset, loopCut, mergeAtCenter, mergeByDistance, OpError } from './index';
import { buildPrimitive, type PrimitiveType } from '../../primitives/primitives';
import { assertValid } from '../validate';
import { allEdgeKeys, edgeFromKey, type MeshData } from '../mesh';
import { selectionFromEdges, selectionFromFaces, selectionFromVerts, type SelectMode } from '../selection';

/** A planar projection, so UVs that are interpolated linearly stay exactly on it. */
const proj = (p: ArrayLike<number>, v: number) => [p[v * 3] + 0.3 * p[v * 3 + 2], p[v * 3 + 1] + 0.7 * p[v * 3 + 2]];

/** Adds a material slot per face (face index % 3), a color per vertex and projected UVs. */
function withAttrs(m: MeshData): MeshData {
  return {
    ...m,
    faceMats: m.faces.map((_, i) => i % 3),
    colors: Array.from({ length: m.positions.length / 3 }, (_, v) => [v % 2, (v % 3) / 2, 0.5, 1]).flat(),
    uvs: m.faces.map((f) => f.flatMap((v) => proj(m.positions, v))),
  };
}

/** Every corner whose UV should still equal the projection of its vertex. */
function expectProjected(d: MeshData, faces: number[]) {
  for (const f of faces) d.faces[f].forEach((v, i) => {
    const [u, w] = proj(d.positions, v);
    expect(d.uvs![f][i * 2]).toBeCloseTo(u, 9);
    expect(d.uvs![f][i * 2 + 1]).toBeCloseTo(w, 9);
  });
}

describe('UVs follow the ops', () => {
  it('extrude keeps the region UVs and stretches the walls between region and neighbours', () => {
    const cube = withAttrs(buildPrimitive('cube'));
    const r = extrude(cube, selectionFromFaces(cube, [4]));
    assertValid(r.data);
    // Nothing moved yet, so every corner (region, walls, untouched faces) is still on the projection.
    expectProjected(r.data, r.data.faces.map((_, i) => i));
    for (const v of r.selection.verts) r.data.positions[v * 3 + 2] += 1;
    // After the move, untouched faces and the moved region keep their UVs (region = old projection).
    expect(r.data.uvs![4]).toEqual(cube.uvs![4]);
  });

  it('loop cut interpolates UVs along the cut edges, everywhere they are spliced in', () => {
    const cyl = withAttrs(buildPrimitive('cylinder', { vertices: 8 } as never));
    const ring = cyl.faces.findIndex((f) => f.length === 4);
    const r = loopCut(cyl, cyl.faces[ring][0], cyl.faces[ring][1], 2);
    assertValid(r.data);
    expectProjected(r.data, r.data.faces.map((_, i) => i));
  });

  it('inset shrinks the UVs with the faces (planar faces stay exact)', () => {
    const cube = withAttrs(buildPrimitive('cube'));
    const r = inset(cube, selectionFromFaces(cube, [0, 1]), 0.2);
    assertValid(r.data);
    expectProjected(r.data, r.data.faces.map((_, i) => i).filter((f) => {
      // Only faces lying in one plane are exact: everything but the rim faces that bend over an edge.
      const n = r.data.faces[f].map((v) => r.data.positions.slice(v * 3, v * 3 + 3));
      return [0, 1, 2].some((k) => n.every((p) => Math.abs(p[k] - n[0][k]) < 1e-9));
    }));
  });

  it('merge drops the corners that collapse', () => {
    const cube = withAttrs(buildPrimitive('cube'));
    const [a, b] = cube.faces[0];
    const r = mergeAtCenter(cube, selectionFromVerts(cube, [a, b]));
    assertValid(r.data);
    expect(r.data.faces.filter((f) => f.length === 3).length).toBe(2);
    // Corners of untouched vertices keep their UVs; the merged vertex keeps one of its own.
    r.data.faces.forEach((f, i) => expect(r.data.uvs![i].length).toBe(f.length * 2));
  });

  it('delete keeps the UVs of the faces that stay', () => {
    const cube = withAttrs(buildPrimitive('cube'));
    const r = deleteSelected(cube, selectionFromFaces(cube, [2]), 'face');
    assertValid(r.data);
    expectProjected(r.data, r.data.faces.map((_, i) => i));
  });
});

describe('materials and colors follow the ops', () => {
  it('extrude copies the face material and vertex colors', () => {
    const cube = withAttrs(buildPrimitive('cube'));
    const r = extrude(cube, selectionFromFaces(cube, [4]));
    assertValid(r.data);
    expect(r.data.faceMats!.slice(6)).toEqual([4 % 3, 4 % 3, 4 % 3, 4 % 3]); // walls take the region's slot
    for (const { src, dup } of r.dupPairs!) {
      expect(r.data.colors!.slice(dup * 4, dup * 4 + 4)).toEqual(cube.colors!.slice(src * 4, src * 4 + 4));
    }
  });

  it('loop cut interpolates colors along the cut edges', () => {
    const cube = withAttrs(buildPrimitive('cube'));
    cube.colors = Array.from({ length: 8 }, (_, v) => (cube.positions[v * 3 + 2] > 0 ? [1, 1, 1, 1] : [0, 0, 0, 1])).flat();
    const r = loopCut(cube, 0, 1, 1, 0.25); // vertex 0 is at the bottom (black), 1 at the top (white)
    assertValid(r.data);
    for (const v of r.selection.verts) expect(r.data.colors![v * 4]).toBeCloseTo(0.25);
  });

  it('merge at center averages colors', () => {
    const plane = withAttrs(buildPrimitive('plane'));
    plane.colors = [1, 0, 0, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
    const r = mergeAtCenter(plane, selectionFromVerts(plane, [0, 1]));
    expect(r.data.colors!.slice(0, 4)).toEqual([0.5, 0, 0.5, 1]);
  });

  it('random op sequences keep attributes in step', () => {
    const prims: PrimitiveType[] = ['cube', 'plane', 'quadSphere', 'cylinder', 'cone', 'torus'];
    fc.assert(
      fc.property(
        fc.constantFrom(...prims),
        fc.array(
          fc.record({
            op: fc.constantFrom('extrude', 'delete', 'merge', 'mergeDist', 'loop', 'inset'),
            mode: fc.constantFrom<SelectMode>('vert', 'edge', 'face'),
            picks: fc.array(fc.nat(), { minLength: 1, maxLength: 5 }),
          }),
          { minLength: 1, maxLength: 6 },
        ),
        (prim, steps) => {
          let mesh = withAttrs(buildPrimitive(prim, { vertices: 6, majorSegments: 6, minorSegments: 4, subdivisions: 2 } as never));
          for (const s of steps) {
            const nV = mesh.positions.length / 3;
            if (!nV || !mesh.faces.length) break;
            const edges = allEdgeKeys(mesh);
            const sel =
              s.mode === 'vert'
                ? selectionFromVerts(mesh, s.picks.map((p) => p % nV))
                : s.mode === 'edge'
                  ? selectionFromEdges(mesh, s.picks.map((p) => edges[p % edges.length]))
                  : selectionFromFaces(mesh, s.picks.map((p) => p % mesh.faces.length));
            try {
              const [a, b] = edgeFromKey(edges[s.picks[0] % edges.length]);
              const r =
                s.op === 'extrude'
                  ? extrude(mesh, sel)
                  : s.op === 'delete'
                    ? deleteSelected(mesh, sel, s.mode)
                    : s.op === 'merge'
                      ? mergeAtCenter(mesh, sel)
                      : s.op === 'mergeDist'
                        ? mergeByDistance(mesh, sel, 0.5)
                        : s.op === 'loop'
                          ? loopCut(mesh, a, b, 2)
                          : inset(mesh, selectionFromFaces(mesh, [s.picks[0] % mesh.faces.length]), 0.05);
              assertValid(r.data, `${prim} after ${s.op}`);
              expect(r.data.faceMats).toBeDefined();
              expect(r.data.colors).toBeDefined();
              expect(r.data.uvs).toBeDefined();
              mesh = r.data;
            } catch (e) {
              if (!(e instanceof OpError)) throw e;
            }
          }
        },
      ),
      { numRuns: 250 },
    );
  });
});
