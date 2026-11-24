import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { edgeLoop, edgeRing, inset, loopCut, selectLinked, OpError } from './index';
import { buildPrimitive, type PrimitiveType } from '../../primitives/primitives';
import { assertValid } from '../validate';
import { allEdgeKeys, edgeFromKey, faceCenter, faceNormal, type MeshData } from '../mesh';
import { selectionFromFaces, selectionFromVerts } from '../selection';

const counts = (m: MeshData) => [m.positions.length / 3, allEdgeKeys(m).length, m.faces.length];

describe('select linked / loop / ring', () => {
  it('selects only the connected piece', () => {
    const a = buildPrimitive('cube');
    const b = buildPrimitive('cube');
    const two: MeshData = {
      positions: [...a.positions, ...b.positions.map((v, i) => (i % 3 === 0 ? v + 5 : v))],
      faces: [...a.faces, ...b.faces.map((f) => f.map((v) => v + 8))],
      looseEdges: [],
    };
    const s = selectLinked(two, selectionFromVerts(two, [0]), 'vert');
    expect([...s.verts].sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(s.faces.size).toBe(6);
  });

  it('walks edge loops around a torus both ways', () => {
    const t = buildPrimitive('torus', { majorSegments: 12, minorSegments: 6 });
    // Edge along the minor circle (vertex 0 → 1) loops around the tube: 6 edges.
    expect(edgeLoop(t, 0, 1).length).toBe(6);
    // Edge along the major circle (vertex 0 → 6) loops around the hole: 12 edges.
    expect(edgeLoop(t, 0, 6).length).toBe(12);
  });

  it('stops at poles and follows open borders', () => {
    const plane = buildPrimitive('plane');
    expect(edgeLoop(plane, 0, 1).length).toBe(4); // border loop
    const sphere = buildPrimitive('uvSphere', { segments: 8, rings: 4 });
    // A meridian edge stops at the triangle-fan poles.
    const loop = edgeLoop(sphere, 1, 2);
    expect(loop.length).toBeGreaterThan(1);
    expect(loop.length).toBeLessThan(sphere.faces.length);
  });

  it('finds closed rings', () => {
    const t = buildPrimitive('torus', { majorSegments: 12, minorSegments: 6 });
    const r = edgeRing(t, 0, 1);
    expect(r.closed).toBe(true);
    expect(r.steps.length).toBe(12);
  });
});

describe('loop cut', () => {
  it('cuts around a cube', () => {
    const cube = buildPrimitive('cube');
    const r = loopCut(cube, 0, 1); // edge along Z on the -X,-Y corner
    assertValid(r.data);
    expect(counts(r.data)).toEqual([12, 20, 10]);
    expect(r.selection.verts.size).toBe(4);
    expect(r.selection.edges.size).toBe(4);
  });

  it('makes several cuts evenly and slides a single cut', () => {
    const cube = buildPrimitive('cube');
    const r = loopCut(cube, 0, 1, 3);
    assertValid(r.data);
    expect(counts(r.data)).toEqual([8 + 12, 12 + 12 + 12, 6 + 12]);
    const slid = loopCut(cube, 0, 1, 1, 0.2);
    const zs = [...slid.selection.verts].map((v) => slid.data.positions[v * 3 + 2]);
    // Vertex 0 is at z = -1, so 20% of the way from it is z = -0.6 on every cut edge.
    for (const z of zs) expect(z).toBeCloseTo(-0.6);
  });

  it('splices cut points into n-gon caps (no cracks)', () => {
    const cyl = buildPrimitive('cylinder', { vertices: 8 });
    // Bottom cap edge 0 → 2 belongs to one side quad: the ring is that single quad.
    const r = loopCut(cyl, 0, 2);
    assertValid(r.data);
    const caps = r.data.faces.filter((f) => f.length > 4);
    expect(caps.map((f) => f.length).sort()).toEqual([9, 9]);
  });

  it('runs all the way around a cylinder', () => {
    const cyl = buildPrimitive('cylinder', { vertices: 8 });
    const r = loopCut(cyl, 0, 1); // vertical side edge: ring around the 8 sides
    assertValid(r.data);
    expect(counts(r.data)).toEqual([24, 24 + 16, 18]);
  });

  it('refuses a ring that does not exist', () => {
    const cone = buildPrimitive('cone', { vertices: 6 });
    expect(() => loopCut(cone, 0, 6)).toThrow(OpError); // side triangles only
  });
});

describe('inset', () => {
  it('insets one face inside its plane', () => {
    const cube = buildPrimitive('cube');
    const top = cube.faces.findIndex((f) => f.every((v) => cube.positions[v * 3 + 2] > 0));
    const r = inset(cube, selectionFromFaces(cube, [top]), 0.25);
    assertValid(r.data);
    expect(counts(r.data)).toEqual([12, 20, 10]);
    for (const v of r.selection.verts) {
      expect(r.data.positions[v * 3 + 2]).toBeCloseTo(1); // still on the top plane
      expect(Math.abs(r.data.positions[v * 3])).toBeCloseTo(0.75);
      expect(Math.abs(r.data.positions[v * 3 + 1])).toBeCloseTo(0.75);
    }
  });

  it('insets a region as one piece, with depth', () => {
    const cube = buildPrimitive('cube');
    const r = inset(cube, selectionFromFaces(cube, [0, 1]), 0.2, 0.3);
    assertValid(r.data);
    expect(r.data.faces.length).toBe(6 + 6);
    // The inset faces still face outward.
    for (const f of r.selection.faces) {
      const face = r.data.faces[f];
      const c = faceCenter(r.data.positions, face), n = faceNormal(r.data.positions, face);
      expect(n[0] * c[0] + n[1] * c[1] + n[2] * c[2]).toBeGreaterThan(0);
    }
  });
});

describe('random sequences with the new tools stay valid', () => {
  const prims: PrimitiveType[] = ['cube', 'plane', 'quadSphere', 'cylinder', 'torus', 'uvSphere'];
  it('loop cut / inset / select linked', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...prims),
        fc.array(fc.record({ op: fc.constantFrom('loop', 'inset'), pick: fc.nat(), n: fc.integer({ min: 1, max: 3 }) }), {
          minLength: 1,
          maxLength: 5,
        }),
        (prim, steps) => {
          let mesh: MeshData = buildPrimitive(prim, { segments: 8, rings: 4, vertices: 6, majorSegments: 6, minorSegments: 4, subdivisions: 2 } as never);
          for (const s of steps) {
            try {
              if (s.op === 'loop') {
                const edges = allEdgeKeys(mesh);
                const [a, b] = edgeFromKey(edges[s.pick % edges.length]);
                mesh = loopCut(mesh, a, b, s.n).data;
              } else {
                const faces = Array.from({ length: s.n }, (_, i) => (s.pick + i * 7) % mesh.faces.length);
                mesh = inset(mesh, selectionFromFaces(mesh, faces), 0.05).data;
              }
              assertValid(mesh, `${prim} after ${s.op}`);
            } catch (e) {
              if (!(e instanceof OpError)) throw e;
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
