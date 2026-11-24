// Three.js view of one scene object: the evaluated (mirrored/subdivided) surface, a selection
// outline, and in Edit Mode the cage overlay (vertices, edges, selected faces, face dots).
// Geometry here is only a render target; the core mesh is the source of truth.

import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { EvalResult } from '../core/modifiers/stack';
import { objectMatrix as objMatrix, type SceneObject } from '../core/scene/scene';
import type { SelectMode } from '../core/mesh/selection';
import { allEdgeKeys, edgeFromKey, faceCenter } from '../core/mesh/mesh';
import { triangulate } from '../core/subdiv/catmullClark';
import { COLORS, makeOutlineMaterial } from './materials';

const tmpColor = new THREE.Color();

export interface CageState {
  selectMode: SelectMode;
  xray: boolean;
  /** Highlighted pick candidate while the loupe is open. */
  hover: { kind: SelectMode; index: number } | null;
}

export interface SlotLook {
  color: [number, number, number, number];
  roughness: number;
  metallic: number;
}
export type Shading = 'solid' | 'material';

export class ObjectView {
  readonly group = new THREE.Group();
  readonly surface: THREE.Mesh;
  private outline: THREE.Mesh;
  private mats: THREE.Material[] = [];
  private matKey = '';
  private xray = false;
  private topoKey = -1;
  private colorKey = -1;

  // Cage overlay (edit mode)
  private cage = new THREE.Group();
  private edgeGeom = new LineSegmentsGeometry();

  private edgeMat: LineMaterial;
  private edges: LineSegments2;
  private verts: THREE.Points;
  private faceTint: THREE.Mesh;
  private faceDots: THREE.Points;
  /** Triangulated cage, only drawn into the picking depth pass (occlusion matches the cage). */
  readonly cageSurface: THREE.Mesh;
  private cageTopo = -1;
  private cageSelKey = '';
  private edgeKeys: number[] = [];
  private cagePos = new Float32Array(0);

  constructor(
    private matcap: THREE.Texture,
    private pointMat: THREE.ShaderMaterial,
  ) {
    this.group.matrixAutoUpdate = false;
    this.surface = new THREE.Mesh(new THREE.BufferGeometry(), []);
    this.surface.frustumCulled = false;
    this.outline = new THREE.Mesh(this.surface.geometry, makeOutlineMaterial(COLORS.selected, 1.6));
    this.outline.frustumCulled = false;
    this.outline.visible = false;
    this.outline.renderOrder = -1;
    this.group.add(this.surface, this.outline, this.cage);

    this.edgeMat = new LineMaterial({ vertexColors: true, linewidth: 1.1, worldUnits: false, transparent: true, opacity: 0.85 });
    this.edges = new LineSegments2(this.edgeGeom, this.edgeMat);
    this.edges.frustumCulled = false;
    this.verts = new THREE.Points(new THREE.BufferGeometry(), pointMat);
    this.verts.frustumCulled = false;
    this.faceTint = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({ color: COLORS.faceTint, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.faceTint.frustumCulled = false;
    this.faceDots = new THREE.Points(new THREE.BufferGeometry(), pointMat);
    this.faceDots.frustumCulled = false;
    this.cage.add(this.faceTint, this.edges, this.verts, this.faceDots);
    this.cage.visible = false;
    this.cageSurface = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    this.cageSurface.visible = false;
    this.cageSurface.frustumCulled = false;
    this.group.add(this.cageSurface);
  }

  setResolution(w: number, h: number, dpr: number): void {
    this.edgeMat.resolution.set(w * dpr, h * dpr);
    this.edgeMat.linewidth = 1.1 * dpr;
    (this.outline.material as THREE.ShaderMaterial).uniforms.resolution.value.set(w, h);
  }

  /** Updates the evaluated surface: geometry, material groups per slot, vertex colors. */
  updateSurface(obj: SceneObject, ev: EvalResult, slots: SlotLook[], shading: Shading): void {
    this.group.matrix.fromArray(Array.from(objMatrix(obj)));
    this.group.matrixWorldNeedsUpdate = true;
    this.group.visible = obj.visible;
    const g = this.surface.geometry;
    if (ev.topoKey !== this.topoKey) {
      g.dispose();
      const ng = new THREE.BufferGeometry();
      ng.setAttribute('position', new THREE.BufferAttribute(ev.positions, 3).setUsage(THREE.DynamicDrawUsage));
      ng.setAttribute('normal', new THREE.BufferAttribute(ev.normals, 3).setUsage(THREE.DynamicDrawUsage));
      if (ev.colors) ng.setAttribute('color', new THREE.BufferAttribute(ev.colors, 3).setUsage(THREE.DynamicDrawUsage));
      ng.setIndex(new THREE.BufferAttribute(ev.tris, 1));
      for (const gr of ev.groups) ng.addGroup(gr.start, gr.count, gr.slot);
      this.surface.geometry = ng;
      this.outline.geometry = ng;
      this.topoKey = ev.topoKey;
      this.colorKey = ev.colorKey;
    } else {
      g.attributes.position.needsUpdate = true;
      g.attributes.normal.needsUpdate = true;
      if (ev.colors && ev.colorKey !== this.colorKey) {
        g.attributes.color.needsUpdate = true;
        this.colorKey = ev.colorKey;
      }
    }

    // Materials: one per slot. With a color attribute the attribute is shown (like Blender's
    // Vertex Paint view); otherwise each slot's base color.
    const hasColors = !!ev.colors;
    const maxSlot = Math.max(0, ...ev.groups.map((gr) => gr.slot));
    const looks = Array.from({ length: maxSlot + 1 }, (_, i) => slots[i] ?? slots[0] ?? { color: [0.8, 0.8, 0.8, 1], roughness: 0.5, metallic: 0 });
    const key = JSON.stringify([shading, obj.shade_smooth, hasColors, this.xray, looks]);
    if (key !== this.matKey) {
      this.matKey = key;
      for (const m of this.mats) m.dispose();
      this.mats = looks.map((l) => {
        const common = {
          color: hasColors ? new THREE.Color(1, 1, 1) : new THREE.Color().setRGB(l.color[0], l.color[1], l.color[2], THREE.LinearSRGBColorSpace),
          vertexColors: hasColors,
          flatShading: !obj.shade_smooth,
          polygonOffset: true,
          polygonOffsetFactor: 1,
          polygonOffsetUnits: 1,
          transparent: this.xray,
          opacity: this.xray ? 0.45 : 1,
          depthWrite: !this.xray,
        };
        return shading === 'material'
          ? new THREE.MeshStandardMaterial({ ...common, roughness: l.roughness, metalness: l.metallic })
          : new THREE.MeshMatcapMaterial({ ...common, matcap: this.matcap });
      });
      this.surface.material = this.mats;
    }
  }

  setOutline(state: 'none' | 'selected' | 'active'): void {
    this.outline.visible = state !== 'none';
    const m = this.outline.material as THREE.ShaderMaterial;
    m.uniforms.color.value.set(state === 'active' ? COLORS.active : COLORS.selected);
  }

  setXray(on: boolean): void {
    this.xray = on;
    this.matKey = ''; // rebuilt with transparency on the next surface update
    for (const m of [this.edgeMat, this.faceTint.material as THREE.Material]) m.depthTest = !on;
    this.pointMat.depthTest = !on;
  }

  /** Shows/hides and refreshes the edit-mode cage. */
  updateCage(obj: SceneObject | null, state: CageState): void {
    if (!obj) {
      this.cage.visible = false;
      return;
    }
    this.cage.visible = true;
    const mesh = obj.mesh;
    const sel = obj.editSelection;
    const nV = mesh.vertCount;
    const nF = mesh.faces.length;

    // Allocate GPU buffers once per topology; afterwards everything is updated in place.
    // (Each geometry gets its own attribute: sharing one attribute between geometries that are
    // disposed separately leaves stale buffers bound in cached vertex array objects.)
    if (this.cageTopo !== mesh.topoVersion) {
      this.cageTopo = mesh.topoVersion;
      this.edgeKeys = allEdgeKeys(mesh);
      this.cagePos = new Float32Array(nV * 3);
      const dyn = () => new THREE.BufferAttribute(this.cagePos, 3).setUsage(THREE.DynamicDrawUsage);

      const vg = new THREE.BufferGeometry();
      vg.setAttribute('position', dyn());
      vg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(nV * 3), 3));
      vg.setAttribute('psize', new THREE.BufferAttribute(new Float32Array(nV), 1));
      this.verts.geometry.dispose();
      this.verts.geometry = vg;

      const cs = new THREE.BufferGeometry();
      cs.setAttribute('position', dyn());
      cs.setIndex(new THREE.BufferAttribute(triangulate(mesh.faces), 1));
      this.cageSurface.geometry.dispose();
      this.cageSurface.geometry = cs;

      const tg = new THREE.BufferGeometry();
      tg.setAttribute('position', dyn());
      tg.setIndex(new THREE.BufferAttribute(new Uint32Array(0), 1));
      this.faceTint.geometry.dispose();
      this.faceTint.geometry = tg;

      const eg = new LineSegmentsGeometry();
      const nE = Math.max(1, this.edgeKeys.length);
      eg.setPositions(new Float32Array(nE * 6));
      eg.setColors(new Float32Array(nE * 6));
      this.edgeGeom.dispose();
      this.edgeGeom = eg;
      this.edges.geometry = eg;

      const fg = new THREE.BufferGeometry();
      fg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nF * 3), 3).setUsage(THREE.DynamicDrawUsage));
      fg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(nF * 3), 3));
      fg.setAttribute('psize', new THREE.BufferAttribute(new Float32Array(nF), 1));
      this.faceDots.geometry.dispose();
      this.faceDots.geometry = fg;
      this.cageSelKey = '';
    }

    // Positions (every frame while dragging).
    const pos = mesh.positions;
    for (let i = 0; i < pos.length; i++) this.cagePos[i] = pos[i];
    this.verts.geometry.attributes.position.needsUpdate = true;
    this.cageSurface.geometry.attributes.position.needsUpdate = true;
    this.faceTint.geometry.attributes.position.needsUpdate = true;
    const startAttr = this.edgeGeom.attributes.instanceStart as THREE.InterleavedBufferAttribute;
    const seg = startAttr.data.array as Float32Array;
    this.edgeKeys.forEach((k, i) => {
      const [a, b] = edgeFromKey(k);
      seg.set(this.cagePos.subarray(a * 3, a * 3 + 3), i * 6);
      seg.set(this.cagePos.subarray(b * 3, b * 3 + 3), i * 6 + 3);
    });
    startAttr.data.needsUpdate = true;

    // Colors / sizes / face tint depend on the selection and the hover candidate.
    const hoverKey = state.hover ? `${state.hover.kind}:${state.hover.index}` : '';
    const selKey = `${mesh.topoVersion}|${state.selectMode}|${sel.verts.size}|${sel.edges.size}|${sel.faces.size}|${hash(sel.verts)}|${hash(sel.faces)}|${hash(sel.edges)}|${hoverKey}`;
    const faceMode = state.selectMode === 'face';
    if (selKey !== this.cageSelKey) {
      this.cageSelKey = selKey;
      const vc = this.verts.geometry.attributes.color as THREE.BufferAttribute;
      const vs = this.verts.geometry.attributes.psize as THREE.BufferAttribute;
      const showVerts = state.selectMode === 'vert';
      for (let v = 0; v < nV; v++) {
        const isSel = sel.verts.has(v);
        const hov = state.hover?.kind === 'vert' && state.hover.index === v;
        tmpColor.set(hov ? 0xffffff : isSel ? COLORS.vertSel : COLORS.vert);
        vc.setXYZ(v, tmpColor.r, tmpColor.g, tmpColor.b);
        vs.setX(v, showVerts ? (hov ? 14 : isSel ? 8 : 5) : 0);
      }
      vc.needsUpdate = vs.needsUpdate = true;

      const colAttr = this.edgeGeom.attributes.instanceColorStart as THREE.InterleavedBufferAttribute;
      const cols = colAttr.data.array as Float32Array;
      this.edgeKeys.forEach((k, i) => {
        const hov = state.hover?.kind === 'edge' && state.hover.index === k;
        tmpColor.set(hov ? 0xffffff : sel.edges.has(k) ? COLORS.edgeSel : COLORS.edge);
        for (let j = 0; j < 2; j++) cols.set([tmpColor.r, tmpColor.g, tmpColor.b], i * 6 + j * 3);
      });
      colAttr.data.needsUpdate = true;

      // Only the (small) index changes with the selection; dispose the old one explicitly.
      const tintFaces = mesh.faces.filter((_, i) => sel.faces.has(i) || (state.hover?.kind === 'face' && state.hover.index === i));
      const tg = this.faceTint.geometry;
      const fresh = new THREE.BufferGeometry();
      fresh.setAttribute('position', tg.attributes.position);
      fresh.setIndex(new THREE.BufferAttribute(triangulate(tintFaces), 1));
      tg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3)); // detach before dispose
      tg.dispose();
      this.faceTint.geometry = fresh;

      if (faceMode) {
        const fc = this.faceDots.geometry.attributes.color as THREE.BufferAttribute;
        const fs = this.faceDots.geometry.attributes.psize as THREE.BufferAttribute;
        for (let i = 0; i < nF; i++) {
          const hov = state.hover?.kind === 'face' && state.hover.index === i;
          tmpColor.set(hov ? 0xffffff : sel.faces.has(i) ? COLORS.vertSel : COLORS.vert);
          fc.setXYZ(i, tmpColor.r, tmpColor.g, tmpColor.b);
          fs.setX(i, hov ? 13 : 7);
        }
        fc.needsUpdate = fs.needsUpdate = true;
      }
    }

    // Face dots: big tap targets at face centers in face mode.
    this.faceDots.visible = faceMode;
    if (faceMode) {
      const fp = this.faceDots.geometry.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < nF; i++) {
        const c = faceCenter(pos, mesh.faces[i]);
        fp.setXYZ(i, c[0], c[1], c[2]);
      }
      fp.needsUpdate = true;
    }
  }

  dispose(): void {
    this.surface.geometry.dispose();
    for (const m of this.mats) m.dispose();
    (this.outline.material as THREE.Material).dispose();
    this.edgeGeom.dispose();
    this.edgeMat.dispose();
    this.verts.geometry.dispose();
    this.faceTint.geometry.dispose();
    this.faceDots.geometry.dispose();
    this.cageSurface.geometry.dispose();
  }

  /** True while the edit-mode cage is shown. */
  get editing(): boolean {
    return this.cage.visible;
  }
}

function hash(s: Set<number>): number {
  let h = 0;
  for (const v of s) h = (h + Math.imul(v + 1, 2654435761)) | 0;
  return h;
}

