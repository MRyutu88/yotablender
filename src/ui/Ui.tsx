import { useEffect, useRef, useState } from 'preact/hooks';
import * as THREE from 'three';
import type { App } from '../app/app';
import * as S from '../app/state';
import { Icon } from './icons';
import { IconButton, Segmented, Stepper } from './widgets';
import { AddSheet, HelpSheet, ItemSheet, MenuSheet, ModifiersSheet, OutlinerSheet, TextureSheet } from './sheets';
import { MaterialsSheet } from './materials';
import { hexToLinear, linearToHex, SWATCHES } from './color';
import { PRIMITIVE_PARAM_SPECS, type PrimitiveType } from '../core/primitives/primitives';
import type { ViewName } from '../render/camera';

export function Ui({ app, installPrompt }: { app: App; installPrompt: (() => void) | null }) {
  void S.sceneRev.value;
  const sheet = S.sheet.value;
  return (
    <div class={`ui mode-${S.mode.value} ${S.transforming.value ? 'transforming' : ''}`}>
      <TopBar app={app} />
      <CenterInfo />
      <AdjustLastPanel app={app} />
      <NavPanel app={app} />
      <BottomBars app={app} />
      {sheet === 'add' && <AddSheet app={app} />}
      {sheet === 'outliner' && <OutlinerSheet app={app} />}
      {sheet === 'modifiers' && <ModifiersSheet app={app} />}
      {sheet === 'item' && <ItemSheet app={app} />}
      {sheet === 'menu' && <MenuSheet app={app} installPrompt={installPrompt} />}
      {sheet === 'help' && <HelpSheet />}
      {sheet === 'materials' && <MaterialsSheet app={app} />}
      {sheet === 'texture' && <TextureSheet app={app} />}
      <SelectPopover app={app} />
      <Marquee />
      <PropCircle />
      <BrushCursor />
      <Loupe app={app} />
      <Hud />
      <Toasts />
      <UpdateBanner />
    </div>
  );
}

function TopBar({ app }: { app: App }) {
  const edit = S.mode.value === 'edit';
  // One control for every mode: Object, Edit (vertex / edge / face) and Vertex Paint.
  const value = edit ? S.selectMode.value : S.mode.value === 'paint' ? 'paint' : 'object';
  return (
    <header class="topbar">
      <IconButton icon={Icon.menu()} title="Menu" onClick={() => toggleSheet('menu')} active={S.sheet.value === 'menu'} />
      <Segmented
        class="modeswitch"
        value={value}
        onChange={(v) => {
          if (v === 'object' || v === 'paint') return app.setMode(v);
          app.setSelectMode(v);
          app.setMode('edit');
        }}
        options={[
          { value: 'object', icon: Icon.cube(), title: 'Object Mode' },
          { value: 'vert', icon: Icon.vert(), title: 'Edit Mode: vertices' },
          { value: 'edge', icon: Icon.edge(), title: 'Edit Mode: edges' },
          { value: 'face', icon: Icon.face(), title: 'Edit Mode: faces' },
          { value: 'paint', icon: Icon.brush(), title: 'Paint (vertex colors or texture)' },
        ]}
      />
      <div class="spacer" />
      <IconButton icon={Icon.undo()} title="Undo" disabled={!S.canUndo.value} onClick={() => app.undo()} />
      <IconButton icon={Icon.redo()} title="Redo" disabled={!S.canRedo.value} onClick={() => app.redo()} />
    </header>
  );
}

function CenterInfo() {
  const r = S.readout.value;
  const h = S.hint.value;
  if (!r && !h) return null;
  return (
    <div class="center-info">
      {r ? (
        <button class="pill readout" onClick={() => (S.sheet.value = 'item')}>
          {r}
          {S.precision.value && <span class="tag">precision</span>}
        </button>
      ) : (
        <div class="pill hint">
          {h}
          <button class="btn small ghost" aria-label="Dismiss" onClick={() => (S.hint.value = null)}>
            {Icon.close({ size: 16 })}
          </button>
        </div>
      )}
    </div>
  );
}

function AdjustLastPanel({ app }: { app: App }) {
  const a = S.adjustLast.value;
  const [open, setOpen] = useState(true);
  if (!a || S.transforming.value) return null;
  let body: preact.JSX.Element[] = [];
  if (a.kind === 'primitive' && a.primitive) {
    const specs = PRIMITIVE_PARAM_SPECS[a.primitive as PrimitiveType] as Record<string, { min: number; max: number; step: number; int?: boolean }>;
    body = Object.entries(specs).map(([k, spec]) => (
      <Stepper
        key={k}
        label={labelize(k)}
        value={a.values[k]}
        min={spec.min}
        max={spec.max}
        step={spec.step}
        int={spec.int}
        onChange={(v) => app.adjustPrimitive({ ...a.values, [k]: v })}
      />
    ));
  } else if (a.kind === 'extrude') {
    body = [<Stepper key="o" label="Offset" value={a.values.offset} min={-100} max={100} step={0.05} onChange={(v) => app.setExtrudeOffset(v)} />];
  } else if (a.specs) {
    body = Object.entries(a.specs).map(([k, spec]) => (
      <Stepper
        key={k}
        label={spec.label ?? labelize(k)}
        value={a.values[k]}
        min={spec.min}
        max={spec.max}
        step={spec.step}
        int={spec.int}
        onChange={(v) => app.adjustOp({ ...a.values, [k]: v })}
      />
    ));
  }
  return (
    <aside class={`adjust ${open ? 'open' : ''}`}>
      <button class="adjust-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? Icon.chevronDown({ size: 18 }) : Icon.chevronUp({ size: 18 })}
        <span>{a.title}</span>
      </button>
      {open && <div class="adjust-body">{body}</div>}
    </aside>
  );
}

function NavPanel({ app }: { app: App }) {
  void S.sceneRev.value;
  const cam = app.vp.cam;
  const views: [ViewName, string, string][] = [
    ['front', 'Front', 'F'],
    ['right', 'Side', 'S'],
    ['top', 'Top', 'T'],
  ];
  return (
    <div class="navpanel">
      <NavBall app={app} />
      <IconButton icon={Icon.frame({ size: 22 })} title="Frame selected" onClick={() => app.frameSelected()} class="small" />
      <IconButton
        icon={Icon.xray({ size: 22 })}
        title="X-ray (see and select through)"
        active={S.xray.value}
        onClick={() => {
          S.xray.value = !S.xray.value;
          app.vp.requestRender();
        }}
        class="small"
      />
      {views.map(([v, title, short]) => (
        <button key={v} class="btn small text" aria-label={`${title} view`} onClick={() => (cam.setView(v), app.vp.requestRender(), S.sceneRev.value++)}>
          {short}
        </button>
      ))}
      <button
        class={`btn small text ${cam.ortho ? 'active' : ''}`}
        aria-label="Toggle orthographic"
        onClick={() => {
          cam.ortho = !cam.ortho;
          cam.update();
          app.vp.requestRender();
          S.sceneRev.value++;
        }}
      >
        {cam.ortho ? 'Orth' : 'Per'}
      </button>
    </div>
  );
}

/** Blender-style navigation gizmo: drag to orbit, tap an axis bubble for that view. */
function NavBall({ app }: { app: App }) {
  const [, force] = useState(0);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  useEffect(() => {
    const prev = app.vp.onAfterFrame;
    let last = '';
    const hook: typeof prev = (s) => {
      prev?.(s);
      const k = `${app.vp.cam.yaw.toFixed(3)}|${app.vp.cam.pitch.toFixed(3)}`;
      if (k !== last) {
        last = k;
        force((n) => n + 1);
      }
    };
    app.vp.onAfterFrame = hook;
    return () => (app.vp.onAfterFrame = prev);
  }, [app]);
  const cam = app.vp.cam;
  const R = 34;
  const right = cam.right(), up = cam.up(), dir = cam.dir();
  const axes = [
    { v: new THREE.Vector3(1, 0, 0), label: 'X', cls: 'x', view: 'right' as ViewName },
    { v: new THREE.Vector3(0, 1, 0), label: 'Y', cls: 'y', view: 'back' as ViewName },
    { v: new THREE.Vector3(0, 0, 1), label: 'Z', cls: 'z', view: 'top' as ViewName },
    { v: new THREE.Vector3(-1, 0, 0), label: '', cls: 'x neg', view: 'left' as ViewName },
    { v: new THREE.Vector3(0, -1, 0), label: '', cls: 'y neg', view: 'front' as ViewName },
    { v: new THREE.Vector3(0, 0, -1), label: '', cls: 'z neg', view: 'bottom' as ViewName },
  ]
    .map((a) => ({ ...a, x: a.v.dot(right) * R, y: -a.v.dot(up) * R, d: a.v.dot(dir) }))
    .sort((a, b) => a.d - b.d);
  return (
    <svg
      class="navball"
      viewBox="-48 -48 96 96"
      onPointerDown={(e) => {
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, y: e.clientY, moved: false };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.x, dy = e.clientY - d.y;
        if (!d.moved && Math.hypot(dx, dy) < 4) return;
        d.moved = true;
        cam.orbit(dx * 1.6, dy * 1.6);
        app.vp.requestRender();
        d.x = e.clientX;
        d.y = e.clientY;
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        if (!d || d.moved) return;
        // Tap: snap to the nearest axis bubble.
        const r = (e.currentTarget as SVGElement).getBoundingClientRect();
        const px = ((e.clientX - r.left) / r.width) * 96 - 48, py = ((e.clientY - r.top) / r.height) * 96 - 48;
        const hit = [...axes].reverse().find((a) => Math.hypot(a.x - px, a.y - py) < 14);
        if (hit) {
          S.haptic(6);
          cam.setView(hit.view);
          app.vp.requestRender();
          S.sceneRev.value++;
        }
      }}
    >
      <circle r="46" class="navball-bg" />
      {axes.map((a) => (
        <g key={a.cls}>
          {a.label && <line x1="0" y1="0" x2={a.x} y2={a.y} class={`nav-line ${a.cls}`} />}
          <circle cx={a.x} cy={a.y} r={a.label ? 9 : 7} class={`nav-dot ${a.cls}`} />
          {a.label && (
            <text x={a.x} y={a.y + 3.5} class="nav-label">
              {a.label}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}

/** Paint mode: Vertex Paint (the "Color" attribute) or Texture Paint (the object's paint texture). */
function PaintBars({ app }: { app: App }) {
  void S.sceneRev.value; // re-render when the object gains/loses its texture (undo too)
  const [r, g, b] = S.brushColor.value;
  const hex = linearToHex([r, g, b]);
  const setHex = (h: string, remember: boolean) => {
    S.brushColor.value = hexToLinear(h);
    if (remember) S.recentColors.value = [h, ...S.recentColors.value.filter((x) => x !== h)].slice(0, 6);
  };
  const t = S.paintTool.value;
  const tex = S.paintTarget.value === 'texture';
  const ready = !tex || app.hasPaintTexture();
  const swatches = [...S.recentColors.value, ...SWATCHES.filter((s) => !S.recentColors.value.includes(s))].slice(0, 10);
  return (
    <div class="bottom">
      <div class="paintbar">
        <div class="paint-target">
          <Segmented
            value={S.paintTarget.value}
            onChange={(v) => app.setPaintTarget(v)}
            options={[
              { value: 'vertex', label: 'Vertex', title: 'Vertex Paint (Color attribute)' },
              { value: 'texture', label: 'Texture', title: 'Texture Paint (UV texture)' },
            ]}
          />
          {tex && ready && <IconButton icon={Icon.dots()} title="Texture options" active={S.sheet.value === 'texture'} onClick={() => toggleSheet('texture')} />}
        </div>
        {ready && (
          <>
            <label class="slider">
              <span class="field-label">Size</span>
              <input type="range" min={4} max={160} step={1} value={S.brushRadius.value} onInput={(e) => (S.brushRadius.value = Number((e.target as HTMLInputElement).value))} />
              <b>{S.brushRadius.value}</b>
            </label>
            <label class="slider">
              <span class="field-label">Strength</span>
              <input type="range" min={0.02} max={1} step={0.01} value={S.brushStrength.value} onInput={(e) => (S.brushStrength.value = Number((e.target as HTMLInputElement).value))} />
              <b>{S.brushStrength.value.toFixed(2)}</b>
            </label>
            {tex && (
              <label class="slider">
                <span class="field-label">Hardness</span>
                <input type="range" min={0} max={1} step={0.01} value={S.brushHardness.value} onInput={(e) => (S.brushHardness.value = Number((e.target as HTMLInputElement).value))} />
                <b>{S.brushHardness.value.toFixed(2)}</b>
              </label>
            )}
          </>
        )}
        {!ready && <NewTextureCard app={app} />}
      </div>
      {ready && (
        <>
          <nav class="actions colors" aria-label="Colors">
            <label class="brushcolor" aria-label="Brush color">
              <input type="color" value={hex} onInput={(e) => setHex((e.target as HTMLInputElement).value, false)} onChange={(e) => setHex((e.target as HTMLInputElement).value, true)} />
              <span class="swatch big" style={{ background: hex }} />
            </label>
            {swatches.map((h) => (
              <button key={h} class={`swatch big ${h === hex ? 'on' : ''}`} aria-label={`Paint with ${h}`} style={{ background: h }} onClick={() => setHex(h, true)} />
            ))}
            <IconButton icon={Icon.fill()} label={tex && t === 'erase' ? 'Clear' : 'Fill'} onClick={() => (tex ? app.fillTexture() : app.fillColor())} />
            <IconButton icon={Icon.palette()} label="Material" active={S.sheet.value === 'materials'} onClick={() => toggleSheet('materials')} />
          </nav>
          <nav class="tools" aria-label="Paint tools">
            <IconButton icon={Icon.brush()} label="Draw" active={t === 'draw'} onClick={() => (S.paintTool.value = 'draw')} />
            {tex ? (
              <IconButton icon={Icon.eraser()} label="Erase" active={t === 'erase'} onClick={() => (S.paintTool.value = 'erase')} />
            ) : (
              <IconButton icon={Icon.blur()} label="Blur" active={t === 'blur'} onClick={() => (S.paintTool.value = 'blur')} />
            )}
            <IconButton icon={Icon.dropper()} label="Pick" active={t === 'pick'} onClick={() => (S.paintTool.value = 'pick')} />
          </nav>
        </>
      )}
    </div>
  );
}

/** Shown in Texture Paint until the object has UVs and a paint texture: one tap sets both up. */
function NewTextureCard({ app }: { app: App }) {
  const o = app.active;
  const unwrapped = !!o?.mesh.uvs;
  return (
    <div class="newtexture">
      <p>
        {unwrapped ? 'Add a paint texture to ' : 'Unwrap '}
        <b>{o?.name ?? 'the object'}</b>
        {unwrapped ? '' : ' (automatic UVs) and add a paint texture'}. Paint goes on top of its colors.
      </p>
      <div class="row gap texsize">
        <span class="field-label">Texture</span>
        <Segmented
          value={String(S.textureSize.value) as '512' | '1024' | '2048'}
          onChange={(v) => (S.textureSize.value = Number(v))}
          options={[
            { value: '512', label: '512' },
            { value: '1024', label: '1K' },
            { value: '2048', label: '2K' },
          ]}
        />
      </div>
      <button class="btn wide" onClick={() => app.createPaintTexture()}>
        {Icon.brush({ size: 20 })}
        <span class="btn-label">{unwrapped ? 'Add paint texture' : 'Unwrap & add paint texture'}</span>
      </button>
    </div>
  );
}

function BrushCursor() {
  const c = S.brushCursor.value;
  if (!c) return null;
  return (
    <svg class="propcircle brush" width="100%" height="100%">
      <circle cx={c.x} cy={c.y} r={c.r} />
    </svg>
  );
}

function BottomBars({ app }: { app: App }) {
  if (S.mode.value === 'paint') return <PaintBars app={app} />;
  const edit = S.mode.value === 'edit';
  const t = S.tool.value;
  const isT = S.isTransformTool.value;
  const setTool = (id: S.ToolId) => {
    // Tapping the active tool again returns to Select (quick toggle).
    S.tool.value = S.tool.value === id && id !== 'select' ? 'select' : id;
    if (S.tool.value !== 'move') S.hint.value = null;
  };
  const c = S.constraint.value;
  const lastTap = useRef<{ axis: number; t: number }>({ axis: -1, t: 0 });
  const axisChip = (axis: 0 | 1 | 2) => {
    const now = performance.now();
    const dbl = lastTap.current.axis === axis && now - lastTap.current.t < 350;
    lastTap.current = { axis, t: now };
    if (dbl) S.constraint.value = { kind: 'plane', axis };
    else S.constraint.value = c?.kind === 'axis' && c.axis === axis ? null : { kind: 'axis', axis };
    S.haptic(6);
  };
  return (
    <div class="bottom">
      {edit && isT && S.propEnabled.value && <PropBar app={app} />}
      <div class="chips">
        {isT ? (
          // Compact while a transform tool needs the room: one chip cycling = → + → −.
          <button
            class={`chip ${S.pickOp.value !== 'replace' ? 'active' : ''}`}
            aria-label={`Selection: ${S.pickOp.value}; tap to change`}
            onClick={() => (S.pickOp.value = S.pickOp.value === 'replace' ? 'add' : S.pickOp.value === 'add' ? 'sub' : 'replace')}
          >
            {S.pickOp.value === 'add' ? Icon.plus({ size: 18 }) : S.pickOp.value === 'sub' ? Icon.minus({ size: 18 }) : Icon.equals({ size: 18 })}
          </button>
        ) : (
          <Segmented
            class="pickop"
            value={S.pickOp.value}
            onChange={(v) => (S.pickOp.value = v)}
            options={[
              { value: 'replace', icon: Icon.equals({ size: 18 }), title: 'Replace selection' },
              { value: 'add', icon: Icon.plus({ size: 18 }), title: 'Add to selection' },
              { value: 'sub', icon: Icon.minus({ size: 18 }), title: 'Remove from selection' },
            ]}
          />
        )}
        <div class="spacer" />
        {isT && (
          <>
            {c?.kind === 'dir' && (
              <button class="chip active" aria-label={`Constrained to ${c.label}; tap to free`} onClick={() => (S.constraint.value = null)}>
                {c.label}
                {Icon.close({ size: 16 })}
              </button>
            )}
            {c?.kind !== 'dir' && (['X', 'Y', 'Z'] as const).map((a, i) => {
              const on = !!c && c.axis === i;
              const plane = on && c!.kind === 'plane';
              return (
                <button
                  key={a}
                  class={`chip axis axis-${a.toLowerCase()} ${on ? 'active' : ''} ${plane ? 'plane' : ''}`}
                  aria-label={`${plane ? 'Plane without' : 'Lock to'} ${a}`}
                  onClick={() => axisChip(i as 0 | 1 | 2)}
                >
                  {plane ? `⊥${a}` : a}
                </button>
              );
            })}
            {edit && (
              <button
                class={`chip ${S.propEnabled.value ? 'active' : ''}`}
                aria-pressed={S.propEnabled.value}
                aria-label="Proportional editing"
                onClick={() => (S.propEnabled.value = !S.propEnabled.value)}
              >
                {Icon.falloff({ size: 18 })}
              </button>
            )}
            <button
              class={`chip ${S.snapEnabled.value ? 'active' : ''}`}
              aria-pressed={S.snapEnabled.value}
              aria-label="Snap to increments"
              onClick={() => (S.snapEnabled.value = !S.snapEnabled.value)}
            >
              {Icon.magnet({ size: 18 })}
            </button>
          </>
        )}
      </div>
      <nav class="actions" aria-label="Actions">
        {edit ? (
          <>
            <IconButton icon={Icon.extrude()} label="Extrude" onClick={() => app.extrude()} />
            <IconButton icon={Icon.inset()} label="Inset" onClick={() => app.inset()} />
            <IconButton icon={Icon.loopcut()} label="Loop Cut" onClick={() => app.loopCut()} />
            <IconButton icon={Icon.select()} label="Select" active={S.popover.value === 'select'} onClick={() => (S.popover.value = S.popover.value ? null : 'select')} />
            <IconButton icon={Icon.merge()} label="Merge" onClick={() => app.mergeCenter()} />
            <IconButton icon={Icon.mergeDist()} label="By dist." onClick={() => app.mergeDistance()} />
            <IconButton icon={Icon.trash()} label="Delete" onClick={() => app.deleteElements()} />
            <IconButton icon={Icon.palette()} label="Material" active={S.sheet.value === 'materials'} onClick={() => toggleSheet('materials')} />
            <IconButton icon={Icon.wrench()} label="Modifiers" active={S.sheet.value === 'modifiers'} onClick={() => toggleSheet('modifiers')} />
            <IconButton icon={Icon.sliders()} label="Item" active={S.sheet.value === 'item'} onClick={() => toggleSheet('item')} />
          </>
        ) : (
          <>
            <IconButton icon={Icon.plus()} label="Add" active={S.sheet.value === 'add'} onClick={() => toggleSheet('add')} />
            <IconButton icon={Icon.wrench()} label="Modifiers" active={S.sheet.value === 'modifiers'} onClick={() => toggleSheet('modifiers')} />
            <IconButton icon={Icon.palette()} label="Material" active={S.sheet.value === 'materials'} onClick={() => toggleSheet('materials')} />
            <IconButton icon={Icon.list()} label="Objects" active={S.sheet.value === 'outliner'} onClick={() => toggleSheet('outliner')} />
            <IconButton icon={Icon.duplicate()} label="Duplicate" onClick={() => app.duplicateSelected()} />
            <IconButton icon={Icon.trash()} label="Delete" onClick={() => app.deleteSelectedObjects()} />
            <IconButton icon={Icon.sliders()} label="Item" active={S.sheet.value === 'item'} onClick={() => toggleSheet('item')} />
            <IconButton icon={Icon.all()} label="All" onClick={() => app.selectAllToggle('all')} />
          </>
        )}
      </nav>
      <nav class="tools" aria-label="Tools">
        <IconButton icon={Icon.select()} label="Select" active={t === 'select'} onClick={() => setTool('select')} />
        <IconButton
          icon={t === 'lasso' ? Icon.lasso() : Icon.box()}
          label={t === 'lasso' ? 'Lasso' : 'Box'}
          active={t === 'box' || t === 'lasso'}
          onClick={() => (S.tool.value = t === 'box' ? 'lasso' : t === 'lasso' ? 'select' : 'box')}
        />
        <IconButton icon={Icon.move()} label="Move" active={t === 'move'} onClick={() => setTool('move')} />
        <IconButton icon={Icon.rotate()} label="Rotate" active={t === 'rotate'} onClick={() => setTool('rotate')} />
        <IconButton icon={Icon.scale()} label="Scale" active={t === 'scale'} onClick={() => setTool('scale')} />
      </nav>
    </div>
  );
}

/** Falloff radius slider (log scale, 1 cm … 10 m) shown while proportional editing is on. */
function PropBar({ app }: { app: App }) {
  const r = S.propRadius.value;
  const toSlider = (v: number) => Math.log10(v);
  return (
    <label class="propbar">
      {Icon.falloff({ size: 18 })}
      <span>Falloff</span>
      <input
        type="range"
        min={-2}
        max={1}
        step={0.01}
        value={toSlider(r)}
        aria-label="Proportional falloff radius"
        onInput={(e) => app.setPropRadius(Math.pow(10, Number((e.target as HTMLInputElement).value)))}
      />
      <b>{r < 1 ? `${(r * 100).toFixed(0)} cm` : `${r.toFixed(2)} m`}</b>
    </label>
  );
}

function PropCircle() {
  const c = S.propCircle.value;
  if (!c) return null;
  return (
    <svg class="propcircle" width="100%" height="100%">
      <circle cx={c.x} cy={c.y} r={c.r} />
    </svg>
  );
}

function SelectPopover({ app }: { app: App }) {
  if (S.popover.value !== 'select' || S.mode.value !== 'edit') return null;
  const run = (fn: () => void) => () => {
    fn();
    S.popover.value = null;
  };
  return (
    <div class="popover" role="menu" aria-label="Select">
      <IconButton icon={Icon.all()} label="All" onClick={run(() => app.selectAllToggle('all'))} />
      <IconButton icon={Icon.none()} label="None" onClick={run(() => app.selectAllToggle('none'))} />
      <IconButton icon={Icon.invert()} label="Invert" onClick={run(() => app.selectAllToggle('invert'))} />
      <IconButton icon={Icon.linked()} label="Linked" onClick={run(() => app.selectSpecial('linked'))} />
      <IconButton icon={Icon.loop()} label="Loop" onClick={run(() => app.selectSpecial('loop'))} />
      <IconButton icon={Icon.ring()} label="Ring" onClick={run(() => app.selectSpecial('ring'))} />
      <p class="note">Tip: double-tap an edge for its loop, a vertex or face for the whole piece.</p>
    </div>
  );
}

function Marquee() {
  const m = S.marquee.value;
  if (!m) return null;
  let shape: preact.JSX.Element;
  if (m.kind === 'box') {
    const [[x0, y0], [x1, y1]] = m.points;
    shape = <rect x={Math.min(x0, x1)} y={Math.min(y0, y1)} width={Math.abs(x1 - x0)} height={Math.abs(y1 - y0)} />;
  } else {
    shape = <polygon points={m.points.map((p) => p.join(',')).join(' ')} />;
  }
  return (
    <svg class={`marquee op-${S.pickOp.value}`} width="100%" height="100%">
      {shape}
    </svg>
  );
}

function Loupe({ app }: { app: App }) {
  const l = S.loupe.value;
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    app.loupeCanvas = ref.current;
    app.vp.requestRender();
  }, [l !== null]);
  if (!l) return null;
  const size = 132;
  const above = l.y > size + 70;
  const top = above ? l.y - size - 64 : l.y + 64;
  const left = Math.min(Math.max(8, l.x - size / 2), window.innerWidth - size - 8);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  return (
    <div class="loupe" style={{ left: `${left}px`, top: `${top}px`, width: `${size}px`, height: `${size}px` }}>
      <canvas ref={ref} width={size * dpr} height={size * dpr} />
      <div class="loupe-cross" />
    </div>
  );
}

function Hud() {
  const [showLog, setShowLog] = useState(false);
  if (!S.hudVisible.value) return null;
  const h = S.hudStats.value;
  return (
    <div class="hud">
      <div>
        <b class={h.fps < 50 ? 'warn' : ''}>{h.fps.toFixed(0)} fps</b> · frame {h.frameMs.toFixed(1)} ms · eval {h.evalMs.toFixed(1)} ms
        {h.buildMs > 0 && <> · build {h.buildMs.toFixed(0)} ms</>}
      </div>
      <div>
        cage {h.cageVerts} v · shown {h.verts} v / {h.faces} f
      </div>
      <button class="hud-log" onClick={() => setShowLog(!showLog)}>
        errors ({S.errorLog.value.length})
      </button>
      {showLog && (
        <div class="hud-errors">
          <pre>{S.errorLog.value.join('\n') || 'No errors'}</pre>
          <button onClick={() => void navigator.clipboard?.writeText(S.errorLog.value.join('\n'))}>Copy</button>
        </div>
      )}
    </div>
  );
}

function Toasts() {
  return (
    <div class="toasts" aria-live="polite">
      {S.toasts.value.map((t) => (
        <div key={t.id} class={`toast ${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

function UpdateBanner() {
  if (!S.updateReady.value) return null;
  return (
    <div class="update">
      <span>A new version is ready.</span>
      <button class="btn small" onClick={() => window.dispatchEvent(new Event('yb-apply-update'))}>
        Reload
      </button>
    </div>
  );
}

function toggleSheet(id: S.SheetId) {
  S.sheet.value = S.sheet.value === id ? null : id;
}

const labelize = (k: string) => k.replace(/([A-Z0-9])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
