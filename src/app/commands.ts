// Undoable commands over the scene.
//
// `recordChange` snapshots the affected objects (including meshes) plus the UI selection
// state before and after a mutation. `vertexMoveCommand` stores only the moved vertices,
// which keeps transform undo steps tiny.

import type { Command } from '../core/history/history';
import type { Project, SceneObject } from '../core/scene/scene';
import { cloneData, type MeshData } from '../core/mesh/mesh';
import { cloneSelection, type Selection, type SelectMode } from '../core/mesh/selection';
import type { Mode } from './state';

export interface UiSel {
  activeId: string | null;
  selectedIds: string[];
  mode: Mode;
  selectMode: SelectMode;
}

interface ObjSnap {
  data: Omit<SceneObject, 'mesh' | 'editSelection'>;
  mesh: MeshData | null;
  editSelection: Selection;
}

function snap(o: SceneObject, withMesh: boolean): ObjSnap {
  const { mesh, editSelection, ...rest } = o;
  return {
    data: structuredClone(rest),
    mesh: withMesh ? cloneData(mesh) : null,
    editSelection: cloneSelection(editSelection),
  };
}

function snapBytes(s: ObjSnap): number {
  return s.mesh ? s.mesh.positions.length * 8 + s.mesh.faces.reduce((n, f) => n + f.length * 8 + 16, 0) : 256;
}

export interface SceneHost {
  project: Project;
  /** Finds or creates the live object for an id (keeps object identity stable across undo). */
  objectFactory(id: string): SceneObject;
  getUiSel(): UiSel;
  setUiSel(s: UiSel): void;
  changed(topology: boolean): void;
}

export interface ChangeOptions {
  /** Objects whose state changes; 'all' snapshots every object. */
  ids: string[] | 'all';
  /** Snapshot meshes too (off for pure transform/rename changes). */
  meshes?: boolean;
}

/** Starts recording: snapshots now, `finish` snapshots again and returns the undo command. */
export function beginRecord(host: SceneHost, opts: ChangeOptions): { finish(label: string): Command; abort(): void } {
  const withMesh = opts.meshes ?? true;
  const pick = () =>
    opts.ids === 'all' ? host.project.objects : host.project.objects.filter((o) => (opts.ids as string[]).includes(o.id));
  const beforeOrder = host.project.objects.map((o) => o.id);
  const before = new Map(pick().map((o) => [o.id, snap(o, withMesh)]));
  const beforeUi = host.getUiSel();
  return {
    abort: () => restore(host, beforeOrder, before, beforeUi),
    finish: (label: string) => {
      const afterOrder = host.project.objects.map((o) => o.id);
      const touched = new Set([...before.keys(), ...afterOrder.filter((id) => !beforeOrder.includes(id))]);
      const after = new Map(host.project.objects.filter((o) => touched.has(o.id)).map((o) => [o.id, snap(o, withMesh)]));
      const afterUi = host.getUiSel();
      let bytes = 512;
      for (const s of before.values()) bytes += snapBytes(s);
      for (const s of after.values()) bytes += snapBytes(s);
      return {
        label,
        bytes,
        undo: () => restore(host, beforeOrder, before, beforeUi),
        redo: () => restore(host, afterOrder, after, afterUi),
      };
    },
  };
}

/** Runs `mutate` and returns a command that undoes/redoes it. If `mutate` throws, the scene is restored. */
export function recordChange(host: SceneHost, label: string, opts: ChangeOptions, mutate: () => void): Command {
  const rec = beginRecord(host, opts);
  try {
    mutate();
  } catch (e) {
    rec.abort();
    throw e;
  }
  return rec.finish(label);
}

/** Two commands as one undo step (e.g. Extrude + its move). */
export function composite(label: string, a: Command, b: Command): Command {
  return {
    label,
    bytes: a.bytes + b.bytes,
    undo: () => {
      b.undo();
      a.undo();
    },
    redo: () => {
      a.redo();
      b.redo();
    },
  };
}

function restore(host: SceneHost, order: string[], snaps: Map<string, ObjSnap>, ui: UiSel): void {
  let topology = false;
  const objs: SceneObject[] = [];
  for (const id of order) {
    const o = host.objectFactory(id);
    const s = snaps.get(id);
    if (s) {
      Object.assign(o, structuredClone(s.data));
      if (s.mesh) {
        o.mesh.setData(cloneData(s.mesh));
        topology = true;
      }
      o.editSelection = cloneSelection(s.editSelection);
    }
    objs.push(o);
  }
  if (objs.length !== host.project.objects.length) topology = true;
  host.project.objects = objs;
  host.setUiSel(ui);
  host.changed(topology);
}

/** Undo step for moving vertices of one object (edit-mode transforms). */
export function vertexMoveCommand(
  host: SceneHost,
  obj: SceneObject,
  verts: Int32Array,
  before: Float64Array,
  after: Float64Array,
  label: string,
): Command {
  const apply = (src: Float64Array) => {
    const p = obj.mesh.positions;
    for (let i = 0; i < verts.length; i++) {
      const v = verts[i] * 3;
      p[v] = src[i * 3];
      p[v + 1] = src[i * 3 + 1];
      p[v + 2] = src[i * 3 + 2];
    }
    obj.mesh.touchPositions();
    host.changed(false);
  };
  return { label, bytes: verts.length * 52 + 128, undo: () => apply(before), redo: () => apply(after) };
}

/** Undo step for an edit-mode selection change. */
export function editSelectionCommand(host: SceneHost, obj: SceneObject, before: Selection, after: Selection): Command {
  const b = cloneSelection(before), a = cloneSelection(after);
  const bytes = (b.verts.size + b.edges.size + b.faces.size + a.verts.size + a.edges.size + a.faces.size) * 16 + 128;
  return {
    label: 'Select',
    bytes,
    undo: () => {
      obj.editSelection = cloneSelection(b);
      host.changed(false);
    },
    redo: () => {
      obj.editSelection = cloneSelection(a);
      host.changed(false);
    },
  };
}

/** Undo step for an object-mode selection change. */
export function uiSelectionCommand(host: SceneHost, before: UiSel, after: UiSel): Command {
  return {
    label: 'Select',
    bytes: 256,
    undo: () => {
      host.setUiSel(before);
      host.changed(false);
    },
    redo: () => {
      host.setUiSel(after);
      host.changed(false);
    },
  };
}
