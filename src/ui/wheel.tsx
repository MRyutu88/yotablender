// Radial menus (Edit and Object Mode): a big wheel on the left for actions and panels, and a
// small one on the right for Select / Box / Lasso / Move / Rotate / Scale.
//
//   Tap the button         opens the wheel; tap a slice (a category opens its tools, a tool runs)
//   Press, slide, release  marking-menu style: slide toward a category, keep sliding outward onto
//                          a tool and lift to run it (the same motion every time, so it can be
//                          done without looking). Lifting on a category keeps the wheel open on it.
//
// The ring opens away from the screen edge it sits on and only uses angles that fit on screen.

import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { signal } from '@preact/signals';
import type { App } from '../app/app';
import * as S from '../app/state';
import { Icon } from './icons';

export interface WheelItem {
  id: string;
  label: string;
  icon: () => JSX.Element;
  run?: () => void;
  active?: boolean;
  children?: WheelItem[];
}

const R0 = 46; // center disc (cancel / label)
const R1 = 150; // categories ring outer edge
const R2 = 222; // tools ring outer edge
const TOOL_DEG = 27; // angular size of one tool slice
const MARGIN = 10;
const DEG = Math.PI / 180;

/** Ids of the last actions run from the big wheel, newest first (per mode). */
const recents = signal<Record<string, string[]>>(loadRecents());

function loadRecents(): Record<string, string[]> {
  try {
    return JSON.parse(localStorage.getItem('yb-wheel-recents') ?? '{}') ?? {};
  } catch {
    return {};
  }
}

function pushRecent(mode: string, id: string): void {
  const list = [id, ...(recents.value[mode] ?? []).filter((x) => x !== id)].slice(0, 3);
  recents.value = { ...recents.value, [mode]: list };
  try {
    localStorage.setItem('yb-wheel-recents', JSON.stringify(recents.value));
  } catch {
    /* ignore */
  }
}

const toggleSheet = (id: S.SheetId) => (S.sheet.value = S.sheet.value === id ? null : id);

/** The big wheel's categories for the current mode. */
export function wheelItems(app: App): WheelItem[] {
  const sheet = (id: S.SheetId) => () => toggleSheet(id);
  const material: WheelItem = { id: 'material', label: 'Material', icon: () => Icon.palette(), run: sheet('materials') };
  const modifiers: WheelItem = { id: 'modifiers', label: 'Modifiers', icon: () => Icon.wrench(), run: sheet('modifiers') };
  const item: WheelItem = { id: 'item', label: 'Item', icon: () => Icon.sliders(), run: sheet('item') };
  if (S.mode.value === 'edit') {
    return [
      {
        id: 'mesh',
        label: 'Mesh',
        icon: () => Icon.extrude(),
        children: [
          { id: 'extrude', label: 'Extrude', icon: () => Icon.extrude(), run: () => app.extrude() },
          { id: 'inset', label: 'Inset', icon: () => Icon.inset(), run: () => app.inset() },
          {
            id: 'cut',
            label: 'Cut',
            icon: () => Icon.cut(),
            active: S.tool.value === 'cut',
            run: () => (S.tool.value = S.tool.value === 'cut' ? 'select' : 'cut'),
          },
          { id: 'loopcut', label: 'Loop Cut', icon: () => Icon.loopcut(), run: () => app.loopCut() },
          { id: 'subdivide', label: 'Subdivide', icon: () => Icon.subdivide(), run: () => app.subdivide() },
        ],
      },
      {
        id: 'merge',
        label: 'Merge',
        icon: () => Icon.merge(),
        children: [
          { id: 'merge-center', label: 'At Center', icon: () => Icon.merge(), run: () => app.mergeCenter() },
          { id: 'merge-dist', label: 'By Distance', icon: () => Icon.mergeDist(), run: () => app.mergeDistance() },
        ],
      },
      {
        id: 'select',
        label: 'Select',
        icon: () => Icon.select(),
        children: [
          { id: 'sel-all', label: 'All', icon: () => Icon.all(), run: () => app.selectAllToggle('all') },
          { id: 'sel-none', label: 'None', icon: () => Icon.none(), run: () => app.selectAllToggle('none') },
          { id: 'sel-invert', label: 'Invert', icon: () => Icon.invert(), run: () => app.selectAllToggle('invert') },
          { id: 'sel-linked', label: 'Linked', icon: () => Icon.linked(), run: () => app.selectSpecial('linked') },
          { id: 'sel-loop', label: 'Loop', icon: () => Icon.loop(), run: () => app.selectSpecial('loop') },
          { id: 'sel-ring', label: 'Ring', icon: () => Icon.ring(), run: () => app.selectSpecial('ring') },
        ],
      },
      { id: 'delete', label: 'Delete', icon: () => Icon.trash(), run: () => app.deleteElements() },
      material,
      modifiers,
      item,
    ];
  }
  return [
    { id: 'add', label: 'Add', icon: () => Icon.plus(), run: sheet('add') },
    { id: 'objects', label: 'Objects', icon: () => Icon.list(), run: sheet('outliner') },
    { id: 'duplicate', label: 'Duplicate', icon: () => Icon.duplicate(), run: () => app.duplicateSelected() },
    { id: 'delete', label: 'Delete', icon: () => Icon.trash(), run: () => app.deleteSelectedObjects() },
    material,
    modifiers,
    item,
    { id: 'all', label: 'Select All', icon: () => Icon.all(), run: () => app.selectAllToggle('all') },
  ];
}

/** The small wheel: selection and transform tools. */
export function toolItems(): WheelItem[] {
  const t = S.tool.value;
  const set = (id: S.ToolId) => () => {
    S.tool.value = id;
    if (id !== 'move') S.hint.value = null;
  };
  const tool = (id: S.ToolId, label: string, icon: () => JSX.Element): WheelItem => ({ id, label, icon, active: t === id, run: set(id) });
  return [
    tool('select', 'Select', () => Icon.select()),
    tool('box', 'Box', () => Icon.box()),
    tool('lasso', 'Lasso', () => Icon.lasso()),
    tool('move', 'Move', () => Icon.move()),
    tool('rotate', 'Rotate', () => Icon.rotate()),
    tool('scale', 'Scale', () => Icon.scale()),
  ];
}

function findLeaf(items: WheelItem[], id: string): WheelItem | null {
  for (const it of items) {
    if (it.id === id && it.run) return it;
    const c = it.children && findLeaf(it.children, id);
    if (c) return c;
  }
  return null;
}

/** Angles (radians, screen: 0 = right, +90° = down) that keep radius r on screen. */
function fitRange(cy: number, r: number, side: 'left' | 'right'): [number, number] {
  const h = window.innerHeight;
  const up = Math.min(1, (cy - MARGIN - 56) / r); // keep clear of the top bar
  const down = Math.min(1, (h - MARGIN - cy) / r);
  const lo = -Math.asin(Math.max(-1, up));
  const hi = Math.asin(Math.max(-1, down));
  // Right side: mirror the half circle to open leftward.
  return side === 'left' ? [lo, hi] : [Math.PI - hi, Math.PI - lo];
}

function sector(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number): string {
  const p = (r: number, a: number) => `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M${p(r0, a0)}L${p(r1, a0)}A${r1},${r1} 0 ${large} 1 ${p(r1, a1)}L${p(r0, a1)}A${r0},${r0} 0 ${large} 0 ${p(r0, a0)}Z`;
}

interface Slot {
  item: WheelItem;
  a0: number;
  a1: number;
}

function layoutRing(items: WheelItem[], lo: number, hi: number): Slot[] {
  const step = (hi - lo) / items.length;
  return items.map((item, i) => ({ item, a0: lo + i * step, a1: lo + (i + 1) * step }));
}

function layoutTools(items: WheelItem[], center: number, lo: number, hi: number): Slot[] {
  const step = Math.min(TOOL_DEG * DEG, (hi - lo) / items.length);
  let start = center - (step * items.length) / 2;
  start = Math.max(lo, Math.min(hi - step * items.length, start));
  return items.map((item, i) => ({ item, a0: start + i * step, a1: start + (i + 1) * step }));
}

/** Normalizes angle a into [lo - π, lo + π) so comparisons with a slot range work. */
const near = (a: number, ref: number) => a - 2 * Math.PI * Math.floor((a - ref + Math.PI) / (2 * Math.PI));
const slotAt = (slots: Slot[], a: number) => slots.find((s) => near(a, (s.a0 + s.a1) / 2) >= s.a0 && near(a, (s.a0 + s.a1) / 2) < s.a1) ?? null;

/**
 * One radial menu. `side` = the screen edge its button sits on; `ring2` = whether categories
 * open a second ring of tools (the big wheel) or every item is a tool (the small wheel).
 */
function Wheel(props: {
  side: 'left' | 'right';
  label: string;
  buttonIcon: JSX.Element;
  buttonActive?: boolean;
  items: WheelItem[];
  /** Outer radius of the first ring (the small wheel is smaller). */
  r1?: number;
  onRun?: (item: WheelItem) => void;
  children?: JSX.Element | null;
}) {
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [cat, setCat] = useState<string | null>(null); // category whose tools are shown
  const [hover, setHover] = useState<string | null>(null);
  const [center, setCenter] = useState<[number, number]>([0, 0]);
  const drag = useRef<{ id: number; x0: number; y0: number; moved: boolean } | null>(null);
  const live = useRef({ cat: null as string | null, hover: null as string | null });

  const close = () => {
    setOpen(false);
    setCat(null);
    setHover(null);
    live.current = { cat: null, hover: null };
  };
  // Leaving the mode (or a sheet opening from elsewhere) closes the wheel.
  useEffect(close, [S.mode.value]);

  const [cx, cy] = center;
  const r1 = props.r1 ?? R1;
  const ring1 = fitRange(cy, r1, props.side);
  const ring2 = fitRange(cy, R2, props.side);
  const catSlots = layoutRing(props.items, ...ring1);
  const catItem = props.items.find((i) => i.id === cat && i.children);
  const catSlot = catSlots.find((s) => s.item.id === cat);
  const toolSlots = catItem && catSlot ? layoutTools(catItem.children!, (catSlot.a0 + catSlot.a1) / 2, ...ring2) : [];

  const run = (item: WheelItem) => {
    close();
    item.run?.();
    props.onRun?.(item);
    S.haptic(10);
  };

  /** What is under (x, y): updates the hovered slot and the shown category (slide mode). */
  const track = (x: number, y: number) => {
    const dx = x - cx, dy = y - cy;
    const d = Math.hypot(dx, dy), a = Math.atan2(dy, dx);
    let h: string | null = null;
    let c = live.current.cat;
    if (d >= R0 && d < r1) {
      const s = slotAt(catSlots, a);
      h = s?.item.id ?? null;
      c = s?.item.children ? s.item.id : null;
    } else if (d >= r1 && c) {
      const ci = props.items.find((i) => i.id === c)!;
      const cs = catSlots.find((s) => s.item.id === c)!;
      const ts = layoutTools(ci.children!, (cs.a0 + cs.a1) / 2, ...ring2);
      h = slotAt(ts, a)?.item.id ?? null;
    }
    if (h !== live.current.hover && h) S.haptic(4);
    live.current = { cat: c, hover: h };
    setCat(c);
    setHover(h);
  };

  const down = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (open) {
      close();
      return;
    }
    const r = btn.current!.getBoundingClientRect();
    // The ring's center sits on the button, raised if needed so a full half circle of the first
    // ring fits above the screen bottom (the finger still starts inside the center disc).
    const by = r.top + r.height / 2;
    setCenter([r.left + r.width / 2, Math.min(by, window.innerHeight - (props.r1 ?? R1) - MARGIN)]);
    try {
      btn.current!.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    drag.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, moved: false };
    live.current = { cat: null, hover: null };
    setOpen(true);
    S.popover.value = null;
    S.haptic(6);
  };
  const move = (e: PointerEvent) => {
    const g = drag.current;
    if (!g || g.id !== e.pointerId) return;
    if (!g.moved && Math.hypot(e.clientX - g.x0, e.clientY - g.y0) < 10) return;
    g.moved = true;
    track(e.clientX, e.clientY);
  };
  const up = (cancelled: boolean) => (e: PointerEvent) => {
    const g = drag.current;
    if (!g || g.id !== e.pointerId) return;
    drag.current = null;
    if (!g.moved) return; // a tap: stay open for tapping
    if (cancelled) return close();
    const { cat: c, hover: h } = live.current;
    const all = props.items.flatMap((i) => [i, ...(i.children ?? [])]);
    const item = h ? all.find((i) => i.id === h) : null;
    if (item?.run) return run(item);
    if (item?.children || c) {
      // Lifted on a category: keep it open so a tool can be tapped.
      setHover(null);
      return;
    }
    close();
  };

  const tapSlot = (item: WheelItem) => (e: Event) => {
    e.stopPropagation();
    if (item.run) return run(item);
    setCat(cat === item.id ? null : item.id);
    live.current.cat = cat === item.id ? null : item.id;
    S.haptic(6);
  };

  const label = (hover && [...catSlots, ...toolSlots].find((s) => s.item.id === hover)?.item.label) ?? (catItem?.label || '');

  // Two passes (all slices, then all icons) so no slice covers a neighbor's icon.
  const slotEls = (slots: Slot[], r0: number, r1: number, cls: string, pass: 'shape' | 'label') =>
    slots.map((s) => {
      const on = hover === s.item.id || (cls === 'cat' && cat === s.item.id);
      if (pass === 'shape') {
        return (
          <path
            key={s.item.id}
            class={`wslot ${cls} ${on ? 'hover' : ''} ${s.item.active ? 'active' : ''}`}
            d={sector(cx, cy, r0 + 2, r1 - 2, s.a0 + 0.012, s.a1 - 0.012)}
            onClick={tapSlot(s.item)}
          />
        );
      }
      // Icon on the inner part of the slice, label further out where the slice is wider.
      const mid = (s.a0 + s.a1) / 2;
      const at = (f: number): [number, number] => [cx + (r0 + (r1 - r0) * f) * Math.cos(mid), cy + (r0 + (r1 - r0) * f) * Math.sin(mid)];
      const [ix, iy] = at(0.36), [lx, ly] = at(0.74);
      return (
        <g key={s.item.id} class={`wlabel ${on ? 'hover' : ''}`}>
          <foreignObject x={ix - 13} y={iy - 13} width={26} height={26} class="wfo">
            <div class="wicon">{s.item.icon()}</div>
          </foreignObject>
          <text x={lx} y={ly} dy="0.35em">
            {s.item.label}
          </text>
        </g>
      );
    });

  return (
    <>
      {open && (
        <svg class="wheel-layer" width="100%" height="100%" onClick={close} aria-hidden="true">
          <rect class="wheel-dim" width="100%" height="100%" />
          {slotEls(catSlots, R0, r1, 'cat', 'shape')}
          {slotEls(toolSlots, r1, R2, 'tool', 'shape')}
          {slotEls(catSlots, R0, r1, 'cat', 'label')}
          {slotEls(toolSlots, r1, R2, 'tool', 'label')}
          {label && (
            <foreignObject x={cx + (props.side === 'left' ? -10 : -150)} y={cy - (toolSlots.length ? R2 : r1) - 40} width={160} height={32}>
              <div class={`wheel-title ${props.side}`}>{label}</div>
            </foreignObject>
          )}
        </svg>
      )}
      <div class={`wheel-dock ${props.side}`}>
        {props.side === 'left' && props.children}
        <button
          ref={btn}
          class={`wheel-btn ${open ? 'open' : ''} ${props.buttonActive ? 'active' : ''}`}
          aria-label={props.label}
          aria-expanded={open}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up(false)}
          onPointerCancel={up(true)}
          onContextMenu={(e) => e.preventDefault()}
        >
          {open ? Icon.close({ size: 22 }) : props.buttonIcon}
        </button>
        {props.side === 'right' && props.children}
      </div>
      {/* Keyboard / screen reader access: the same items as a plain list while open. */}
      {open && (
        <div class="sr-only" role="menu" aria-label={props.label}>
          {props.items.flatMap((i) => [i, ...(i.children ?? [])]).filter((i) => i.run).map((i) => (
            <button key={i.id} role="menuitem" onClick={() => run(i)}>
              {i.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/** The two wheels and the recent-actions buttons next to the big one. */
export function Wheels({ app }: { app: App }) {
  void S.sceneRev.value;
  const mode = S.mode.value;
  const items = wheelItems(app);
  const tools = toolItems();
  const cur = tools.find((t) => t.active) ?? tools[0];
  const recent = (recents.value[mode] ?? []).map((id) => findLeaf(items, id)).filter((x): x is WheelItem => !!x);
  return (
    <>
      <Wheel side="left" label="Actions" buttonIcon={Icon.dots({ size: 26 })} items={items} onRun={(i) => pushRecent(mode, i.id)}>
        {recent.length ? (
          <div class="wheel-recents" aria-label="Recent actions">
            {recent.map((r) => (
              <button
                key={r.id}
                class={`btn small ${r.active ? 'active' : ''}`}
                aria-label={r.label}
                onClick={() => {
                  r.run?.();
                  pushRecent(mode, r.id);
                }}
              >
                {r.icon()}
              </button>
            ))}
          </div>
        ) : null}
      </Wheel>
      <Wheel side="right" label="Tools" buttonIcon={cur.icon()} buttonActive={S.isTransformTool.value} items={tools} r1={118} />
    </>
  );
}
