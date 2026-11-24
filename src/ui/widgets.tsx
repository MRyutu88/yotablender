import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Icon } from './icons';
import * as S from '../app/state';

export function IconButton(props: {
  icon: JSX.Element;
  label?: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  class?: string;
  title?: string;
  onLongPress?: () => void;
}) {
  const timer = useRef(0);
  const long = useRef(false);
  return (
    <button
      class={`btn ${props.active ? 'active' : ''} ${props.class ?? ''}`}
      disabled={props.disabled}
      aria-label={props.title ?? props.label}
      aria-pressed={props.active}
      onPointerDown={() => {
        long.current = false;
        if (props.onLongPress) {
          timer.current = window.setTimeout(() => {
            long.current = true;
            S.haptic(12);
            props.onLongPress!();
          }, 450);
        }
      }}
      onPointerUp={() => clearTimeout(timer.current)}
      onPointerLeave={() => clearTimeout(timer.current)}
      onClick={() => {
        if (long.current) return;
        S.haptic(4);
        props.onClick();
      }}
    >
      {props.icon}
      {props.label && <span class="btn-label">{props.label}</span>}
    </button>
  );
}

export function Segmented<T extends string>(props: {
  value: T;
  options: { value: T; label?: string; icon?: JSX.Element; title?: string }[];
  onChange: (v: T) => void;
  class?: string;
}) {
  return (
    <div class={`segmented ${props.class ?? ''}`} role="radiogroup">
      {props.options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={props.value === o.value}
          aria-label={o.title ?? o.label}
          class={`seg ${props.value === o.value ? 'active' : ''}`}
          onClick={() => {
            S.haptic(4);
            props.onChange(o.value);
          }}
        >
          {o.icon}
          {o.label && <span>{o.label}</span>}
        </button>
      ))}
    </div>
  );
}

/** Number input that commits on blur/enter. Big enough to hit with a thumb. */
export function NumberField(props: { value: number; onCommit: (v: number) => void; step?: number; digits?: number; label?: string; suffix?: string }) {
  const digits = props.digits ?? 3;
  const [text, setText] = useState(fmt(props.value, digits));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(fmt(props.value, digits));
  }, [props.value, digits]);
  const commit = () => {
    const v = evalNumber(text);
    if (v !== null && Math.abs(v - props.value) > 1e-9) props.onCommit(v);
    else setText(fmt(props.value, digits));
  };
  return (
    <label class="numfield">
      {props.label && <span class={`numfield-label axis-${props.label.toLowerCase()}`}>{props.label}</span>}
      <input
        inputMode="decimal"
        value={text}
        onFocus={(e) => {
          focused.current = true;
          (e.target as HTMLInputElement).select();
        }}
        onInput={(e) => setText((e.target as HTMLInputElement).value)}
        onBlur={() => {
          focused.current = false;
          commit();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
      {props.suffix && <span class="numfield-suffix">{props.suffix}</span>}
    </label>
  );
}

export function Stepper(props: { value: number; min: number; max: number; step?: number; int?: boolean; onChange: (v: number) => void; label?: string }) {
  const step = props.step ?? 1;
  const clamp = (v: number) => Math.min(props.max, Math.max(props.min, props.int ? Math.round(v) : Math.round(v * 1000) / 1000));
  return (
    <div class="stepper">
      {props.label && <span class="stepper-label">{props.label}</span>}
      <button class="btn small" aria-label={`Decrease ${props.label ?? ''}`} disabled={props.value <= props.min} onClick={() => props.onChange(clamp(props.value - step))}>
        {Icon.minus({ size: 18 })}
      </button>
      <NumberField value={props.value} digits={props.int ? 0 : 2} onCommit={(v) => props.onChange(clamp(v))} />
      <button class="btn small" aria-label={`Increase ${props.label ?? ''}`} disabled={props.value >= props.max} onClick={() => props.onChange(clamp(props.value + step))}>
        {Icon.plus({ size: 18 })}
      </button>
    </div>
  );
}

export function Toggle(props: { value: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      class={`toggle ${props.value ? 'on' : ''}`}
      role="switch"
      aria-checked={props.value}
      onClick={() => {
        S.haptic(4);
        props.onChange(!props.value);
      }}
    >
      <span class="toggle-track">
        <span class="toggle-knob" />
      </span>
      <span>{props.label}</span>
    </button>
  );
}

/** Bottom sheet in portrait, side panel in landscape. */
export function Sheet(props: { title: string; children: ComponentChildren; actions?: ComponentChildren }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <section class={`sheet ${expanded ? 'expanded' : ''}`} role="dialog" aria-label={props.title}>
      <header class="sheet-head">
        <button class="sheet-handle" aria-label={expanded ? 'Shrink panel' : 'Expand panel'} onClick={() => setExpanded(!expanded)}>
          <span />
        </button>
        <h2>{props.title}</h2>
        <div class="sheet-actions">
          {props.actions}
          <button class="btn small ghost" aria-label="Close" onClick={() => (S.sheet.value = null)}>
            {Icon.close({ size: 20 })}
          </button>
        </div>
      </header>
      <div class="sheet-body">{props.children}</div>
    </section>
  );
}

function fmt(n: number, digits: number): string {
  if (!Number.isFinite(n)) return '0';
  const s = n.toFixed(digits);
  return digits > 0 ? s.replace(/\.?0+$/, '') || '0' : s;
}

/** Accepts plain numbers and simple arithmetic like "0.5*2" or "1/3" (handy for exact values). */
export function evalNumber(text: string): number | null {
  const t = text.replace(/,/g, '.').trim();
  if (!t) return null;
  if (!/^[\d+\-*/().\s e]+$/i.test(t)) return null;
  try {
    const v = Function(`"use strict"; return (${t});`)() as unknown;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}
