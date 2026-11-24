import { describe, expect, it } from 'vitest';
import { buildPrimitive, PRIMITIVE_DEFAULTS, type PrimitiveType } from './primitives';
import { assertValid } from '../mesh/validate';
import { allEdgeKeys, faceCenter, faceNormal } from '../mesh/mesh';

// Reference counts read from Blender 5.3.0's primitive operators with default settings.
const BLENDER_COUNTS: Partial<Record<PrimitiveType, [number, number, number]>> = {
  cube: [8, 12, 6],
  plane: [4, 4, 1],
  uvSphere: [482, 992, 512],
  cylinder: [64, 96, 34],
  cone: [33, 64, 33],
  torus: [576, 1152, 576],
};

describe('primitives', () => {
  for (const type of Object.keys(PRIMITIVE_DEFAULTS) as PrimitiveType[]) {
    it(`${type} is valid`, () => {
      const m = buildPrimitive(type);
      assertValid(m, type);
      const ref = BLENDER_COUNTS[type];
      if (ref) {
        expect([m.positions.length / 3, allEdgeKeys(m).length, m.faces.length]).toEqual(ref);
      }
    });
  }

  it('closed primitives face outward', () => {
    for (const type of ['cube', 'uvSphere', 'quadSphere', 'cylinder', 'cone'] as PrimitiveType[]) {
      const m = buildPrimitive(type);
      for (const f of m.faces) {
        const c = faceCenter(m.positions, f);
        const n = faceNormal(m.positions, f);
        expect(n[0] * c[0] + n[1] * c[1] + n[2] * c[2], type).toBeGreaterThan(0);
      }
    }
  });

  it('matches Blender vertex positions for small cases', () => {
    // From Blender: cylinder(vertices=8) v2 = (0.70711, 0.70711, -1); cone(8) tip v8 = (0,0,1);
    // uv sphere(8x4) v1 = (0, 0.70711, 0.70711); torus(6x4) v1 = (1, 0, 0.25).
    const near = (a: number[], b: number[]) => a.every((x, i) => Math.abs(x - b[i]) < 1e-4);
    const v = (m: { positions: number[] }, i: number) => m.positions.slice(i * 3, i * 3 + 3);
    expect(near(v(buildPrimitive('cylinder', { vertices: 8 }), 2), [0.70711, 0.70711, -1])).toBe(true);
    expect(near(v(buildPrimitive('cone', { vertices: 8 }), 8), [0, 0, 1])).toBe(true);
    expect(near(v(buildPrimitive('uvSphere', { segments: 8, rings: 4 }), 1), [0, 0.70711, 0.70711])).toBe(true);
    expect(near(v(buildPrimitive('torus', { majorSegments: 6, minorSegments: 4 }), 1), [1, 0, 0.25])).toBe(true);
  });

  it('matches Blender face loops for the cube', () => {
    expect(buildPrimitive('cube').faces).toEqual([
      [0, 1, 3, 2],
      [2, 3, 7, 6],
      [6, 7, 5, 4],
      [4, 5, 1, 0],
      [2, 6, 4, 0],
      [7, 3, 1, 5],
    ]);
  });

  it('quad sphere is all quads with no poles', () => {
    const m = buildPrimitive('quadSphere', { subdivisions: 3 });
    expect(m.faces.every((f) => f.length === 4)).toBe(true);
    expect(m.faces.length).toBe(6 * 9);
    expect(m.positions.length / 3).toBe(6 * 9 + 2);
    for (let i = 0; i < m.positions.length; i += 3) {
      expect(Math.hypot(m.positions[i], m.positions[i + 1], m.positions[i + 2])).toBeCloseTo(1, 6);
    }
  });
});
