// The application controller: every user action ("operator") lives here, turns into an
// undoable command, and keeps the viewport, the UI signals and autosave in sync.

import * as THREE from 'three';
import type { Viewport } from '../render/viewport';
import { projectCage, pickElement, pickObject, elementsInPolygon, type ScreenCage, type Pick } from '../render/picking';
import type { GizmoHit, GizmoMode } from '../render/gizmo';
import { History, type Command } from '../core/history/history';
import { Mesh, bounds, type MeshData } from '../core/mesh/mesh';
import {
  applyPick,
  cloneSelection,
  convertSelectMode,
  emptySelection,
  invertSelection,
  selectAll,
  type Selection,
  type SelectMode,
} from '../core/mesh/selection';
import { extrude as extrudeOp, deleteSelected as deleteOp, mergeAtCenter, mergeByDistance, OpError } from '../core/mesh/ops';
import { StackEvaluator, type EvalResult } from '../core/modifiers/stack';
import { newMirror, newSubsurf, sortStack, type Modifier, type ModifierType } from '../core/modifiers/types';
import { buildPrimitive, PRIMITIVE_DEFAULTS, PRIMITIVE_LABELS, type PrimitiveType } from '../core/primitives/primitives';
import { newObject, newProject, objectMatrix, uniqueName, uid, type Project, type SceneObject } from '../core/scene/scene';
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
import { objFiles, pickFile, projectFile, shareOrDownload } from './files';

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

  constructor(readonly vp: Viewport) {
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

  async exportObj(applyMirror: boolean, zip: boolean): Promise<void> {
    if (!this.project.objects.some((o) => o.visible)) return S.toast('Nothing visible to export', 'error');
    const r = await shareOrDownload(objFiles(this.project, applyMirror, zip), this.project.name);
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
        materialId: o.materialId,
        shade_smooth: o.shade_smooth,
        editSelection: cloneSelection(o.editSelection),
      });
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

  private editTap(x: number, y: number): void {
    const o = this.active;
    if (!o) return;
    const cage = projectCage(this.vp, o, S.xray.value);
    const pick = pickElement(o, cage, S.selectMode.value, x, y, 30);
    this.applyEditPick(o, pick ? [pick.index] : [], S.pickOp.value === 'add' ? 'toggle' : S.pickOp.value);
    if (pick) S.haptic();
  }

  private applyEditPick(o: SceneObject, items: number[], op: 'replace' | 'add' | 'sub' | 'toggle'): void {
    if (!items.length && op !== 'replace') return;
    const before = cloneSelection(o.editSelection);
    const after = applyPick(o.mesh, before, S.selectMode.value, items, op);
    if (sameSel(before, after)) return;
    o.editSelection = after;
    this.push(editSelectionCommand(this, o, before, after));
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
    if (m === 'edit') {
      const o = this.active ?? this.selectedObjects()[0];
      if (!o) return S.toast('Select an object to edit', 'error');
      if (!o.visible) return S.toast('Unhide the object to edit it', 'error');
      S.activeId.value = o.id;
      S.selectedIds.value = new Set([o.id]);
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

  mergeDistance(threshold = 0.0001): void {
    let removed = 0;
    const cmd = this.runOp('Merge by Distance', (o) => {
      const r = mergeByDistance(o.mesh, o.editSelection, threshold);
      removed = r.removed;
      return r;
    });
    if (cmd) S.toast(`Removed ${removed} vertices`);
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

  gizmoHit(x: number, y: number): GizmoHit | null {
    if (!S.isTransformTool.value) return null;
    return this.vp.gizmo.hitTest(this.vp.cam, x, y);
  }

  /** Starts a transform; returns false when there is nothing to transform. */
  beginTransform(kind: TransformKind, x: number, y: number, hit: GizmoHit | null): boolean {
    const pivot = this.pivot();
    if (!pivot) return false;
    let c = S.constraint.value;
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
      const t = makeEditTarget(o, [...o.editSelection.verts]);
      this.session = new TransformSession(kind, this.vp.cam, { x, y }, c, { edit: t }, pivot, snap);
      this.sessionRecord = null;
    } else {
      const objs = this.selectedObjects();
      this.sessionRecord = beginRecord(this, { ids: objs.map((ob) => ob.id), meshes: false });
      this.session = new TransformSession(kind, this.vp.cam, { x, y }, c, { objects: objs }, pivot, snap);
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
    S.readout.value = this.session.label;
    S.precision.value = precision;
    this.vp.requestRender();
  }

  endTransform(cancelled: boolean): void {
    const s = this.session;
    if (!s) return;
    this.session = null;
    S.transforming.value = false;
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

  /** Gizmo shown for transform tools when something is selected. */
  gizmoMode(): GizmoMode | null {
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
      const stamp = `${o.mesh.topoVersion}|${o.mesh.posVersion}|${JSON.stringify(o.modifiers)}|${dragging}`;
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
      const mat = this.project.materials.find((m) => m.id === o.materialId);
      view.updateSurface(o, ev, mat?.base_color ?? [0.8, 0.8, 0.8, 1]);
      if (xray !== this.lastXray) view.setXray(xray);
      view.setOutline(editing || !sel.has(o.id) ? 'none' : o.id === S.activeId.value ? 'active' : 'selected');
      view.updateCage(editing === o ? o : null, {
        selectMode: S.selectMode.value,
        xray,
        hover: this.hover ? { kind: this.hover.kind, index: this.hover.index } : null,
      });
    }
    this.lastXray = xray;
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
