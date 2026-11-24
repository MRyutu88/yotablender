// Touch picking: objects by ray casting the evaluated surface; edit-mode elements in screen
// space with finger-sized radii, hiding what is behind geometry unless X-ray is on.

import * as THREE from 'three';
import type { Viewport } from './viewport';
import type { SceneObject } from '../core/scene/scene';
import { objectMatrix } from '../core/scene/scene';
import type { EvalResult } from '../core/modifiers/stack';
import { allEdgeKeys, edgeFromKey, faceCenter } from '../core/mesh/mesh';
import type { SelectMode } from '../core/mesh/selection';

export interface ScreenCage {
  /** Screen x, y (CSS px) per vertex. */
  sx: Float32Array;
  sy: Float32Array;
  /** Whether each vertex is in front of the camera and not hidden by geometry. */
  visible: Uint8Array;
  edgeKeys: number[];
  faceCx: Float32Array;
  faceCy: Float32Array;
  faceVisible: Uint8Array;
  faceDepth: Float32Array;
}

export function projectCage(vp: Viewport, obj: SceneObject, xray: boolean): ScreenCage {
  const m = new THREE.Matrix4().fromArray(Array.from(objectMatrix(obj)));
  const mesh = obj.mesh;
  const n = mesh.vertCount;
  const sx = new Float32Array(n), sy = new Float32Array(n), visible = new Uint8Array(n);
  const depthAt = xray ? null : vp.readDepth();
  const w = new THREE.Vector3(), s = new THREE.Vector3();
  const isVisible = (world: THREE.Vector3, x: number, y: number, ndcZ: number) => {
    if (ndcZ < -1 || ndcZ > 1) return false;
    if (!depthAt) return true;
    const d = vp.viewDepth(world);
    const surf = depthAt(x, y);
    return d <= surf + Math.max(0.004, d * 0.012);
  };
  for (let i = 0; i < n; i++) {
    w.set(mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]).applyMatrix4(m);
    vp.cam.project(w, s);
    sx[i] = s.x;
    sy[i] = s.y;
    visible[i] = isVisible(w, s.x, s.y, s.z) ? 1 : 0;
  }
  const nf = mesh.faces.length;
  const faceCx = new Float32Array(nf), faceCy = new Float32Array(nf), faceVisible = new Uint8Array(nf), faceDepth = new Float32Array(nf);
  mesh.faces.forEach((f, i) => {
    const c = faceCenter(mesh.positions, f);
    w.set(c[0], c[1], c[2]).applyMatrix4(m);
    vp.cam.project(w, s);
    faceCx[i] = s.x;
    faceCy[i] = s.y;
    faceDepth[i] = vp.viewDepth(w);
    faceVisible[i] = isVisible(w, s.x, s.y, s.z) ? 1 : 0;
  });
  return { sx, sy, visible, edgeKeys: allEdgeKeys(mesh), faceCx, faceCy, faceVisible, faceDepth };
}

export type Pick = { kind: SelectMode; index: number; dist: number };

/** Nearest element of the current select mode around (x, y), within `radius` CSS px. */
export function pickElement(obj: SceneObject, cage: ScreenCage, mode: SelectMode, x: number, y: number, radius: number): Pick | null {
  let best: Pick | null = null;
  const consider = (index: number, dist: number) => {
    if (dist <= radius && (!best || dist < best.dist)) best = { kind: mode, index, dist };
  };
  if (mode === 'vert') {
    for (let i = 0; i < cage.sx.length; i++) {
      if (cage.visible[i]) consider(i, Math.hypot(cage.sx[i] - x, cage.sy[i] - y));
    }
  } else if (mode === 'edge') {
    for (const k of cage.edgeKeys) {
      const [a, b] = edgeFromKey(k);
      if (!cage.visible[a] && !cage.visible[b]) continue;
      consider(k, segDist(x, y, cage.sx[a], cage.sy[a], cage.sx[b], cage.sy[b]));
    }
  } else {
    // A face under the finger wins (front-most); otherwise the nearest face dot.
    let inside: Pick | null = null;
    let insideDepth = Infinity;
    obj.mesh.faces.forEach((f, i) => {
      if (!cage.faceVisible[i]) return;
      if (pointInPoly(x, y, f.map((v) => [cage.sx[v], cage.sy[v]]))) {
        if (cage.faceDepth[i] < insideDepth) {
          insideDepth = cage.faceDepth[i];
          inside = { kind: 'face', index: i, dist: 0 };
        }
      }
      consider(i, Math.hypot(cage.faceCx[i] - x, cage.faceCy[i] - y));
    });
    if (inside) return inside;
  }
  return best;
}

/** Elements inside a screen polygon (box = 4 points). Edges must be fully inside. */
export function elementsInPolygon(obj: SceneObject, cage: ScreenCage, mode: SelectMode, poly: [number, number][]): number[] {
  const inV = (i: number) => cage.visible[i] === 1 && pointInPoly(cage.sx[i], cage.sy[i], poly);
  if (mode === 'vert') {
    const out: number[] = [];
    for (let i = 0; i < cage.sx.length; i++) if (inV(i)) out.push(i);
    return out;
  }
  if (mode === 'edge') {
    return cage.edgeKeys.filter((k) => {
      const [a, b] = edgeFromKey(k);
      return inV(a) && inV(b);
    });
  }
  const out: number[] = [];
  obj.mesh.faces.forEach((_, i) => {
    if (cage.faceVisible[i] && pointInPoly(cage.faceCx[i], cage.faceCy[i], poly)) out.push(i);
  });
  return out;
}

/** Ray-casts evaluated surfaces; returns the nearest hit object id. */
export function pickObject(vp: Viewport, objects: SceneObject[], evals: Map<string, EvalResult>, x: number, y: number): string | null {
  const ray = vp.cam.ray(x, y);
  let best: { id: string; t: number } | null = null;
  const inv = new THREE.Matrix4();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), hit = new THREE.Vector3();
  for (const o of objects) {
    if (!o.visible) continue;
    const ev = evals.get(o.id);
    if (!ev) continue;
    const m = new THREE.Matrix4().fromArray(Array.from(objectMatrix(o)));
    inv.copy(m).invert();
    const local = ray.clone().applyMatrix4(inv);
    // Cheap reject with the bounding sphere of the evaluated mesh.
    const sphere = boundingSphere(ev);
    if (!local.intersectsSphere(sphere)) continue;
    const p = ev.positions, t = ev.tris;
    for (let i = 0; i < t.length; i += 3) {
      a.fromArray(p, t[i] * 3);
      b.fromArray(p, t[i + 1] * 3);
      c.fromArray(p, t[i + 2] * 3);
      if (local.intersectTriangle(a, b, c, false, hit)) {
        const world = hit.clone().applyMatrix4(m);
        const dist = world.distanceTo(ray.origin);
        if (!best || dist < best.t) best = { id: o.id, t: dist };
      }
    }
  }
  return best ? (best as { id: string; t: number }).id : null;
}

function boundingSphere(ev: EvalResult): THREE.Sphere {
  // Positions change in place while dragging, so this is computed per pick (cheap: one pass).
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (let i = 0; i < ev.positions.length; i += 3) box.expandByPoint(v.fromArray(ev.positions, i));
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  sphere.radius = sphere.radius * 1.01 + 1e-6;
  return sphere;
}

export function pointInPoly(x: number, y: number, poly: ArrayLike<number[]> | [number, number][]): boolean {
  let c = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}
