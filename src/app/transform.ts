// Interactive Move / Rotate / Scale driven by one finger anywhere on the screen.
//
// - Move: free in the view plane, along an axis/direction, or within a plane.
// - Rotate: angle swept around the pivot on screen; around the view axis or a locked axis.
// - Scale: distance from the pivot on screen; uniform, one axis, or a plane.
// A second finger held down (or Shift) slows everything to 1/10 for precision.
// Increment snapping works on the delta, like Blender's default "Increment" snapping.

import * as THREE from 'three';
import type { OrbitCamera } from '../render/camera';
import { worldPerPixelAt } from '../render/gizmo';
import type { Constraint } from './state';
import type { SceneObject } from '../core/scene/scene';
import { objectMatrix } from '../core/scene/scene';
import { axisAngleToRot, eulerToRot, invert, mulRot, rotToEuler, compatibleEuler, transformPoint, type Mat4 } from '../core/math/mat4';
import type { Vec3 } from '../core/math/vec3';
import { applyMirrorClip } from '../core/modifiers/mirror';

export type TransformKind = 'move' | 'rotate' | 'scale';

const AXES: Vec3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

interface ObjTarget {
  obj: SceneObject;
  loc: Vec3;
  rot: Vec3;
  scale: Vec3;
}

export interface EditTarget {
  obj: SceneObject;
  verts: Int32Array;
  start: Float64Array; // local positions of `verts`
  m: Mat4;
  inv: Mat4;
  /** Full copy of positions before the drag (for mirror clipping). */
  all: Float64Array;
  /** Influence per entry of `verts`: 1 for the selection, falloff for proportional neighbours. */
  weights: Float32Array;
  /** The selected vertices (proportional neighbours are added around these). */
  selected: number[];
}

export interface SnapOptions {
  enabled: boolean;
  move: number;
  rotateDeg: number;
  scale: number;
}

export class TransformSession {
  readonly pivot: Vec3;
  private virt: { x: number; y: number };
  private last: { x: number; y: number };
  private angleTotal = 0;
  private lastAngle: number;
  private objTargets: ObjTarget[] = [];
  edit: EditTarget | null = null;
  /** Human-readable value for the readout. */
  label = '';
  /** Current value (distance, degrees or factor) for "Adjust Last". */
  value = 0;

  constructor(
    readonly kind: TransformKind,
    private cam: OrbitCamera,
    readonly start: { x: number; y: number },
    readonly constraint: Constraint | null,
    target: { objects: SceneObject[] } | { edit: EditTarget },
    pivot: Vec3,
    private snap: SnapOptions,
    /**
     * Scrub mode (sliding along an X/Y/Z chip): the finger's sideways travel is the value itself,
     * independent of where the pivot is on screen. Right/up = positive.
     */
    readonly scrub = false,
  ) {
    this.pivot = pivot;
    this.virt = { ...start };
    this.last = { ...start };
    const ps = this.pivotScreen();
    this.lastAngle = Math.atan2(start.y - ps.y, start.x - ps.x);
    if ('objects' in target) {
      this.objTargets = target.objects.map((o) => ({ obj: o, loc: [...o.location] as Vec3, rot: [...o.rotation_euler] as Vec3, scale: [...o.scale] as Vec3 }));
    } else {
      this.edit = target.edit;
    }
  }

  private pivotScreen() {
    const v = this.cam.project(new THREE.Vector3(...this.pivot));
    return { x: v.x, y: v.y };
  }

  update(p: { x: number; y: number }, precision: boolean): void {
    const k = precision ? 0.1 : 1;
    this.virt.x += (p.x - this.last.x) * k;
    this.virt.y += (p.y - this.last.y) * k;
    this.last = { ...p };
    if (this.scrub) return this.updateScrub();
    if (this.kind === 'move') this.applyMove(this.computeMove());
    else if (this.kind === 'rotate') this.applyRotate(this.computeAngle());
    else this.applyScale(this.computeScale());
  }

  /** Re-applies with an exact value (Adjust Last / numeric entry). */
  setValue(v: number): void {
    if (this.kind === 'move') {
      const d = this.constraintDir();
      if (d) this.applyMove([d[0] * v, d[1] * v, d[2] * v]);
    } else if (this.kind === 'rotate') this.applyRotate((v * Math.PI) / 180);
    else this.applyScale(v);
  }

  private updateScrub(): void {
    const s = this.virt.x - this.start.x - (this.virt.y - this.start.y);
    const c = this.constraint;
    const axisName = c ? (c.kind === 'dir' ? c.label : c.kind === 'plane' ? `not ${'XYZ'[c.axis]}` : 'XYZ'[c.axis]) : '';
    if (this.kind === 'move') {
      const dir = this.constraintDir() ?? AXES[0];
      // One pixel = one pixel's worth of distance at the pivot, so it feels like dragging it.
      let t = s * worldPerPixelAt(this.cam, new THREE.Vector3(...this.pivot));
      if (this.snap.enabled) t = Math.round(t / this.snap.move) * this.snap.move;
      this.value = t;
      this.label = `${axisName}  ${fmt(t)}`;
      this.applyMove([dir[0] * t, dir[1] * t, dir[2] * t]);
    } else if (this.kind === 'rotate') {
      let angle = s * 0.01; // ≈ 0.57° per pixel
      if (this.snap.enabled) {
        const inc = (this.snap.rotateDeg * Math.PI) / 180;
        angle = Math.round(angle / inc) * inc;
      }
      this.value = (angle * 180) / Math.PI;
      this.label = `${fmt(this.value, 1)}°  ${axisName}`;
      this.applyRotate(angle);
    } else {
      let f = Math.exp(s / 160);
      if (this.snap.enabled) f = Math.max(this.snap.scale, Math.round(f / this.snap.scale) * this.snap.scale);
      this.value = f;
      this.label = `×${fmt(f, 3)}  ${axisName}`;
      this.applyScale(f);
    }
  }

  private constraintDir(): Vec3 | null {
    const c = this.constraint;
    if (!c) return null;
    if (c.kind === 'axis') return AXES[c.axis];
    if (c.kind === 'dir') return c.dir;
    return null;
  }

  // --- Move ---------------------------------------------------------------------------------
  private computeMove(): Vec3 {
    const dx = this.virt.x - this.start.x, dy = this.virt.y - this.start.y;
    const c = this.constraint;
    const pv = new THREE.Vector3(...this.pivot);
    const dir = this.constraintDir();
    if (dir) {
      const wpp = worldPerPixelAt(this.cam, pv);
      const s0 = this.cam.project(pv.clone());
      const s1 = this.cam.project(pv.clone().addScaledVector(new THREE.Vector3(...dir), wpp * 100));
      const sx = s1.x - s0.x, sy = s1.y - s0.y;
      const pxPerUnit = Math.hypot(sx, sy) / (wpp * 100);
      let t: number;
      if (pxPerUnit < 0.15 / wpp) {
        // Axis points at the camera: use vertical drag instead.
        t = -dy * wpp;
      } else {
        t = (dx * sx + dy * sy) / Math.hypot(sx, sy) / pxPerUnit;
      }
      if (this.snap.enabled) t = Math.round(t / this.snap.move) * this.snap.move;
      this.value = t;
      this.label = `${c?.kind === 'dir' ? c.label : 'XYZ'[(c as { axis: number }).axis]}  ${fmt(t)}`;
      return [dir[0] * t, dir[1] * t, dir[2] * t];
    }
    let delta: THREE.Vector3;
    if (c && c.kind === 'plane') {
      const n = new THREE.Vector3(...AXES[c.axis]);
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, pv);
      const r0 = this.cam.ray(this.start.x, this.start.y), r1 = this.cam.ray(this.virt.x, this.virt.y);
      const h0 = new THREE.Vector3(), h1 = new THREE.Vector3();
      if (Math.abs(r1.direction.dot(n)) > 0.08 && r0.intersectPlane(plane, h0) && r1.intersectPlane(plane, h1)) {
        delta = h1.sub(h0);
      } else {
        delta = this.freeDelta(dx, dy);
        delta.sub(n.clone().multiplyScalar(delta.dot(n)));
      }
    } else {
      delta = this.freeDelta(dx, dy);
    }
    const d: Vec3 = [delta.x, delta.y, delta.z];
    if (this.snap.enabled) for (let i = 0; i < 3; i++) d[i] = Math.round(d[i] / this.snap.move) * this.snap.move;
    this.value = Math.hypot(...d);
    this.label = `Δ  x ${fmt(d[0])}  y ${fmt(d[1])}  z ${fmt(d[2])}`;
    return d;
  }

  private freeDelta(dx: number, dy: number): THREE.Vector3 {
    const wpp = worldPerPixelAt(this.cam, new THREE.Vector3(...this.pivot));
    return this.cam.right().multiplyScalar(dx * wpp).add(this.cam.up().multiplyScalar(-dy * wpp));
  }

  private applyMove(d: Vec3): void {
    for (const t of this.objTargets) {
      t.obj.location = [t.loc[0] + d[0], t.loc[1] + d[1], t.loc[2] + d[2]];
    }
    if (this.edit) this.applyEdit((w, k) => [w[0] + d[0] * k, w[1] + d[1] * k, w[2] + d[2] * k]);
    this.reapply = () => this.applyMove(d);
  }

  // --- Rotate -------------------------------------------------------------------------------
  private rotAxis(): Vec3 {
    const c = this.constraint;
    if (c && (c.kind === 'axis' || c.kind === 'plane')) return AXES[c.axis];
    if (c && c.kind === 'dir') return c.dir;
    const d = this.cam.dir();
    return [d.x, d.y, d.z];
  }

  private computeAngle(): number {
    const ps = this.pivotScreen();
    const dist = Math.hypot(this.virt.x - ps.x, this.virt.y - ps.y);
    let screenAngle: number;
    if (dist < 24) {
      // Too close to the pivot to measure an angle reliably: horizontal drag rotates instead.
      screenAngle = (this.virt.x - this.start.x) * 0.012;
    } else {
      const a = Math.atan2(this.virt.y - ps.y, this.virt.x - ps.x);
      let da = a - this.lastAngle;
      if (da > Math.PI) da -= 2 * Math.PI;
      if (da < -Math.PI) da += 2 * Math.PI;
      this.angleTotal += da;
      this.lastAngle = a;
      screenAngle = this.angleTotal;
    }
    // Screen y points down, so a positive screen angle is clockwise. Rotation around an axis
    // that points at the viewer is counter-clockwise for positive angles.
    const axis = this.rotAxis();
    const toViewer = this.cam.dir();
    const sign = axis[0] * toViewer.x + axis[1] * toViewer.y + axis[2] * toViewer.z >= 0 ? -1 : 1;
    let angle = sign * screenAngle;
    if (this.snap.enabled) {
      const inc = (this.snap.rotateDeg * Math.PI) / 180;
      angle = Math.round(angle / inc) * inc;
    }
    const c = this.constraint;
    this.value = (angle * 180) / Math.PI;
    this.label = `${fmt(this.value, 1)}°  ${c ? (c.kind === 'dir' ? c.label : 'XYZ'[c.axis]) : 'view'}`;
    return angle;
  }

  private applyRotate(angle: number): void {
    const R = axisAngleToRot(this.rotAxis(), angle);
    const p = this.pivot;
    for (const t of this.objTargets) {
      const rel: Vec3 = [t.loc[0] - p[0], t.loc[1] - p[1], t.loc[2] - p[2]];
      const r = apply3(R, rel);
      t.obj.location = [p[0] + r[0], p[1] + r[1], p[2] + r[2]];
      t.obj.rotation_euler = compatibleEuler(rotToEuler(mulRot(R, eulerToRot(t.rot))), t.rot);
    }
    if (this.edit) {
      const axis = this.rotAxis();
      this.applyEdit((w, k) => {
        const Rk = k === 1 ? R : axisAngleToRot(axis, angle * k);
        const r = apply3(Rk, [w[0] - p[0], w[1] - p[1], w[2] - p[2]]);
        return [p[0] + r[0], p[1] + r[1], p[2] + r[2]];
      });
    }
    this.reapply = () => this.applyRotate(angle);
  }

  // --- Scale --------------------------------------------------------------------------------
  private computeScale(): number {
    const ps = this.pivotScreen();
    const d0 = Math.hypot(this.start.x - ps.x, this.start.y - ps.y);
    let f: number;
    if (d0 < 24) f = Math.exp((this.virt.x - this.start.x) / 160);
    else f = Math.hypot(this.virt.x - ps.x, this.virt.y - ps.y) / d0;
    if (this.snap.enabled) f = Math.max(this.snap.scale, Math.round(f / this.snap.scale) * this.snap.scale);
    this.value = f;
    const c = this.constraint;
    this.label = `×${fmt(f, 3)}  ${c ? (c.kind === 'plane' ? `not ${'XYZ'[c.axis]}` : c.kind === 'axis' ? 'XYZ'[c.axis] : '') : ''}`;
    return f;
  }

  private scaleVec(f: number): Vec3 {
    const c = this.constraint;
    if (c?.kind === 'axis') return AXES[c.axis].map((a) => (a ? f : 1)) as Vec3;
    if (c?.kind === 'plane') return AXES[c.axis].map((a) => (a ? 1 : f)) as Vec3;
    return [f, f, f];
  }

  private applyScale(f: number): void {
    const s = this.scaleVec(f);
    const p = this.pivot;
    for (const t of this.objTargets) {
      t.obj.location = [p[0] + (t.loc[0] - p[0]) * s[0], p[1] + (t.loc[1] - p[1]) * s[1], p[2] + (t.loc[2] - p[2]) * s[2]];
      t.obj.scale = [t.scale[0] * s[0], t.scale[1] * s[1], t.scale[2] * s[2]];
    }
    if (this.edit) {
      this.applyEdit((w, k) => {
        const sk = [1 + (s[0] - 1) * k, 1 + (s[1] - 1) * k, 1 + (s[2] - 1) * k];
        return [p[0] + (w[0] - p[0]) * sk[0], p[1] + (w[1] - p[1]) * sk[1], p[2] + (w[2] - p[2]) * sk[2]];
      });
    }
    this.reapply = () => this.applyScale(f);
  }

  // --- Edit mode ----------------------------------------------------------------------------
  private reapply: (() => void) | null = null;

  /** Changes the proportional-editing radius mid-drag and re-applies the current transform. */
  setProportionalRadius(radius: number | null): void {
    const e = this.edit;
    if (!e) return;
    // Put everything back first, then rebuild the affected set from the original positions.
    const pos = e.obj.mesh.positions;
    for (let i = 0; i < e.all.length; i++) pos[i] = e.all[i];
    this.edit = makeEditTarget(e.obj, e.selected, radius, e.all);
    this.reapply?.();
  }

  private applyEdit(fn: (world: Vec3, weight: number) => Vec3): void {
    const e = this.edit!;
    const pos = e.obj.mesh.positions;
    for (let i = 0; i < e.verts.length; i++) {
      const w = transformPoint(e.m, [e.start[i * 3], e.start[i * 3 + 1], e.start[i * 3 + 2]]);
      const l = transformPoint(e.inv, fn(w, e.weights[i]));
      const v = e.verts[i] * 3;
      pos[v] = l[0];
      pos[v + 1] = l[1];
      pos[v + 2] = l[2];
    }
    for (const m of e.obj.modifiers) if (m.type === 'MIRROR' && m.show_viewport) applyMirrorClip(m, e.verts, e.all, pos);
    e.obj.mesh.touchPositions();
  }

  /** Restores the state from before the drag. */
  cancel(): void {
    for (const t of this.objTargets) {
      t.obj.location = t.loc;
      t.obj.rotation_euler = t.rot;
      t.obj.scale = t.scale;
    }
    if (this.edit) {
      const e = this.edit;
      const pos = e.obj.mesh.positions;
      for (let i = 0; i < e.verts.length; i++) {
        const v = e.verts[i] * 3;
        pos[v] = e.start[i * 3];
        pos[v + 1] = e.start[i * 3 + 1];
        pos[v + 2] = e.start[i * 3 + 2];
      }
      e.obj.mesh.touchPositions();
    }
  }

  get objects(): SceneObject[] {
    return this.objTargets.map((t) => t.obj);
  }
}

/**
 * What an edit-mode transform moves. With `proportional` (a world-space radius), unselected
 * vertices within that distance of the selection follow with Blender's "Smooth" falloff.
 */
export function makeEditTarget(
  obj: SceneObject,
  selected: number[],
  proportional: number | null = null,
  original: ArrayLike<number> = obj.mesh.positions,
): EditTarget {
  const m = objectMatrix(obj);
  const all = Float64Array.from(original);
  const list = [...selected];
  const weights: number[] = selected.map(() => 1);
  if (proportional && proportional > 0) {
    const R = proportional;
    const isSel = new Uint8Array(all.length / 3);
    for (const v of selected) isSel[v] = 1;
    const world = (i: number) => transformPoint(m, [all[i * 3], all[i * 3 + 1], all[i * 3 + 2]]);
    const selWorld = selected.map(world);
    for (let i = 0; i < all.length / 3; i++) {
      if (isSel[i]) continue;
      const w = world(i);
      let best = Infinity;
      for (const s of selWorld) {
        const d = (w[0] - s[0]) ** 2 + (w[1] - s[1]) ** 2 + (w[2] - s[2]) ** 2;
        if (d < best) best = d;
      }
      const d = Math.sqrt(best);
      if (d >= R) continue;
      const t = 1 - d / R;
      list.push(i);
      weights.push(3 * t * t - 2 * t * t * t);
    }
  }
  const v = Int32Array.from(list);
  const start = new Float64Array(v.length * 3);
  v.forEach((vi, i) => start.set([all[vi * 3], all[vi * 3 + 1], all[vi * 3 + 2]], i * 3));
  return { obj, verts: v, start, m, inv: invert(m), all, weights: Float32Array.from(weights), selected: [...selected] };
}

const apply3 = (r: number[][], v: Vec3): Vec3 => [
  r[0][0] * v[0] + r[0][1] * v[1] + r[0][2] * v[2],
  r[1][0] * v[0] + r[1][1] * v[1] + r[1][2] * v[2],
  r[2][0] * v[0] + r[2][1] * v[1] + r[2][2] * v[2],
];

function fmt(n: number, digits = 3): string {
  const s = n.toFixed(digits);
  return s.startsWith('-0.') && Number(s) === 0 ? s.slice(1) : s;
}
