import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { deleteSelected, extrude, inset, loopCut, mergeAtCenter, mergeByDistance, OpError } from './index';
import { buildPrimitive, type PrimitiveType } from '../../primitives/primitives';
import { assertValid } from '../validate';
import { allEdgeKeys, edgeFromKey, type MeshData } from '../mesh';
import { selectionFromEdges, selectionFromFaces, selectionFromVerts, type SelectMode } from '../selection';

/** Adds a material slot per face (face index % 3) and a color per vertex (by position). */
function withAttrs(m: MeshData): MeshData {
  return {
    ...m,
    faceMats: m.faces.map((_, i) => i % 3),
    colors: Array.from({ length: m.positions.length / 3 }, (_, v) => [v % 2, (v % 3) / 2, 0.5, 1]).flat(),
  };
}

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
