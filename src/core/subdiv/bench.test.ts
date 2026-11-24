// Performance guard for the drag path and the plan rebuild (run with `npx vitest run bench`).
// Uses a ~2,000-quad half cage mirrored on X with Subdivision level 2, the target from the brief.
import { describe, expect, it } from 'vitest';
import { buildPrimitive } from '../primitives/primitives';
import { Mesh, type MeshData } from '../mesh/mesh';
import { StackEvaluator } from '../modifiers/stack';
import { newMirror, newSubsurf } from '../modifiers/types';
import { buildTopologyRaw } from '../mesh/topology';
import { buildSubdivPlan } from './catmullClark';

function halfQuadSphere(): MeshData {
  const m = buildPrimitive('quadSphere', { subdivisions: 26 });
  const pos = m.positions;
  for (let i = 0; i < pos.length; i += 3) if (Math.abs(pos[i]) < 1e-6) pos[i] = 0;
  const faces = m.faces.filter((f) => f.every((v) => pos[v * 3] >= -1e-9));
  const used = new Map<number, number>();
  const np: number[] = [];
  const nf = faces.map((f) =>
    f.map((v) => {
      if (!used.has(v)) {
        used.set(v, np.length / 3);
        np.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
      }
      return used.get(v)!;
    }),
  );
  return { positions: np, faces: nf, looseEdges: [] };
}

const time = (fn: () => void, n = 1) => {
  const t0 = performance.now();
  for (let i = 0; i < n; i++) fn();
  return (performance.now() - t0) / n;
};

describe('performance (2k-quad cage, Mirror X, Subdivision 2)', () => {
  it('rebuilds plans and evaluates within budget', () => {
    const data = halfQuadSphere();
    expect(data.faces.length).toBeGreaterThan(1900);
    const mesh = new Mesh(data);
    const mods = [newMirror(), newSubsurf()];
    const ev = new StackEvaluator();
    const build = time(() => {
      mesh.setData(halfQuadSphere());
      ev.evaluate(mesh, mods, { dragging: true });
    });
    const evalMs = time(() => {
      mesh.positions[3] += 0.0001;
      mesh.touchPositions();
      ev.evaluate(mesh, mods, { dragging: true });
    }, 30);
    // Breakdown of the rebuild.
    const mirrored = ev.evaluate(mesh, [newMirror()]);
    const topoMs = time(() => buildTopologyRaw(mirrored.nV, mirrored.faces, []));
    const planMs = time(() => buildSubdivPlan(mirrored.nV, mirrored.faces, [], { levels: 2, useLimitSurface: true }));
    console.log(JSON.stringify({ buildMs: build.toFixed(1), evalMs: evalMs.toFixed(2), topoL0Ms: topoMs.toFixed(1), planMs: planMs.toFixed(1) }));
    // Generous CI limits (desktop is ~3x faster than the phone).
    expect(evalMs).toBeLessThan(25);
    expect(build).toBeLessThan(1500);
  });
});
