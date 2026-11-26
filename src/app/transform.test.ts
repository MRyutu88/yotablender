import { describe, expect, it } from 'vitest';
import { buildPrimitive } from '../core/primitives/primitives';
import { Mesh } from '../core/mesh/mesh';
import { newObject } from '../core/scene/scene';
import { makeEditTarget, TransformSession } from './transform';
import type { OrbitCamera } from '../render/camera';

const fakeCam = { project: () => ({ x: 0, y: 0 }) } as unknown as OrbitCamera;
const snap = { enabled: false, move: 1, rotateDeg: 15, scale: 0.1 };
const vertAt = (m: Mesh, x: number, y: number, z: number) =>
  [...Array(m.vertCount).keys()].find((v) => [x, y, z].every((c, k) => Math.abs(m.positions[v * 3 + k] - c) < 1e-6))!;

describe('live symmetry in edit transforms', () => {
  it('moves the mirror image the mirrored way, and cancel restores both', () => {
    const obj = newObject('Cube', new Mesh(buildPrimitive('cube')));
    const m = obj.mesh;
    const v = vertAt(m, 1, 1, 1), img = vertAt(m, -1, 1, 1);
    const t = makeEditTarget(obj, [v], null, m.positions, [true, false, false]);
    const s = new TransformSession('move', fakeCam, { x: 0, y: 0 }, { kind: 'axis', axis: 0 }, { edit: t }, [1, 1, 1], snap);
    s.setValue(0.5);
    expect(m.getVert(v)).toEqual([1.5, 1, 1]);
    expect(m.getVert(img)).toEqual([-1.5, 1, 1]);
    s.cancel();
    expect(m.getVert(img)).toEqual([-1, 1, 1]);
  });

  it('keeps center vertices on the mirror plane', () => {
    const obj = newObject('P', new Mesh({ positions: [0, 1, 0, 1, 1, 0, 0, 0, 0], faces: [[0, 2, 1]], looseEdges: [] }));
    const t = makeEditTarget(obj, [0], null, obj.mesh.positions, [true, false, false]);
    const s = new TransformSession('move', fakeCam, { x: 0, y: 0 }, { kind: 'dir', dir: [0.6, 0.8, 0], label: 'd' }, { edit: t }, [0, 1, 0], snap);
    s.setValue(1);
    const p = obj.mesh.getVert(0);
    expect(p[0]).toBe(0);
    expect(p[1]).toBeCloseTo(1.8);
  });
});
