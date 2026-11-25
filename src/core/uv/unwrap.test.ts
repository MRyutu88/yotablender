import { describe, expect, it } from 'vitest';
import { unwrap, signedArea, trianglesOverlap } from './unwrap';
import { buildPrimitive, type PrimitiveType } from '../primitives/primitives';
import { sampleProject } from '../io/sample';
import { faceNormalRaw, type MeshData } from '../mesh/mesh';
import { assertValid } from '../mesh/validate';

type P = [number, number];
const polys = (m: MeshData, uvs: number[][]) => uvs.map((u, f) => m.faces[f].map((_, i) => [u[i * 2], u[i * 2 + 1]] as P));

function checkUnwrap(name: string, m: MeshData) {
  const r = unwrap(m);
  const ps = polys(m, r.uvs);
  // Every corner inside the unit square, every face CCW (not flipped) and not degenerate.
  for (const p of ps) {
    for (const [u, v] of p) {
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThanOrEqual(1);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  }
  ps.forEach((p, f) => {
    const a3 = Math.hypot(...faceNormalRaw(m.positions, m.faces[f]));
    if (a3 > 1e-9) expect(signedArea(p), `${name} face ${f} flipped`).toBeGreaterThan(0);
  });
  // No two faces overlap in UV space.
  const tris: { t: [P, P, P]; f: number }[] = [];
  ps.forEach((p, f) => {
    for (let i = 1; i < p.length - 1; i++) tris.push({ t: [p[0], p[i], p[i + 1]], f });
  });
  for (let i = 0; i < tris.length; i++)
    for (let j = i + 1; j < tris.length; j++) {
      if (tris[i].f === tris[j].f) continue;
      expect(trianglesOverlap(tris[i].t, tris[j].t), `${name}: faces ${tris[i].f} and ${tris[j].f} overlap`).toBe(false);
    }
  assertValid({ ...m, uvs: r.uvs });
  return r;
}

describe('unwrap', () => {
  it('gives a cube 6 islands of equal size (same texel density)', () => {
    const cube = buildPrimitive('cube');
    const r = checkUnwrap('cube', cube);
    expect(r.islands).toBe(6);
    const areas = polys(cube, r.uvs).map((p) => signedArea(p));
    for (const a of areas) expect(a).toBeCloseTo(areas[0], 6);
    expect(r.coverage).toBeGreaterThan(0.4);
  });

  const prims: PrimitiveType[] = ['plane', 'uvSphere', 'quadSphere', 'cylinder', 'cone', 'torus'];
  for (const p of prims) {
    it(`unwraps a ${p} without overlaps or flips`, () => {
      const r = checkUnwrap(p, buildPrimitive(p));
      expect(r.islands).toBeLessThan(60);
      expect(r.coverage).toBeGreaterThan(0.3);
    });
  }

  it('a plane is one island filling the square', () => {
    const r = checkUnwrap('plane', buildPrimitive('plane'));
    expect(r.islands).toBe(1);
    expect(r.coverage).toBeGreaterThan(0.95);
  });

  it('unwraps the sample character', () => {
    const body = sampleProject().objects[0].mesh;
    checkUnwrap('body', body);
  });

  it('keeps texel density uniform across islands', () => {
    const cyl = buildPrimitive('cylinder', { vertices: 8 } as never);
    const r = checkUnwrap('cyl', cyl);
    const ratio = polys(cyl, r.uvs).map((p, f) => signedArea(p) / (Math.hypot(...faceNormalRaw(cyl.positions, cyl.faces[f])) / 2));
    // Planar projection only shrinks faces (cos of their angle to the island normal ≥ cos 66°).
    const max = Math.max(...ratio);
    for (const x of ratio) expect(x / max).toBeGreaterThan(Math.cos((66 * Math.PI) / 180) - 1e-6);
  });
});
