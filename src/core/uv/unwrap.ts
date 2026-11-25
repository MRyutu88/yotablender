// Automatic UV unwrap in the spirit of Blender's Smart UV Project:
// 1. Faces are grouped into islands: starting from the largest free face, neighbours join while
//    their normal stays within `angleLimit` of the seed's normal (66° like Blender's default).
// 2. Each island is projected flat along its average normal (every face faces the projection
//    direction, so nothing flips). An island that would overlap itself is split.
// 3. Islands are turned to their smallest bounding box and packed into the unit square with one
//    texel density for all of them and a margin between them.
//
// The paint brush works in 3D, so seams between islands don't show up as gaps in strokes.

import { faceNormalRaw, type MeshData } from '../mesh/mesh';
import { edgeKey } from '../mesh/keys';
import type { Vec3 } from '../math/vec3';

export interface UnwrapOptions {
  /** Degrees between a face and its island's seed (Blender: 66). */
  angleLimit?: number;
  /** Gap between islands, as a fraction of the texture size (2 px at 1024 ≈ 0.002). */
  margin?: number;
}

export interface UnwrapResult {
  /** Per face, u,v per corner (same layout as MeshData.uvs). */
  uvs: number[][];
  islands: number;
  /** Fraction of the unit square covered by faces. */
  coverage: number;
}

interface Island {
  faces: number[];
  /** Projected 2D position per face corner (parallel to faces). */
  pts: [number, number][][];
  minX: number;
  minY: number;
  w: number;
  h: number;
}

export function unwrap(mesh: MeshData, opts: UnwrapOptions = {}): UnwrapResult {
  const cosLimit = Math.cos(((opts.angleLimit ?? 66) * Math.PI) / 180);
  const margin = opts.margin ?? 0.004;
  const { positions: pos, faces } = mesh;
  const nF = faces.length;
  const normals: Vec3[] = [];
  const areas = new Float64Array(nF);
  for (let f = 0; f < nF; f++) {
    const n = faceNormalRaw(pos, faces[f]);
    const l = Math.hypot(n[0], n[1], n[2]);
    areas[f] = l / 2;
    normals.push(l > 1e-20 ? [n[0] / l, n[1] / l, n[2] / l] : [0, 0, 1]);
  }
  // Face adjacency through shared edges.
  const byEdge = new Map<number, number[]>();
  faces.forEach((f, fi) => {
    for (let i = 0; i < f.length; i++) {
      const k = edgeKey(f[i], f[(i + 1) % f.length]);
      (byEdge.get(k) ?? byEdge.set(k, []).get(k)!).push(fi);
    }
  });
  const neighbours = (fi: number): number[] => {
    const f = faces[fi];
    const out: number[] = [];
    for (let i = 0; i < f.length; i++) for (const g of byEdge.get(edgeKey(f[i], f[(i + 1) % f.length]))!) if (g !== fi) out.push(g);
    return out;
  };

  const island = new Int32Array(nF).fill(-1);
  const order = Array.from({ length: nF }, (_, i) => i).sort((a, b) => areas[b] - areas[a] || a - b);
  const islands: Island[] = [];
  /** Grows an island from `seed` over faces in `allowed` (all free faces when undefined). */
  const grow = (seed: number, allowed?: Set<number>): number[] => {
    const id = islands.length;
    const n0 = normals[seed];
    const members = [seed];
    island[seed] = id;
    for (let q = 0; q < members.length; q++) {
      for (const g of neighbours(members[q])) {
        if (island[g] !== -1 || (allowed && !allowed.has(g))) continue;
        const n = normals[g];
        if (n[0] * n0[0] + n[1] * n0[1] + n[2] * n0[2] < cosLimit) continue;
        island[g] = id;
        members.push(g);
      }
    }
    return members;
  };

  const pending: { seed: number; allowed?: Set<number> }[] = order.map((seed) => ({ seed }));
  while (pending.length) {
    const { seed, allowed } = pending.shift()!;
    if (island[seed] !== -1) continue;
    const members = grow(seed, allowed);
    const proj = project(pos, faces, members, normals, areas);
    const bad = selfOverlaps(proj);
    if (bad.size && members.length > 1) {
      // Keep the faces that don't overlap anything; the rest become islands of their own.
      for (const f of members) island[f] = -1;
      const keep = members.filter((_, i) => !bad.has(i));
      const rest = new Set(members.filter((_, i) => bad.has(i)));
      const keepSet = new Set(keep.length ? keep : [seed]);
      pending.unshift({ seed: keep.length ? keep[0] : seed, allowed: keepSet });
      for (const f of rest) if (!keepSet.has(f)) pending.push({ seed: f, allowed: rest });
      continue;
    }
    islands.push(fitIsland(members, proj));
  }

  const coverage = pack(islands, margin);
  const uvs: number[][] = faces.map((f) => new Array(f.length * 2).fill(0));
  for (const isl of islands) {
    isl.faces.forEach((f, i) => {
      const out = uvs[f];
      isl.pts[i].forEach(([x, y], c) => {
        out[c * 2] = x;
        out[c * 2 + 1] = y;
      });
    });
  }
  return { uvs, islands: islands.length, coverage };
}

/** Projects faces onto the plane of their area-weighted mean normal (right-handed, CCW kept). */
function project(pos: ArrayLike<number>, faces: number[][], members: number[], normals: Vec3[], areas: Float64Array): [number, number][][] {
  let nx = 0, ny = 0, nz = 0;
  for (const f of members) {
    nx += normals[f][0] * areas[f];
    ny += normals[f][1] * areas[f];
    nz += normals[f][2] * areas[f];
  }
  let l = Math.hypot(nx, ny, nz);
  if (l < 1e-12) [nx, ny, nz, l] = [...normals[members[0]], 1];
  const n: Vec3 = [nx / l, ny / l, nz / l];
  // Tangent: world Z projected into the plane when possible (keeps "up" up), else world X.
  const ref: Vec3 = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const d = ref[0] * n[0] + ref[1] * n[1] + ref[2] * n[2];
  let ty: Vec3 = [ref[0] - n[0] * d, ref[1] - n[1] * d, ref[2] - n[2] * d];
  const tl = Math.hypot(...ty);
  ty = [ty[0] / tl, ty[1] / tl, ty[2] / tl];
  const tx: Vec3 = [ty[1] * n[2] - ty[2] * n[1], ty[2] * n[0] - ty[0] * n[2], ty[0] * n[1] - ty[1] * n[0]];
  return members.map((f) =>
    faces[f].map((v) => {
      const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
      return [x * tx[0] + y * tx[1] + z * tx[2], x * ty[0] + y * ty[1] + z * ty[2]] as [number, number];
    }),
  );
}

// --- Overlap test ---------------------------------------------------------------------------

type Tri = [[number, number], [number, number], [number, number]];

/** Indices (into the island's face list) of faces whose projection overlaps another face's. */
function selfOverlaps(proj: [number, number][][]): Set<number> {
  const tris: { tri: Tri; face: number }[] = [];
  proj.forEach((poly, fi) => {
    for (let i = 1; i < poly.length - 1; i++) tris.push({ tri: [poly[0], poly[i], poly[i + 1]], face: fi });
  });
  const bad = new Set<number>();
  // Flipped or degenerate projections are overlaps too.
  proj.forEach((poly, fi) => {
    if (signedArea(poly) <= 1e-14) bad.add(fi);
  });
  if (tris.length < 2) return bad;
  // Uniform grid over bounding boxes.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const { tri } of tris) for (const [x, y] of tri) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const cells = Math.max(1, Math.ceil(Math.sqrt(tris.length)));
  const cw = (maxX - minX) / cells || 1, ch = (maxY - minY) / cells || 1;
  const grid = new Map<number, number[]>();
  tris.forEach(({ tri }, ti) => {
    const x0 = Math.floor((Math.min(tri[0][0], tri[1][0], tri[2][0]) - minX) / cw);
    const x1 = Math.floor((Math.max(tri[0][0], tri[1][0], tri[2][0]) - minX) / cw);
    const y0 = Math.floor((Math.min(tri[0][1], tri[1][1], tri[2][1]) - minY) / ch);
    const y1 = Math.floor((Math.max(tri[0][1], tri[1][1], tri[2][1]) - minY) / ch);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const k = x * 100003 + y;
      (grid.get(k) ?? grid.set(k, []).get(k)!).push(ti);
    }
  });
  const tested = new Set<number>();
  for (const list of grid.values()) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      const ta = tris[a], tb = tris[b];
      if (ta.face === tb.face) continue;
      const key = Math.min(a, b) * tris.length + Math.max(a, b);
      if (tested.has(key)) continue;
      tested.add(key);
      if (trianglesOverlap(ta.tri, tb.tri)) {
        // Blame the smaller face so big faces stay together.
        bad.add(Math.abs(signedArea(proj[ta.face])) < Math.abs(signedArea(proj[tb.face])) ? ta.face : tb.face);
      }
    }
  }
  return bad;
}

export function signedArea(poly: ArrayLike<number>[] | [number, number][]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** True when two triangles' interiors overlap (touching edges/corners doesn't count). */
export function trianglesOverlap(a: Tri, b: Tri): boolean {
  // Separating axis test over the 6 edge normals, with a small tolerance for shared edges.
  const scale = Math.max(...a.flat().map(Math.abs), ...b.flat().map(Math.abs), 1e-9);
  const eps = 1e-9 * scale;
  for (const t of [a, b]) {
    for (let i = 0; i < 3; i++) {
      const p = t[i], q = t[(i + 1) % 3];
      const nx = q[1] - p[1], ny = p[0] - q[0];
      const l = Math.hypot(nx, ny);
      if (l < 1e-20) continue;
      let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
      for (const v of a) {
        const d = (v[0] * nx + v[1] * ny) / l;
        amin = Math.min(amin, d);
        amax = Math.max(amax, d);
      }
      for (const v of b) {
        const d = (v[0] * nx + v[1] * ny) / l;
        bmin = Math.min(bmin, d);
        bmax = Math.max(bmax, d);
      }
      if (amax <= bmin + eps || bmax <= amin + eps) return false;
    }
  }
  return true;
}

// --- Fitting and packing ----------------------------------------------------------------------

/** Rotates the island to its minimum-area bounding rectangle (rotating calipers on the hull). */
function fitIsland(faces: number[], pts: [number, number][][]): Island {
  const all = pts.flat();
  const hull = convexHull(all);
  let best = { area: Infinity, c: 1, s: 0 };
  for (let i = 0; i < hull.length; i++) {
    const p = hull[i], q = hull[(i + 1) % hull.length];
    const ang = Math.atan2(q[1] - p[1], q[0] - p[0]);
    const c = Math.cos(-ang), s = Math.sin(-ang);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of hull) {
      const rx = x * c - y * s, ry = x * s + y * c;
      x0 = Math.min(x0, rx);
      x1 = Math.max(x1, rx);
      y0 = Math.min(y0, ry);
      y1 = Math.max(y1, ry);
    }
    const area = (x1 - x0) * (y1 - y0);
    if (area < best.area - 1e-12) best = { area, c, s };
  }
  const rot = pts.map((poly) => poly.map(([x, y]) => [x * best.c - y * best.s, x * best.s + y * best.c] as [number, number]));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const poly of rot) for (const [x, y] of poly) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { faces, pts: rot, minX, minY, w: maxX - minX, h: maxY - minY };
}

function convexHull(points: [number, number][]): [number, number][] {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: [number, number][] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

interface Placed {
  x: number;
  y: number;
  rotated: boolean;
}

/**
 * Skyline (bottom-left) packing with all islands at the same scale. Tries a few bin widths and
 * keeps the most square result, then scales everything into [margin, 1 - margin]².
 * Writes the final UVs into island.pts and returns the covered fraction of the square.
 */
function pack(islands: Island[], margin: number): number {
  if (!islands.length) return 0;
  const totalArea = islands.reduce((n, i) => n + i.w * i.h, 0);
  const maxSide = Math.max(...islands.map((i) => Math.max(i.w, i.h)));
  // The gap in 3D units depends on the final scale; estimate it from the area, then refine.
  let gap = margin * Math.sqrt(totalArea) * 1.3;
  let best: { side: number; placed: Placed[] } | null = null;
  for (let iter = 0; iter < 3; iter++) {
    best = null;
    const base = Math.sqrt(totalArea * 1.1);
    for (const k of [0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6]) {
      const W = Math.max(base * k, maxSide + 2 * gap);
      const r = skyline(islands, W, gap);
      const side = Math.max(W, r.height);
      if (!best || side < best.side) best = { side, placed: r.placed };
    }
    const nextGap = margin * best!.side;
    if (Math.abs(nextGap - gap) < 1e-3 * gap) break;
    gap = nextGap;
  }
  const { side, placed } = best!;
  const scale = (1 - 2 * margin) / side;
  let covered = 0;
  islands.forEach((isl, i) => {
    const p = placed[i];
    isl.pts = isl.pts.map((poly) => {
      const out = poly.map(([x, y]) => {
        let lx = x - isl.minX, ly = y - isl.minY;
        if (p.rotated) [lx, ly] = [isl.h - ly, lx]; // 90° CCW keeps the winding
        return [margin + (p.x + lx) * scale, margin + (p.y + ly) * scale] as [number, number];
      });
      covered += Math.abs(signedArea(out));
      return out;
    });
  });
  return covered;
}

function skyline(islands: Island[], W: number, gap: number): { placed: Placed[]; height: number } {
  // Biggest first; lay islands flat (wider than tall).
  const order = islands.map((_, i) => i).sort((a, b) => Math.max(islands[b].w, islands[b].h) - Math.max(islands[a].w, islands[a].h) || a - b);
  let segs: { x: number; y: number; w: number }[] = [{ x: 0, y: 0, w: W }];
  const placed: Placed[] = new Array(islands.length);
  let height = 0;
  for (const i of order) {
    const isl = islands[i];
    let bestPos: { x: number; y: number; rotated: boolean; top: number } | null = null;
    for (const rotated of isl.w >= isl.h ? [false, true] : [true, false]) {
      const w = (rotated ? isl.h : isl.w) + gap, h = (rotated ? isl.w : isl.h) + gap;
      if (w > W + 1e-9) continue;
      for (let s = 0; s < segs.length; s++) {
        const x = segs[s].x;
        if (x + w > W + 1e-9) break;
        // Resting height = max skyline under [x, x + w).
        let y = 0;
        for (let t = s; t < segs.length && segs[t].x < x + w - 1e-12; t++) y = Math.max(y, segs[t].y);
        const top = y + h;
        if (!bestPos || top < bestPos.top - 1e-12 || (Math.abs(top - bestPos.top) <= 1e-12 && x < bestPos.x)) bestPos = { x, y, rotated, top };
      }
    }
    if (!bestPos) bestPos = { x: 0, y: height, rotated: false, top: height + isl.h + gap }; // wider than the bin: stack
    placed[i] = { x: bestPos.x + gap / 2, y: bestPos.y + gap / 2, rotated: bestPos.rotated };
    const w = (bestPos.rotated ? isl.h : isl.w) + gap;
    height = Math.max(height, bestPos.top);
    // Raise the skyline over [x, x + w).
    const x0 = bestPos.x, x1 = bestPos.x + w;
    const next: typeof segs = [];
    for (const sg of segs) {
      const e = sg.x + sg.w;
      if (e <= x0 || sg.x >= x1) next.push(sg);
      else {
        if (sg.x < x0) next.push({ x: sg.x, y: sg.y, w: x0 - sg.x });
        if (e > x1) next.push({ x: x1, y: sg.y, w: e - x1 });
      }
    }
    next.push({ x: x0, y: bestPos.top, w: x1 - x0 });
    next.sort((a, b) => a.x - b.x);
    // Merge neighbours at the same height.
    segs = [];
    for (const sg of next) {
      const last = segs[segs.length - 1];
      if (last && Math.abs(last.y - sg.y) < 1e-12 && Math.abs(last.x + last.w - sg.x) < 1e-12) last.w += sg.w;
      else segs.push({ ...sg });
    }
  }
  return { placed, height };
}
