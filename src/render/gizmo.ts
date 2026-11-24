// Transform gizmo: arrows + plane handles (move), rings (rotate), stems with boxes (scale).
// Drawn on top of everything at a constant screen size; hit-testing happens in screen space
// with generous radii so handles are easy to grab with a finger.

import * as THREE from 'three';
import type { OrbitCamera } from './camera';
import { COLORS } from './materials';

export type GizmoMode = 'move' | 'rotate' | 'scale';
export type GizmoHit = { kind: 'axis' | 'plane' | 'ring'; axis: 0 | 1 | 2 } | { kind: 'free' } | { kind: 'view' };

const AXIS_COLORS = [COLORS.axisX, COLORS.axisY, COLORS.axisZ];
const AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
const SIZE_PX = 92;

export class Gizmo {
  readonly group = new THREE.Group();
  private parts: Record<GizmoMode, THREE.Group> = { move: new THREE.Group(), rotate: new THREE.Group(), scale: new THREE.Group() };
  private mode: GizmoMode = 'move';
  private pivot = new THREE.Vector3();
  private scaleWorld = 1;
  private viewRing: THREE.Mesh;
  highlight: GizmoHit | null = null;
  private materials: THREE.MeshBasicMaterial[] = [];

  constructor() {
    const mat = (c: number, opacity = 1) => {
      const m = new THREE.MeshBasicMaterial({ color: c, depthTest: false, depthWrite: false, transparent: true, opacity });
      this.materials.push(m);
      return m;
    };
    for (let a = 0; a < 3; a++) {
      const color = AXIS_COLORS[a];
      // Move: shaft + cone, and a plane handle for the two other axes.
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.8, 8), mat(color));
      shaft.position.y = 0.5;
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.24, 14), mat(color));
      cone.position.y = 1.0;
      const arrow = new THREE.Group();
      arrow.add(shaft, cone);
      orientY(arrow, AXES[a]);
      arrow.userData = { axis: a, kind: 'axis' };
      this.parts.move.add(arrow);
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.22), mat(color, 0.55));
      (plane.material as THREE.Material).side = THREE.DoubleSide;
      const [u, v] = [AXES[(a + 1) % 3], AXES[(a + 2) % 3]];
      plane.position.copy(u.clone().add(v).multiplyScalar(0.36));
      plane.lookAt(plane.position.clone().add(AXES[a]));
      plane.userData = { axis: a, kind: 'plane' };
      this.parts.move.add(plane);
      // Rotate: ring around the axis.
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.9, 0.022, 8, 64), mat(color));
      ring.lookAt(AXES[a]);
      ring.userData = { axis: a, kind: 'ring' };
      this.parts.rotate.add(ring);
      // Scale: stem + box.
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.85, 8), mat(color));
      stem.position.y = 0.45;
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.16), mat(color));
      box.position.y = 0.95;
      const s = new THREE.Group();
      s.add(stem, box);
      orientY(s, AXES[a]);
      s.userData = { axis: a, kind: 'axis' };
      this.parts.scale.add(s);
    }
    const center = new THREE.Mesh(new THREE.SphereGeometry(0.08, 16, 12), mat(0xffffff, 0.8));
    this.parts.move.add(center);
    this.parts.scale.add(center.clone());
    this.viewRing = new THREE.Mesh(new THREE.TorusGeometry(1.12, 0.016, 8, 72), mat(0xffffff, 0.7));
    this.parts.rotate.add(this.viewRing);
    for (const p of Object.values(this.parts)) this.group.add(p);
    this.group.renderOrder = 10;
    this.group.visible = false;
  }

  /** Places the gizmo for this frame. */
  update(cam: OrbitCamera, pivot: THREE.Vector3 | null, mode: GizmoMode | null): void {
    if (!pivot || !mode) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;
    this.mode = mode;
    for (const [k, g] of Object.entries(this.parts)) g.visible = k === mode;
    this.pivot.copy(pivot);
    this.scaleWorld = worldPerPixelAt(cam, pivot) * SIZE_PX;
    this.group.position.copy(pivot);
    this.group.scale.setScalar(this.scaleWorld);
    // The view ring faces the camera.
    this.viewRing.quaternion.copy(cam.camera.quaternion);
    this.applyHighlight();
  }

  private applyHighlight(): void {
    for (const g of Object.values(this.parts)) {
      g.children.forEach((c) => {
        const ud = c.userData as { axis?: number; kind?: string };
        const hot =
          this.highlight &&
          'axis' in this.highlight &&
          ud.axis === this.highlight.axis &&
          (ud.kind === this.highlight.kind || (this.highlight.kind === 'ring' && ud.kind === 'ring'));
        c.traverse((o) => {
          const m = (o as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
          if (m && 'color' in m && ud.axis !== undefined) m.color.set(hot ? 0xffffff : AXIS_COLORS[ud.axis]);
        });
      });
    }
  }

  /** Screen-space hit test (CSS px). */
  hitTest(cam: OrbitCamera, x: number, y: number): GizmoHit | null {
    if (!this.group.visible) return null;
    const p = new THREE.Vector2(x, y);
    const sp = (w: THREE.Vector3) => {
      const v = cam.project(w);
      return new THREE.Vector2(v.x, v.y);
    };
    const center = sp(this.pivot);
    const at = (dir: THREE.Vector3, len: number) => this.pivot.clone().addScaledVector(dir, len * this.scaleWorld);
    let best: { hit: GizmoHit; d: number } | null = null;
    const consider = (hit: GizmoHit, d: number, max: number) => {
      if (d <= max && (!best || d < best.d)) best = { hit, d };
    };
    if (this.mode === 'move' || this.mode === 'scale') {
      for (let a = 0; a < 3; a++) {
        const a0 = sp(at(AXES[a], 0.25)), a1 = sp(at(AXES[a], 1.12));
        consider({ kind: 'axis', axis: a as 0 | 1 | 2 }, segDist(p, a0, a1), 24);
      }
      if (this.mode === 'move') {
        for (let a = 0; a < 3; a++) {
          const c = sp(at(AXES[(a + 1) % 3].clone().add(AXES[(a + 2) % 3]), 0.36));
          consider({ kind: 'plane', axis: a as 0 | 1 | 2 }, p.distanceTo(c), 20);
        }
      }
      consider({ kind: 'free' }, p.distanceTo(center), 22);
    } else {
      for (let a = 0; a < 3; a++) {
        const u = AXES[(a + 1) % 3], v = AXES[(a + 2) % 3];
        let d = Infinity;
        let prev: THREE.Vector2 | null = null;
        for (let i = 0; i <= 48; i++) {
          const t = (i / 48) * Math.PI * 2;
          const w = this.pivot.clone().addScaledVector(u, Math.cos(t) * 0.9 * this.scaleWorld).addScaledVector(v, Math.sin(t) * 0.9 * this.scaleWorld);
          const s = sp(w);
          if (prev) d = Math.min(d, segDist(p, prev, s));
          prev = s;
        }
        consider({ kind: 'ring', axis: a as 0 | 1 | 2 }, d, 18);
      }
      const r = center.distanceTo(sp(at(cam.right(), 1.12)));
      consider({ kind: 'view' }, Math.abs(p.distanceTo(center) - r), 16);
    }
    return (best as { hit: GizmoHit; d: number } | null)?.hit ?? null;
  }
}

function orientY(obj: THREE.Object3D, dir: THREE.Vector3): void {
  obj.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
}

function segDist(p: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2): number {
  const ab = b.clone().sub(a);
  const t = THREE.MathUtils.clamp(p.clone().sub(a).dot(ab) / Math.max(ab.lengthSq(), 1e-9), 0, 1);
  return p.distanceTo(a.clone().addScaledVector(ab, t));
}

/** World units per CSS pixel at a given world point (works for perspective and ortho). */
export function worldPerPixelAt(cam: OrbitCamera, p: THREE.Vector3): number {
  if (cam.ortho) return cam.worldPerPixel();
  const camPos = cam.camera.position;
  const depth = p.clone().sub(camPos).dot(cam.dir().negate());
  return (2 * Math.max(depth, 1e-4) * Math.tan(cam.vfov / 2)) / cam.size.height;
}
