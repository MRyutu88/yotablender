// Owns the WebGL renderer, the scene graph and the render-on-demand loop. Frames are drawn only
// when something changed (or while a camera animation runs), which saves battery on the phone.

import * as THREE from 'three';
import { OrbitCamera } from './camera';
import { ObjectView } from './objectView';
import { Gizmo } from './gizmo';
import { COLORS, makeMatcap, makePointMaterial } from './materials';

export interface FrameStats {
  frameMs: number;
  fps: number;
}

export class Viewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly overlay = new THREE.Scene();
  readonly cam = new OrbitCamera();
  readonly gizmo = new Gizmo();
  readonly views = new Map<string, ObjectView>();
  readonly matcap: THREE.Texture;
  readonly pointMat: THREE.ShaderMaterial;
  /** Called before every frame so the app can sync scene data into the views. */
  onBeforeFrame: (() => void) | null = null;
  /** Called right after a frame was drawn (e.g. to copy pixels into the loupe). */
  onAfterFrame: ((stats: FrameStats) => void) | null = null;

  private pending = false;
  private width = 1;
  private height = 1;
  private dpr = 1;
  private frameTimes: number[] = [];
  private depthTarget: THREE.WebGLRenderTarget | null = null;
  private depthMat: THREE.ShaderMaterial;
  private floatDepthOk: boolean;
  readonly grid: THREE.Group;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setClearColor(COLORS.background, 1);
    this.renderer.autoClear = false;
    this.matcap = makeMatcap();
    this.pointMat = makePointMaterial();
    this.grid = makeGrid();
    this.scene.add(this.grid);
    this.overlay.add(this.gizmo.group);
    this.floatDepthOk = this.renderer.extensions.has('EXT_color_buffer_float');
    this.depthMat = new THREE.ShaderMaterial({
      vertexShader: /* glsl */ `
        varying float vDepth;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vDepth = -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying float vDepth;
        void main() { gl_FragColor = vec4(vDepth, 0.0, 0.0, 1.0); }`,
      side: THREE.DoubleSide,
    });
    canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
    canvas.addEventListener('webglcontextrestored', () => this.requestRender());
  }

  resize(w: number, h: number): void {
    this.width = Math.max(1, Math.floor(w));
    this.height = Math.max(1, Math.floor(h));
    // The S24 reports a pixel ratio of ~3; 2 is plenty and saves a lot of fill rate.
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setSize(this.width, this.height, false);
    this.cam.setSize(this.width, this.height);
    this.pointMat.uniforms.pixelRatio.value = this.dpr;
    for (const v of this.views.values()) v.setResolution(this.width, this.height, this.dpr);
    this.requestRender();
  }

  get size() {
    return { width: this.width, height: this.height, dpr: this.dpr };
  }

  requestRender(): void {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame((t) => this.frame(t));
  }

  view(id: string): ObjectView {
    let v = this.views.get(id);
    if (!v) {
      v = new ObjectView(this.matcap, this.pointMat);
      v.setResolution(this.width, this.height, this.dpr);
      this.views.set(id, v);
      this.scene.add(v.group);
    }
    return v;
  }

  /** Removes views for objects that no longer exist. */
  prune(alive: Set<string>): void {
    for (const [id, v] of this.views) {
      if (!alive.has(id)) {
        this.scene.remove(v.group);
        v.dispose();
        this.views.delete(id);
      }
    }
  }

  private frame(t: number): void {
    this.pending = false;
    const t0 = performance.now();
    const animating = this.cam.tick(t0);
    this.onBeforeFrame?.();
    const r = this.renderer;
    r.clear();
    r.render(this.scene, this.cam.camera);
    r.clearDepth();
    r.render(this.overlay, this.cam.camera);
    const frameMs = performance.now() - t0;
    this.frameTimes.push(t);
    while (this.frameTimes.length > 30) this.frameTimes.shift();
    const span = this.frameTimes.length > 1 ? this.frameTimes[this.frameTimes.length - 1] - this.frameTimes[0] : 0;
    const fps = span > 0 ? ((this.frameTimes.length - 1) * 1000) / span : 0;
    this.onAfterFrame?.({ frameMs, fps });
    if (animating) this.requestRender();
  }

  /**
   * Renders the surfaces' view-space depth at reduced resolution and returns a sampler used to
   * test whether a point is hidden behind geometry (for touch picking without X-ray).
   * Returns null when float render targets are unavailable (then nothing is treated as hidden).
   */
  readDepth(scale = 0.5): ((x: number, y: number) => number) | null {
    if (!this.floatDepthOk) return null;
    const w = Math.max(1, Math.floor(this.width * scale)), h = Math.max(1, Math.floor(this.height * scale));
    if (!this.depthTarget || this.depthTarget.width !== w || this.depthTarget.height !== h) {
      this.depthTarget?.dispose();
      this.depthTarget = new THREE.WebGLRenderTarget(w, h, { type: THREE.FloatType, format: THREE.RGBAFormat });
    }
    // Hide everything that isn't a surface.
    const hidden: THREE.Object3D[] = [];
    this.scene.traverse((o) => {
      if (o.visible && (o instanceof THREE.Points || o instanceof THREE.Line || o.type === 'LineSegments2' || o === this.grid)) {
        hidden.push(o);
        o.visible = false;
      }
    });
    const shown: THREE.Object3D[] = [];
    for (const v of this.views.values()) {
      // The edited object occludes with its cage (what the user sees and picks), others with
      // their evaluated surface.
      const occluder = v.editing ? v.cageSurface : v.surface;
      v.group.children.forEach((c) => {
        if (c !== occluder && c.visible) {
          hidden.push(c);
          c.visible = false;
        }
      });
      if (!occluder.visible) {
        occluder.visible = true;
        shown.push(occluder);
      }
    }
    const r = this.renderer;
    const prevClear = r.getClearColor(new THREE.Color()), prevAlpha = r.getClearAlpha();
    r.setRenderTarget(this.depthTarget);
    r.setClearColor(new THREE.Color(1e9, 0, 0), 1);
    r.clear();
    this.scene.overrideMaterial = this.depthMat;
    r.render(this.scene, this.cam.camera);
    this.scene.overrideMaterial = null;
    r.setRenderTarget(null);
    r.setClearColor(prevClear, prevAlpha);
    for (const o of hidden) o.visible = true;
    for (const o of shown) o.visible = false;
    const buf = new Float32Array(w * h * 4);
    r.readRenderTargetPixels(this.depthTarget, 0, 0, w, h, buf);
    this.requestRender();
    return (x, y) => {
      // Smallest depth in a 3x3 neighbourhood so thin silhouettes don't hide vertices.
      const cx = Math.floor(x * scale), cy = h - 1 - Math.floor(y * scale);
      let d = 1e9;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const px = cx + dx, py = cy + dy;
          if (px < 0 || py < 0 || px >= w || py >= h) continue;
          const v = buf[(py * w + px) * 4];
          if (v > 0 && v < d) d = v;
        }
      return d;
    };
  }

  /** View-space depth of a world point (distance along the view direction). */
  viewDepth(p: THREE.Vector3): number {
    const cam = this.cam.camera;
    return -p.clone().applyMatrix4(cam.matrixWorldInverse).z;
  }
}

function makeGrid(): THREE.Group {
  const g = new THREE.Group();
  const size = 40;
  const minor = new THREE.GridHelper(size, size, COLORS.gridMinor, COLORS.gridMinor);
  minor.rotation.x = Math.PI / 2; // GridHelper is XZ; Blender's floor is XY
  const major = new THREE.GridHelper(size, size / 5, COLORS.gridMajor, COLORS.gridMajor);
  major.rotation.x = Math.PI / 2;
  for (const m of [minor, major]) {
    const mat = m.material as THREE.Material;
    mat.transparent = true;
    mat.opacity = 0.9;
    mat.depthWrite = false;
  }
  const axis = (color: number, a: THREE.Vector3, b: THREE.Vector3) => {
    const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
    const l = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, depthWrite: false }));
    l.renderOrder = 1;
    return l;
  };
  g.add(minor, major);
  g.add(axis(COLORS.axisX, new THREE.Vector3(-size / 2, 0, 0), new THREE.Vector3(size / 2, 0, 0)));
  g.add(axis(COLORS.axisY, new THREE.Vector3(0, -size / 2, 0), new THREE.Vector3(0, size / 2, 0)));
  g.renderOrder = -10;
  return g;
}
