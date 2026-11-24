import { describe, expect, it } from 'vitest';
import { validateMesh } from './validate';
import { buildPrimitive } from '../primitives/primitives';
import { buildTopology } from './topology';
import type { Edge } from './mesh';

describe('validateMesh', () => {
  it('accepts open and closed meshes, n-gons and loose edges', () => {
    expect(validateMesh(buildPrimitive('cylinder')).ok).toBe(true);
    expect(validateMesh(buildPrimitive('plane')).ok).toBe(true);
    const wire = { positions: [0, 0, 0, 1, 0, 0, 2, 0, 0], faces: [], looseEdges: [[0, 1], [1, 2]] as Edge[] };
    expect(validateMesh(wire).errors).toEqual([]);
  });

  it('rejects flipped winding', () => {
    const m = buildPrimitive('cube');
    m.faces[0] = m.faces[0].slice().reverse();
    const r = validateMesh(m);
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/same direction/);
  });

  it('rejects an edge with three faces', () => {
    const m = {
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1],
      faces: [
        [0, 1, 2],
        [1, 0, 3],
        [0, 1, 4],
      ],
      looseEdges: [] as Edge[],
    };
    expect(validateMesh(m).ok).toBe(false);
  });

  it('rejects degenerate faces', () => {
    const m = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], faces: [[0, 1]], looseEdges: [] as Edge[] };
    expect(validateMesh(m).ok).toBe(false);
  });

  it('builds a consistent half-edge structure for a cube', () => {
    const t = buildTopology(buildPrimitive('cube'));
    expect(t.nE).toBe(12);
    expect(t.nHe).toBe(24); // closed: no boundary half-edges
    for (let h = 0; h < t.nHe; h++) expect(t.heFace[h]).toBeGreaterThanOrEqual(0);
  });

  it('adds boundary half-edges to open meshes', () => {
    const t = buildTopology(buildPrimitive('plane'));
    expect(t.nHe).toBe(8);
    let boundary = 0;
    for (let h = 0; h < t.nHe; h++) if (t.heFace[h] === -1) boundary++;
    expect(boundary).toBe(4);
  });
});
