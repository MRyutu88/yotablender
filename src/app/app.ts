// The application controller: every user action ("operator") lives here, turns into an
// undoable command, and keeps the viewport, the UI signals and autosave in sync.

import * as THREE from 'three';
import type { Viewport } from '../render/viewport';
import type { SlotLook } from '../render/objectView';
import { projectCage, pickElement, pickObject, elementsInPolygon, type ScreenCage, type Pick } from '../render/picking';
import { worldPerPixelAt, type GizmoHit, type GizmoMode } from '../render/gizmo';
import { History, type Command } from '../core/history/history';
import { Mesh, bounds, type MeshData } from '../core/mesh/mesh';
import {
  applyPick,
  cloneSelection,
  convertSelectMode,
  emptySelection,
  flushSelection,
  invertSelection,
  selectAll,
  type Selection,
  type SelectMode,
} from '../core/mesh/selection';
import {
  extrude as extrudeOp,
  deleteSelected as deleteOp,
  mergeAtCenter,
  mergeByDistance,
  loopCut as loopCutOp,
  inset as insetOp,
  subdivide as subdivideOp,
  type SubdivideAxis,
  selectLinked as selectLinkedOp,
  selectLoop as selectLoopOp,
  selectRing as selectRingOp,
  OpError,
} from '../core/mesh/ops';
import { edgeFromKey } from '../core/mesh/keys';
import { StackEvaluator, type EvalResult } from '../core/modifiers/stack';
import { newMirror, newSubsurf, sortStack, type Modifier, type ModifierType } from '../core/modifiers/types';
import { buildPrimitive, PRIMITIVE_DEFAULTS, PRIMITIVE_LABELS, type PrimitiveType } from '../core/primitives/primitives';
import { DEFAULT_MATERIAL_ID, newObject, newProject, objectMatrix, uniqueName, uid, type Material, type Project, type SceneObject } from '../core/scene/scene';
import { transformDir, transformPoint } from '../core/math/mat4';
import { normalize, type Vec3 } from '../core/math/vec3';
import { deserializeProject } from '../core/io/projectJson';
import {
  beginRecord,
  composite,
  editSelectionCommand,
  recordChange,
  uiSelectionCommand,
  vertexMoveCommand,
  type SceneHost,
  type UiSel,
} from './commands';
import { makeEditTarget, TransformSession, type TransformKind } from './transform';
import * as S from './state';
import { Autosaver, deleteProject, lastProjectId, listProjects, loadProject, saveProject } from './storage';
import { collectFiles, imageToSquarePng, objFiles, pickFile, pickFiles, projectFile, safeFileName, shareOrDownload, textOf } from './files';
import { importGltf, importObj, importStl, ImportError, type ModelImportResult } from '../core/io/modelImport';
import { IMPORT_LIMITS } from '../core/io/importMesh';
import { objMtlLibs } from '../core/io/obj';
import { TexturePainter, diffTiles, flipRows, type PaintLayer, type PaintTile } from '../render/texturePaint';
import { unwrap } from '../core/uv/unwrap';
import { encodePng } from '../core/io/png';
import type { ProjectImage } from '../core/scene/scene';

const PRIMITIVE_NAMES: Record<PrimitiveType, string> = {
  cube: 'Cube',
  plane: 'Plane',
  uvSphere: 'Sphere',
  quadSphere: 'QuadSphere',
  cylinder: 'Cylinder',
  cone: 'Cone',
  torus: 'Torus',
};

interface ExtrudeFollow {
  obj: SceneObject;
  extrudeCmd: Command;
  dirWorld: Vec3 | null;
  /** Filled once the follow-up move finished, for Adjust Last. */
  verts?: Int32Array;
  start?: Float64Array;
  dirLocal?: Vec3;
}

export class App implements SceneHost {
  project: Project = newProject();
  readonly history = new History();
  private evaluators = new Map<string, StackEvaluator>();
  readonly evals = new Map<string, EvalResult>();
  private stamps = new Map<string, string>();
  private registry = new Map<string, SceneObject>();
  session: TransformSession | null = null;
  private sessionRecord: ReturnType<typeof beginRecord> | null = null;
  private extrudeFollow: ExtrudeFollow | null = null;
  private holdCage: ScreenCage | null = null;
  private holdCamVersion = -1;
  hover: Pick | null = null;
  gizmoHover: GizmoHit | null = null;
  loupeCanvas: HTMLCanvasElement | null = null;
  private autosaver: Autosaver;
  private lastXray = false;
  private lastEval = { evalMs: 0, buildMs: 0 };
  readonly painter: TexturePainter;
  /** GPU paint layers by image id (created from the image's PNG when first needed). */
  private layers = new Map<string, PaintLayer>();
  private encoding = new Map<string, Promise<void>>();

  constructor(readonly vp: Viewport) {
    this.painter = new TexturePainter(vp.renderer);
    vp.onBeforeFrame = () => this.syncViews();
    vp.onAfterFrame = (stats) => {
      if (S.hudVisible.value) {
        let verts = 0, faces = 0, cage = 0;
        for (const o of this.project.objects) {
          const ev = this.evals.get(o.id);
          if (ev && o.visible) {
            verts += ev.nV;
            faces += ev.faces.length;
          }
          cage += o.mesh.vertCount;
        }
        S.hudStats.value = { ...stats, ...this.lastEval, verts, faces, cageVerts: cage };
      }
      this.drawLoupe();
    };
    this.history.onChange(() => {
      S.canUndo.value = this.history.canUndo();
      S.canRedo.value = this.history.canRedo();
    });
    this.autosaver = new Autosaver(
      () => this.project,
      (s) => (S.saveState.value = s),
      (e) => {
        S.logError(`autosave failed: ${String(e)}`);
        S.toast('Autosave failed — export a backup', 'error', 4000);
      },
    );
  }

  // --- Startup / projects -----------------------------------------------------------------

  async init(): Promise<void> {
    try {
      const id = await lastProjectId();
      const p = id ? await loadProject(id) : null;
      if (p) {
        this.setProject(p);
        return;
      }
    } catch (e) {
      S.logError(`could not load last project: ${String(e)}`);
    }
    this.newProject(true);
  }

  private setProject(p: Project): void {
    this.project = p;
    for (const l of this.layers.values()) l.dispose();
    this.layers.clear();
    this.registry.clear();
    for (const o of p.objects) this.registry.set(o.id, o);
    this.evaluators.clear();
    this.evals.clear();
    this.stamps.clear();
    this.history.clear();
    this.session = null;
    this.extrudeFollow = null;
    S.projectName.value = p.name;
    S.mode.value = 'object';
    S.adjustLast.value = null;
    const first = p.objects.find((o) => o.visible);
    S.activeId.value = first?.id ?? null;
    S.selectedIds.value = new Set(first ? [first.id] : []);
    S.sceneRev.value++;
    this.frameAll(true);
    this.vp.requestRender();
  }

  newProject(withCube = false): void {
    void this.autosaver.flush();
    const p = newProject('Untitled');
    if (withCube) {
      const cube = newObject('Cube', new Mesh(buildPrimitive('cube')), { primitive: { type: 'cube', params: { ...PRIMITIVE_DEFAULTS.cube } } });
      p.objects.push(cube);
    }
    this.setProject(p);
    this.autosaver.schedule();
  }

  async openProject(id: string): Promise<void> {
    await this.autosaver.flush();
    const p = await loadProject(id);
    if (p) {
      this.setProject(p);
      await saveProject(p); // marks it as the last project
    } else S.toast('Project not found', 'error');
  }

  async removeProject(id: string): Promise<void> {
    await deleteProject(id);
    if (id === this.project.id) {
      const rest = await listProjects();
      if (rest.length) await this.openProject(rest[0].id);
      else this.newProject(true);
    }
  }

  renameProject(name: string): void {
    const n = name.trim();
    if (!n) return;
    this.project.name = n;
    S.projectName.value = n;
    this.autosaver.schedule();
  }

  async saveProjectFile(): Promise<void> {
    await this.encodeTextures();
    await this.autosaver.flush();
    const r = await shareOrDownload([projectFile(this.project)], this.project.name);
    if (r !== 'cancelled') S.toast(r === 'shared' ? 'Project shared' : 'Project downloaded');
  }

  async openProjectFile(): Promise<void> {
    const f = await pickFile('.json,.yblend,application/json');
    if (!f) return;
    try {
      const p = deserializeProject(JSON.parse(await f.text()));
      p.id = uid(); // never overwrite an existing project by accident
      await this.autosaver.flush();
      this.setProject(p);
      this.autosaver.schedule();
      S.toast(`Opened ${p.name}`);
    } catch (e) {
      S.toast(e instanceof Error ? e.message : 'Could not open that file', 'error', 4000);
    }
  }

  /**
   * Imports an OBJ, STL or glTF into the current project as new objects (one undo step). Pick the
   * model alone, an .obj together with its .mtl and textures, or a .zip of them.
   */
  async importModel(): Promise<void> {
    const picked = await pickFiles(
      '.obj,.mtl,.stl,.glb,.gltf,.bin,.zip,.png,.jpg,.jpeg,.webp,model/obj,model/stl,model/gltf-binary,model/gltf+json,text/plain,application/zip,application/sla,application/octet-stream,image/*',
    );
    if (!picked.length) return;
    try {
      const total = picked.reduce((n, f) => n + f.size, 0);
      if (total > IMPORT_LIMITS.maxFileBytes)
        throw new ImportError(`That's ${(total / 1048576).toFixed(0)} MB; the limit is ${IMPORT_LIMITS.maxFileBytes / 1048576} MB`);
      const files = await collectFiles(picked);
      const models = [...files.keys()].filter((n) => /\.(obj|stl|glb|gltf)$/.test(n));
      if (!models.length) throw new ImportError('Pick an .obj, .stl or .glb file (or a .zip with one)');
      const model = models[0];
      const warnings: string[] = [];
      let r: ModelImportResult;
      const displayName = picked.find((f) => f.name.toLowerCase() === model)?.name ?? model;
      const byName = (uri: string) => files.get(uri.split(/[\\/]/).pop()!.toLowerCase());
      if (model.endsWith('.stl')) {
        r = importStl(this.project, files.get(model)!, displayName);
      } else if (/\.(glb|gltf)$/.test(model)) {
        r = importGltf(this.project, files.get(model)!, displayName, byName);
      } else {
        const objText = textOf(files.get(model)!);
        // The MTLs the OBJ asks for, else any MTL that came along.
        const libs = objMtlLibs(objText).map((n) => n.split(/[\\/]/).pop()!.toLowerCase());
        let mtlNames = libs.filter((n) => files.has(n));
        if (!mtlNames.length) mtlNames = [...files.keys()].filter((n) => n.endsWith('.mtl'));
        r = importObj(this.project, objText, mtlNames.map((n) => textOf(files.get(n)!)));
        if (libs.length && !mtlNames.length) warnings.push('no .mtl picked, so materials are plain');
      }
      warnings.unshift(...r.warnings);
      if (models.length > 1) warnings.push(`only ${model} was imported`);

      // Textures become each object's paint texture.
      const images: ProjectImage[] = [];
      const missingTex = new Set<string>();
      for (const o of r.objects) {
        const file = r.textureFiles[o.id];
        if (!file) continue;
        const bytes = r.embeddedImages?.[file] ?? byName(file);
        if (!bytes) {
          missingTex.add(file);
          continue;
        }
        try {
          const { size, png } = await imageToSquarePng(bytes, IMPORT_LIMITS.maxTextureSize);
          const img: ProjectImage = { id: uid(), name: uniqueName(`${o.name} Paint`, [...this.project.images, ...images].map((i) => i.name)), width: size, height: size, png };
          images.push(img);
          o.texture = img.id;
        } catch {
          missingTex.add(file);
        }
      }
      if (missingTex.size) warnings.push(`texture${missingTex.size > 1 ? 's' : ''} not loaded: ${[...missingTex].join(', ')}`);

      if (S.mode.value !== 'object') this.setMode('object');
      // Images stay in the project list (undo may bring the reference back); saving keeps only used ones.
      this.project.images.push(...images);
      for (const o of r.objects) this.registry.set(o.id, o);
      this.push(
        recordChange(this, `Import ${model.split('.').pop()!.toUpperCase()}`, { ids: [], materials: true }, () => {
          this.project.materials.push(...r.materials);
          this.project.objects.push(...r.objects);
          S.activeId.value = r.objects[0].id;
          S.selectedIds.value = new Set(r.objects.map((o) => o.id));
        }),
      );
      S.sheet.value = null;
      this.frameSelected();
      const faces = r.objects.reduce((n, o) => n + o.mesh.faces.length, 0);
      const head = `Imported ${r.objects.length} object${r.objects.length > 1 ? 's' : ''} (${faces.toLocaleString('en-US')} faces)`;
      S.toast(warnings.length ? `${head} · ${warnings.join(' · ')}` : head, 'info', warnings.length ? 6000 : 2500);
    } catch (e) {
      if (!(e instanceof ImportError)) S.logError(`import failed: ${String(e)}`);
      S.toast(e instanceof ImportError ? e.message : 'Could not import that file', 'error', 5000);
    }
  }

  async exportObj(applyMirror: boolean, zip: boolean): Promise<void> {
    if (!this.project.objects.some((o) => o.visible)) return S.toast('Nothing visible to export', 'error');
    // Painted objects get a flattened texture (paint over their colors), referenced by map_Kd.
    const textures: Record<string, { name: string; png: Uint8Array }> = {};
    const taken = new Set<string>();
    for (const o of this.project.objects) {
      if (!o.visible) continue;
      const layer = this.layerOf(o);
      const view = this.vp.views.get(o.id);
      if (!layer || !view) continue;
      let name = `${safeFileName(o.name)}_paint.png`;
      for (let i = 2; taken.has(name); i++) name = `${safeFileName(o.name)}_paint_${i}.png`;
      taken.add(name);
      const slots = Array.from({ length: Math.max(1, o.materialSlots.length) }, (_, i) => {
        const m = this.project.materials.find((x) => x.id === o.materialSlots[i]);
        const c = m?.base_color ?? [0.8, 0.8, 0.8, 1];
        return [c[0], c[1], c[2]] as [number, number, number];
      });
      textures[o.id] = { name, png: this.painter.flatten(layer, view.paintSurface(), slots, !!o.mesh.colors) };
    }
    const r = await shareOrDownload(objFiles(this.project, applyMirror, zip, textures), this.project.name);
    if (r !== 'cancelled') S.toast(r === 'shared' ? 'OBJ shared' : 'OBJ downloaded');
  }

  // --- SceneHost --------------------------------------------------------------------------

  objectFactory(id: string): SceneObject {
    let o = this.registry.get(id);
    if (!o) {
      o = newObject('Object', new Mesh(), { id });
      this.registry.set(id, o);
    }
    return o;
  }

  getUiSel(): UiSel {
    return { activeId: S.activeId.value, selectedIds: [...S.selectedIds.value], mode: S.mode.value, selectMode: S.selectMode.value };
  }

  setUiSel(s: UiSel): void {
    S.activeId.value = s.activeId;
    S.selectedIds.value = new Set(s.selectedIds);
    S.mode.value = s.mode;
    S.selectMode.value = s.selectMode;
  }

  changed(_topology: boolean): void {
    S.sceneRev.value++;
    this.vp.requestRender();
  }

  private push(cmd: Command): void {
    this.history.push(cmd);
    this.changed(true);
    this.autosaver.schedule();
  }

  // --- Lookups ----------------------------------------------------------------------------

  get active(): SceneObject | null {
    const id = S.activeId.value;
    return (id && this.project.objects.find((o) => o.id === id)) || null;
  }

  selectedObjects(): SceneObject[] {
    const sel = S.selectedIds.value;
    return this.project.objects.filter((o) => sel.has(o.id) && o.visible);
  }

  private names(exclude?: string): string[] {
    return this.project.objects.filter((o) => o.id !== exclude).map((o) => o.name);
  }

  private editObject(): SceneObject | null {
    return S.mode.value === 'edit' ? this.active : null;
  }

  // --- Undo -------------------------------------------------------------------------------

  undo(): void {
    if (this.session) return this.endTransform(true);
    const c = this.history.undo();
    this.afterHistory(c, 'Undo');
  }

  redo(): void {
    if (this.session) return;
    const c = this.history.redo();
    this.afterHistory(c, 'Redo');
  }

  private afterHistory(c: Command | undefined, verb: string): void {
    this.extrudeFollow = null;
    S.adjustLast.value = null;
    S.hint.value = null;
    if (!c) return S.toast(`Nothing to ${verb.toLowerCase()}`);
    S.toast(`${verb}: ${c.label}`, 'info', 1200);
    S.haptic(6);
    this.changed(true);
    this.autosaver.schedule();
  }

  // --- Object mode ------------------------------------------------------------------------

  addPrimitive(type: PrimitiveType, params?: Record<string, number>): void {
    if (S.mode.value === 'edit') this.setMode('object');
    const p = { ...PRIMITIVE_DEFAULTS[type], ...(params ?? {}) } as Record<string, number>;
    const obj = newObject(uniqueName(PRIMITIVE_NAMES[type], this.names()), new Mesh(buildPrimitive(type, p)), {
      primitive: { type, params: p as never },
    });
    this.registry.set(obj.id, obj);
    const cmd = recordChange(this, `Add ${PRIMITIVE_LABELS[type]}`, { ids: [] }, () => {
      this.project.objects.push(obj);
      S.activeId.value = obj.id;
      S.selectedIds.value = new Set([obj.id]);
    });
    this.push(cmd);
    S.adjustLast.value = { kind: 'primitive', title: PRIMITIVE_LABELS[type], primitive: type, values: p };
    S.sheet.value = null;
  }

  /** Adjust Last Operation for primitives: redo the add with new parameters. */
  adjustPrimitive(values: Record<string, number>): void {
    const a = S.adjustLast.value;
    if (!a || a.kind !== 'primitive' || !a.primitive) return;
    this.history.undo();
    this.addPrimitive(a.primitive, values);
  }

  /** A half box with Mirror (X) and Subdivision: the usual way to start a character. */
  addCharacterStart(): void {
    if (S.mode.value === 'edit') this.setMode('object');
    const positions: number[] = [];
    for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) for (let z = 0; z < 2; z++) positions.push(x * 0.5, y ? 0.35 : -0.35, z ? 1.6 : 0.6);
    const faces = [
      [2, 3, 7, 6],
      [6, 7, 5, 4],
      [4, 5, 1, 0],
      [2, 6, 4, 0],
      [7, 3, 1, 5],
    ];
    const obj = newObject(uniqueName('Character', this.names()), new Mesh({ positions, faces, looseEdges: [] }), {
      modifiers: [newMirror(), newSubsurf()],
      shade_smooth: true,
    });
    this.registry.set(obj.id, obj);
    this.push(
      recordChange(this, 'Add Character Start', { ids: [] }, () => {
        this.project.objects.push(obj);
        S.activeId.value = obj.id;
        S.selectedIds.value = new Set([obj.id]);
      }),
    );
    S.sheet.value = null;
    this.frameSelected();
  }

  duplicateSelected(): void {
    const src = this.selectedObjects();
    if (!src.length) return S.toast('Select an object first', 'error');
    const copies: SceneObject[] = [];
    const taken = this.names();
    for (const o of src) {
      const name = uniqueName(o.name, taken);
      taken.push(name);
      const c = newObject(name, o.mesh.clone(), {
        location: [...o.location],
        rotation_euler: [...o.rotation_euler],
        scale: [...o.scale],
        modifiers: structuredClone(o.modifiers),
        materialSlots: [...o.materialSlots],
        shade_smooth: o.shade_smooth,
        editSelection: cloneSelection(o.editSelection),
      });
      // The copy gets its own paint texture (same pixels), so painting one doesn't change the other.
      const img = this.imageOf(o);
      if (img) {
        const layer = this.layers.get(img.id);
        const copy: ProjectImage = {
          ...img,
          id: uid(),
          name: uniqueName(`${name} Paint`, this.project.images.map((i) => i.name)),
          png: layer && layer.encodedVersion !== layer.version ? encodePng(flipRows(layer.cpu, img.width, img.height), img.width, img.height) : img.png,
        };
        this.project.images.push(copy);
        c.texture = copy.id;
      }
      this.registry.set(c.id, c);
      copies.push(c);
    }
    this.push(
      recordChange(this, 'Duplicate', { ids: [] }, () => {
        this.project.objects.push(...copies);
        S.selectedIds.value = new Set(copies.map((c) => c.id));
        S.activeId.value = copies[copies.length - 1].id;
      }),
    );
    S.tool.value = 'move';
    S.hint.value = 'Drag to place the copy';
  }

  deleteSelectedObjects(): void {
    const ids = this.selectedObjects().map((o) => o.id);
    if (!ids.length) return S.toast('Select an object first', 'error');
    this.push(
      recordChange(this, 'Delete', { ids, meshes: false }, () => {
        this.project.objects = this.project.objects.filter((o) => !ids.includes(o.id));
        S.selectedIds.value = new Set();
        S.activeId.value = null;
      }),
    );
  }

  deleteObject(id: string): void {
    this.push(
      recordChange(this, 'Delete', { ids: [id], meshes: false }, () => {
        this.project.objects = this.project.objects.filter((o) => o.id !== id);
        S.selectedIds.value = new Set([...S.selectedIds.value].filter((x) => x !== id));
        if (S.activeId.value === id) S.activeId.value = null;
        if (S.mode.value === 'edit' && !this.active) S.mode.value = 'object';
      }),
    );
  }

  renameObject(id: string, name: string): void {
    const o = this.project.objects.find((x) => x.id === id);
    const n = name.trim();
    if (!o || !n || n === o.name) return;
    this.push(recordChange(this, 'Rename', { ids: [id], meshes: false }, () => (o.name = uniqueName(n, this.names(id)))));
  }

  toggleVisible(id: string): void {
    const o = this.project.objects.find((x) => x.id === id);
    if (!o) return;
    this.push(recordChange(this, o.visible ? 'Hide' : 'Unhide', { ids: [id], meshes: false }, () => (o.visible = !o.visible)));
  }

  setShadeSmooth(on: boolean): void {
    const objs = this.selectedObjects();
    if (!objs.length) return;
    this.push(
      recordChange(this, on ? 'Shade Smooth' : 'Shade Flat', { ids: objs.map((o) => o.id), meshes: false }, () => {
        for (const o of objs) o.shade_smooth = on;
      }),
    );
  }

  /** Sets location/rotation(degrees)/scale of the active object from the Item panel. */
  setObjectTransform(field: 'location' | 'rotation' | 'scale', axis: number, value: number): void {
    const o = this.active;
    if (!o || !Number.isFinite(value)) return;
    this.push(
      recordChange(this, 'Transform', { ids: [o.id], meshes: false }, () => {
        if (field === 'location') o.location[axis] = value;
        else if (field === 'rotation') o.rotation_euler[axis] = (value * Math.PI) / 180;
        else o.scale[axis] = value;
      }),
    );
  }

  /** Moves the selected vertices so their median lands on `value` along `axis` (Item panel). */
  setMedian(axis: number, value: number): void {
    const o = this.editObject();
    if (!o || !Number.isFinite(value)) return;
    const verts = [...o.editSelection.verts];
    if (!verts.length) return;
    const m = objectMatrix(o);
    const med = this.medianWorld(o, verts);
    const delta: Vec3 = [0, 0, 0];
    delta[axis] = value - med[axis];
    const t = makeEditTarget(o, verts);
    const pos = o.mesh.positions;
    const inv = t.inv;
    verts.forEach((v, i) => {
      const w = transformPoint(m, [t.start[i * 3], t.start[i * 3 + 1], t.start[i * 3 + 2]]);
      const l = transformPoint(inv, [w[0] + delta[0], w[1] + delta[1], w[2] + delta[2]]);
      pos[v * 3] = l[0];
      pos[v * 3 + 1] = l[1];
      pos[v * 3 + 2] = l[2];
    });
    o.mesh.touchPositions();
    const afterPos = new Float64Array(verts.length * 3);
    verts.forEach((v, i) => afterPos.set([pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]], i * 3));
    this.push(vertexMoveCommand(this, o, t.verts, t.start, afterPos, 'Move'));
  }

  // --- Selection --------------------------------------------------------------------------

  tap(x: number, y: number): void {
    this.cancelExtrudeFollow();
    S.adjustLast.value = null;
    if (S.mode.value === 'edit') return this.editTap(x, y);
    const id = pickObject(this.vp, this.project.objects, this.evals, x, y);
    const before = this.getUiSel();
    const sel = new Set(S.selectedIds.value);
    const op = S.pickOp.value;
    if (!id) {
      if (op !== 'replace') return;
      sel.clear();
      S.activeId.value = null;
    } else if (op === 'replace') {
      sel.clear();
      sel.add(id);
      S.activeId.value = id;
    } else if (op === 'add') {
      if (sel.has(id) && S.activeId.value === id) {
        sel.delete(id);
        S.activeId.value = null;
      } else {
        sel.add(id);
        S.activeId.value = id;
      }
    } else {
      sel.delete(id);
      if (S.activeId.value === id) S.activeId.value = null;
    }
    S.selectedIds.value = sel;
    const after = this.getUiSel();
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      this.push(uiSelectionCommand(this, before, after));
      if (id) S.haptic();
    }
  }

  private lastTap: { index: number; mode: SelectMode; t: number; pushed: boolean } | null = null;

  private editTap(x: number, y: number): void {
    const o = this.active;
    if (!o) return;
    const cage = projectCage(this.vp, o, S.xray.value);
    const pick = pickElement(o, cage, S.selectMode.value, x, y, 30);
    const now = performance.now();
    const dbl = pick && this.lastTap && this.lastTap.index === pick.index && this.lastTap.mode === pick.kind && now - this.lastTap.t < 380;
    if (dbl && pick) {
      // Double-tap: edge → its edge loop (Blender's Alt+click); vertex/face → the linked piece.
      // If the first tap changed the selection, replace that undo step with the bigger one.
      if (this.lastTap!.pushed) this.history.undo();
      this.lastTap = null;
      if (pick.kind === 'edge') {
        const [a, b] = edgeFromKey(pick.index);
        this.applySelection(o, selectLoopOp(o.mesh, o.editSelection, a, b, S.pickOp.value === 'add'), 'Select Loop');
      } else {
        const base = applyPick(o.mesh, o.editSelection, S.selectMode.value, [pick.index], S.pickOp.value === 'add' ? 'add' : 'replace');
        this.applySelection(o, selectLinkedOp(o.mesh, base, S.selectMode.value), 'Select Linked');
      }
      S.haptic(14);
      return;
    }
    const pushed = this.applyEditPick(o, pick ? [pick.index] : [], S.pickOp.value === 'add' ? 'toggle' : S.pickOp.value);
    this.lastTap = pick ? { index: pick.index, mode: pick.kind, t: now, pushed } : null;
    if (pick) S.haptic();
  }

  private applySelection(o: SceneObject, after: Selection, label: string): void {
    const before = cloneSelection(o.editSelection);
    const conv = convertSelectMode(o.mesh, after, S.selectMode.value);
    if (sameSel(before, conv)) return;
    o.editSelection = conv;
    const cmd = editSelectionCommand(this, o, before, conv);
    cmd.label = label;
    this.push(cmd);
  }

  /** Select Linked / Loop / Ring from the Select menu. */
  selectSpecial(kind: 'linked' | 'loop' | 'ring'): void {
    const o = this.editObject();
    if (!o) return;
    if (kind === 'linked') {
      if (!o.editSelection.verts.size) return S.toast('Select something first', 'error');
      return this.applySelection(o, selectLinkedOp(o.mesh, o.editSelection, S.selectMode.value), 'Select Linked');
    }
    const edge = this.oneEdge(o);
    if (edge === null) return;
    const [a, b] = edgeFromKey(edge);
    const add = S.pickOp.value === 'add';
    this.applySelection(o, kind === 'loop' ? selectLoopOp(o.mesh, o.editSelection, a, b, add) : selectRingOp(o.mesh, o.editSelection, a, b, add), kind === 'loop' ? 'Select Loop' : 'Select Ring');
  }

  /** The edge to act on: the single selected edge (any one of them if several). */
  private oneEdge(o: SceneObject): number | null {
    const edges = [...o.editSelection.edges];
    if (!edges.length) {
      S.toast('Select an edge first (Edge mode)', 'error');
      return null;
    }
    return edges[edges.length - 1];
  }

  /** Returns whether the selection changed (an undo step was pushed). */
  private applyEditPick(o: SceneObject, items: number[], op: 'replace' | 'add' | 'sub' | 'toggle'): boolean {
    if (!items.length && op !== 'replace') return false;
    const before = cloneSelection(o.editSelection);
    const after = applyPick(o.mesh, before, S.selectMode.value, items, op);
    if (sameSel(before, after)) return false;
    o.editSelection = after;
    this.push(editSelectionCommand(this, o, before, after));
    return true;
  }

  /** Touch-and-hold in Edit Mode: show the loupe and the candidate under the finger. */
  holdStart(x: number, y: number): void {
    const o = this.editObject();
    if (!o) return;
    this.holdCage = projectCage(this.vp, o, S.xray.value);
    this.holdCamVersion = this.vp.cam.version;
    S.loupe.value = { x, y };
    this.holdMove(x, y);
    S.haptic(5);
  }

  holdMove(x: number, y: number): void {
    const o = this.editObject();
    if (!o || !this.holdCage) return;
    if (this.vp.cam.version !== this.holdCamVersion) {
      // The view moved (e.g. a camera animation finished): re-project so the candidate matches.
      this.holdCage = projectCage(this.vp, o, S.xray.value);
      this.holdCamVersion = this.vp.cam.version;
    }
    S.loupe.value = { x, y };
    const prev = this.hover;
    this.hover = pickElement(o, this.holdCage, S.selectMode.value, x, y, 44);
    if (this.hover && (!prev || prev.index !== this.hover.index)) S.haptic(4);
    this.vp.requestRender();
  }

  holdEnd(cancelled: boolean): void {
    const o = this.editObject();
    const h = this.hover;
    this.hover = null;
    this.holdCage = null;
    S.loupe.value = null;
    if (o && h && !cancelled) {
      this.applyEditPick(o, [h.index], S.pickOp.value === 'add' ? 'toggle' : S.pickOp.value);
      S.haptic();
    }
    this.vp.requestRender();
  }

  /** Box/lasso selection with a screen polygon. */
  selectPolygon(poly: [number, number][]): void {
    const op = S.pickOp.value;
    const o = this.editObject();
    if (o) {
      const cage = projectCage(this.vp, o, S.xray.value);
      const items = elementsInPolygon(o, cage, S.selectMode.value, poly);
      const before = cloneSelection(o.editSelection);
      const after = applyPick(o.mesh, before, S.selectMode.value, items, op);
      if (!sameSel(before, after)) {
        o.editSelection = after;
        this.push(editSelectionCommand(this, o, before, after));
      }
      return;
    }
    const before = this.getUiSel();
    const sel = op === 'replace' ? new Set<string>() : new Set(S.selectedIds.value);
    for (const ob of this.project.objects) {
      if (!ob.visible) continue;
      const m = new THREE.Matrix4().fromArray(Array.from(objectMatrix(ob)));
      const p = new THREE.Vector3();
      let inside = false;
      for (let i = 0; i < ob.mesh.vertCount && !inside; i++) {
        p.fromArray(ob.mesh.positions, i * 3).applyMatrix4(m);
        const s = this.vp.cam.project(p);
        if (s.z >= -1 && s.z <= 1 && pointIn(s.x, s.y, poly)) inside = true;
      }
      if (!inside) continue;
      if (op === 'sub') sel.delete(ob.id);
      else sel.add(ob.id);
    }
    S.selectedIds.value = sel;
    if (!S.activeId.value || !sel.has(S.activeId.value)) S.activeId.value = [...sel][sel.size - 1] ?? null;
    const after = this.getUiSel();
    if (JSON.stringify(before) !== JSON.stringify(after)) this.push(uiSelectionCommand(this, before, after));
  }

  selectAllToggle(kind: 'all' | 'none' | 'invert'): void {
    const o = this.editObject();
    if (o) {
      const before = cloneSelection(o.editSelection);
      const after =
        kind === 'all' ? selectAll(o.mesh) : kind === 'none' ? emptySelection() : invertSelection(o.mesh, before, S.selectMode.value);
      if (sameSel(before, after)) return;
      o.editSelection = after;
      this.push(editSelectionCommand(this, o, before, after));
      return;
    }
    const before = this.getUiSel();
    const visible = this.project.objects.filter((x) => x.visible).map((x) => x.id);
    const cur = S.selectedIds.value;
    const next = kind === 'all' ? visible : kind === 'none' ? [] : visible.filter((id) => !cur.has(id));
    S.selectedIds.value = new Set(next);
    if (!S.activeId.value || !S.selectedIds.value.has(S.activeId.value)) S.activeId.value = next[0] ?? null;
    const after = this.getUiSel();
    if (JSON.stringify(before) !== JSON.stringify(after)) this.push(uiSelectionCommand(this, before, after));
  }

  selectObjectFromList(id: string): void {
    const before = this.getUiSel();
    if (S.mode.value === 'edit' && S.activeId.value !== id) S.mode.value = 'object';
    S.selectedIds.value = new Set([id]);
    S.activeId.value = id;
    const after = this.getUiSel();
    if (JSON.stringify(before) !== JSON.stringify(after)) this.push(uiSelectionCommand(this, before, after));
  }

  // --- Modes ------------------------------------------------------------------------------

  setMode(m: S.Mode): void {
    if (m === S.mode.value) return;
    this.cancelExtrudeFollow();
    if (m === 'edit' || m === 'paint') {
      const o = this.active ?? this.selectedObjects()[0];
      if (!o) return S.toast(m === 'edit' ? 'Select an object to edit' : 'Select an object to paint', 'error');
      if (!o.visible) return S.toast('Unhide the object first', 'error');
      S.activeId.value = o.id;
      S.selectedIds.value = new Set([o.id]);
      // Objects with a paint texture open in Texture Paint; others in the last used target.
      if (m === 'paint') {
        if (this.hasPaintTexture(o)) S.paintTarget.value = 'texture';
        if (S.paintTarget.value === 'vertex' && !o.mesh.colors) this.addColorAttribute(o);
        if (S.paintTarget.value === 'texture' && S.paintTool.value === 'blur') S.paintTool.value = 'draw';
        if (S.paintTarget.value === 'vertex' && S.paintTool.value === 'erase') S.paintTool.value = 'draw';
      }
    }
    S.mode.value = m;
    S.adjustLast.value = null;
    this.changed(false);
  }

  setSelectMode(sm: SelectMode): void {
    const o = this.editObject();
    if (o) o.editSelection = convertSelectMode(o.mesh, o.editSelection, sm);
    S.selectMode.value = sm;
    this.changed(false);
  }

  // --- Edit operations --------------------------------------------------------------------

  private runOp(label: string, fn: (o: SceneObject) => { data: MeshData; selection: Selection }): Command | null {
    const o = this.editObject();
    if (!o) return null;
    try {
      const cmd = recordChange(this, label, { ids: [o.id] }, () => {
        const result = fn(o);
        o.mesh.setData(result.data);
        o.editSelection = convertSelectMode(o.mesh, result.selection, S.selectMode.value);
      });
      this.push(cmd);
      return cmd;
    } catch (e) {
      if (e instanceof OpError) {
        S.toast(e.message, 'error', 3000);
        S.haptic(30);
        return null;
      }
      throw e;
    }
  }

  extrude(): void {
    const o = this.editObject();
    if (!o) return;
    let normal: Vec3 | undefined;
    const hadFaces = o.editSelection.faces.size > 0;
    const cmd = this.runOp('Extrude', (obj) => {
      const r = extrudeOp(obj.mesh, obj.editSelection);
      normal = r.normal;
      return r;
    });
    if (!cmd) return;
    const m = objectMatrix(o);
    const dirWorld = normal && hadFaces ? normalize(transformDir(m, normal)) : null;
    this.extrudeFollow = { obj: o, extrudeCmd: cmd, dirWorld };
    S.tool.value = 'move';
    S.constraint.value = dirWorld ? { kind: 'dir', dir: dirWorld, label: 'Normal' } : null;
    S.hint.value = 'Drag anywhere to extrude';
  }

  private cancelExtrudeFollow(): void {
    if (!this.extrudeFollow) return;
    this.extrudeFollow = null;
    if (S.constraint.value?.kind === 'dir') S.constraint.value = null;
    S.hint.value = null;
  }

  deleteElements(): void {
    this.runOp('Delete', (o) => deleteOp(o.mesh, o.editSelection, S.selectMode.value));
  }

  mergeCenter(): void {
    this.runOp('Merge at Center', (o) => mergeAtCenter(o.mesh, o.editSelection));
  }

  private lastLoopEdge: [number, number] | null = null;

  /** Loop Cut through the selected edge's ring. Adjust Last: number of cuts and slide. */
  loopCut(cuts = 1, factor = 0.5, edge?: [number, number]): void {
    const o = this.editObject();
    if (!o) return;
    let ab = edge;
    if (!ab) {
      const k = this.oneEdge(o);
      if (k === null) return;
      ab = edgeFromKey(k);
    }
    const [a, b] = ab;
    const cmd = this.runOp('Loop Cut', (obj) => loopCutOp(obj.mesh, a, b, cuts, factor));
    if (!cmd) return;
    this.lastLoopEdge = ab;
    S.adjustLast.value = {
      kind: 'loopcut',
      title: 'Loop Cut',
      values: { cuts, factor },
      specs: {
        cuts: { min: 1, max: 16, step: 1, int: true, label: 'Cuts' },
        factor: { min: 0.02, max: 0.98, step: 0.05, label: 'Slide' },
      },
    };
  }

  /**
   * Subdivide (real geometry, not the modifier): the selected faces, or the whole mesh when no
   * face is selected. Adjust Last: number of cuts and direction (all edges, or only edges along
   * local X/Y/Z, e.g. Z = horizontal slices around a cube).
   */
  subdivide(cuts = 1, axis: SubdivideAxis = -1, faces?: number[] | null): void {
    const o = this.editObject();
    if (!o) return;
    const target = faces !== undefined ? faces : o.editSelection.faces.size ? [...o.editSelection.faces] : null;
    const cmd = this.runOp('Subdivide', (obj) => subdivideOp(obj.mesh, target, cuts, axis));
    if (!cmd) return;
    this.lastSubdivFaces = target;
    S.adjustLast.value = {
      kind: 'subdivide',
      title: target ? 'Subdivide' : 'Subdivide (whole mesh)',
      values: { cuts, axis },
      specs: { cuts: { min: 1, max: 16, step: 1, int: true, label: 'Cuts' } },
    };
  }

  private lastSubdivFaces: number[] | null = null;

  /** Inset the selected faces. Adjust Last: thickness and depth. */
  inset(thickness?: number, depth = 0): void {
    const o = this.editObject();
    if (!o) return;
    if (!o.editSelection.faces.size) return S.toast('Select faces to inset', 'error');
    const th = thickness ?? this.defaultInset(o);
    const cmd = this.runOp('Inset', (obj) => insetOp(obj.mesh, obj.editSelection, th, depth));
    if (!cmd) return;
    S.adjustLast.value = {
      kind: 'inset',
      title: 'Inset',
      values: { thickness: Math.round(th * 1000) / 1000, depth },
      specs: {
        thickness: { min: 0.001, max: 10, step: 0.02, label: 'Thickness' },
        depth: { min: -10, max: 10, step: 0.05, label: 'Depth' },
      },
    };
  }

  /** A quarter of the average edge length of the selected faces. */
  private defaultInset(o: SceneObject): number {
    let sum = 0, n = 0;
    for (const f of o.editSelection.faces) {
      const face = o.mesh.faces[f];
      if (!face) continue;
      for (let i = 0; i < face.length; i++) {
        const p = o.mesh.getVert(face[i]), q = o.mesh.getVert(face[(i + 1) % face.length]);
        sum += Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
        n++;
      }
    }
    return n ? (sum / n) * 0.25 : 0.1;
  }

  /** Adjust Last Operation for Loop Cut / Inset: undo and redo with the new values. */
  adjustOp(values: Record<string, number>): void {
    const a = S.adjustLast.value;
    if (!a) return;
    if (a.kind === 'loopcut' && this.lastLoopEdge) {
      this.history.undo();
      this.loopCut(values.cuts, values.factor, this.lastLoopEdge);
    } else if (a.kind === 'subdivide') {
      this.history.undo();
      this.subdivide(values.cuts, values.axis as SubdivideAxis, this.lastSubdivFaces);
    } else if (a.kind === 'inset') {
      this.history.undo();
      this.inset(values.thickness, values.depth);
    }
  }

  mergeDistance(threshold = 0.0001): void {
    let removed = 0;
    const cmd = this.runOp('Merge by Distance', (o) => {
      const r = mergeByDistance(o.mesh, o.editSelection, threshold);
      removed = r.removed;
      return r;
    });
    if (cmd) S.toast(`Removed ${removed} vertices`);
  }

  // --- Vertex Paint -----------------------------------------------------------------------

  private stroke: { obj: SceneObject; before: number[]; cage: ScreenCage; last: { x: number; y: number } } | null = null;

  private paintObject(): SceneObject | null {
    const o = S.mode.value === 'paint' ? this.active : null;
    return o && o.mesh.colors ? o : null;
  }

  private get texturePainting(): boolean {
    return S.mode.value === 'paint' && S.paintTarget.value === 'texture';
  }

  paintStart(x: number, y: number): void {
    if (this.texturePainting) return this.texStart(x, y);
    const o = this.paintObject();
    if (!o) return;
    if (S.paintTool.value === 'pick') return this.pickColor(x, y);
    this.stroke = { obj: o, before: o.mesh.colors!.slice(), cage: projectCage(this.vp, o, false), last: { x, y } };
    this.dab(x, y);
  }

  paintMove(x: number, y: number): void {
    if (this.texturePainting) return this.texMove(x, y);
    const s = this.stroke;
    if (!s) {
      if (S.paintTool.value === 'pick') this.pickColor(x, y);
      return;
    }
    // Space dabs along the stroke so fast swipes still paint a continuous line.
    const r = S.brushRadius.value;
    const dist = Math.hypot(x - s.last.x, y - s.last.y);
    const step = Math.max(2, r * 0.3);
    const n = Math.floor(dist / step);
    for (let i = 1; i <= n; i++) {
      const t = (i * step) / dist;
      this.dab(s.last.x + (x - s.last.x) * t, s.last.y + (y - s.last.y) * t);
    }
    if (n > 0) s.last = { x: s.last.x + ((x - s.last.x) * n * step) / dist, y: s.last.y + ((y - s.last.y) * n * step) / dist };
    S.brushCursor.value = { x, y, r };
  }

  paintEnd(): void {
    if (this.texturePainting) return this.texEnd();
    const s = this.stroke;
    this.stroke = null;
    S.brushCursor.value = null;
    if (!s) return;
    const after = s.obj.mesh.colors!.slice();
    if (after.every((c, i) => c === s.before[i])) return;
    this.push(this.colorsCommand(s.obj, s.before, after, S.paintTool.value === 'blur' ? 'Blur' : 'Paint'));
  }

  private colorsCommand(o: SceneObject, before: number[], after: number[], label: string): Command {
    const put = (c: number[]) => () => {
      if (o.mesh.colors && o.mesh.colors.length === c.length) {
        o.mesh.colors = c.slice();
        o.mesh.touchColors();
      }
      this.changed(false);
    };
    return { label, bytes: before.length * 16, undo: put(before), redo: put(after) };
  }

  /** One brush dab at a screen point. */
  private dab(x: number, y: number): void {
    const s = this.stroke!;
    const c = s.obj.mesh.colors!;
    const r = S.brushRadius.value, strength = S.brushStrength.value;
    const [br, bg, bb] = S.brushColor.value;
    const blur = S.paintTool.value === 'blur';
    const topo = blur ? s.obj.mesh.topology() : null;
    const src = blur ? c.slice() : c;
    for (let v = 0; v < s.cage.sx.length; v++) {
      if (!s.cage.visible[v]) continue;
      const d = Math.hypot(s.cage.sx[v] - x, s.cage.sy[v] - y);
      if (d >= r) continue;
      const f = (1 - (d / r) ** 2) ** 2; // smooth falloff
      const k = strength * f;
      let tr = br, tg = bg, tb = bb;
      if (blur && topo) {
        // Average of the neighbours.
        let n = 0;
        tr = tg = tb = 0;
        for (let e = topo.vEdgeStart[v]; e < topo.vEdgeStart[v + 1]; e++) {
          const ed = topo.vEdges[e];
          const o = topo.edgeV[ed * 2] === v ? topo.edgeV[ed * 2 + 1] : topo.edgeV[ed * 2];
          tr += src[o * 4];
          tg += src[o * 4 + 1];
          tb += src[o * 4 + 2];
          n++;
        }
        if (!n) continue;
        tr /= n;
        tg /= n;
        tb /= n;
      }
      c[v * 4] += (tr - c[v * 4]) * k;
      c[v * 4 + 1] += (tg - c[v * 4 + 1]) * k;
      c[v * 4 + 2] += (tb - c[v * 4 + 2]) * k;
    }
    s.obj.mesh.touchColors();
    S.brushCursor.value = { x, y, r };
    this.vp.requestRender();
  }

  /** Eyedropper: takes the color of the visible vertex nearest the finger. */
  private pickColor(x: number, y: number): void {
    const o = this.paintObject();
    if (!o) return;
    const cage = projectCage(this.vp, o, false);
    let best = -1, bd = 60;
    for (let v = 0; v < cage.sx.length; v++) {
      if (!cage.visible[v]) continue;
      const d = Math.hypot(cage.sx[v] - x, cage.sy[v] - y);
      if (d < bd) {
        bd = d;
        best = v;
      }
    }
    if (best < 0) return;
    const c = o.mesh.colors!;
    S.brushColor.value = [c[best * 4], c[best * 4 + 1], c[best * 4 + 2]];
    S.haptic(6);
  }

  /** Fills the whole object with the brush color. */
  fillColor(): void {
    const o = this.paintObject();
    if (!o) return;
    const before = o.mesh.colors!.slice();
    const [r, g, b] = S.brushColor.value;
    const after = before.map((v, i) => [r, g, b, v][i % 4]);
    o.mesh.colors = after.slice();
    o.mesh.touchColors();
    this.push(this.colorsCommand(o, before, after, 'Fill'));
  }

  /** Removes the color attribute so the object shows its materials again. */
  removeColors(): void {
    const o = this.active;
    if (!o?.mesh.colors) return;
    this.push(
      recordChange(this, 'Remove Color Attribute', { ids: [o.id] }, () => {
        o.mesh.setData({ ...o.mesh.snapshot(), colors: undefined });
        if (S.mode.value === 'paint') S.mode.value = 'object';
      }),
    );
  }

  // --- Texture Paint ----------------------------------------------------------------------

  private texStroke: { obj: SceneObject; image: ProjectImage; layer: PaintLayer; last: { x: number; y: number }; erase: boolean } | null = null;

  /** The image an object paints into, when it has one and is unwrapped. */
  private imageOf(o: SceneObject | null): ProjectImage | null {
    if (!o?.texture || !o.mesh.uvs) return null;
    return this.project.images.find((im) => im.id === o.texture) ?? null;
  }

  /** The object's GPU paint layer (created from its PNG on first use). */
  layerOf(o: SceneObject | null): PaintLayer | null {
    const img = this.imageOf(o);
    if (!img) return null;
    let l = this.layers.get(img.id);
    if (!l) {
      try {
        l = this.painter.createLayer(img.width, img.png);
      } catch (e) {
        S.logError(`could not read texture ${img.name}: ${String(e)}`);
        l = this.painter.createLayer(img.width);
      }
      this.layers.set(img.id, l);
    }
    return l;
  }

  /** True when the object can be texture painted (has UVs and a paint texture). */
  hasPaintTexture(o: SceneObject | null = this.active): boolean {
    return !!this.imageOf(o);
  }

  setPaintTarget(t: 'vertex' | 'texture'): void {
    S.paintTarget.value = t;
    const tool = S.paintTool.value;
    if (t === 'texture' && tool === 'blur') S.paintTool.value = 'draw';
    if (t === 'vertex' && tool === 'erase') S.paintTool.value = 'draw';
    const o = this.active;
    if (t === 'vertex' && o && S.mode.value === 'paint' && !o.mesh.colors) this.addColorAttribute(o);
    this.changed(false);
  }

  private addColorAttribute(o: SceneObject): void {
    // Like Blender, vertex painting needs a color attribute: add one, filled with white.
    this.push(
      recordChange(this, 'Add Color Attribute', { ids: [o.id] }, () => {
        o.mesh.setData({ ...o.mesh.snapshot(), colors: new Array(o.mesh.vertCount * 4).fill(1) });
      }),
    );
  }

  /** Smart-UV-style unwrap (if needed) and a new, transparent paint texture for the active object. */
  createPaintTexture(size = S.textureSize.value): void {
    const o = this.active;
    if (!o) return S.toast('Select an object first', 'error');
    if (!o.mesh.faces.length) return S.toast('This object has no faces to paint', 'error');
    const img: ProjectImage = {
      id: uid(),
      name: uniqueName(`${o.name} Paint`, this.project.images.map((i) => i.name)),
      width: size,
      height: size,
      png: encodePng(new Uint8Array(size * size * 4), size, size),
    };
    // Images stay in the project list (undo may bring the reference back); saving keeps only used ones.
    this.project.images.push(img);
    const hadUVs = !!o.mesh.uvs;
    this.push(
      recordChange(this, 'New Paint Texture', { ids: [o.id], meshes: !hadUVs }, () => {
        if (!hadUVs) o.mesh.setData({ ...o.mesh.snapshot(), uvs: unwrap(o.mesh).uvs });
        o.texture = img.id;
      }),
    );
    S.toast(hadUVs ? `New ${size}×${size} texture` : `Unwrapped, new ${size}×${size} texture`);
  }

  /** Unwraps again (after big topology changes). The paint is cleared, since the islands move. */
  reunwrap(): void {
    const o = this.active;
    if (!o?.mesh.faces.length) return;
    const layer = this.layerOf(o);
    const img = this.imageOf(o);
    const a = recordChange(this, 'Unwrap', { ids: [o.id] }, () => o.mesh.setData({ ...o.mesh.snapshot(), uvs: unwrap(o.mesh).uvs }));
    let cmd: Command = a;
    if (layer && img) {
      const before = layer.cpu.slice();
      layer.cpu.fill(0);
      this.painter.upload(layer);
      layer.version++;
      cmd = composite('Unwrap', a, this.tilesCommand(img, layer, diffTiles(layer.size, before, layer.cpu), 'Clear Paint'));
      this.encodeLater(img);
    }
    this.push(cmd);
    S.toast(layer ? 'Unwrapped again: paint cleared (Undo brings it back)' : 'Unwrapped');
  }

  /** Removes the paint texture (the UVs stay). Undo brings it back. */
  removePaintTexture(): void {
    const o = this.active;
    if (!o?.texture) return;
    this.push(recordChange(this, 'Remove Paint Texture', { ids: [o.id], meshes: false }, () => (o.texture = undefined)));
    if (S.mode.value === 'paint') this.setPaintTarget('vertex');
  }

  /** Shares the paint layer as PNG (transparent where unpainted). */
  async exportTexturePng(): Promise<void> {
    const o = this.active, img = this.imageOf(o);
    if (!o || !img) return S.toast('No paint texture', 'error');
    await this.encodeTextures();
    const file = new File([img.png as BlobPart], `${safeFileName(img.name)}.png`, { type: 'image/png' });
    const r = await shareOrDownload([file], img.name);
    if (r !== 'cancelled') S.toast(r === 'shared' ? 'Texture shared' : 'Texture downloaded');
  }

  private texStart(x: number, y: number): void {
    const o = this.active;
    const img = this.imageOf(o);
    const layer = this.layerOf(o);
    if (!o || !img || !layer) return S.toast('Add a paint texture first', 'error');
    if (S.paintTool.value === 'pick') return this.texPick(x, y);
    this.syncViews(); // geometry and matrices up to date
    const view = this.vp.views.get(o.id);
    if (!view) return;
    const erase = S.paintTool.value === 'erase';
    const [r, g, b] = S.brushColor.value;
    this.painter.beginStroke(layer, view.paintSurface(), this.vp.cam.camera, this.vp.size, [linToSrgb(r), linToSrgb(g), linToSrgb(b)], erase ? 1 : 0);
    this.texStroke = { obj: o, image: img, layer, last: { x, y }, erase };
    this.texDab(x, y);
    this.painter.compose();
    S.brushCursor.value = { x, y, r: S.brushRadius.value };
    this.vp.requestRender();
  }

  private texDab(x: number, y: number): void {
    this.painter.dab({ x, y, radius: S.brushRadius.value, strength: S.brushStrength.value, hardness: S.brushHardness.value });
  }

  private texMove(x: number, y: number): void {
    const s = this.texStroke;
    const r = S.brushRadius.value;
    if (!s) {
      if (S.paintTool.value === 'pick') this.texPick(x, y);
      return;
    }
    // Dabs every 15% of the radius: smooth lines, and the mask (max) keeps the strength even.
    const dist = Math.hypot(x - s.last.x, y - s.last.y);
    const step = Math.max(1.5, r * 0.15);
    const n = Math.floor(dist / step);
    for (let i = 1; i <= n; i++) {
      const t = (i * step) / dist;
      this.texDab(s.last.x + (x - s.last.x) * t, s.last.y + (y - s.last.y) * t);
    }
    if (n > 0) {
      s.last = { x: s.last.x + ((x - s.last.x) * n * step) / dist, y: s.last.y + ((y - s.last.y) * n * step) / dist };
      this.painter.compose();
      this.vp.requestRender();
    }
    S.brushCursor.value = { x, y, r };
  }

  private texEnd(): void {
    const s = this.texStroke;
    this.texStroke = null;
    S.brushCursor.value = null;
    if (!s) return;
    const tiles = this.painter.endStroke();
    this.vp.requestRender();
    if (!tiles.length) return;
    this.push(this.tilesCommand(s.image, s.layer, tiles, s.erase ? 'Erase' : 'Paint'));
    this.encodeLater(s.image);
  }

  /** Undo step for a paint change: only the changed 64×64 tiles, before and after. */
  private tilesCommand(img: ProjectImage, layer: PaintLayer, tiles: PaintTile[], label: string): Command {
    const apply = (which: 'before' | 'after') => () => {
      this.painter.putTiles(layer, tiles, which);
      this.encodeLater(img);
      this.changed(false);
    };
    const bytes = tiles.reduce((n, t) => n + t.before.length * 2, 256);
    return { label, bytes, undo: apply('before'), redo: apply('after') };
  }

  /** Fills (or with Erase, clears) the whole paint texture. */
  fillTexture(): void {
    const o = this.active, img = this.imageOf(o), layer = this.layerOf(o);
    const view = o ? this.vp.views.get(o.id) : undefined;
    if (!o || !img || !layer || !view) return;
    const [r, g, b] = S.brushColor.value;
    const erase = S.paintTool.value === 'erase';
    const tiles = this.painter.fill(layer, view.paintSurface(), [linToSrgb(r), linToSrgb(g), linToSrgb(b)], erase ? 1 : 0);
    this.vp.requestRender();
    if (!tiles.length) return;
    this.push(this.tilesCommand(img, layer, tiles, erase ? 'Clear Paint' : 'Fill'));
    this.encodeLater(img);
  }

  /** Eyedropper: the paint under the finger, or the material color when unpainted there. */
  private texPick(x: number, y: number): void {
    const o = this.active, layer = this.layerOf(o);
    const view = o ? this.vp.views.get(o.id) : undefined;
    if (!o || !layer || !view) return;
    const { width, height } = this.vp.size;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((x / width) * 2 - 1, -(y / height) * 2 + 1), this.vp.cam.camera);
    view.surface.geometry.computeBoundingSphere();
    view.surface.updateMatrixWorld(true);
    const hit = ray.intersectObject(view.surface, false)[0];
    if (!hit?.uv) return;
    const [pr, pg, pb, pa] = this.painter.sample(layer, hit.uv.x, hit.uv.y);
    let c: [number, number, number];
    if (pa >= 128) c = [srgbToLin(pr / 255), srgbToLin(pg / 255), srgbToLin(pb / 255)];
    else {
      const slot = hit.face?.materialIndex ?? 0;
      const m = this.project.materials.find((mm) => mm.id === o.materialSlots[slot]);
      c = m ? [m.base_color[0], m.base_color[1], m.base_color[2]] : [0.8, 0.8, 0.8];
    }
    S.brushColor.value = c;
    S.haptic(6);
  }

  /** Re-encodes an image's PNG in the background, then autosaves. */
  private encodeLater(img: ProjectImage): void {
    const layer = this.layers.get(img.id);
    if (!layer || this.encoding.has(img.id)) return;
    const job = (async () => {
      try {
        // Keep encoding until the PNG matches the latest pixels (painting may go on meanwhile).
        while (layer.encodedVersion !== layer.version) {
          const v = layer.version;
          img.png = await this.painter.encode(layer);
          layer.encodedVersion = v;
        }
      } finally {
        this.encoding.delete(img.id);
      }
      this.autosaver.schedule();
    })();
    this.encoding.set(img.id, job);
  }

  /** Waits until every changed texture has an up-to-date PNG (before saving/sharing files). */
  async encodeTextures(): Promise<void> {
    for (const img of this.project.images) {
      const l = this.layers.get(img.id);
      if (l && l.encodedVersion !== l.version) this.encodeLater(img);
    }
    await Promise.all([...this.encoding.values()]);
  }

  // --- Materials --------------------------------------------------------------------------

  /** A new material with a fresh name and a pleasant color from a small palette. */
  private makeMaterial(): Material {
    const palette: [number, number, number][] = [
      [0.8, 0.25, 0.2],
      [0.2, 0.45, 0.85],
      [0.3, 0.7, 0.3],
      [0.9, 0.7, 0.2],
      [0.6, 0.3, 0.75],
      [0.15, 0.15, 0.15],
      [0.95, 0.95, 0.95],
      [0.85, 0.55, 0.4],
    ];
    const c = palette[this.project.materials.length % palette.length];
    return {
      id: uid(),
      name: uniqueName('Material', this.project.materials.map((m) => m.name)),
      base_color: [c[0], c[1], c[2], 1],
      roughness: 0.5,
      metallic: 0,
    };
  }

  /** Adds a material slot with a new material to the active object. */
  addMaterialSlot(): void {
    const o = this.active;
    if (!o) return S.toast('Select an object first', 'error');
    const mat = this.makeMaterial();
    this.push(
      recordChange(this, 'Add Material', { ids: [o.id], meshes: false, materials: true }, () => {
        this.project.materials.push(mat);
        o.materialSlots = [...o.materialSlots, mat.id];
      }),
    );
    S.activeSlot.value = o.materialSlots.length - 1;
  }

  /** Removes a slot; its faces fall back to the previous slot (like Blender). */
  removeMaterialSlot(slot: number): void {
    const o = this.active;
    if (!o || o.materialSlots.length <= 1) return S.toast('An object keeps at least one material', 'error');
    this.push(
      recordChange(this, 'Remove Material', { ids: [o.id], materials: true }, () => {
        o.materialSlots = o.materialSlots.filter((_, i) => i !== slot);
        if (o.mesh.faceMats) {
          const fm = o.mesh.faceMats.map((m) => (m > slot ? m - 1 : m === slot ? Math.max(0, slot - 1) : m));
          o.mesh.setData({ ...o.mesh.snapshot(), faceMats: fm.some((m) => m !== 0) ? fm : undefined });
        }
        // Drop materials no object uses any more.
        const used = new Set(this.project.objects.flatMap((x) => x.materialSlots));
        this.project.materials = this.project.materials.filter((m) => used.has(m.id) || m.id === DEFAULT_MATERIAL_ID);
      }),
    );
    S.activeSlot.value = Math.max(0, Math.min(slot, o.materialSlots.length - 1));
  }

  /** Points a slot at another existing material. */
  setSlotMaterial(slot: number, materialId: string): void {
    const o = this.active;
    if (!o || o.materialSlots[slot] === materialId) return;
    this.push(
      recordChange(this, 'Set Material', { ids: [o.id], meshes: false, materials: true }, () => {
        o.materialSlots = o.materialSlots.map((id, i) => (i === slot ? materialId : id));
      }),
    );
  }

  /** Assigns a slot to the selected faces (Edit Mode), like Blender's Assign button. */
  assignMaterialSlot(slot: number): void {
    const o = this.editObject();
    if (!o) return;
    if (!o.editSelection.faces.size) return S.toast('Select faces first', 'error');
    this.push(
      recordChange(this, 'Assign Material', { ids: [o.id] }, () => {
        const fm = o.mesh.faces.map((_, i) => (o.editSelection.faces.has(i) ? slot : (o.mesh.faceMats?.[i] ?? 0)));
        o.mesh.setData({ ...o.mesh.snapshot(), faceMats: fm.some((m) => m !== 0) ? fm : undefined });
      }),
    );
    S.haptic(10);
  }

  /** Selects every face that uses a slot. */
  selectMaterialSlot(slot: number): void {
    const o = this.editObject();
    if (!o) return;
    const faces = o.mesh.faces.map((_, i) => i).filter((i) => (o.mesh.faceMats?.[i] ?? 0) === slot);
    const base = S.pickOp.value === 'add' ? cloneSelection(o.editSelection) : emptySelection();
    for (const f of faces) base.faces.add(f);
    this.applySelection(o, flushSelection(o.mesh, base, 'face'), 'Select by Material');
  }

  private matEdit: { before: Material[] } | null = null;

  /**
   * Edits a material. Live changes (slider/color drags) apply immediately; `commit` turns
   * everything since the first live change into one undo step.
   */
  updateMaterial(id: string, patch: Partial<Material>, commit: boolean): void {
    const m = this.project.materials.find((x) => x.id === id);
    if (!m) return;
    this.matEdit ??= { before: structuredClone(this.project.materials) };
    Object.assign(m, patch);
    this.changed(false);
    if (!commit) return;
    const before = this.matEdit.before;
    const after = structuredClone(this.project.materials);
    this.matEdit = null;
    const put = (mats: Material[]) => () => {
      this.project.materials = structuredClone(mats);
      this.changed(false);
    };
    this.push({ label: 'Material', bytes: 2048, undo: put(before), redo: put(after) });
  }

  // --- Modifiers --------------------------------------------------------------------------

  addModifier(type: ModifierType): void {
    const o = this.active;
    if (!o) return S.toast('Select an object first', 'error');
    if (o.modifiers.some((m) => m.type === type)) return S.toast(`${type === 'MIRROR' ? 'Mirror' : 'Subdivision'} is already on`, 'error');
    this.push(
      recordChange(this, 'Add Modifier', { ids: [o.id], meshes: false }, () => {
        o.modifiers = sortStack([...o.modifiers, type === 'MIRROR' ? newMirror() : newSubsurf()]);
        if (type === 'SUBSURF') o.shade_smooth = true;
      }),
    );
  }

  updateModifier(index: number, patch: Partial<Modifier>): void {
    const o = this.active;
    if (!o || !o.modifiers[index]) return;
    this.push(
      recordChange(this, 'Modifier', { ids: [o.id], meshes: false }, () => {
        o.modifiers[index] = { ...o.modifiers[index], ...patch } as Modifier;
      }),
    );
  }

  removeModifier(index: number): void {
    const o = this.active;
    if (!o) return;
    this.push(
      recordChange(this, 'Remove Modifier', { ids: [o.id], meshes: false }, () => {
        o.modifiers = o.modifiers.filter((_, i) => i !== index);
      }),
    );
  }

  // --- View -------------------------------------------------------------------------------

  frameSelected(): void {
    const o = this.editObject();
    if (o) {
      const verts = o.editSelection.verts.size ? [...o.editSelection.verts] : [...Array(o.mesh.vertCount).keys()];
      return this.frameWorldPoints(verts.map((v) => transformPoint(objectMatrix(o), o.mesh.getVert(v))));
    }
    const objs = this.selectedObjects();
    this.frameObjects(objs.length ? objs : this.project.objects.filter((x) => x.visible));
  }

  frameAll(instant = false): void {
    const objs = this.project.objects.filter((x) => x.visible);
    this.frameObjects(objs);
    if (instant) for (let i = 0; i < 40 && this.vp.cam.tick(performance.now() + 10_000); i++);
  }

  private frameObjects(objs: SceneObject[]): void {
    const pts: Vec3[] = [];
    for (const o of objs) {
      const ev = this.evals.get(o.id);
      const pos = ev?.positions ?? o.mesh.positions;
      const b = bounds(pos);
      if (!b) continue;
      const m = objectMatrix(o);
      for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) pts.push(transformPoint(m, [x, y, z]));
    }
    if (!pts.length) pts.push([-1, -1, -1], [1, 1, 1]);
    this.frameWorldPoints(pts);
  }

  private frameWorldPoints(pts: Vec3[]): void {
    const box = new THREE.Box3();
    for (const p of pts) box.expandByPoint(new THREE.Vector3(...p));
    const s = box.getBoundingSphere(new THREE.Sphere());
    this.vp.cam.frame(s.center, Math.max(s.radius, 0.15));
    this.vp.requestRender();
  }

  // --- Transforms -------------------------------------------------------------------------

  private medianWorld(o: SceneObject, verts: number[]): Vec3 {
    const m = objectMatrix(o);
    const c: Vec3 = [0, 0, 0];
    for (const v of verts) {
      const w = transformPoint(m, o.mesh.getVert(v));
      c[0] += w[0] / verts.length;
      c[1] += w[1] / verts.length;
      c[2] += w[2] / verts.length;
    }
    return c;
  }

  /** Median point of what a transform would move, or null if nothing is selected. */
  pivot(): Vec3 | null {
    const o = this.editObject();
    if (o) {
      const verts = [...o.editSelection.verts];
      return verts.length ? this.medianWorld(o, verts) : null;
    }
    const objs = this.selectedObjects();
    if (!objs.length) return null;
    const c: Vec3 = [0, 0, 0];
    for (const ob of objs) for (let k = 0; k < 3; k++) c[k] += ob.location[k] / objs.length;
    return c;
  }

  /**
   * Starts sliding the selection along one axis (finger on an X/Y/Z chip, or a drag on the view
   * while a chip is held): Move/Rotate/Scale follow the active tool, any other tool moves.
   * Right/up = positive. `prev` = the lock shown before (Scale keeps a matching plane lock).
   */
  beginAxisSlide(axis: 0 | 1 | 2, x: number, y: number, prev: S.Constraint | null): boolean {
    const t = S.tool.value;
    const kind: TransformKind = t === 'rotate' || t === 'scale' ? t : 'move';
    const constraint: S.Constraint = kind === 'scale' && prev?.kind === 'plane' && prev.axis === axis ? prev : { kind: 'axis', axis };
    if (!this.beginTransform(kind, x, y, null, { constraint, scrub: true })) {
      S.toast('Select something first', 'error');
      return false;
    }
    S.constraint.value = constraint;
    S.haptic(6);
    return true;
  }

  /** Whether a transform tool's drag from (x, y) should transform (vs. orbit the view). */
  dragTransforms(x: number, y: number, hit: GizmoHit | null): boolean {
    if (hit || this.extrudeFollow) return true; // gizmo handle, or "drag anywhere to extrude"
    return this.touchesGeometry(x, y);
  }

  /** Whether (x, y) is on an object (Object Mode) or on the edited mesh / near its elements. */
  touchesGeometry(x: number, y: number): boolean {
    const o = this.editObject();
    if (!o) return pickObject(this.vp, this.project.objects, this.evals, x, y) !== null;
    if (pickObject(this.vp, [o], this.evals, x, y)) return true;
    const cage = projectCage(this.vp, o, S.xray.value);
    return !!(pickElement(o, cage, 'vert', x, y, 28) || pickElement(o, cage, 'edge', x, y, 20) || pickElement(o, cage, 'face', x, y, 0));
  }

  gizmoHit(x: number, y: number): GizmoHit | null {
    if (!S.isTransformTool.value) return null;
    return this.vp.gizmo.hitTest(this.vp.cam, x, y);
  }

  /** Starts a transform; returns false when there is nothing to transform. */
  beginTransform(kind: TransformKind, x: number, y: number, hit: GizmoHit | null, opts: { constraint?: S.Constraint; scrub?: boolean } = {}): boolean {
    const pivot = this.pivot();
    if (!pivot) return false;
    const scrub = !!opts.scrub;
    let c = opts.constraint ?? S.constraint.value;
    if (hit) {
      if (hit.kind === 'axis' || hit.kind === 'ring') c = { kind: 'axis', axis: hit.axis };
      else if (hit.kind === 'plane') c = { kind: 'plane', axis: hit.axis };
      else c = null;
    }
    if (kind === 'rotate' && c?.kind === 'plane') c = { kind: 'axis', axis: c.axis };
    if (this.extrudeFollow && kind !== 'move') this.cancelExtrudeFollow();
    const snap = { enabled: S.snapEnabled.value, ...S.snapSettings.value };
    const o = this.editObject();
    if (o) {
      const t = makeEditTarget(o, [...o.editSelection.verts], S.propEnabled.value ? S.propRadius.value : null);
      this.session = new TransformSession(kind, this.vp.cam, { x, y }, c, { edit: t }, pivot, snap, scrub);
      this.sessionRecord = null;
    } else {
      const objs = this.selectedObjects();
      this.sessionRecord = beginRecord(this, { ids: objs.map((ob) => ob.id), meshes: false });
      this.session = new TransformSession(kind, this.vp.cam, { x, y }, c, { objects: objs }, pivot, snap, scrub);
    }
    S.transforming.value = true;
    S.hint.value = null;
    S.adjustLast.value = null;
    this.vp.gizmo.highlight = hit;
    return true;
  }

  updateTransform(x: number, y: number, precision: boolean): void {
    if (!this.session) return;
    this.session.update({ x, y }, precision);
    this.updatePropCircle();
    S.readout.value = this.session.label;
    S.precision.value = precision;
    this.vp.requestRender();
  }

  endTransform(cancelled: boolean): void {
    const s = this.session;
    if (!s) return;
    this.session = null;
    S.transforming.value = false;
    S.propCircle.value = null;
    S.readout.value = null;
    S.precision.value = false;
    this.vp.gizmo.highlight = null;
    const label = s.kind === 'move' ? 'Move' : s.kind === 'rotate' ? 'Rotate' : 'Scale';
    if (cancelled) {
      s.cancel();
      this.sessionRecord = null;
      this.changed(false);
      return;
    }
    let cmd: Command;
    if (s.edit) {
      const e = s.edit;
      const pos = e.obj.mesh.positions;
      const after = new Float64Array(e.verts.length * 3);
      e.verts.forEach((v, i) => after.set([pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]], i * 3));
      cmd = vertexMoveCommand(this, e.obj, e.verts, e.start, after, label);
      const f = this.extrudeFollow;
      if (f && s.kind === 'move' && f.obj === e.obj) {
        this.history.replaceLast(composite('Extrude', f.extrudeCmd, cmd));
        const dirLocal = f.dirWorld ? normalize(transformDir(e.inv, f.dirWorld)) : null;
        if (dirLocal) {
          Object.assign(f, { verts: e.verts, start: e.start, dirLocal });
          S.adjustLast.value = { kind: 'extrude', title: 'Extrude', values: { offset: s.value } };
        }
        this.cancelExtrudeFollowKeepAdjust();
        this.changed(false);
        this.autosaver.schedule();
        return;
      }
    } else {
      cmd = this.sessionRecord!.finish(label);
      this.sessionRecord = null;
    }
    this.push(cmd);
  }

  private cancelExtrudeFollowKeepAdjust(): void {
    if (S.constraint.value?.kind === 'dir') S.constraint.value = null;
    S.hint.value = null;
  }

  /** Adjust Last for extrude: change the offset along the normal. */
  setExtrudeOffset(offset: number): void {
    const f = this.extrudeFollow;
    if (!f || !f.verts || !f.start || !f.dirLocal) return;
    const pos = f.obj.mesh.positions;
    const after = new Float64Array(f.verts.length * 3);
    f.verts.forEach((v, i) => {
      for (let k = 0; k < 3; k++) {
        pos[v * 3 + k] = f.start![i * 3 + k] + f.dirLocal![k] * offset;
        after[i * 3 + k] = pos[v * 3 + k];
      }
    });
    f.obj.mesh.touchPositions();
    this.history.replaceLast(composite('Extrude', f.extrudeCmd, vertexMoveCommand(this, f.obj, f.verts, f.start, after, 'Move')));
    S.adjustLast.value = { kind: 'extrude', title: 'Extrude', values: { offset } };
    this.changed(false);
    this.autosaver.schedule();
  }

  /** Sets the proportional falloff radius (live while dragging). */
  setPropRadius(r: number): void {
    const radius = Math.min(50, Math.max(0.01, r));
    S.propRadius.value = radius;
    if (this.session?.edit && S.propEnabled.value) {
      this.session.setProportionalRadius(radius);
      this.updatePropCircle();
      this.vp.requestRender();
    }
  }

  private updatePropCircle(): void {
    const s = this.session;
    if (!s?.edit || !S.propEnabled.value) {
      S.propCircle.value = null;
      return;
    }
    const p = new THREE.Vector3(...s.pivot);
    const c = this.vp.cam.project(p.clone());
    S.propCircle.value = { x: c.x, y: c.y, r: S.propRadius.value / worldPerPixelAt(this.vp.cam, p) };
  }

  /** Gizmo shown for transform tools when something is selected. */
  gizmoMode(): GizmoMode | null {
    if (S.mode.value === 'paint') return null;
    const t = S.tool.value;
    return t === 'move' || t === 'rotate' || t === 'scale' ? t : null;
  }

  // --- Per-frame sync ---------------------------------------------------------------------

  private syncViews(): void {
    const objs = this.project.objects;
    this.vp.prune(new Set(objs.map((o) => o.id)));
    for (const id of this.evaluators.keys()) {
      if (!objs.some((o) => o.id === id)) {
        this.evaluators.delete(id);
        this.evals.delete(id);
        this.stamps.delete(id);
      }
    }
    const editing = this.editObject();
    const sel = S.selectedIds.value;
    const xray = S.xray.value;
    const sessionObjs = new Set(this.session ? (this.session.edit ? [this.session.edit.obj] : this.session.objects) : []);
    let evalMs = 0, buildMs = 0;
    for (const o of objs) {
      const dragging = sessionObjs.has(o) && !!this.session?.edit;
      const stamp = `${o.mesh.topoVersion}|${o.mesh.posVersion}|${o.mesh.colorVersion}|${JSON.stringify(o.modifiers)}|${dragging}`;
      let ev = this.evals.get(o.id);
      if (!ev || this.stamps.get(o.id) !== stamp) {
        let evaluator = this.evaluators.get(o.id);
        if (!evaluator) this.evaluators.set(o.id, (evaluator = new StackEvaluator()));
        ev = evaluator.evaluate(o.mesh, o.modifiers, { dragging });
        this.evals.set(o.id, ev);
        this.stamps.set(o.id, stamp);
        evalMs += ev.evalMs;
        buildMs += ev.buildMs;
      }
      const view = this.vp.view(o.id);
      view.setPaint(this.layerOf(o)?.texture ?? null);
      const looks = o.materialSlots.map((id) => {
        const m = this.project.materials.find((x) => x.id === id);
        return { color: m?.base_color ?? [0.8, 0.8, 0.8, 1], roughness: m?.roughness ?? 0.5, metallic: m?.metallic ?? 0 } as SlotLook;
      });
      view.updateSurface(o, ev, looks, S.shading.value);
      if (xray !== this.lastXray) view.setXray(xray);
      view.setOutline(editing || S.mode.value === 'paint' || !sel.has(o.id) ? 'none' : o.id === S.activeId.value ? 'active' : 'selected');
      view.updateCage(editing === o ? o : null, {
        selectMode: S.selectMode.value,
        xray,
        hover: this.hover ? { kind: this.hover.kind, index: this.hover.index } : null,
      });
    }
    this.lastXray = xray;
    this.vp.useEnvironment(S.shading.value === 'material');
    if (evalMs || buildMs) this.lastEval = { evalMs, buildMs };
    const pivot = this.pivot();
    const gm = this.gizmoMode();
    this.vp.gizmo.update(this.vp.cam, pivot ? new THREE.Vector3(...pivot) : null, gm);
  }

  private drawLoupe(): void {
    const l = S.loupe.value, c = this.loupeCanvas;
    if (!l || !c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const { dpr } = this.vp.size;
    const region = 56; // CSS px around the finger, magnified into the loupe
    const sx = (l.x - region / 2) * dpr, sy = (l.y - region / 2) * dpr;
    ctx.imageSmoothingEnabled = true;
    ctx.fillStyle = '#2a2c31';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(this.vp.canvas, sx, sy, region * dpr, region * dpr, 0, 0, c.width, c.height);
  }
}

const linToSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(0, c), 1 / 2.4) - 0.055);
const srgbToLin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

function sameSel(a: Selection, b: Selection): boolean {
  const eq = (x: Set<number>, y: Set<number>) => x.size === y.size && [...x].every((v) => y.has(v));
  return eq(a.verts, b.verts) && eq(a.edges, b.edges) && eq(a.faces, b.faces);
}

function pointIn(x: number, y: number, poly: [number, number][]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
