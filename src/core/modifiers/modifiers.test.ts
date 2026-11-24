import { describe, expect, it } from 'vitest';
import { buildMirrorPlan, evaluateMirror, applyMirrorClip } from './mirror';
import { newMirror, newSubsurf } from './types';
import { StackEvaluator } from './stack';
import { Mesh, type MeshData } from '../mesh/mesh';
import { assertValid } from '../mesh/validate';
import { buildTopologyRaw } from '../mesh/topology';

/** Right half of a 2x1x1 box: x in [0, 1], the face on x = 0 removed (it's the mirror seam). */
function halfBox(): MeshData {
  const positions: number[] = [];
  for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) for (let z = 0; z < 2; z++) positions.push(x, y ? 1 : -1, z ? 1 : -1);
  const faces = [
    [2, 3, 7, 6],
    [6, 7, 5, 4],
    [4, 5, 1, 0],
    [2, 6, 4, 0],
    [7, 3, 1, 5],
  ];
  return { positions, faces, looseEdges: [] };
}

/** The same box, whole: x in [-1, 1] with a ring of vertices at x = 0. */
function fullBox(): MeshData {
  const positions: number[] = [];
  const id = (x: number, y: number, z: number) => x * 4 + y * 2 + z;
  for (let x = 0; x < 3; x++) for (let y = 0; y < 2; y++) for (let z = 0; z < 2; z++) positions.push(x - 1, y ? 1 : -1, z ? 1 : -1);
  const faces: number[][] = [
    [id(0, 0, 0), id(0, 0, 1), id(0, 1, 1), id(0, 1, 0)], // -X cap
    [id(2, 1, 0), id(2, 1, 1), id(2, 0, 1), id(2, 0, 0)], // +X cap
  ];
  for (let x = 0; x < 2; x++) {
    const a = x, b = x + 1;
    faces.push([id(a, 1, 0), id(a, 1, 1), id(b, 1, 1), id(b, 1, 0)]); // +Y
    faces.push([id(b, 0, 0), id(b, 0, 1), id(a, 0, 1), id(a, 0, 0)]); // -Y
    faces.push([id(a, 1, 0), id(b, 1, 0), id(b, 0, 0), id(a, 0, 0)]); // -Z
    faces.push([id(b, 1, 1), id(a, 1, 1), id(a, 0, 1), id(b, 0, 1)]); // +Z
  }
  return { positions, faces, looseEdges: [] };
}

function sameSet(a: ArrayLike<number>, b: ArrayLike<number>, tol = 1e-5): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 3) {
    let ok = false;
    for (let j = 0; j < b.length && !ok; j += 3) {
      ok = Math.abs(a[i] - b[j]) < tol && Math.abs(a[i + 1] - b[j + 1]) < tol && Math.abs(a[i + 2] - b[j + 2]) < tol;
    }
    if (!ok) return false;
  }
  return true;
}

describe('mirror', () => {
  it('stitches the seam into a closed mesh', () => {
    const h = halfBox();
    const plan = buildMirrorPlan(h.positions, 8, h.faces, [], newMirror());
    expect(plan.nOut).toBe(12);
    expect(plan.faces.length).toBe(10);
    const pos = new Float64Array(plan.nOut * 3);
    evaluateMirror(plan, h.positions, pos);
    assertValid({ positions: [...pos], faces: plan.faces, looseEdges: [] });
    const t = buildTopologyRaw(plan.nOut, plan.faces, []);
    for (let e = 0; e < t.nHe; e++) expect(t.heFace[e]).toBeGreaterThanOrEqual(0); // no open border left
  });

  it('without merge, keeps the halves separate', () => {
    const h = halfBox();
    const plan = buildMirrorPlan(h.positions, 8, h.faces, [], { ...newMirror(), use_mirror_merge: false });
    expect(plan.nOut).toBe(16);
  });

  it('mirrors on several axes in Blender order', () => {
    const h = halfBox();
    const plan = buildMirrorPlan(h.positions, 8, h.faces, [], { ...newMirror(), use_axis: [true, true, false] });
    expect(plan.nOut).toBe(24);
    expect(plan.faces.length).toBe(20);
  });

  it('Mirror → Subdivision equals subdividing the whole symmetric mesh', () => {
    const ev = new StackEvaluator();
    const half = ev.evaluate(new Mesh(halfBox()), [newMirror(), newSubsurf()]);
    const full = new StackEvaluator().evaluate(new Mesh(fullBox()), [newSubsurf()]);
    expect(half.nV).toBe(full.nV);
    expect(sameSet(half.positions, full.positions)).toBe(true);
  });

  it('clipping keeps seam vertices on the plane and stops crossing', () => {
    const start = [0, 0, 0, 0.5, 0, 0];
    const pos = [0.3, 0, 0, -0.2, 0, 0];
    applyMirrorClip(newMirror(), [0, 1], start, pos);
    expect(pos[0]).toBe(0);
    expect(pos[3]).toBe(0);
  });
});

describe('stack evaluator', () => {
  it('reuses plans while only positions change, rebuilds on topology change', () => {
    const mesh = new Mesh(halfBox());
    const ev = new StackEvaluator();
    const mods = [newMirror(), newSubsurf()];
    const a = ev.evaluate(mesh, mods);
    mesh.positions[3 * 4] = 1.5; // drag a vertex not on the seam
    mesh.touchPositions();
    const b = ev.evaluate(mesh, mods);
    expect(b.topoKey).toBe(a.topoKey);
    expect(b.buildMs).toBe(0);
    mesh.setData(halfBox());
    expect(ev.evaluate(mesh, mods).topoKey).not.toBe(a.topoKey);
  });

  it('rebuilds when a vertex leaves the mirror plane', () => {
    const mesh = new Mesh(halfBox());
    const ev = new StackEvaluator();
    const mods = [newMirror()];
    const a = ev.evaluate(mesh, mods);
    mesh.positions[0] = 0.2; // seam vertex moves off the plane
    expect(ev.evaluate(mesh, mods).nV).toBe(a.nV + 1);
  });

  it('uses the drag level while dragging', () => {
    const mesh = new Mesh(halfBox());
    const ev = new StackEvaluator();
    const sub = { ...newSubsurf(), levels: 3, drag_levels: 1 };
    expect(ev.evaluate(mesh, [sub], { dragging: true }).nV).toBeLessThan(ev.evaluate(mesh, [sub]).nV);
  });
});
