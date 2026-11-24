// Turntable orbit camera around a target, Z-up like Blender. Orientation is built directly from
// yaw/pitch (no lookAt), so straight top/bottom views have no gimbal problems.
//
// Like Blender's "Auto Perspective": snapping to front/side/top switches to orthographic, and
// orbiting away switches back to perspective.

import * as THREE from 'three';

export type ViewName = 'front' | 'back' | 'right' | 'left' | 'top' | 'bottom';

const VIEWS: Record<ViewName, [number, number]> = {
  front: [0, 0],
  back: [Math.PI, 0],
  right: [Math.PI / 2, 0],
  left: [-Math.PI / 2, 0],
  top: [0, Math.PI / 2],
  bottom: [0, -Math.PI / 2],
};

const FOV_MIN_SIDE = 42; // degrees across the shorter screen side

export class OrbitCamera {
  target = new THREE.Vector3(0, 0, 0);
  distance = 9;
  yaw = 0.82;
  pitch = 0.42;
  ortho = false;
  autoPerspective = true;

  /** Incremented on every view change (lets cached screen projections know they are stale). */
  version = 0;
  readonly persp = new THREE.PerspectiveCamera(40, 1, 0.01, 2000);
  readonly orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
  private width = 1;
  private height = 1;
  private anim: { from: number[]; to: number[]; t0: number; dur: number } | null = null;

  get camera(): THREE.Camera {
    return this.ortho ? this.orthoCam : this.persp;
  }

  setSize(w: number, h: number): void {
    this.width = Math.max(1, w);
    this.height = Math.max(1, h);
    this.update();
  }

  get size(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  /** Vertical field of view in radians (the shorter side always gets FOV_MIN_SIDE). */
  get vfov(): number {
    const base = THREE.MathUtils.degToRad(FOV_MIN_SIDE);
    if (this.height <= this.width) return base;
    return 2 * Math.atan(Math.tan(base / 2) * (this.height / this.width));
  }

  /** Unit vector from target towards the camera. */
  dir(): THREE.Vector3 {
    const cp = Math.cos(this.pitch);
    return new THREE.Vector3(cp * Math.sin(this.yaw), -cp * Math.cos(this.yaw), Math.sin(this.pitch));
  }
  right(): THREE.Vector3 {
    return new THREE.Vector3(Math.cos(this.yaw), Math.sin(this.yaw), 0);
  }
  up(): THREE.Vector3 {
    return this.dir().cross(this.right());
  }

  /** Steps any running view animation; returns true while it is still animating. */
  tick(now: number): boolean {
    if (!this.anim) return false;
    const { from, to, t0, dur } = this.anim;
    const k = Math.min(1, (now - t0) / dur);
    const e = 1 - Math.pow(1 - k, 3);
    this.yaw = from[0] + (to[0] - from[0]) * e;
    this.pitch = from[1] + (to[1] - from[1]) * e;
    this.distance = from[2] + (to[2] - from[2]) * e;
    this.target.set(from[3] + (to[3] - from[3]) * e, from[4] + (to[4] - from[4]) * e, from[5] + (to[5] - from[5]) * e);
    if (k >= 1) this.anim = null;
    this.update();
    return this.anim !== null;
  }

  get animating(): boolean {
    return this.anim !== null;
  }

  update(): void {
    this.version++;
    const d = this.dir(), r = this.right(), u = d.clone().cross(r);
    const basis = new THREE.Matrix4().makeBasis(r, u, d);
    const q = new THREE.Quaternion().setFromRotationMatrix(basis);
    const pos = this.target.clone().addScaledVector(d, this.distance);
    const aspect = this.width / this.height;
    for (const cam of [this.persp, this.orthoCam]) {
      cam.position.copy(pos);
      cam.quaternion.copy(q);
    }
    this.persp.fov = THREE.MathUtils.radToDeg(this.vfov);
    this.persp.aspect = aspect;
    this.persp.near = Math.max(0.001, this.distance / 100);
    this.persp.far = this.distance * 60 + 100;
    this.persp.updateProjectionMatrix();
    const hh = this.distance * Math.tan(this.vfov / 2);
    this.orthoCam.left = -hh * aspect;
    this.orthoCam.right = hh * aspect;
    this.orthoCam.top = hh;
    this.orthoCam.bottom = -hh;
    this.orthoCam.near = -this.distance * 200 - 100;
    this.orthoCam.far = this.distance * 200 + 100;
    this.orthoCam.updateProjectionMatrix();
    this.persp.updateMatrixWorld();
    this.orthoCam.updateMatrixWorld();
  }

  orbit(dxPx: number, dyPx: number): void {
    this.anim = null;
    const k = 0.0085;
    this.yaw -= dxPx * k;
    this.pitch = THREE.MathUtils.clamp(this.pitch + dyPx * k, -Math.PI / 2, Math.PI / 2);
    if (this.autoPerspective) this.ortho = false;
    this.update();
  }

  /** World units per screen pixel at the target's depth. */
  worldPerPixel(): number {
    return (2 * this.distance * Math.tan(this.vfov / 2)) / this.height;
  }

  pan(dxPx: number, dyPx: number): void {
    this.anim = null;
    const w = this.worldPerPixel();
    this.target.addScaledVector(this.right(), -dxPx * w).addScaledVector(this.up(), dyPx * w);
    this.update();
  }

  /** Zooms by `factor` (<1 = closer) keeping the point under `at` (CSS px) fixed. */
  zoom(factor: number, at?: { x: number; y: number }): void {
    this.anim = null;
    const f = THREE.MathUtils.clamp(factor, 0.2, 5);
    const next = THREE.MathUtils.clamp(this.distance * f, 0.02, 2000);
    const real = next / this.distance;
    if (at) {
      const w = this.worldPerPixel();
      const ox = (at.x - this.width / 2) * w, oy = -(at.y - this.height / 2) * w;
      const shift = 1 - real;
      this.target.addScaledVector(this.right(), ox * shift).addScaledVector(this.up(), oy * shift);
    }
    this.distance = next;
    this.update();
  }

  setView(name: ViewName): void {
    const [y, p] = VIEWS[name];
    // Take the short way around.
    let yaw = y;
    while (yaw - this.yaw > Math.PI) yaw -= 2 * Math.PI;
    while (yaw - this.yaw < -Math.PI) yaw += 2 * Math.PI;
    if (this.autoPerspective) this.ortho = true;
    this.animateTo(yaw, p, this.distance, this.target);
  }

  /** Frames a bounding sphere. */
  frame(center: THREE.Vector3, radius: number): void {
    const r = Math.max(radius, 0.05);
    // Fit the sphere in the narrower field of view, with room for the toolbars.
    const fovMin = THREE.MathUtils.degToRad(FOV_MIN_SIDE);
    const dist = (r / Math.sin(fovMin / 2)) * 1.25;
    this.animateTo(this.yaw, this.pitch, dist, center);
  }

  private animateTo(yaw: number, pitch: number, distance: number, target: THREE.Vector3): void {
    this.anim = {
      from: [this.yaw, this.pitch, this.distance, this.target.x, this.target.y, this.target.z],
      to: [yaw, pitch, distance, target.x, target.y, target.z],
      t0: performance.now(),
      dur: 260,
    };
  }

  /** Projects a world point to CSS pixels; z is NDC depth (-1 near … 1 far). */
  project(p: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
    out.copy(p).project(this.camera);
    out.x = (out.x * 0.5 + 0.5) * this.width;
    out.y = (-out.y * 0.5 + 0.5) * this.height;
    return out;
  }

  /** World-space ray through a CSS pixel. */
  ray(x: number, y: number): THREE.Ray {
    const ndc = new THREE.Vector2((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.camera);
    return rc.ray;
  }

  snapshot() {
    return { target: this.target.toArray(), distance: this.distance, yaw: this.yaw, pitch: this.pitch, ortho: this.ortho };
  }
  restore(s: ReturnType<OrbitCamera['snapshot']>): void {
    this.target.fromArray(s.target);
    this.distance = s.distance;
    this.yaw = s.yaw;
    this.pitch = s.pitch;
    this.ortho = s.ortho;
    this.update();
  }
}
