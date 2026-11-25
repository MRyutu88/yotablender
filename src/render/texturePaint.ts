// Texture painting on the GPU, like Blender's projection painting.
//
// Each object with a paint texture owns a PaintLayer: two RGBA8 render targets (the committed
// paint and the one shown while a stroke is in progress), a coverage mask of its UV islands and
// a CPU copy of the committed pixels (for undo and saving). Pixels are sRGB with straight alpha;
// rows run bottom-up (v = 0 first), like GL and Blender.
//
// A dab renders the object's evaluated surface *in UV space*: every texel computes where its
// surface point lands on screen, and is painted when that point is inside the brush circle,
// faces the camera and isn't hidden (compared with a depth pass of the current view). Mirrored
// halves share UVs, so both halves' texels get painted: symmetric painting for free.
// Dabs accumulate (max) into a stroke mask, so a stroke never gets darker than its strength;
// the stroke is composited over the committed paint, and texels just outside the islands copy
// their nearest painted neighbour so seams don't show (texture filtering, Blender, mipmaps).

import * as THREE from 'three';
import { encodePng, decodePng } from '../core/io/png';

export const TILE = 64;

export interface PaintTile {
  x: number;
  y: number;
  w: number;
  h: number;
  before: Uint8Array;
  after: Uint8Array;
}

export class PaintLayer {
  readonly targets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  committed = 0;
  stroking = false;
  /** Committed pixels (RGBA, bottom row first). */
  cpu: Uint8Array;
  coverage: THREE.WebGLRenderTarget;
  coverageKey = -1;
  /** Bumped whenever the committed pixels change (PNG needs re-encoding). */
  version = 0;
  encodedVersion = 0;

  constructor(readonly size: number) {
    const opts = {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
      depthBuffer: false,
    };
    this.targets = [new THREE.WebGLRenderTarget(size, size, opts), new THREE.WebGLRenderTarget(size, size, opts)];
    this.coverage = new THREE.WebGLRenderTarget(size, size, { ...opts, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.cpu = new Uint8Array(size * size * 4);
  }

  /** What the object shows right now (the stroke preview while painting). */
  get texture(): THREE.Texture {
    return this.targets[this.stroking ? 1 - this.committed : this.committed].texture;
  }

  dispose(): void {
    for (const t of this.targets) t.dispose();
    this.coverage.dispose();
  }
}

/** The object to paint: its evaluated surface geometry (with a `uv` attribute) and transform. */
export interface PaintSurface {
  geometry: THREE.BufferGeometry;
  matrixWorld: THREE.Matrix4;
  /** Topology key of the geometry (coverage is rebuilt when it changes). */
  topoKey: number;
}

export interface BrushDab {
  /** CSS px from the top-left of the viewport. */
  x: number;
  y: number;
  radius: number;
  strength: number;
  /** 0 = soft, 1 = hard edge. */
  hardness: number;
}

const FULLSCREEN_VS = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const UV_SPACE_VS = /* glsl */ `
  uniform mat4 uModel;
  uniform mat4 uViewProj;
  uniform mat3 uNormalMat;
  varying vec4 vClip;
  varying vec3 vWorld;
  varying vec3 vNormal;
  void main() {
    vec4 w = uModel * vec4(position, 1.0);
    vWorld = w.xyz;
    vClip = uViewProj * w;
    vNormal = uNormalMat * normal;
    gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
  }`;

const DAB_FS = /* glsl */ `
  uniform vec2 uCenter;
  uniform float uRadius;
  uniform vec2 uViewport;
  uniform float uStrength;
  uniform float uHardness;
  uniform sampler2D uDepth;
  uniform float uNear;
  uniform float uFar;
  uniform bool uOrtho;
  uniform vec3 uCamPos;
  uniform vec3 uCamDir;
  varying vec4 vClip;
  varying vec3 vWorld;
  varying vec3 vNormal;
  float linearDepth(float d) {
    float z = d * 2.0 - 1.0;
    return uOrtho ? (z + 1.0) * 0.5 * (uFar - uNear) + uNear : (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
  }
  void main() {
    if (vClip.w <= 0.0) discard;
    vec3 ndc = vClip.xyz / vClip.w;
    if (abs(ndc.x) > 1.0 || abs(ndc.y) > 1.0) discard;
    vec2 px = vec2((ndc.x * 0.5 + 0.5) * uViewport.x, (0.5 - ndc.y * 0.5) * uViewport.y);
    float d = distance(px, uCenter);
    if (d > uRadius) discard;
    vec3 toCam = uOrtho ? -uCamDir : normalize(uCamPos - vWorld);
    float facing = dot(normalize(vNormal), toCam);
    if (facing <= 0.02) discard;
    // Hidden behind the surface the user sees? (a little slack, relative to the distance)
    float mine = linearDepth(ndc.z * 0.5 + 0.5);
    float seen = linearDepth(texture2D(uDepth, ndc.xy * 0.5 + 0.5).r);
    if (mine > seen * 1.004 + 0.002) discard;
    float t = d / uRadius;
    float fall = 1.0 - smoothstep(min(uHardness, 0.98), 1.0, t);
    float grazing = smoothstep(0.02, 0.3, facing);
    gl_FragColor = vec4(fall * uStrength * grazing, 0.0, 0.0, 1.0);
  }`;

/** Composite of the stroke over the committed paint, with dilation outside the UV islands. */
const COMPOSE_FS = /* glsl */ `
  uniform sampler2D uBase;
  uniform sampler2D uMask;
  uniform sampler2D uCoverage;
  uniform vec3 uColor;
  uniform int uMode; // 0 draw, 1 erase
  uniform vec2 uTexel;
  varying vec2 vUv;
  vec4 comp(vec2 uv) {
    vec4 b = texture2D(uBase, uv);
    float m = texture2D(uMask, uv).r;
    if (uMode == 1) return vec4(b.rgb, b.a * (1.0 - m));
    float a = m + b.a * (1.0 - m);
    vec3 c = a > 0.0 ? (uColor * m + b.rgb * b.a * (1.0 - m)) / a : (b.a > 0.0 ? b.rgb : uColor);
    return vec4(c, a);
  }
  void main() {
    if (texture2D(uCoverage, vUv).r > 0.5) { gl_FragColor = comp(vUv); return; }
    for (int r = 1; r <= 4; r++) {
      for (int k = 0; k < 8; k++) {
        float ang = float(k) * 0.7853982;
        vec2 q = vUv + vec2(cos(ang), sin(ang)) * float(r) * uTexel;
        if (texture2D(uCoverage, q).r > 0.5) { gl_FragColor = comp(q); return; }
      }
    }
    gl_FragColor = texture2D(uBase, vUv);
  }`;

const COPY_FS = /* glsl */ `
  uniform sampler2D uSrc;
  varying vec2 vUv;
  void main() { gl_FragColor = texture2D(uSrc, vUv); }`;

/** Flattened texture for OBJ export: slot color (or vertex color) with the paint over it. */
const FLAT_BASE_VS = /* glsl */ `
  attribute vec3 color;
  varying vec3 vColor;
  void main() { vColor = color; gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0); }`;
const FLAT_BASE_FS = /* glsl */ `
  uniform vec3 uColor;
  uniform bool uUseVertex;
  varying vec3 vColor;
  vec3 toSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(max(c, 0.0), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
  void main() { gl_FragColor = vec4(toSrgb(uUseVertex ? vColor : uColor), 1.0); }`;
const FLAT_OVER_FS = /* glsl */ `
  uniform sampler2D uBase;
  uniform sampler2D uPaint;
  uniform sampler2D uCoverage;
  uniform vec2 uTexel;
  varying vec2 vUv;
  vec4 over(vec2 uv) {
    vec4 b = texture2D(uBase, uv), p = texture2D(uPaint, uv);
    return vec4(mix(b.rgb, p.rgb, p.a), 1.0);
  }
  void main() {
    if (texture2D(uCoverage, vUv).r > 0.5) { gl_FragColor = over(vUv); return; }
    for (int r = 1; r <= 4; r++) {
      for (int k = 0; k < 8; k++) {
        float ang = float(k) * 0.7853982;
        vec2 q = vUv + vec2(cos(ang), sin(ang)) * float(r) * uTexel;
        if (texture2D(uCoverage, q).r > 0.5) { gl_FragColor = over(q); return; }
      }
    }
    gl_FragColor = over(vUv);
  }`;

export class TexturePainter {
  private quadScene = new THREE.Scene();
  private quad: THREE.Mesh;
  private uvScene = new THREE.Scene();
  private uvMesh: THREE.Mesh;
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private dabMat: THREE.ShaderMaterial;
  private composeMat: THREE.ShaderMaterial;
  private copyMat: THREE.ShaderMaterial;
  private coverMat: THREE.ShaderMaterial;
  private mask: THREE.WebGLRenderTarget | null = null;
  private depth: THREE.WebGLRenderTarget | null = null;
  private depthScene = new THREE.Scene();
  private depthMesh: THREE.Mesh;
  private stroke: { layer: PaintLayer; surface: PaintSurface; color: [number, number, number]; mode: 0 | 1 } | null = null;
  private worker: Worker | null | undefined;
  private jobs = new Map<number, (png: Uint8Array) => void>();
  private nextJob = 1;

  constructor(private renderer: THREE.WebGLRenderer) {
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
    this.uvMesh = new THREE.Mesh();
    this.uvMesh.frustumCulled = false;
    this.uvScene.add(this.uvMesh);
    this.depthMesh = new THREE.Mesh(undefined, new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide }));
    this.depthMesh.frustumCulled = false;
    this.depthMesh.matrixAutoUpdate = false;
    this.depthScene.add(this.depthMesh);
    this.dabMat = new THREE.ShaderMaterial({
      uniforms: {
        uModel: { value: new THREE.Matrix4() },
        uViewProj: { value: new THREE.Matrix4() },
        uNormalMat: { value: new THREE.Matrix3() },
        uCenter: { value: new THREE.Vector2() },
        uRadius: { value: 10 },
        uViewport: { value: new THREE.Vector2(1, 1) },
        uStrength: { value: 1 },
        uHardness: { value: 0.5 },
        uDepth: { value: null },
        uNear: { value: 0.1 },
        uFar: { value: 100 },
        uOrtho: { value: false },
        uCamPos: { value: new THREE.Vector3() },
        uCamDir: { value: new THREE.Vector3() },
      },
      vertexShader: UV_SPACE_VS,
      fragmentShader: DAB_FS,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.MaxEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    });
    this.composeMat = new THREE.ShaderMaterial({
      uniforms: {
        uBase: { value: null },
        uMask: { value: null },
        uCoverage: { value: null },
        uColor: { value: new THREE.Vector3() },
        uMode: { value: 0 },
        uTexel: { value: new THREE.Vector2() },
      },
      vertexShader: FULLSCREEN_VS,
      fragmentShader: COMPOSE_FS,
      depthTest: false,
      depthWrite: false,
    });
    this.copyMat = new THREE.ShaderMaterial({
      uniforms: { uSrc: { value: null } },
      vertexShader: FULLSCREEN_VS,
      fragmentShader: COPY_FS,
      depthTest: false,
      depthWrite: false,
    });
    this.coverMat = new THREE.ShaderMaterial({
      vertexShader: 'void main() { gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0); }',
      fragmentShader: 'void main() { gl_FragColor = vec4(1.0); }',
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
    });
  }

  // --- Layers ----------------------------------------------------------------------------

  /** A layer filled from a PNG (or transparent when none is given). */
  createLayer(size: number, png?: Uint8Array): PaintLayer {
    const layer = new PaintLayer(size);
    if (png) {
      const img = decodePng(png);
      if (img.width === size && img.height === size) {
        // PNG rows are top-first; ours are bottom-first.
        const row = size * 4;
        for (let y = 0; y < size; y++) layer.cpu.set(img.rgba.subarray((size - 1 - y) * row, (size - y) * row), y * row);
      }
    }
    this.upload(layer);
    layer.encodedVersion = layer.version;
    return layer;
  }

  /** Copies layer.cpu to the GPU (committed target). */
  upload(layer: PaintLayer): void {
    const tex = new THREE.DataTexture(layer.cpu, layer.size, layer.size, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.needsUpdate = true;
    this.copyMat.uniforms.uSrc.value = tex;
    this.drawQuad(this.copyMat, layer.targets[layer.committed]);
    tex.dispose();
  }

  /** Reads the committed target back into layer.cpu. */
  private download(layer: PaintLayer): void {
    this.renderer.readRenderTargetPixels(layer.targets[layer.committed], 0, 0, layer.size, layer.size, layer.cpu);
  }

  /** Rasterizes the UV islands (texels the surface covers) for dilation. */
  ensureCoverage(layer: PaintLayer, surface: PaintSurface): void {
    if (layer.coverageKey === surface.topoKey) return;
    layer.coverageKey = surface.topoKey;
    this.withTarget(layer.coverage, () => {
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.clear();
      this.uvMesh.geometry = surface.geometry;
      this.uvMesh.material = this.coverMat;
      this.renderer.render(this.uvScene, this.cam);
    });
  }

  // --- Strokes ----------------------------------------------------------------------------

  /**
   * Starts a stroke on `layer` as seen from `camera` (viewport size in CSS px).
   * `color` is sRGB 0..1; mode 1 erases.
   */
  beginStroke(layer: PaintLayer, surface: PaintSurface, camera: THREE.Camera, viewport: { width: number; height: number; dpr: number }, color: [number, number, number], mode: 0 | 1): void {
    this.ensureCoverage(layer, surface);
    const size = layer.size;
    if (!this.mask || this.mask.width !== size) {
      this.mask?.dispose();
      this.mask = new THREE.WebGLRenderTarget(size, size, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat, generateMipmaps: false, depthBuffer: false });
    }
    this.withTarget(this.mask, () => {
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.clear();
    });
    // Depth of the surface as the user sees it (for "only paint what's visible").
    const w = Math.max(1, Math.round(viewport.width * viewport.dpr * 0.5)), h = Math.max(1, Math.round(viewport.height * viewport.dpr * 0.5));
    if (!this.depth || this.depth.width !== w || this.depth.height !== h) {
      this.depth?.dispose();
      this.depth = new THREE.WebGLRenderTarget(w, h, { depthBuffer: true, depthTexture: new THREE.DepthTexture(w, h, THREE.UnsignedIntType) });
    }
    this.depthMesh.geometry = surface.geometry;
    this.depthMesh.matrix.copy(surface.matrixWorld);
    this.depthMesh.matrixWorld.copy(surface.matrixWorld);
    this.withTarget(this.depth, () => {
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.clear(true, true);
      this.renderer.render(this.depthScene, camera);
    });

    const u = this.dabMat.uniforms;
    camera.updateMatrixWorld();
    u.uModel.value.copy(surface.matrixWorld);
    u.uNormalMat.value.getNormalMatrix(surface.matrixWorld);
    u.uViewProj.value.multiplyMatrices((camera as THREE.PerspectiveCamera).projectionMatrix, camera.matrixWorldInverse);
    u.uViewport.value.set(viewport.width, viewport.height);
    u.uDepth.value = this.depth.depthTexture;
    const cam = camera as THREE.PerspectiveCamera | THREE.OrthographicCamera;
    u.uNear.value = cam.near;
    u.uFar.value = cam.far;
    u.uOrtho.value = (cam as THREE.OrthographicCamera).isOrthographicCamera === true;
    u.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
    camera.getWorldDirection(u.uCamDir.value);
    layer.stroking = true;
    this.stroke = { layer, surface, color, mode };
    this.compose();
  }

  dab(d: BrushDab): void {
    const s = this.stroke;
    if (!s || !this.mask) return;
    const u = this.dabMat.uniforms;
    u.uCenter.value.set(d.x, d.y);
    u.uRadius.value = d.radius;
    u.uStrength.value = d.strength;
    u.uHardness.value = d.hardness;
    this.withTarget(this.mask, () => {
      this.uvMesh.geometry = s.surface.geometry;
      this.uvMesh.material = this.dabMat;
      this.renderer.render(this.uvScene, this.cam);
    });
  }

  /** Updates the stroke preview (call once after a batch of dabs). */
  compose(): void {
    const s = this.stroke;
    if (!s || !this.mask) return;
    const l = s.layer;
    const u = this.composeMat.uniforms;
    u.uBase.value = l.targets[l.committed].texture;
    u.uMask.value = this.mask.texture;
    u.uCoverage.value = l.coverage.texture;
    u.uColor.value.set(...s.color);
    u.uMode.value = s.mode;
    u.uTexel.value.set(1 / l.size, 1 / l.size);
    this.drawQuad(this.composeMat, l.targets[1 - l.committed]);
  }

  /** Commits the stroke and returns the changed tiles (for undo). */
  endStroke(): PaintTile[] {
    const s = this.stroke;
    this.stroke = null;
    if (!s) return [];
    const l = s.layer;
    l.stroking = false;
    l.committed = 1 - l.committed;
    const before = l.cpu.slice();
    this.download(l);
    const tiles = diffTiles(l.size, before, l.cpu);
    if (tiles.length) l.version++;
    return tiles;
  }

  get painting(): boolean {
    return !!this.stroke;
  }

  /** Paints the whole surface (mask = every island) with `color`, or erases it. */
  fill(layer: PaintLayer, surface: PaintSurface, color: [number, number, number], mode: 0 | 1): PaintTile[] {
    this.ensureCoverage(layer, surface);
    const u = this.composeMat.uniforms;
    u.uBase.value = layer.targets[layer.committed].texture;
    u.uMask.value = layer.coverage.texture;
    u.uCoverage.value = layer.coverage.texture;
    u.uColor.value.set(...color);
    u.uMode.value = mode;
    u.uTexel.value.set(1 / layer.size, 1 / layer.size);
    this.drawQuad(this.composeMat, layer.targets[1 - layer.committed]);
    layer.committed = 1 - layer.committed;
    const before = layer.cpu.slice();
    this.download(layer);
    const tiles = diffTiles(layer.size, before, layer.cpu);
    if (tiles.length) layer.version++;
    return tiles;
  }

  /** Writes tiles (undo/redo). */
  putTiles(layer: PaintLayer, tiles: PaintTile[], which: 'before' | 'after'): void {
    const row = layer.size * 4;
    for (const t of tiles) {
      const src = t[which];
      for (let y = 0; y < t.h; y++) layer.cpu.set(src.subarray(y * t.w * 4, (y + 1) * t.w * 4), (t.y + y) * row + t.x * 4);
    }
    this.upload(layer);
    layer.version++;
  }

  /** Straight-alpha sRGB texel at a UV (from the CPU copy). */
  sample(layer: PaintLayer, u: number, v: number): [number, number, number, number] {
    const n = layer.size;
    const x = Math.min(n - 1, Math.max(0, Math.floor(u * n))), y = Math.min(n - 1, Math.max(0, Math.floor(v * n)));
    const i = (y * n + x) * 4;
    const c = layer.cpu;
    return [c[i], c[i + 1], c[i + 2], c[i + 3]];
  }

  // --- Export -----------------------------------------------------------------------------

  /** PNG of the layer (top row first), encoded off the main thread when possible. */
  encode(layer: PaintLayer): Promise<Uint8Array> {
    const rgba = flipRows(layer.cpu, layer.size, layer.size);
    const w = this.encoder();
    if (!w) return Promise.resolve(encodePng(rgba, layer.size, layer.size));
    const id = this.nextJob++;
    return new Promise((resolve) => {
      this.jobs.set(id, resolve);
      w.postMessage({ id, rgba, width: layer.size, height: layer.size }, [rgba.buffer]);
    });
  }

  private encoder(): Worker | null {
    if (this.worker !== undefined) return this.worker;
    try {
      this.worker = new Worker(new URL('./pngWorker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<{ id: number; png: Uint8Array }>) => {
        this.jobs.get(e.data.id)?.(e.data.png);
        this.jobs.delete(e.data.id);
      };
      this.worker.onerror = () => {
        // Fall back to encoding on the main thread from now on.
        this.worker = null;
      };
    } catch {
      this.worker = null;
    }
    return this.worker;
  }

  /**
   * The texture as it looks with the object's colors under the paint (opaque), for formats that
   * can't layer (OBJ/MTL). `slotColors` are linear RGB per material slot (geometry groups).
   */
  flatten(layer: PaintLayer, surface: PaintSurface, slotColors: [number, number, number][], useVertexColors: boolean): Uint8Array {
    this.ensureCoverage(layer, surface);
    const n = layer.size;
    const base = new THREE.WebGLRenderTarget(n, n, { type: THREE.UnsignedByteType, generateMipmaps: false, depthBuffer: false });
    const out = new THREE.WebGLRenderTarget(n, n, { type: THREE.UnsignedByteType, generateMipmaps: false, depthBuffer: false });
    const mats = slotColors.map(
      (c) =>
        new THREE.ShaderMaterial({
          uniforms: { uColor: { value: new THREE.Vector3(...c) }, uUseVertex: { value: useVertexColors } },
          vertexShader: FLAT_BASE_VS,
          fragmentShader: FLAT_BASE_FS,
          side: THREE.DoubleSide,
          depthTest: false,
          depthWrite: false,
        }),
    );
    this.withTarget(base, () => {
      this.renderer.setClearColor(0xcccccc, 1);
      this.renderer.clear();
      this.uvMesh.geometry = surface.geometry;
      this.uvMesh.material = mats.length ? mats : this.coverMat;
      this.renderer.render(this.uvScene, this.cam);
    });
    const over = new THREE.ShaderMaterial({
      uniforms: {
        uBase: { value: base.texture },
        uPaint: { value: layer.targets[layer.committed].texture },
        uCoverage: { value: layer.coverage.texture },
        uTexel: { value: new THREE.Vector2(1 / n, 1 / n) },
      },
      vertexShader: FULLSCREEN_VS,
      fragmentShader: FLAT_OVER_FS,
      depthTest: false,
      depthWrite: false,
    });
    this.drawQuad(over, out);
    const px = new Uint8Array(n * n * 4);
    this.renderer.readRenderTargetPixels(out, 0, 0, n, n, px);
    for (const m of mats) m.dispose();
    over.dispose();
    base.dispose();
    out.dispose();
    return encodePng(flipRows(px, n, n), n, n);
  }

  // --- Helpers ----------------------------------------------------------------------------

  private drawQuad(mat: THREE.Material, target: THREE.WebGLRenderTarget): void {
    this.quad.material = mat;
    this.withTarget(target, () => this.renderer.render(this.quadScene, this.cam));
  }

  private withTarget(target: THREE.WebGLRenderTarget, fn: () => void): void {
    const r = this.renderer;
    const prev = r.getRenderTarget();
    const prevClear = r.getClearColor(new THREE.Color()), prevAlpha = r.getClearAlpha();
    const prevAuto = r.autoClear;
    r.autoClear = false;
    r.setRenderTarget(target);
    fn();
    r.setRenderTarget(prev);
    r.setClearColor(prevClear, prevAlpha);
    r.autoClear = prevAuto;
  }
}

/** Rows bottom-first ↔ top-first. */
export function flipRows(px: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(px.length);
  const row = w * 4;
  for (let y = 0; y < h; y++) out.set(px.subarray(y * row, (y + 1) * row), (h - 1 - y) * row);
  return out;
}

/** The 64×64 tiles that differ between two images, with their before/after pixels. */
export function diffTiles(size: number, before: Uint8Array, after: Uint8Array): PaintTile[] {
  const tiles: PaintTile[] = [];
  const row = size * 4;
  for (let ty = 0; ty < size; ty += TILE) {
    for (let tx = 0; tx < size; tx += TILE) {
      const w = Math.min(TILE, size - tx), h = Math.min(TILE, size - ty);
      let changed = false;
      for (let y = 0; y < h && !changed; y++) {
        const o = (ty + y) * row + tx * 4;
        for (let i = 0; i < w * 4; i++) {
          if (before[o + i] !== after[o + i]) {
            changed = true;
            break;
          }
        }
      }
      if (!changed) continue;
      const b = new Uint8Array(w * h * 4), a = new Uint8Array(w * h * 4);
      for (let y = 0; y < h; y++) {
        const o = (ty + y) * row + tx * 4;
        b.set(before.subarray(o, o + w * 4), y * w * 4);
        a.set(after.subarray(o, o + w * 4), y * w * 4);
      }
      tiles.push({ x: tx, y: ty, w, h, before: b, after: a });
    }
  }
  return tiles;
}
