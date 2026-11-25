// UI-facing state as Preact signals. Scene data itself lives in plain objects (the core);
// `sceneRev` is bumped whenever it changes so the UI and viewport know to refresh.

import { signal, computed } from '@preact/signals';
import type { SelectMode } from '../core/mesh/selection';
import type { Vec3 } from '../core/math/vec3';
import type { PrimitiveType } from '../core/primitives/primitives';

export type Mode = 'object' | 'edit' | 'paint';
export type ToolId = 'select' | 'box' | 'lasso' | 'move' | 'rotate' | 'scale';
export type PickOp = 'replace' | 'add' | 'sub';
export const popover = signal<null | 'select'>(null);
export type SheetId = null | 'add' | 'outliner' | 'modifiers' | 'menu' | 'item' | 'projects' | 'help' | 'export' | 'materials' | 'texture';

/** Axis constraint for transforms: one axis, a plane (all but one axis), or a custom direction. */
export type Constraint =
  | { kind: 'axis'; axis: 0 | 1 | 2 }
  | { kind: 'plane'; axis: 0 | 1 | 2 }
  | { kind: 'dir'; dir: Vec3; label: string };

export interface AdjustLast {
  kind: 'primitive' | 'extrude' | 'loopcut' | 'inset' | 'subdivide';
  title: string;
  /** For primitives: the type, so the panel knows which parameters to show. */
  primitive?: PrimitiveType;
  values: Record<string, number>;
  /** Limits for each value (non-primitive kinds). */
  specs?: Record<string, { min: number; max: number; step: number; int?: boolean; label?: string }>;
}

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error';
}

export const sceneRev = signal(0);
export const mode = signal<Mode>('object');
export const selectMode = signal<SelectMode>('vert');
export const tool = signal<ToolId>('select');
export const pickOp = signal<PickOp>('replace');
export const activeId = signal<string | null>(null);
export const selectedIds = signal<ReadonlySet<string>>(new Set());
export const constraint = signal<Constraint | null>(null);
export const snapEnabled = signal(false);
export const snapSettings = signal({ move: 0.25, rotateDeg: 15, scale: 0.1 });
export const xray = signal(false);
export const sheet = signal<SheetId>(null);
export const adjustLast = signal<AdjustLast | null>(null);
export const readout = signal<string | null>(null);
export const hint = signal<string | null>(null);
export const toasts = signal<Toast[]>([]);
export const hudVisible = signal(false);
export const hudStats = signal({ fps: 0, frameMs: 0, evalMs: 0, buildMs: 0, verts: 0, faces: 0, cageVerts: 0 });
export const errorLog = signal<string[]>([]);
export const canUndo = signal(false);
export const canRedo = signal(false);
export const projectName = signal('Untitled');
export const updateReady = signal(false);
export const saveState = signal<'saved' | 'saving' | 'dirty'>('saved');
export const transforming = signal(false);
export const marquee = signal<{ kind: 'box' | 'lasso'; points: [number, number][] } | null>(null);
export const loupe = signal<{ x: number; y: number } | null>(null);
export const precision = signal(false);
/** Proportional editing (Edit Mode transforms): on/off and falloff radius in meters. */
export const propEnabled = signal(false);
/** Viewport shading: Solid (matcap, like Blender's Solid mode) or Material (lit, roughness/metallic). */
export const shading = signal<'solid' | 'material'>('solid');
/** Material slot being edited in the Materials sheet. */
export const activeSlot = signal(0);

// Vertex Paint / Texture Paint
export type PaintTool = 'draw' | 'blur' | 'erase' | 'pick';
export const paintTool = signal<PaintTool>('draw');
/** What Paint mode paints into: the "Color" attribute or the object's paint texture. */
export const paintTarget = signal<'vertex' | 'texture'>('vertex');
/** Size of new paint textures (square). */
export const textureSize = signal(1024);
/** Brush edge for texture painting: 0 soft … 1 hard. */
export const brushHardness = signal(0.5);
/** Brush color, linear RGB. */
export const brushColor = signal<[number, number, number]>([0.88, 0.58, 0.39]);
/** Brush radius in CSS px (screen space, like Blender's default). */
export const brushRadius = signal(36);
export const brushStrength = signal(0.6);
export const recentColors = signal<string[]>([]);
export const brushCursor = signal<{ x: number; y: number; r: number } | null>(null);
export const propRadius = signal(0.5);
/** Falloff circle shown while dragging with proportional editing (CSS px). */
export const propCircle = signal<{ x: number; y: number; r: number } | null>(null);

export const isTransformTool = computed(() => tool.value === 'move' || tool.value === 'rotate' || tool.value === 'scale');

let toastId = 1;
export function toast(text: string, kind: Toast['kind'] = 'info', ms = 2200): void {
  const t = { id: toastId++, text, kind };
  toasts.value = [...toasts.value, t].slice(-3);
  setTimeout(() => (toasts.value = toasts.value.filter((x) => x.id !== t.id)), ms);
}

export function logError(msg: string): void {
  const line = `${new Date().toLocaleTimeString()} ${msg}`;
  errorLog.value = [...errorLog.value, line].slice(-50);
}

/** A short haptic tick (Android Chrome); silently ignored elsewhere. */
export function haptic(ms = 8): void {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* ignore */
  }
}
