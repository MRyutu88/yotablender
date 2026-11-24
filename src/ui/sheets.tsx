import { useEffect, useState } from 'preact/hooks';
import type { App } from '../app/app';
import * as S from '../app/state';
import { Icon } from './icons';
import { NumberField, Sheet, Stepper, Toggle, IconButton } from './widgets';
import { PRIMITIVE_LABELS, type PrimitiveType } from '../core/primitives/primitives';
import { listProjects, setSetting, type ProjectMeta } from '../app/storage';
import type { MirrorModifier, SubsurfModifier } from '../core/modifiers/types';
import { objectMatrix } from '../core/scene/scene';
import { transformPoint } from '../core/math/mat4';

const PRIM_ICONS: Record<PrimitiveType, () => preact.JSX.Element> = {
  cube: () => Icon.cube({ size: 30 }),
  plane: () => Icon.plane({ size: 30 }),
  uvSphere: () => Icon.sphere({ size: 30 }),
  quadSphere: () => Icon.quadSphere({ size: 30 }),
  cylinder: () => Icon.cylinder({ size: 30 }),
  cone: () => Icon.cone({ size: 30 }),
  torus: () => Icon.torus({ size: 30 }),
};

export function AddSheet({ app }: { app: App }) {
  const types: PrimitiveType[] = ['cube', 'quadSphere', 'uvSphere', 'cylinder', 'cone', 'torus', 'plane'];
  return (
    <Sheet title="Add">
      <button class="tile wide accent" onClick={() => app.addCharacterStart()}>
        {Icon.person({ size: 30 })}
        <span>
          <b>Character start</b>
          <small>Half box · Mirror X · Subdivision 2</small>
        </span>
      </button>
      <div class="tile-grid">
        {types.map((t) => (
          <button key={t} class="tile" onClick={() => app.addPrimitive(t)}>
            {PRIM_ICONS[t]()}
            <span>{PRIMITIVE_LABELS[t]}</span>
          </button>
        ))}
      </div>
    </Sheet>
  );
}

export function OutlinerSheet({ app }: { app: App }) {
  void S.sceneRev.value;
  const [renaming, setRenaming] = useState<string | null>(null);
  const objs = app.project.objects;
  return (
    <Sheet title={`Objects (${objs.length})`}>
      {objs.length === 0 && <p class="empty">No objects yet. Tap Add to start with a primitive.</p>}
      <ul class="outliner">
        {objs.map((o) => {
          const selected = S.selectedIds.value.has(o.id);
          const active = S.activeId.value === o.id;
          return (
            <li key={o.id} class={`${selected ? 'selected' : ''} ${active ? 'active' : ''} ${o.visible ? '' : 'hidden'}`}>
              <button class="btn small ghost" aria-label={o.visible ? `Hide ${o.name}` : `Show ${o.name}`} onClick={() => app.toggleVisible(o.id)}>
                {o.visible ? Icon.eye({ size: 20 }) : Icon.eyeOff({ size: 20 })}
              </button>
              {renaming === o.id ? (
                <input
                  class="rename"
                  value={o.name}
                  ref={(el) => el?.focus()}
                  onBlur={(e) => {
                    app.renameObject(o.id, (e.target as HTMLInputElement).value);
                    setRenaming(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                />
              ) : (
                <button class="outliner-name" onClick={() => app.selectObjectFromList(o.id)} onDblClick={() => setRenaming(o.id)}>
                  {o.name}
                  {o.modifiers.length > 0 && <span class="badge">{o.modifiers.map((m) => (m.type === 'MIRROR' ? 'M' : 'S')).join('')}</span>}
                </button>
              )}
              <button class="btn small ghost" aria-label={`Rename ${o.name}`} onClick={() => setRenaming(o.id)}>
                {Icon.edit({ size: 18 })}
              </button>
              <button class="btn small ghost danger" aria-label={`Delete ${o.name}`} onClick={() => app.deleteObject(o.id)}>
                {Icon.trash({ size: 18 })}
              </button>
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
}

export function ModifiersSheet({ app }: { app: App }) {
  void S.sceneRev.value;
  const o = app.active;
  if (!o) {
    return (
      <Sheet title="Modifiers">
        <p class="empty">Select an object to see its modifiers.</p>
      </Sheet>
    );
  }
  const has = (t: 'MIRROR' | 'SUBSURF') => o.modifiers.some((m) => m.type === t);
  return (
    <Sheet title={`Modifiers · ${o.name}`}>
      {o.modifiers.map((m, i) =>
        m.type === 'MIRROR' ? (
          <MirrorCard key={i} m={m} onChange={(p) => app.updateModifier(i, p)} onRemove={() => app.removeModifier(i)} />
        ) : (
          <SubsurfCard key={i} m={m} onChange={(p) => app.updateModifier(i, p)} onRemove={() => app.removeModifier(i)} />
        ),
      )}
      <div class="row gap">
        {!has('MIRROR') && <IconButton icon={Icon.plus({ size: 20 })} label="Mirror" onClick={() => app.addModifier('MIRROR')} />}
        {!has('SUBSURF') && <IconButton icon={Icon.plus({ size: 20 })} label="Subdivision" onClick={() => app.addModifier('SUBSURF')} />}
      </div>
      <p class="note">Modifiers stay live (never applied) and export to Blender with the same settings.</p>
    </Sheet>
  );
}

function CardHead(props: { title: string; on: boolean; onToggle: () => void; onRemove: () => void }) {
  return (
    <div class="card-head">
      <button class="btn small ghost" aria-label={props.on ? 'Hide in viewport' : 'Show in viewport'} onClick={props.onToggle}>
        {props.on ? Icon.eye({ size: 20 }) : Icon.eyeOff({ size: 20 })}
      </button>
      <h3>{props.title}</h3>
      <button class="btn small ghost danger" aria-label={`Remove ${props.title}`} onClick={props.onRemove}>
        {Icon.close({ size: 18 })}
      </button>
    </div>
  );
}

function MirrorCard({ m, onChange, onRemove }: { m: MirrorModifier; onChange: (p: Partial<MirrorModifier>) => void; onRemove: () => void }) {
  return (
    <div class={`card ${m.show_viewport ? '' : 'off'}`}>
      <CardHead title="Mirror" on={m.show_viewport} onToggle={() => onChange({ show_viewport: !m.show_viewport })} onRemove={onRemove} />
      <div class="row gap">
        <span class="field-label">Axis</span>
        {(['X', 'Y', 'Z'] as const).map((a, i) => (
          <button
            key={a}
            class={`chip axis-${a.toLowerCase()} ${m.use_axis[i] ? 'active' : ''}`}
            aria-pressed={m.use_axis[i]}
            onClick={() => {
              const use = [...m.use_axis] as [boolean, boolean, boolean];
              use[i] = !use[i];
              onChange({ use_axis: use });
            }}
          >
            {a}
          </button>
        ))}
      </div>
      <div class="row gap wrap">
        <Toggle label="Clipping" value={m.use_clip} onChange={(v) => onChange({ use_clip: v })} />
        <Toggle label="Merge" value={m.use_mirror_merge} onChange={(v) => onChange({ use_mirror_merge: v })} />
      </div>
      {m.use_mirror_merge && (
        <div class="row">
          <span class="field-label">Merge distance</span>
          <NumberField value={m.merge_threshold} digits={4} suffix="m" onCommit={(v) => onChange({ merge_threshold: Math.max(0, v) })} />
        </div>
      )}
    </div>
  );
}

function SubsurfCard({ m, onChange, onRemove }: { m: SubsurfModifier; onChange: (p: Partial<SubsurfModifier>) => void; onRemove: () => void }) {
  return (
    <div class={`card ${m.show_viewport ? '' : 'off'}`}>
      <CardHead title="Subdivision" on={m.show_viewport} onToggle={() => onChange({ show_viewport: !m.show_viewport })} onRemove={onRemove} />
      <Stepper label="Viewport" value={m.levels} min={0} max={3} int onChange={(v) => onChange({ levels: v, drag_levels: Math.min(m.drag_levels, v) || v })} />
      <Stepper label="Render" value={m.render_levels} min={0} max={6} int onChange={(v) => onChange({ render_levels: v })} />
      <Stepper label="While dragging" value={Math.min(m.drag_levels, m.levels)} min={0} max={m.levels} int onChange={(v) => onChange({ drag_levels: v })} />
      <Toggle label="Limit surface (like Blender)" value={m.use_limit_surface} onChange={(v) => onChange({ use_limit_surface: v })} />
    </div>
  );
}

export function ItemSheet({ app }: { app: App }) {
  void S.sceneRev.value;
  const o = app.active;
  if (!o) {
    return (
      <Sheet title="Item">
        <p class="empty">Select an object.</p>
      </Sheet>
    );
  }
  if (S.mode.value === 'edit') {
    const verts = [...o.editSelection.verts];
    const m = objectMatrix(o);
    const med = [0, 0, 0];
    for (const v of verts) {
      const w = transformPoint(m, o.mesh.getVert(v));
      for (let k = 0; k < 3; k++) med[k] += w[k] / verts.length;
    }
    return (
      <Sheet title="Item · Selection">
        <p class="note">
          {o.editSelection.verts.size} verts · {o.editSelection.edges.size} edges · {o.editSelection.faces.size} faces selected
        </p>
        {verts.length > 0 && (
          <>
            <h3 class="section">Median (global)</h3>
            <div class="xyz">
              {['X', 'Y', 'Z'].map((a, i) => (
                <NumberField key={a} label={a} value={med[i]} onCommit={(v) => app.setMedian(i, v)} suffix="m" />
              ))}
            </div>
          </>
        )}
      </Sheet>
    );
  }
  const deg = (r: number) => (r * 180) / Math.PI;
  return (
    <Sheet title={`Item · ${o.name}`}>
      <h3 class="section">Location</h3>
      <div class="xyz">
        {['X', 'Y', 'Z'].map((a, i) => (
          <NumberField key={a} label={a} value={o.location[i]} suffix="m" onCommit={(v) => app.setObjectTransform('location', i, v)} />
        ))}
      </div>
      <h3 class="section">Rotation</h3>
      <div class="xyz">
        {['X', 'Y', 'Z'].map((a, i) => (
          <NumberField key={a} label={a} value={deg(o.rotation_euler[i])} digits={2} suffix="°" onCommit={(v) => app.setObjectTransform('rotation', i, v)} />
        ))}
      </div>
      <h3 class="section">Scale</h3>
      <div class="xyz">
        {['X', 'Y', 'Z'].map((a, i) => (
          <NumberField key={a} label={a} value={o.scale[i]} onCommit={(v) => app.setObjectTransform('scale', i, v)} />
        ))}
      </div>
      <div class="row gap">
        <IconButton icon={Icon.smooth({ size: 20 })} label="Shade Smooth" active={o.shade_smooth} onClick={() => app.setShadeSmooth(true)} />
        <IconButton icon={Icon.flat({ size: 20 })} label="Flat" active={!o.shade_smooth} onClick={() => app.setShadeSmooth(false)} />
      </div>
    </Sheet>
  );
}

export function MenuSheet({ app, installPrompt }: { app: App; installPrompt: (() => void) | null }) {
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [applyMirror, setApplyMirror] = useState(false);
  const [zip, setZip] = useState(true);
  const [name, setName] = useState(S.projectName.value);
  const refresh = () => listProjects().then(setProjects).catch(() => setProjects([]));
  useEffect(() => {
    void refresh();
  }, [S.saveState.value]);
  const snap = S.snapSettings.value;
  return (
    <Sheet title="YotaBlender">
      <h3 class="section">Project</h3>
      <div class="row gap">
        <input class="text" value={name} aria-label="Project name" onInput={(e) => setName((e.target as HTMLInputElement).value)} onBlur={() => app.renameProject(name)} />
        <span class={`save-dot ${S.saveState.value}`} title={S.saveState.value} />
      </div>
      <div class="row gap wrap">
        <IconButton icon={Icon.plus({ size: 20 })} label="New" onClick={() => app.newProject(true)} />
        <IconButton icon={Icon.share({ size: 20 })} label="Save file" onClick={() => void app.saveProjectFile()} />
        <IconButton icon={Icon.folder({ size: 20 })} label="Open file" onClick={() => void app.openProjectFile()} />
      </div>

      <h3 class="section">Export to Blender</h3>
      <div class="row gap wrap">
        <Toggle label="Apply Mirror" value={applyMirror} onChange={setApplyMirror} />
        <Toggle label="Zip OBJ + MTL" value={zip} onChange={setZip} />
      </div>
      <div class="row gap wrap">
        <IconButton icon={Icon.download({ size: 20 })} label="Export OBJ" onClick={() => void app.exportObj(applyMirror, zip)} />
        <IconButton icon={Icon.download({ size: 20 })} label="Export JSON" onClick={() => void app.saveProjectFile()} />
      </div>
      <p class="note">OBJ is the cage (quads and n-gons kept). JSON keeps modifiers, transforms and materials for the Blender add-on.</p>

      <h3 class="section">Recent projects</h3>
      <ul class="projects">
        {projects.map((p) => (
          <li key={p.id} class={p.id === app.project.id ? 'active' : ''}>
            <button class="outliner-name" onClick={() => void app.openProject(p.id).then(() => (S.sheet.value = null))}>
              <b>{p.name}</b>
              <small>
                {p.objects} objects · {new Date(p.modified).toLocaleString()}
              </small>
            </button>
            <button
              class="btn small ghost danger"
              aria-label={`Delete project ${p.name}`}
              onClick={() => {
                if (confirm(`Delete "${p.name}"? This can't be undone.`)) void app.removeProject(p.id).then(refresh);
              }}
            >
              {Icon.trash({ size: 18 })}
            </button>
          </li>
        ))}
      </ul>

      <h3 class="section">Snapping increments</h3>
      <div class="xyz">
        <NumberField label="Move" value={snap.move} suffix="m" onCommit={(v) => (S.snapSettings.value = { ...snap, move: Math.max(0.001, v) })} />
        <NumberField label="Rot" value={snap.rotateDeg} digits={1} suffix="°" onCommit={(v) => (S.snapSettings.value = { ...snap, rotateDeg: Math.max(0.1, v) })} />
        <NumberField label="Scale" value={snap.scale} onCommit={(v) => (S.snapSettings.value = { ...snap, scale: Math.max(0.001, v) })} />
      </div>

      <h3 class="section">App</h3>
      <div class="row gap wrap">
        <Toggle label="Performance HUD" value={S.hudVisible.value} onChange={(v) => (S.hudVisible.value = v)} />
        <Toggle
          label="Auto perspective"
          value={app.vp.cam.autoPerspective}
          onChange={(v) => {
            app.vp.cam.autoPerspective = v;
            S.sceneRev.value++;
          }}
        />
      </div>
      <div class="row gap wrap">
        <IconButton icon={Icon.help({ size: 20 })} label="Gestures" onClick={() => (S.sheet.value = 'help')} />
        {installPrompt && <IconButton icon={Icon.download({ size: 20 })} label="Install app" onClick={installPrompt} />}
      </div>
      <p class="note">Version {__APP_VERSION__} · works offline · projects stay on this device</p>
    </Sheet>
  );
}

export function HelpSheet() {
  const rows: [string, string][] = [
    ['1 finger drag', 'Orbit (Select tool) · transform (Move/Rotate/Scale)'],
    ['2 fingers', 'Pan and pinch to zoom'],
    ['Tap', 'Select (tap empty space to deselect)'],
    ['Touch & hold (Edit Mode)', 'Magnifier: slide to the exact vertex, lift to select'],
    ['2-finger tap', 'Undo'],
    ['3-finger tap', 'Redo'],
    ['2nd finger while dragging', 'Precision: 10× slower'],
    ['＋ / − chips', 'Add to / remove from the selection'],
    ['X Y Z chips', 'Tap: lock to an axis · double-tap: lock to the other two'],
    ['Gizmo handles', 'Drag an arrow, ring or square to constrain'],
    ['Nav ball (top right)', 'Drag to orbit · tap an axis for that view'],
    ['Tap a tool again', 'Back to the Select tool'],
    ['Double-tap an edge', 'Select its edge loop (a vertex or face: the whole piece)'],
    ['◎ chip (Edit Mode)', 'Proportional editing: nearby vertices follow; set the falloff with the slider'],
    ['Brush mode (top bar)', 'Vertex Paint: drag to paint, Blur to soften, Pick to sample a color'],
  ];
  return (
    <Sheet title="Gestures">
      <dl class="help">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <button
        class="btn wide"
        onClick={() => {
          void setSetting('seenHelp', true);
          S.sheet.value = null;
        }}
      >
        {Icon.check({ size: 20 })}
        <span class="btn-label">Got it</span>
      </button>
    </Sheet>
  );
}
