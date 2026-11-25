import { describe, expect, it } from 'vitest';
import { subdivide } from './index';
import { buildPrimitive, type PrimitiveType } from '../../primitives/primitives';
import { assertValid } from '../validate';
import { allEdgeKeys, bounds, type MeshData } from '../mesh';

const counts = (m: MeshData) => [m.positions.length / 3, allEdgeKeys(m).length, m.faces.length];

describe('subdivide', () => {
  it('turns every cube face into a grid', () => {
    const r = subdivide(buildPrimitive('cube'), null, 1);
    assertValid(r.data);
    // Like Blender: 26 verts, 48 edges, 24 faces.
    expect(counts(r.data)).toEqual([26, 48, 24]);
    expect(r.selection.faces.size).toBe(24);
    expect(bounds(r.data.positions)).toEqual(bounds(buildPrimitive('cube').positions));
  });

  it('handles several cuts', () => {
    const r = subdivide(buildPrimitive('cube'), null, 3);
    assertValid(r.data);
    expect(r.data.faces.length).toBe(6 * 16);
    expect(r.data.positions.length / 3).toBe(6 * 16 + 2);
  });

  it('slices a cube horizontally along Z', () => {
    const cube = buildPrimitive('cube');
    const r = subdivide(cube, null, 2, 2);
    assertValid(r.data);
    // 4 vertical edges × 2 cuts; sides become 3 strips each; caps stay but gain no vertices.
    expect(counts(r.data)).toEqual([16, 28, 14]);
    expect(r.data.faces.filter((f) => f.length === 4).length).toBe(14);
  });

  it('only subdivides the chosen faces and keeps neighbours watertight', () => {
    const cube = buildPrimitive('cube');
    const r = subdivide(cube, [0], 1);
    assertValid(r.data);
    expect(r.data.faces.length).toBe(4 + 5);
    expect(r.selection.faces.size).toBe(4);
  });

  it('keeps every primitive valid, with UVs and colors', () => {
    const types: PrimitiveType[] = ['cube', 'plane', 'uvSphere', 'quadSphere', 'cylinder', 'cone', 'torus'];
    for (const t of types) {
      const m = buildPrimitive(t);
      m.colors = new Array((m.positions.length / 3) * 4).fill(0.5);
      m.uvs = m.faces.map((f) => f.flatMap((_, i) => [i % 2, i < 2 ? 0 : 1]));
      for (const axis of [-1, 0, 1, 2] as const) {
        let r;
        try {
          r = subdivide(m, null, 2, axis);
        } catch (e) {
          if (axis >= 0) continue; // e.g. a plane has no Z edges
          throw e;
        }
        assertValid(r.data, `${t} axis ${axis}`);
        expect(r.data.colors!.length).toBe((r.data.positions.length / 3) * 4);
        expect(r.data.uvs!.length).toBe(r.data.faces.length);
        r.data.faces.forEach((f, i) => expect(r.data.uvs![i].length).toBe(f.length * 2));
      }
    }
  });
});
