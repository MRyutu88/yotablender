// Routes gestures to the active tool.
//
//   Select tool     tap = select, hold = loupe (Edit Mode), drag = orbit
//   Box / Lasso     drag = selection shape (orbit with the nav ball or two fingers)
//   Move/Rot/Scale  drag anywhere = transform the selection (grab a gizmo handle to constrain);
//                   with nothing selected, drag orbits
//   Two fingers     pan + pinch zoom (always)
//   2/3-finger tap  undo / redo

import type { App } from '../app/app';
import type { GestureHandler, Pt } from './gestures';
import * as S from '../app/state';
import type { TransformKind } from '../app/transform';

type DragKind = 'orbit' | 'transform' | 'marquee' | 'none';

export class InputController implements GestureHandler {
  private drag: DragKind = 'none';
  private last: Pt = { x: 0, y: 0 };
  private marqueePts: [number, number][] = [];

  constructor(private app: App) {}

  touchDown(): boolean {
    // In portrait an open panel covers part of the view: the first touch on the model closes it
    // and does nothing else (so it can't deselect by accident).
    if (S.sheet.value && window.matchMedia('(orientation: portrait)').matches) {
      S.sheet.value = null;
      return true;
    }
    return false;
  }

  wantsHold(): boolean {
    return S.mode.value === 'edit' && !S.isTransformTool.value && S.tool.value === 'select';
  }

  dragKeepsSecondFinger(): boolean {
    return this.drag === 'transform';
  }

  tap(p: Pt): void {
    this.app.tap(p.x, p.y);
  }

  holdStart(p: Pt): void {
    this.app.holdStart(p.x, p.y);
  }
  holdMove(p: Pt): void {
    this.app.holdMove(p.x, p.y);
  }
  holdEnd(_p: Pt, cancelled: boolean): void {
    this.app.holdEnd(cancelled);
  }

  dragStart(start: Pt, p: Pt): void {
    this.last = { ...start };
    const t = S.tool.value;
    if (t === 'move' || t === 'rotate' || t === 'scale') {
      const hit = this.app.gizmoHit(start.x, start.y);
      if (this.app.beginTransform(t as TransformKind, start.x, start.y, hit)) {
        this.drag = 'transform';
        S.haptic(6);
        return;
      }
    }
    if (t === 'box' || t === 'lasso') {
      this.drag = 'marquee';
      this.marqueePts = [[start.x, start.y]];
      this.updateMarquee(p);
      return;
    }
    this.drag = 'orbit';
  }

  dragMove(p: Pt, precision: boolean): void {
    if (this.drag === 'orbit') {
      this.app.vp.cam.orbit(p.x - this.last.x, p.y - this.last.y);
      this.app.vp.requestRender();
    } else if (this.drag === 'transform') {
      this.app.updateTransform(p.x, p.y, precision);
    } else if (this.drag === 'marquee') {
      this.updateMarquee(p);
    }
    this.last = { ...p };
  }

  dragEnd(_p: Pt, cancelled: boolean): void {
    if (this.drag === 'transform') this.app.endTransform(cancelled);
    else if (this.drag === 'marquee') {
      const m = S.marquee.value;
      S.marquee.value = null;
      if (!cancelled && m) this.app.selectPolygon(m.kind === 'box' ? boxPoly(m.points) : m.points);
    }
    this.drag = 'none';
  }

  private updateMarquee(p: Pt): void {
    const kind = S.tool.value === 'lasso' ? 'lasso' : 'box';
    if (kind === 'box') {
      S.marquee.value = { kind, points: [this.marqueePts[0], [p.x, p.y]] };
    } else {
      const lastPt = this.marqueePts[this.marqueePts.length - 1];
      if (Math.hypot(p.x - lastPt[0], p.y - lastPt[1]) > 4) this.marqueePts.push([p.x, p.y]);
      S.marquee.value = { kind, points: [...this.marqueePts] };
    }
  }

  pinch(dx: number, dy: number, scale: number, center: Pt): void {
    const cam = this.app.vp.cam;
    cam.pan(dx, dy);
    if (Math.abs(scale - 1) > 1e-4) cam.zoom(1 / scale, center);
    this.app.vp.requestRender();
  }

  pinchEnd(): void {}

  twoFingerTap(): void {
    this.app.undo();
  }

  threeFingerTap(): void {
    this.app.redo();
  }

  mouseOrbit(dx: number, dy: number): void {
    this.app.vp.cam.orbit(dx, dy);
    this.app.vp.requestRender();
  }

  mousePan(dx: number, dy: number): void {
    this.app.vp.cam.pan(dx, dy);
    this.app.vp.requestRender();
  }

  wheel(deltaY: number, p: Pt): void {
    this.app.vp.cam.zoom(Math.exp(deltaY * 0.0015), p);
    this.app.vp.requestRender();
  }
}

function boxPoly(pts: [number, number][]): [number, number][] {
  const [[x0, y0], [x1, y1]] = pts;
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

/** Blender-style shortcuts for desktop development. */
export function installKeyboard(app: App): void {
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    const k = e.key.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && k === 'z') {
      e.preventDefault();
      if (e.shiftKey) app.redo();
      else app.undo();
      return;
    }
    if (ctrl && k === 'y') return app.redo();
    if (ctrl) return;
    switch (k) {
      case 'tab':
        e.preventDefault();
        return app.setMode(S.mode.value === 'edit' ? 'object' : 'edit');
      case '1':
      case '2':
      case '3':
        if (S.mode.value === 'edit') app.setSelectMode((['vert', 'edge', 'face'] as const)[Number(k) - 1]);
        return;
      case 'g':
        S.tool.value = 'move';
        return;
      case 'r':
        S.tool.value = 'rotate';
        return;
      case 's':
        S.tool.value = 'scale';
        return;
      case 'b':
        S.tool.value = 'box';
        return;
      case 'w':
        S.tool.value = 'select';
        return;
      case 'x':
      case 'y':
      case 'z': {
        const axis = 'xyz'.indexOf(k) as 0 | 1 | 2;
        const cur = S.constraint.value;
        S.constraint.value = e.shiftKey
          ? { kind: 'plane', axis }
          : cur?.kind === 'axis' && cur.axis === axis
            ? null
            : { kind: 'axis', axis };
        return;
      }
      case 'e':
        return app.extrude();
      case 'm':
        return app.mergeCenter();
      case 'delete':
      case 'backspace':
        return S.mode.value === 'edit' ? app.deleteElements() : app.deleteSelectedObjects();
      case 'a':
        return app.selectAllToggle(e.altKey ? 'none' : 'all');
      case 'escape':
        if (app.session) app.endTransform(true);
        S.sheet.value = null;
        return;
      case '.':
        return app.frameSelected();
      case 'home':
        return app.frameAll();
      case 'f':
        return app.frameSelected();
    }
    if (e.code === 'Numpad1') app.vp.cam.setView(e.ctrlKey ? 'back' : 'front');
    else if (e.code === 'Numpad3') app.vp.cam.setView(e.ctrlKey ? 'left' : 'right');
    else if (e.code === 'Numpad7') app.vp.cam.setView(e.ctrlKey ? 'bottom' : 'top');
    else if (e.code === 'Numpad5') app.vp.cam.ortho = !app.vp.cam.ortho;
    app.vp.requestRender();
  });
}
