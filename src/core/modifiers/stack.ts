// Evaluates an object's modifier stack (Mirror → Subdivision) for display.
//
// The expensive part (plans: mirrored topology, subdivision stencils) is cached and rebuilt
// only when the mesh topology, the modifier settings or the mirror merge set change. While a
// vertex is being dragged only the position passes run.

import type { Mesh } from '../mesh/mesh';
import type { Modifier, MirrorModifier, SubsurfModifier } from './types';
import { buildMirrorPlan, evaluateMirror, mirrorPlanStale, type MirrorPlan } from './mirror';
import { buildSubdivPlan, computeNormals, evaluateSubdiv, triangulate, type SubdivPlan } from '../subdiv/catmullClark';

export interface EvalResult {
  nV: number;
  positions: Float32Array;
  normals: Float32Array;
  tris: Uint32Array;
  /** Final polygons (for wireframe-style overlays). */
  faces: number[][];
  looseEdges: [number, number][];
  /** Changes whenever tris/faces change; lets the renderer reuse index buffers. */
  topoKey: number;
  /** Triangle ranges per material slot (tris are sorted by slot). */
  groups: { start: number; count: number; slot: number }[];
  /** Evaluated color attribute (RGB per vertex), when the mesh has one. */
  colors: Float32Array | null;
  /** Changes when `colors` change (so the renderer only re-uploads then). */
  colorKey: number;
  /** Milliseconds spent: plan rebuild (0 when cached) and per-frame evaluation. */
  buildMs: number;
  evalMs: number;
}

type Stage = { kind: 'mirror'; mod: MirrorModifier; plan: MirrorPlan } | { kind: 'subsurf'; plan: SubdivPlan };

interface Chain {
  key: string;
  stages: Stage[];
  buffers: Float64Array[];
  colorBuffers: Float64Array[];
  colorVersion: number;
  result: EvalResult;
}

let topoCounter = 1;
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class StackEvaluator {
  private chains = new Map<string, Chain>();

  /** Drops cached plans (e.g. when the object is deleted). */
  clear(): void {
    this.chains.clear();
  }

  evaluate(mesh: Mesh, modifiers: Modifier[], opts: { dragging?: boolean } = {}): EvalResult {
    const active = modifiers.filter((m) => m.show_viewport);
    const levelOf = (m: SubsurfModifier) =>
      Math.max(0, Math.min(3, opts.dragging ? Math.min(m.levels, m.drag_levels) : m.levels));
    const key =
      mesh.topoVersion +
      '|' +
      (mesh.colors ? 'C' : '') +
      '|' +
      active
        .map((m) =>
          m.type === 'MIRROR'
            ? `M${m.use_axis.map(Number).join('')}${m.use_mirror_merge ? 1 : 0}${m.merge_threshold}`
            : `S${levelOf(m)}${m.use_limit_surface ? 1 : 0}`,
        )
        .join(',');

    let chain = this.chains.get(key);
    // Mirror merge depends on positions: a vertex moved onto/off the plane invalidates the plan.
    if (chain && this.mirrorStale(chain, mesh)) chain = undefined;
    let buildMs = 0;
    if (!chain) {
      const t0 = now();
      chain = this.build(key, mesh, active, levelOf);
      buildMs = now() - t0;
      // Keep only a few chains per object (normal + drag level), newest first.
      this.chains.set(key, chain);
      if (this.chains.size > 3) this.chains.delete(this.chains.keys().next().value!);
    }
    const t1 = now();
    this.run(chain, mesh);
    chain.result.buildMs = buildMs;
    chain.result.evalMs = now() - t1;
    return chain.result;
  }

  private mirrorStale(chain: Chain, mesh: Mesh): boolean {
    const first = chain.stages[0];
    return !!first && first.kind === 'mirror' && mirrorPlanStale(first.plan, mesh.positions, first.mod);
  }

  private build(key: string, mesh: Mesh, active: Modifier[], levelOf: (m: SubsurfModifier) => number): Chain {
    let nV = mesh.vertCount, faces = mesh.faces, loose = mesh.looseEdges;
    // Which cage face every current face came from (for per-face materials).
    let faceSrc: Int32Array = Int32Array.from(faces, (_, i) => i);
    const stages: Stage[] = [];
    const buffers: Float64Array[] = [];
    let curPos: ArrayLike<number> = mesh.positions;
    for (const m of active) {
      if (m.type === 'MIRROR') {
        if (!m.use_axis.some(Boolean)) continue;
        // Merge decisions need the positions at this point of the stack.
        const plan = buildMirrorPlan(curPos, nV, faces, loose, m);
        stages.push({ kind: 'mirror', mod: m, plan });
        const buf = new Float64Array(plan.nOut * 3);
        evaluateMirror(plan, curPos, buf);
        buffers.push(buf);
        curPos = buf;
        nV = plan.nOut;
        faces = plan.faces;
        faceSrc = Int32Array.from(plan.faceSrc, (f) => faceSrc[f]);
        loose = plan.looseEdges;
      } else {
        const levels = levelOf(m);
        if (levels === 0) continue;
        const plan = buildSubdivPlan(nV, faces, loose, { levels, useLimitSurface: m.use_limit_surface });
        stages.push({ kind: 'subsurf', plan });
        const buf = new Float64Array(plan.nFinal * 3);
        buffers.push(buf);
        // Level 1 splits a k-gon into k quads, every later level splits each quad into 4, and
        // children are stored contiguously per parent face.
        const src: number[] = [];
        const per = 4 ** (levels - 1);
        faces.forEach((f, fi) => {
          for (let k = 0; k < f.length * per; k++) src.push(faceSrc[fi]);
        });
        faceSrc = Int32Array.from(src);
        nV = plan.nFinal;
        faces = plan.faces;
        loose = plan.looseEdges;
      }
    }
    // Triangles sorted by material slot, one draw group per slot.
    const slotOf = (f: number) => mesh.faceMats?.[faceSrc[f]] ?? 0;
    let tris = triangulate(faces);
    const groups: EvalResult['groups'] = [];
    const slots = new Set<number>(faces.map((_, f) => slotOf(f)));
    if (slots.size <= 1) {
      groups.push({ start: 0, count: tris.length, slot: [...slots][0] ?? 0 });
    } else {
      const triFace: number[] = [];
      faces.forEach((f, fi) => {
        for (let k = 0; k < f.length - 2; k++) triFace.push(fi);
      });
      const order = triFace.map((_, t) => t).sort((a, b) => slotOf(triFace[a]) - slotOf(triFace[b]));
      const sorted = new Uint32Array(tris.length);
      order.forEach((t, i) => sorted.set(tris.subarray(t * 3, t * 3 + 3), i * 3));
      tris = sorted;
      let start = 0;
      for (let i = 1; i <= order.length; i++) {
        if (i === order.length || slotOf(triFace[order[i]]) !== slotOf(triFace[order[start]])) {
          groups.push({ start: start * 3, count: (i - start) * 3, slot: slotOf(triFace[order[start]]) });
          start = i;
        }
      }
    }
    return {
      key,
      stages,
      buffers,
      colorBuffers: stages.map((s) => new Float64Array(s.kind === 'mirror' ? s.plan.nOut * 3 : s.plan.nFinal * 3)),
      colorVersion: -1,
      result: {
        nV,
        positions: new Float32Array(nV * 3),
        normals: new Float32Array(nV * 3),
        tris,
        faces,
        looseEdges: loose,
        topoKey: topoCounter++,
        groups,
        colors: mesh.colors ? new Float32Array(nV * 3) : null,
        colorKey: 0,
        buildMs: 0,
        evalMs: 0,
      },
    };
  }

  private run(chain: Chain, mesh: Mesh): void {
    let cur: ArrayLike<number> = mesh.positions;
    chain.stages.forEach((s, i) => {
      const buf = chain.buffers[i];
      if (s.kind === 'mirror') evaluateMirror(s.plan, cur, buf);
      else evaluateSubdiv(s.plan, cur, buf);
      cur = buf;
    });
    const out = chain.result.positions;
    for (let i = 0; i < out.length; i++) out[i] = cur[i];
    computeNormals(out, chain.result.tris, chain.result.normals);
    if (mesh.colors && chain.result.colors && chain.colorVersion !== mesh.colorVersion) {
      // Colors go through the same stencils as positions (RGB as if it were xyz, no mirroring).
      chain.colorVersion = mesh.colorVersion;
      const rgb = new Float64Array(mesh.vertCount * 3);
      for (let v = 0; v < mesh.vertCount; v++) for (let k = 0; k < 3; k++) rgb[v * 3 + k] = mesh.colors[v * 4 + k];
      let c: ArrayLike<number> = rgb;
      chain.stages.forEach((s, i) => {
        const buf = chain.colorBuffers[i];
        if (s.kind === 'mirror') {
          for (let o = 0; o < s.plan.nOut; o++) for (let k = 0; k < 3; k++) buf[o * 3 + k] = c[s.plan.src[o] * 3 + k];
        } else evaluateSubdiv(s.plan, c, buf);
        c = buf;
      });
      const co = chain.result.colors;
      for (let i = 0; i < co.length; i++) co[i] = Math.min(1, Math.max(0, c[i]));
      chain.result.colorKey++;
    }
  }
}
