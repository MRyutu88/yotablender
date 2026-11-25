import { describe, expect, it } from 'vitest';
import { buildPrimitive } from '../primitives/primitives';
import { assertValid } from './validate';
import { buildTopology } from './topology';
import { emptySelection } from './selection';
import { mirrorLookup, planSymmetry, symmetrize } from './symmetry';
import { loopCut } from './ops';
import type { MeshData } from './mesh';

const boundaryEdges = (m: MeshData) => {
  const t = buildTopology(m);
  let n = 0;
  for (let h = 0; h < t.nHe; h++) if (t.heFace[h] === -1) n++;
  return n;
};

/** True when every vertex has a mirror image across `axis`. */
function isSymmetric(m: MeshData, axis: 0 | 1 | 2): boolean {
  const find = mirrorLookup(m.positions);
  for (let v = 0; v < m.positions.length / 3; v++) if (find(v, 1 << axis) < 0) return false;
  return true;
}

const vertAt = (m: MeshData, x: number, y: number, z: number) => {
  for (let v = 0; v < m.positions.length / 3; v++) {
    const p = m.positions;
    if (Math.abs(p[v * 3] - x) < 1e-6 && Math.abs(p[v * 3 + 1] - y) < 1e-6 && Math.abs(p[v * 3 + 2] - z) < 1e-6) return v;
  }
  return -1;
};

describe('symmetrize', () => {
  it('cuts a cube at the plane and mirrors the + half into a closed mesh', () => {
    const cube = buildPrimitive('cube');
    const r = symmetrize(cube, 0, true);
    assertValid(r.data);
    expect(r.data.positions.length / 3).toBe(12);
    expect(r.data.faces.length).toBe(10);
    expect(boundaryEdges(r.data)).toBe(0);
    expect(isSymmetric(r.data, 0)).toBe(true);
  });

  it('copies the chosen side over the other', () => {
    const cube = buildPrimitive('cube');
    const v = vertAt(cube, 1, 1, 1);
    cube.positions[v * 3 + 1] = 1.5; // pull one + corner out
    const plus = symmetrize(cube, 0, true);
    expect(vertAt(plus.data, -1, 1.5, 1)).toBeGreaterThanOrEqual(0);
    expect(isSymmetric(plus.data, 0)).toBe(true);
    const minus = symmetrize(cube, 0, false);
    expect(vertAt(minus.data, 1, 1.5, 1)).toBe(-1);
    expect(vertAt(minus.data, 1, 1, 1)).toBeGreaterThanOrEqual(0);
    expect(isSymmetric(minus.data, 0)).toBe(true);
  });

  it('shares vertices on the plane instead of doubling them (Y and Z too)', () => {
    const cube = buildPrimitive('cube');
    const once = symmetrize(cube, 1, true).data;
    const twice = symmetrize(once, 1, false).data; // already symmetric: nothing changes in size
    expect(twice.positions.length).toBe(once.positions.length);
    expect(twice.faces.length).toBe(once.faces.length);
    const z = symmetrize(cube, 2, false).data;
    assertValid(z);
    expect(boundaryEdges(z)).toBe(0);
  });

  it('keeps materials, colors and UVs in step', () => {
    const cube = buildPrimitive('cube');
    cube.faceMats = cube.faces.map((_, i) => i % 2);
    cube.colors = new Array((cube.positions.length / 3) * 4).fill(0.5);
    cube.uvs = cube.faces.map((f) => f.flatMap((_, i) => [i / f.length, 0.5]));
    const r = symmetrize(cube, 0, true).data;
    expect(r.faceMats!.length).toBe(r.faces.length);
    expect(r.colors!.length).toBe((r.positions.length / 3) * 4);
    expect(r.uvs!.length).toBe(r.faces.length);
    r.faces.forEach((f, i) => expect(r.uvs![i].length).toBe(f.length * 2));
  });

  it('works on a mesh that already has a center loop', () => {
    const cube = buildPrimitive('cube');
    // An edge along X, so the cut ring goes around the X = 0 plane.
    let edge: [number, number] | null = null;
    for (const f of cube.faces)
      for (let i = 0; i < f.length && !edge; i++) {
        const a = f[i], b = f[(i + 1) % f.length];
        if (Math.abs(cube.positions[a * 3] - cube.positions[b * 3]) > 1) edge = [a, b];
      }
    const cut = loopCut(cube, edge![0], edge![1], 1, 0.5).data;
    const r = symmetrize(cut, 0, true, emptySelection()).data;
    assertValid(r);
    expect(r.positions.length).toBe(cut.positions.length);
    expect(boundaryEdges(r)).toBe(0);
  });
});

describe('live symmetry plan', () => {
  it('mirrors a selected corner onto its image', () => {
    const cube = buildPrimitive('cube');
    const v = vertAt(cube, 1, 1, 1), img = vertAt(cube, -1, 1, 1);
    const plan = planSymmetry(cube.positions, [v], [1], new Set([v]), [true, false, false]);
    expect(plan.drivers).toEqual([v]);
    expect(plan.mirrors).toEqual([{ v: img, driver: v, mask: 1 }]);
  });

  it('mirrors across several axes at once', () => {
    const cube = buildPrimitive('cube');
    const v = vertAt(cube, 1, 1, 1);
    const plan = planSymmetry(cube.positions, [v], [1], new Set([v]), [true, true, false]);
    expect(plan.mirrors.map((m) => m.mask).sort()).toEqual([1, 2, 3]);
  });

  it('leaves both sides alone when both are selected', () => {
    const cube = buildPrimitive('cube');
    const v = vertAt(cube, 1, 1, 1), img = vertAt(cube, -1, 1, 1);
    const plan = planSymmetry(cube.positions, [v, img], [1, 1], new Set([v, img]), [true, false, false]);
    expect(plan.drivers.sort()).toEqual([v, img].sort());
    expect(plan.mirrors).toEqual([]);
  });

  it('pins vertices on the plane and skips stacked duplicates', () => {
    const pos = [0, 1, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0];
    const plan = planSymmetry(pos, [0, 1], [1, 1], new Set([0, 1]), [true, false, false]);
    expect(plan.pin[plan.drivers.indexOf(0)]).toBe(1);
    expect(plan.mirrors).toEqual([]); // vertex 1 shares its spot with vertex 2: ambiguous
  });
});
