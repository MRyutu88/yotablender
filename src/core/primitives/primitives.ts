// Primitive builders matching Blender 5.3's defaults: same sizes, Z-up orientation, vertex
// positions, n-gon caps and outward CCW winding. (Verified against Blender's operators; see
// primitives.test.ts for the reference counts.)

import type { MeshData, Face } from '../mesh/mesh';

export type PrimitiveType = 'cube' | 'plane' | 'uvSphere' | 'quadSphere' | 'cylinder' | 'cone' | 'torus';

export interface PrimitiveParams {
  cube: { size: number };
  plane: { size: number };
  uvSphere: { segments: number; rings: number; radius: number };
  quadSphere: { subdivisions: number; radius: number };
  cylinder: { vertices: number; radius: number; depth: number };
  cone: { vertices: number; radius1: number; radius2: number; depth: number };
  torus: { majorSegments: number; minorSegments: number; majorRadius: number; minorRadius: number };
}

export const PRIMITIVE_DEFAULTS: { [K in PrimitiveType]: PrimitiveParams[K] } = {
  cube: { size: 2 },
  plane: { size: 2 },
  uvSphere: { segments: 32, rings: 16, radius: 1 },
  quadSphere: { subdivisions: 4, radius: 1 },
  cylinder: { vertices: 32, radius: 1, depth: 2 },
  cone: { vertices: 32, radius1: 1, radius2: 0, depth: 2 },
  torus: { majorSegments: 48, minorSegments: 12, majorRadius: 1, minorRadius: 0.25 },
};

/** UI metadata for the "Adjust Last Operation" panel: limits and steps for each parameter. */
export const PRIMITIVE_PARAM_SPECS: {
  [K in PrimitiveType]: { [P in keyof PrimitiveParams[K]]: { min: number; max: number; step: number; int?: boolean } };
} = {
  cube: { size: { min: 0.01, max: 100, step: 0.1 } },
  plane: { size: { min: 0.01, max: 100, step: 0.1 } },
  uvSphere: {
    segments: { min: 3, max: 128, step: 1, int: true },
    rings: { min: 3, max: 64, step: 1, int: true },
    radius: { min: 0.01, max: 100, step: 0.1 },
  },
  quadSphere: { subdivisions: { min: 1, max: 24, step: 1, int: true }, radius: { min: 0.01, max: 100, step: 0.1 } },
  cylinder: {
    vertices: { min: 3, max: 128, step: 1, int: true },
    radius: { min: 0.01, max: 100, step: 0.1 },
    depth: { min: 0.01, max: 100, step: 0.1 },
  },
  cone: {
    vertices: { min: 3, max: 128, step: 1, int: true },
    radius1: { min: 0, max: 100, step: 0.1 },
    radius2: { min: 0, max: 100, step: 0.1 },
    depth: { min: 0.01, max: 100, step: 0.1 },
  },
  torus: {
    majorSegments: { min: 3, max: 128, step: 1, int: true },
    minorSegments: { min: 3, max: 64, step: 1, int: true },
    majorRadius: { min: 0.01, max: 100, step: 0.1 },
    minorRadius: { min: 0.01, max: 100, step: 0.05 },
  },
};

export const PRIMITIVE_LABELS: Record<PrimitiveType, string> = {
  cube: 'Cube',
  plane: 'Plane',
  uvSphere: 'UV Sphere',
  quadSphere: 'Quad Sphere',
  cylinder: 'Cylinder',
  cone: 'Cone',
  torus: 'Torus',
};

export function buildPrimitive<K extends PrimitiveType>(type: K, params: Partial<PrimitiveParams[K]> = {}): MeshData {
  const p = { ...PRIMITIVE_DEFAULTS[type], ...params } as PrimitiveParams[K];
  switch (type) {
    case 'cube':
      return cube((p as PrimitiveParams['cube']).size);
    case 'plane':
      return plane((p as PrimitiveParams['plane']).size);
    case 'uvSphere':
      return uvSphere(p as PrimitiveParams['uvSphere']);
    case 'quadSphere':
      return quadSphere(p as PrimitiveParams['quadSphere']);
    case 'cylinder':
      return cylinder(p as PrimitiveParams['cylinder']);
    case 'cone':
      return cone(p as PrimitiveParams['cone']);
    case 'torus':
      return torus(p as PrimitiveParams['torus']);
  }
  throw new Error(`unknown primitive ${type}`);
}

const int = (n: number, min: number) => Math.max(min, Math.round(n));

function cube(size: number): MeshData {
  const h = size / 2;
  const positions: number[] = [];
  // Blender's order: index = x*4 + y*2 + z, each in {-h, +h}.
  for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) for (let z = 0; z < 2; z++) positions.push(x ? h : -h, y ? h : -h, z ? h : -h);
  const faces: Face[] = [
    [0, 1, 3, 2],
    [2, 3, 7, 6],
    [6, 7, 5, 4],
    [4, 5, 1, 0],
    [2, 6, 4, 0],
    [7, 3, 1, 5],
  ];
  return { positions, faces, looseEdges: [] };
}

function plane(size: number): MeshData {
  const h = size / 2;
  return { positions: [-h, -h, 0, h, -h, 0, -h, h, 0, h, h, 0], faces: [[0, 1, 3, 2]], looseEdges: [] };
}

/** Circle points like Blender: start at +Y and go clockwise seen from above (towards +X). */
const circle = (i: number, n: number, r: number): [number, number] => {
  const a = (i / n) * Math.PI * 2;
  return [r * Math.sin(a), r * Math.cos(a)];
};

function uvSphere({ segments, rings, radius }: PrimitiveParams['uvSphere']): MeshData {
  const seg = int(segments, 3), rg = int(rings, 3);
  const positions: number[] = [0, 0, radius]; // 0 = top pole
  // Columns of (rings - 1) vertices, top to bottom.
  for (let s = 0; s < seg; s++) {
    for (let r = 1; r < rg; r++) {
      const phi = (r / rg) * Math.PI;
      const [x, y] = circle(s, seg, Math.sin(phi) * radius);
      positions.push(x, y, Math.cos(phi) * radius);
    }
  }
  const bottom = positions.length / 3;
  positions.push(0, 0, -radius);
  const col = (s: number, r: number) => 1 + (s % seg) * (rg - 1) + (r - 1); // r in 1..rg-1
  const faces: Face[] = [];
  for (let s = 0; s < seg; s++) {
    const s2 = s + 1;
    faces.push([col(s, 1), 0, col(s2, 1)]);
    for (let r = 1; r < rg - 1; r++) faces.push([col(s, r + 1), col(s, r), col(s2, r), col(s2, r + 1)]);
    faces.push([bottom, col(s, rg - 1), col(s2, rg - 1)]);
  }
  return { positions, faces, looseEdges: [] };
}

function cylinder({ vertices, radius, depth }: PrimitiveParams['cylinder']): MeshData {
  const n = int(vertices, 3), h = depth / 2;
  const positions: number[] = [];
  for (let i = 0; i < n; i++) {
    const [x, y] = circle(i, n, radius);
    positions.push(x, y, -h, x, y, h); // 2i = bottom, 2i+1 = top
  }
  const faces: Face[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    faces.push([2 * i, 2 * i + 1, 2 * j + 1, 2 * j]);
  }
  const top: number[] = [], bot: number[] = [];
  for (let i = 0; i < n; i++) {
    bot.push(2 * i);
    top.push(2 * ((n - i) % n) + 1);
  }
  faces.push(top, bot);
  return { positions, faces, looseEdges: [] };
}

function cone({ vertices, radius1, radius2, depth }: PrimitiveParams['cone']): MeshData {
  const n = int(vertices, 3), h = depth / 2;
  const positions: number[] = [];
  for (let i = 0; i < n; i++) {
    const [x, y] = circle(i, n, radius1);
    positions.push(x, y, -h);
  }
  const faces: Face[] = [];
  const base: number[] = [];
  for (let i = 0; i < n; i++) base.push(i);
  if (radius2 <= 1e-9) {
    const tip = n;
    positions.push(0, 0, h);
    for (let i = 0; i < n; i++) faces.push([i, tip, (i + 1) % n]);
  } else {
    for (let i = 0; i < n; i++) {
      const [x, y] = circle(i, n, radius2);
      positions.push(x, y, h);
    }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      faces.push([i, n + i, n + j, j]);
    }
    const top: number[] = [];
    for (let i = 0; i < n; i++) top.push(n + ((n - i) % n));
    faces.push(top);
  }
  if (radius1 > 1e-9) faces.push(base);
  return { positions, faces, looseEdges: [] };
}

function torus({ majorSegments, minorSegments, majorRadius, minorRadius }: PrimitiveParams['torus']): MeshData {
  const M = int(majorSegments, 3), m = int(minorSegments, 3);
  const positions: number[] = [];
  for (let i = 0; i < M; i++) {
    const a = (i / M) * Math.PI * 2; // starts at +X, counter-clockwise
    const ca = Math.cos(a), sa = Math.sin(a);
    for (let j = 0; j < m; j++) {
      const b = (j / m) * Math.PI * 2; // starts on the outside, then goes up
      const r = majorRadius + minorRadius * Math.cos(b);
      positions.push(r * ca, r * sa, minorRadius * Math.sin(b));
    }
  }
  const faces: Face[] = [];
  for (let i = 0; i < M; i++) {
    const i2 = (i + 1) % M;
    for (let j = 0; j < m; j++) {
      const j2 = (j + 1) % m;
      faces.push([i * m + j, i2 * m + j, i2 * m + j2, i * m + j2]);
    }
  }
  return { positions, faces, looseEdges: [] };
}

/**
 * A cube with an n×n grid on each side, projected onto a sphere with an area-preserving map so
 * the quads stay even. All quads: a good base for characters (no poles, subdivides cleanly).
 */
function quadSphere({ subdivisions, radius }: PrimitiveParams['quadSphere']): MeshData {
  const n = int(subdivisions, 1);
  const positions: number[] = [];
  const index = new Map<string, number>();
  const vert = (x: number, y: number, z: number): number => {
    const key = `${x},${y},${z}`; // integer lattice coords in [-n, n]
    let i = index.get(key);
    if (i === undefined) {
      i = positions.length / 3;
      index.set(key, i);
      const px = x / n, py = y / n, pz = z / n;
      const sx = px * Math.sqrt(1 - (py * py) / 2 - (pz * pz) / 2 + (py * py * pz * pz) / 3);
      const sy = py * Math.sqrt(1 - (pz * pz) / 2 - (px * px) / 2 + (pz * pz * px * px) / 3);
      const sz = pz * Math.sqrt(1 - (px * px) / 2 - (py * py) / 2 + (px * px * py * py) / 3);
      positions.push(sx * radius, sy * radius, sz * radius);
    }
    return i;
  };
  const faces: Face[] = [];
  // Each side: origin corner + two lattice directions (u, v) with u × v pointing outward.
  const sides: [number[], number[], number[]][] = [
    [[n, -n, -n], [0, 2, 0], [0, 0, 2]], // +X
    [[-n, n, -n], [0, -2, 0], [0, 0, 2]], // -X
    [[n, n, -n], [-2, 0, 0], [0, 0, 2]], // +Y
    [[-n, -n, -n], [2, 0, 0], [0, 0, 2]], // -Y
    [[-n, -n, n], [2, 0, 0], [0, 2, 0]], // +Z
    [[-n, n, -n], [2, 0, 0], [0, -2, 0]], // -Z
  ];
  for (const [o, u, v] of sides) {
    const at = (i: number, j: number) =>
      vert(o[0] + (u[0] * i) / 2 + (v[0] * j) / 2, o[1] + (u[1] * i) / 2 + (v[1] * j) / 2, o[2] + (u[2] * i) / 2 + (v[2] * j) / 2);
    for (let i = 0; i < 2 * n; i += 2) {
      for (let j = 0; j < 2 * n; j += 2) faces.push([at(i, j), at(i + 2, j), at(i + 2, j + 2), at(i, j + 2)]);
    }
  }
  return { positions, faces, looseEdges: [] };
}
