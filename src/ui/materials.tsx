import type { App } from '../app/app';
import * as S from '../app/state';
import { Icon } from './icons';
import { IconButton, Sheet, Toggle } from './widgets';
import { hexToLinear, linearToHex, SWATCHES } from './color';

/** Material slots of the active object and the editor for the selected slot's material. */
export function MaterialsSheet({ app }: { app: App }) {
  void S.sceneRev.value;
  const o = app.active;
  if (!o) {
    return (
      <Sheet title="Materials">
        <p class="empty">Select an object to edit its materials.</p>
      </Sheet>
    );
  }
  const edit = S.mode.value === 'edit';
  const slot = Math.min(S.activeSlot.value, o.materialSlots.length - 1);
  const mat = app.project.materials.find((m) => m.id === o.materialSlots[slot]);
  const setColor = (hex: string, commit: boolean) => {
    if (!mat) return;
    const [r, g, b] = hexToLinear(hex);
    app.updateMaterial(mat.id, { base_color: [r, g, b, mat.base_color[3]] }, commit);
  };
  return (
    <Sheet title={`Materials · ${o.name}`}>
      <ul class="slots">
        {o.materialSlots.map((id, i) => {
          const m = app.project.materials.find((x) => x.id === id);
          return (
            <li key={i}>
              <button class={`slot ${i === slot ? 'active' : ''}`} onClick={() => (S.activeSlot.value = i)}>
                <span class="swatch" style={{ background: m ? linearToHex(m.base_color) : '#888' }} />
                <span class="slot-name">{m?.name ?? '(empty)'}</span>
                <small>slot {i + 1}</small>
              </button>
            </li>
          );
        })}
      </ul>
      <div class="row gap wrap">
        <IconButton icon={Icon.plus({ size: 20 })} label="New slot" onClick={() => app.addMaterialSlot()} />
        <IconButton icon={Icon.minus({ size: 20 })} label="Remove" disabled={o.materialSlots.length <= 1} onClick={() => app.removeMaterialSlot(slot)} />
        {edit && <IconButton icon={Icon.check({ size: 20 })} label="Assign" onClick={() => app.assignMaterialSlot(slot)} />}
        {edit && <IconButton icon={Icon.select({ size: 20 })} label="Select" onClick={() => app.selectMaterialSlot(slot)} />}
      </div>
      {edit && <p class="note">Select faces, pick a slot, then Assign.</p>}

      {mat && (
        <>
          <h3 class="section">Material</h3>
          <div class="row gap">
            <input
              class="text"
              aria-label="Material name"
              value={mat.name}
              onBlur={(e) => {
                const n = (e.target as HTMLInputElement).value.trim();
                if (n && n !== mat.name && !app.project.materials.some((m) => m.name === n)) app.updateMaterial(mat.id, { name: n }, true);
              }}
            />
          </div>
          <div class="row gap">
            <span class="field-label">Base color</span>
            <input
              type="color"
              class="colorpick"
              aria-label="Base color"
              value={linearToHex(mat.base_color)}
              onInput={(e) => setColor((e.target as HTMLInputElement).value, false)}
              onChange={(e) => setColor((e.target as HTMLInputElement).value, true)}
            />
          </div>
          <div class="swatches">
            {SWATCHES.map((hex) => (
              <button key={hex} class="swatch big" aria-label={`Color ${hex}`} style={{ background: hex }} onClick={() => setColor(hex, true)} />
            ))}
          </div>
          {(['roughness', 'metallic'] as const).map((k) => (
            <label key={k} class="slider">
              <span class="field-label">{k === 'roughness' ? 'Roughness' : 'Metallic'}</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={mat[k]}
                onInput={(e) => app.updateMaterial(mat.id, { [k]: Number((e.target as HTMLInputElement).value) }, false)}
                onChange={(e) => app.updateMaterial(mat.id, { [k]: Number((e.target as HTMLInputElement).value) }, true)}
              />
              <b>{mat[k].toFixed(2)}</b>
            </label>
          ))}
          {app.project.materials.length > 1 && (
            <>
              <h3 class="section">Use another material in this slot</h3>
              <div class="row gap wrap">
                {app.project.materials
                  .filter((m) => m.id !== mat.id)
                  .map((m) => (
                    <button key={m.id} class="chip" onClick={() => app.setSlotMaterial(slot, m.id)}>
                      <span class="swatch" style={{ background: linearToHex(m.base_color) }} />
                      {m.name}
                    </button>
                  ))}
              </div>
            </>
          )}
        </>
      )}
      <h3 class="section">Viewport</h3>
      <Toggle
        label="Material preview (shows roughness and metallic)"
        value={S.shading.value === 'material'}
        onChange={(v) => {
          S.shading.value = v ? 'material' : 'solid';
          app.vp.requestRender();
        }}
      />
      {o.mesh.colors && <p class="note">This object has painted colors, so the viewport shows those instead of the base color.</p>}
    </Sheet>
  );
}
