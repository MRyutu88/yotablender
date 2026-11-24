import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { extrude, deleteSelected, mergeAtCenter, mergeByDistance, OpError } from './index';
import { buildPrimitive, type PrimitiveType } from '../../primitives/primitives';
import { assertValid } from '../validate';
import { allEdgeKeys, edgeKey, type MeshData } from '../mesh';
import { emptySelection, selectionFromEdges, selectionFromFaces, selectionFromVerts, type SelectMode } from '../selection';
import { buildTopology } from '../topology';

const counts = (m: MeshData) => [m.positions.length / 3, allEdgeKeys(m).length, m.faces.length];
const boundaryEdges = (m: MeshData) => {
  const t = buildTopology(m);
  let n = 0;
  for (let h = 0; h < t.nHe; h++) if (t.heFace[h] === -1) n++;
  return n;
};

describe('extrude', () => {
  it('extrudes one cube face into a closed mesh', () => {
    const cube = buildPrimitive('cube');
    const top = cube.faces.findIndex((f) => f.every((v) => cube.positions[v * 3 + 2] > 0));
    const r = extrude(cube, selectionFromFaces(cube, [top]));
    assertValid(r.data);
    expect(counts(r.data)).toEqual([12, 20, 10]);
    expect(boundaryEdges(r.data)).toBe(0);
    expect(r.selection.verts.size).toBe(4);
    expect(r.selection.faces.size).toBe(1);
    expect(r.normal![2]).toBeCloseTo(1);
  });

  it('extrudes a plane into an open box (walls on open borders too)', () => {
    const plane = buildPrimitive('plane');
    const r = extrude(plane, selectionFromFaces(plane, [0]));
    assertValid(r.data);
    expect(counts(r.data)).toEqual([8, 12, 5]);
  });

  it('extrudes connected faces as one region', () => {
    const cube = buildPrimitive('cube');
    const r = extrude(cube, selectionFromFaces(cube, [0, 1])); // two adjacent sides
    assertValid(r.data);
    expect(r.data.faces.length).toBe(6 + 6);
    expect(r.data.positions.length / 3).toBe(14);
  });

  it('extruding every face of a closed mesh keeps it valid', () => {
    const cube = buildPrimitive('cube');
    const r = extrude(cube, selectionFromFaces(cube, [0, 1, 2, 3, 4, 5]));
    assertValid(r.data);
    expect(counts(r.data)).toEqual([8, 12, 6]);
  });

  it('extrudes a border edge into a quad', () => {
    const plane = buildPrimitive('plane');
    const r = extrude(plane, selectionFromEdges(plane, [edgeKey(0, 1)]));
    assertValid(r.data);
    expect(counts(r.data)).toEqual([6, 7, 2]);
    expect(r.selection.edges.size).toBe(1);
  });

  it('extrudes a wire chain into a strip with consistent winding', () => {
    const wire: MeshData = { positions: [0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0], faces: [], looseEdges: [[1, 0], [1, 2], [3, 2]] };
    const r = extrude(wire, selectionFromVerts(wire, [0, 1, 2, 3]));
    assertValid(r.data);
    expect(r.data.faces.length).toBe(3);
    expect(r.data.looseEdges.length).toBe(0);
  });

  it('refuses interior edges', () => {
    const cube = buildPrimitive('cube');
    expect(() => extrude(cube, selectionFromEdges(cube, [edgeKey(0, 1)]))).toThrow(OpError);
  });

  it('extrudes a lone vertex into a wire edge', () => {
    const plane = buildPrimitive('plane');
    const r = extrude(plane, selectionFromVerts(plane, [0]));
    assertValid(r.data);
    expect(r.data.looseEdges.length).toBe(1);
    expect(r.selection.verts.size).toBe(1);
  });
});

describe('delete', () => {
  it('deletes faces, edges and vertices like Blender', () => {
    const cube = buildPrimitive('cube');
    expect(counts(deleteSelected(cube, selectionFromFaces(cube, [0]), 'face').data)).toEqual([8, 12, 5]);
    expect(counts(deleteSelected(cube, selectionFromEdges(cube, [edgeKey(0, 1)]), 'edge').data)).toEqual([8, 11, 4]);
    expect(counts(deleteSelected(cube, selectionFromVerts(cube, [0]), 'vert').data)).toEqual([7, 9, 3]);
  });

  it('removes vertices left with nothing', () => {
    const plane = buildPrimitive('plane');
    expect(counts(deleteSelected(plane, selectionFromFaces(plane, [0]), 'face').data)).toEqual([0, 0, 0]);
  });
});

describe('merge', () => {
  it('merges a cube top into a point (pyramid)', () => {
    const cube = buildPrimitive('cube');
    const top = [1, 3, 5, 7];
    const r = mergeAtCenter(cube, selectionFromVerts(cube, top));
    assertValid(r.data);
    expect(counts(r.data)).toEqual([5, 8, 5]);
    expect(r.selection.verts.size).toBe(1);
  });

  it('merges coincident vertices by distance', () => {
    // Two quads side by side that don't share their middle edge.
    const m: MeshData = {
      positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 2, 0, 0, 2, 1, 0, 1, 1, 0],
      faces: [[0, 1, 2, 3], [4, 5, 6, 7]],
      looseEdges: [],
    };
    const all = selectionFromVerts(m, [0, 1, 2, 3, 4, 5, 6, 7]);
    const r = mergeByDistance(m, all, 0.001);
    assertValid(r.data);
    expect(r.removed).toBe(2);
    expect(counts(r.data)).toEqual([6, 7, 2]);
  });

  it('refuses merges that would make an edge with three faces', () => {
    // Merging the two opposite cube corners of a face pinches the mesh.
    const cube = buildPrimitive('cube');
    try {
      const r = mergeAtCenter(cube, selectionFromVerts(cube, [0, 7]));
      assertValid(r.data); // if it succeeds, it must be valid
    } catch (e) {
      expect(e).toBeInstanceOf(OpError);
    }
  });
});

describe('random op sequences never break topology', () => {
  const prims: PrimitiveType[] = ['cube', 'plane', 'uvSphere', 'quadSphere', 'cylinder', 'cone', 'torus'];
  it('extrude / delete / merge on random selections', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...prims),
        fc.array(
          fc.record({
            op: fc.constantFrom('extrude', 'delete', 'merge', 'mergeDist'),
            mode: fc.constantFrom<SelectMode>('vert', 'edge', 'face'),
            picks: fc.array(fc.nat(), { minLength: 1, maxLength: 6 }),
          }),
          { minLength: 1, maxLength: 6 },
        ),
        (prim, steps) => {
          let mesh: MeshData = buildPrimitive(prim, { segments: 8, rings: 4, vertices: 6, majorSegments: 6, minorSegments: 4, subdivisions: 2 } as never);
          for (const s of steps) {
            const nV = mesh.positions.length / 3;
            if (nV === 0) break;
            let sel = emptySelection();
            if (s.mode === 'vert') sel = selectionFromVerts(mesh, s.picks.map((p) => p % nV));
            else if (s.mode === 'edge') {
              const edges = allEdgeKeys(mesh);
              if (!edges.length) continue;
              sel = selectionFromEdges(mesh, s.picks.map((p) => edges[p % edges.length]));
            } else {
              if (!mesh.faces.length) continue;
              sel = selectionFromFaces(mesh, s.picks.map((p) => p % mesh.faces.length));
            }
            try {
              const r =
                s.op === 'extrude'
                  ? extrude(mesh, sel)
                  : s.op === 'delete'
                    ? deleteSelected(mesh, sel, s.mode)
                    : s.op === 'merge'
                      ? mergeAtCenter(mesh, sel)
                      : mergeByDistance(mesh, sel, 0.5);
              assertValid(r.data, `${prim} after ${s.op}`);
              mesh = r.data;
            } catch (e) {
              if (!(e instanceof OpError)) throw e;
            }
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
